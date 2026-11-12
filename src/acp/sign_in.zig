//! `authenticate` with `lia-login` on Gateway: adopts a saved `lia login`, or
//! runs its browser sign-in on a worker so the connection keeps reading
//! requests meanwhile. The sign-in page and code go to stderr, never to
//! stdout, which carries JSON-RPC.
const std = @import("std");
const server = @import("server.zig");
const jsonrpc = @import("jsonrpc.zig");
const acp_types = @import("types.zig");
const auth_runtime = @import("../core/auth/auth_runtime.zig");
const credentials = @import("../core/auth/credentials.zig");
const login_flow = @import("../core/auth/login_flow.zig");
const oauth_session = @import("../core/auth/oauth_session.zig");
const provider_activation = @import("../core/cli/provider_activation.zig");
const host_target = @import("../core/hosts/target.zig");
const debug_trace = @import("../core/shared/debug_trace.zig");
const io_mod = @import("../core/shared/io.zig");
const types = @import("../core/shared/types.zig");
const host = @import("../core/hosts/host.zig");
const oauth_transport = @import("../core/auth/oauth_transport.zig");
const model_catalog = @import("../core/gateway/model_catalog.zig");
const provider_set = @import("../core/gateway/provider_set.zig");
const secret = @import("../core/auth/secret.zig");
const sessions = @import("sessions.zig");

const Allocator = std.mem.Allocator;
const ErrorCode = jsonrpc.ErrorCode;
const ServerState = server.ServerState;

const poll_ms: u64 = 100;
pub const team_required_message = "Signed in to Vercel AI Gateway, but no team is selected. Run lia teams to choose one, then retry.";
const cancelled_message = "Sign-in to Vercel AI Gateway was cancelled.";

/// How a sign-in ended, as its `authenticate` is answered.
const Outcome = union(enum) {
    /// A saved sign-in with a team, which the profile is switched to.
    signed_in,
    /// A saved sign-in without a team.
    team_required,
    failed: anyerror,
    cancelled,
};

/// The one sign-in a connection runs at a time, owned by `ServerState.sign_in`.
/// Its worker reads `state.cfg` and writes through `state.writer`, and leaves
/// every other field to the request loop.
pub const Job = struct {
    state: *ServerState,
    /// The auth methods its `AUTH_REQUIRED` answers list, as the request
    /// loop saw them when the sign-in started.
    offer: acp_types.AuthOffer,
    thread: std.Thread = undefined,
    mutex: std.Io.Mutex = .init,
    /// The `authenticate` request this sign-in answers, owned; null once it
    /// is answered. Guarded by `mutex`.
    waiting: ?jsonrpc.RequestId,
    /// Set under `mutex` once the outcome is known, before it is written.
    finished: std.atomic.Value(bool) = .init(false),
    stop: std.atomic.Value(bool) = .init(false),
    /// Read only after `finished`.
    signed_in: bool = false,

    fn alloc(self: *const Job) Allocator {
        return self.state.alloc;
    }

    fn run(self: *Job) void {
        const outcome = self.savedSignIn() orelse self.newSignIn();
        self.finish(outcome);
    }

    /// The saved `lia login`, unless only a new sign-in can replace it.
    fn savedSignIn(self: *Job) ?Outcome {
        var credential = (credentials.loadLiaLoginCredential(self.alloc(), self.state.cfg.gateway_provider.oauth_transport) catch |err| {
            if (err == error.OutOfMemory) return .{ .failed = err };
            const failure = auth_runtime.classifyCredentialFailure(.fx_login, err);
            debug_trace.logf("auth", "acp saved sign-in unusable reason={t} err={s}", .{ failure.reason, @errorName(err) });
            return switch (failure.reason) {
                // A rejected refresh token, or a saved sign-in that cannot be
                // read; a new sign-in replaces either, as `lia login` does.
                .invalid_credential, .invalid_storage => null,
                .temporary_unavailable, .persistence_uncertain, .authority_changed => .{ .failed = auth_runtime.preparationError(failure).? },
            };
        }) orelse return null;
        defer credential.deinit(self.alloc());
        // A new sign-in would not choose a team either.
        if (credential.gatewayTeam() == null) return .team_required;
        self.switchProfile();
        return .signed_in;
    }

    fn newSignIn(self: *Job) Outcome {
        var runtime: login_flow.SignInRuntime = .{};
        defer runtime.deinit(self.alloc());
        const started = runtime.start(self.alloc(), self.state.cfg.gateway_provider.oauth_transport) catch |err| return .{ .failed = err };
        if (!started) return .{ .failed = error.SignInAlreadyRunning };
        while (true) {
            if (self.stop.load(.seq_cst)) {
                _ = runtime.cancel(self.alloc());
                return .cancelled;
            }
            if (runtime.takeBrowserPending()) self.announce(runtime.snapshot());
            switch (runtime.pollTransition(self.alloc())) {
                .none => io_mod.sleep(poll_ms * std.time.ns_per_ms),
                .succeeded => |completion| {
                    var owned = completion;
                    defer owned.deinit(self.alloc());
                    return self.complete(&owned.vercel);
                },
                .failed => |err| return .{ .failed = err },
                .cancelled => return .cancelled,
            }
        }
    }

    /// Saves the team when the account has exactly one, as `lia login` does
    /// without asking. With several, the session keeps none until `lia teams`.
    fn complete(self: *Job, selection: *const login_flow.TeamSelection) Outcome {
        switch (selection.teams.items.len) {
            // `completeSignIn` reads a failed team request as no teams.
            0 => return .{ .failed = error.NoTeams },
            1 => {
                var team = selection.select(self.alloc(), 0) catch |err| {
                    debug_trace.logf("auth", "acp sign-in team selection failed err={s}", .{@errorName(err)});
                    return .{ .failed = if (err == error.OutOfMemory) err else error.TeamSaveFailed };
                };
                team.deinit(self.alloc());
            },
            else => return .team_required,
        }
        self.switchProfile();
        return .signed_in;
    }

    /// Points the profile at the saved sign-in, as `lia login` does after
    /// signing in. A failure is reported on stderr; this connection uses the
    /// sign-in either way.
    fn switchProfile(self: *Job) void {
        const cfg = &self.state.cfg;
        const switched = provider_activation.activateProviderSelection(self.alloc(), .{
            .auth_mode = cfg.auth_mode,
            .default_model = cfg.default_model,
            .models_path = cfg.gateway_models_path,
            .gateway_provider = cfg.gateway_provider,
            .provider_set = cfg.provider_set,
            .secret_store = cfg.secret_store,
            .url_opener = cfg.url_opener,
        }, stderr_output, .gateway, .provider_login, .fx_login) catch |err| blk: {
            debug_trace.logf("auth", "acp sign-in profile switch failed err={s}", .{@errorName(err)});
            break :blk false;
        };
        if (!switched) debug_trace.logf("auth", "acp sign-in left the saved profile unchanged", .{});
    }

    /// Prints the sign-in page and code to stderr and opens the page. Without
    /// a browser, answers the waiting `authenticate` with them at once, and
    /// the sign-in goes on for the next `authenticate` to wait on.
    fn announce(self: *Job, flow: login_flow.SignInSnapshot) void {
        const url = flow.verification_uri_complete orelse flow.verification_uri;
        const text = std.mem.concat(self.alloc(), u8, &.{ "Open ", url, "\nCode: ", flow.user_code, "\n" }) catch |err| {
            debug_trace.logf("auth", "acp sign-in announcement skipped err={s}", .{@errorName(err)});
            return;
        };
        defer self.alloc().free(text);
        writeStderr(null, text) catch {};
        if (io_mod.getenv("LIA_NO_OPEN_BROWSER") == null) {
            if (self.state.cfg.url_opener.open(self.alloc(), url) catch false) return;
            debug_trace.logf("auth", "acp sign-in could not open the browser", .{});
        }
        const id = self.takeWaiting() orelse return;
        defer freeRequestId(self.alloc(), id);
        self.writeCodeRequired(id, url, flow.user_code) catch |err| {
            debug_trace.logf("auth", "acp sign-in code answer failed err={s}", .{@errorName(err)});
        };
    }

    fn writeCodeRequired(self: *Job, id: jsonrpc.RequestId, url: []const u8, code: []const u8) !void {
        const message = try self.alloc().print(
            "Sign in to Vercel AI Gateway: open {s} and enter the code {s}. Retry once it is approved.",
            .{ url, code },
        );
        defer self.alloc().free(message);
        try self.writeAuthRequired(id, message);
    }

    fn writeAuthRequired(self: *Job, id: jsonrpc.RequestId, message: []const u8) !void {
        try self.state.writer.send(self.alloc(), try server.buildAuthRequired(self.alloc(), id, .{
            .message = message,
            .offer = self.offer,
        }));
    }

    fn takeWaiting(self: *Job) ?jsonrpc.RequestId {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        const id = self.waiting;
        self.waiting = null;
        return id;
    }

    fn finish(self: *Job, outcome: Outcome) void {
        self.mutex.lockUncancelable(io_mod.getIo());
        self.signed_in = outcome == .signed_in;
        self.finished.store(true, .seq_cst);
        const waiting = self.waiting;
        self.waiting = null;
        self.mutex.unlock(io_mod.getIo());
        const id = waiting orelse return;
        defer freeRequestId(self.alloc(), id);
        self.answer(id, outcome) catch |err| {
            debug_trace.logf("auth", "acp sign-in answer failed err={s}", .{@errorName(err)});
        };
    }

    fn answer(self: *Job, id: jsonrpc.RequestId, outcome: Outcome) !void {
        switch (outcome) {
            .signed_in => try self.state.writer.writeResponse(self.alloc(), id, "{}"),
            .team_required => try self.writeAuthRequired(id, team_required_message),
            .failed => |err| {
                debug_trace.logf("auth", "acp sign-in failed err={s}", .{@errorName(err)});
                try self.state.writer.writeError(self.alloc(), id, .{
                    .code = ErrorCode.invalid_request,
                    .message = signInFailureMessage(err),
                });
            },
            .cancelled => try self.state.writer.writeError(self.alloc(), id, .{
                .code = ErrorCode.request_cancelled,
                .message = cancelled_message,
            }),
        }
    }

    const Join = enum { waiting, busy, finished };

    /// Makes `id` the request this sign-in answers, unless one already is.
    fn join(self: *Job, id: ?jsonrpc.RequestId) Allocator.Error!Join {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        if (self.finished.load(.seq_cst)) return .finished;
        if (self.waiting != null) return .busy;
        self.waiting = try dupeRequestId(self.alloc(), id);
        return .waiting;
    }
};

/// Writes activation's report to stderr; stdout carries JSON-RPC.
const stderr_output: provider_activation.Output = .{
    .write_stdout = writeStderr,
    .write_stderr = writeStderr,
};

fn writeStderr(_: ?*anyopaque, text: []const u8) anyerror!void {
    try std.Io.File.stderr().writeStreamingAll(io_mod.getIo(), text);
}

/// Answers `authenticate` with `lia-login` on a Gateway connection: `{}` once
/// a credential is usable, otherwise after the saved `lia login` is adopted
/// or a new browser sign-in resolves. Joins a sign-in already running.
pub fn authenticate(state: *ServerState, alloc: Allocator, id: ?jsonrpc.RequestId) !void {
    reap(state, false);
    if (state.sign_in) |job| switch (try job.join(id)) {
        .waiting => return,
        .busy => return state.writer.writeError(alloc, id, .{
            .code = ErrorCode.invalid_request,
            .message = signInFailureMessage(error.SignInAlreadyRunning),
        }),
        .finished => reap(state, true),
    };
    const pending = server.refreshPendingAuth(state) catch |err| switch (err) {
        // A new sign-in replaces a saved one that cannot be read.
        error.CredentialStorageUnavailable => .unavailable,
        error.CredentialTemporarilyUnavailable,
        error.CredentialRefreshPersistenceUncertain,
        error.CredentialAuthorityChanged,
        => return state.writer.writeError(alloc, id, .{
            .code = ErrorCode.invalid_request,
            .message = signInFailureMessage(err),
        }),
        else => return err,
    };
    // `.deferred`, while a turn runs, confirms the sign-in too.
    if (pending != .unavailable) return state.writer.writeResponse(alloc, id, "{}");
    if (signInBlock()) |block| return state.writer.writeError(alloc, id, .{
        .code = ErrorCode.invalid_request,
        .message = block.reason(),
    });
    try start(state, id);
}

fn start(state: *ServerState, id: ?jsonrpc.RequestId) !void {
    const job = try state.alloc.create(Job);
    errdefer state.alloc.destroy(job);
    job.* = .{
        .state = state,
        .offer = server.authOffer(state),
        .waiting = try dupeRequestId(state.alloc, id),
    };
    errdefer if (job.waiting) |owned| freeRequestId(state.alloc, owned);
    job.thread = try std.Thread.spawn(.{}, Job.run, .{job});
    state.sign_in = job;
}

/// Releases a finished sign-in, or with `wait`, waits for it to finish. A
/// saved sign-in becomes this connection's Gateway credential, adopted as
/// `refreshPendingAuth` allows while a turn runs.
pub fn reap(state: *ServerState, wait: bool) void {
    if (comptime host_target.is_wasm) return;
    const job = state.sign_in orelse return;
    if (!wait and !job.finished.load(.seq_cst)) return;
    job.thread.join();
    const signed_in = job.signed_in;
    state.alloc.destroy(job);
    state.sign_in = null;
    if (!signed_in) return;
    state.gateway_source_preference = .fx_login;
    _ = server.refreshPendingAuth(state) catch |err| {
        debug_trace.logf("auth", "acp sign-in adoption failed err={s}", .{@errorName(err)});
    };
}

/// Stops the sign-in that would answer `requested`. Its `authenticate` is
/// answered as cancelled. False when no sign-in answers that request.
pub fn cancelRequest(state: *ServerState, requested: jsonrpc.RequestId) bool {
    if (comptime host_target.is_wasm) return false;
    const job = state.sign_in orelse return false;
    job.mutex.lockUncancelable(io_mod.getIo());
    const matches = if (job.waiting) |id| server.requestIdsEqual(id, requested) else false;
    job.mutex.unlock(io_mod.getIo());
    if (matches) job.stop.store(true, .seq_cst);
    return matches;
}

/// Stops the connection's sign-in when the client goes away, and waits for
/// its worker. A sign-in still polling answers its `authenticate` as
/// cancelled, while the channel still takes it.
pub fn stop(state: *ServerState) void {
    if (comptime host_target.is_wasm) return;
    const job = state.sign_in orelse return;
    job.stop.store(true, .seq_cst);
    job.thread.join();
    state.alloc.destroy(job);
    state.sign_in = null;
}

/// Why this machine cannot save a `lia login` sign-in, or null when it can.
pub fn signInBlock() ?acp_types.SignInBlock {
    if (comptime host_target.is_wasm) return null;
    oauth_session.requireSignInStorage() catch {
        const home = io_mod.homeDir() orelse return .home_unavailable;
        var home_dir = std.Io.Dir.openDirAbsolute(io_mod.getIo(), home, .{}) catch return .home_unavailable;
        home_dir.close(io_mod.getIo());
        return .storage_unusable;
    };
    return null;
}

fn signInFailureMessage(err: anyerror) []const u8 {
    return switch (err) {
        error.AccessDenied => "Sign-in to Vercel AI Gateway was denied.",
        error.ExpiredToken => "Vercel says the sign-in code expired before it was approved. Try again.",
        error.LoginTimedOut => "The sign-in code expired before it was approved. Try again.",
        error.SignInAlreadyRunning => "A Vercel AI Gateway sign-in is already waiting for approval. Finish it in the browser, then retry.",
        error.CredentialPersistenceFailed => "Signed in to Vercel AI Gateway, but lia could not save the sign-in. Check that ~/.lia is writable, then retry.",
        error.TeamSaveFailed => "Signed in to Vercel AI Gateway, but lia could not save its team. Check that ~/.lia is writable, then retry.",
        error.NoTeams => "Signed in to Vercel AI Gateway, but its teams could not be listed. Check the network connection, then retry.",
        error.CredentialTemporarilyUnavailable => "The saved Vercel AI Gateway sign-in could not be refreshed. Check the network connection, then retry.",
        error.CredentialStorageUnavailable,
        error.CredentialRefreshPersistenceUncertain,
        error.CredentialAuthorityChanged,
        => auth_runtime.preparationFailureNotice(err).?,
        error.OutOfMemory => "lia ran out of memory during the Vercel AI Gateway sign-in.",
        // The device-code and token requests fail this way when Vercel
        // cannot be reached or answers with something else.
        else => "Could not reach Vercel to sign in to AI Gateway. Check the network connection, then retry.",
    };
}

fn dupeRequestId(alloc: Allocator, id: ?jsonrpc.RequestId) Allocator.Error!jsonrpc.RequestId {
    return switch (id orelse .null) {
        .string => |value| .{ .string = try alloc.dupe(u8, value) },
        else => |value| value,
    };
}

fn freeRequestId(alloc: Allocator, id: jsonrpc.RequestId) void {
    if (id == .string) alloc.free(id.string);
}

/// Vercel's issuer, device, token and team endpoints, answering as the fields
/// say. The sign-in workers call it, so what a test reads back is atomic.
const FakeVercel = struct {
    /// Until set, the token endpoint answers `authorization_pending`.
    approved: std.atomic.Value(bool) = .init(true),
    device_expires_in: u32 = 60,
    token_disposition: oauth_transport.Disposition = .accepted,
    token_body: []const u8 = "{\"access_token\":\"signed-in-access\",\"refresh_token\":\"signed-in-refresh\"," ++
        "\"expires_in\":3600,\"scope\":\"openid offline_access\",\"token_type\":\"Bearer\"}",
    /// A refresh of a saved sign-in is rejected as a revoked refresh token.
    refresh_body: []const u8 = "{\"error\":\"invalid_grant\"}",
    /// Every request fails with this instead of reaching Vercel.
    request_error: ?anyerror = null,
    teams_body: []const u8 = "{\"teams\":[{\"id\":\"team_solo\",\"slug\":\"solo\",\"name\":\"Solo\"}]}",
    device_requests: std.atomic.Value(usize) = .init(0),
    token_polls: std.atomic.Value(usize) = .init(0),
    refresh_requests: std.atomic.Value(usize) = .init(0),
    opened: std.atomic.Value(bool) = .init(false),

    const issuer = "https://vercel.com";
    const verification_url = issuer ++ "/oauth/device?code=USER-CODE";

    fn transport(self: *FakeVercel) oauth_transport.Provider {
        return .{ .context = self, .execute_fn = execute };
    }

    fn opener(self: *FakeVercel) host.UrlOpener {
        return .{ .context = self, .open_fn = open };
    }

    fn execute(raw: ?*anyopaque, alloc: Allocator, request: oauth_transport.Request) !oauth_transport.Response {
        const self: *FakeVercel = @ptrCast(@alignCast(raw.?));
        if (self.request_error) |err| return err;
        const payload = request.payload orelse "";
        if (std.mem.eql(u8, request.url, issuer ++ "/.well-known/openid-configuration")) {
            return accepted(alloc, "{\"issuer\":\"" ++ issuer ++ "\",\"device_authorization_endpoint\":\"" ++ issuer ++ "/oauth/device\"," ++
                "\"token_endpoint\":\"" ++ issuer ++ "/oauth/token\"}");
        }
        if (std.mem.eql(u8, request.url, issuer ++ "/oauth/device")) {
            _ = self.device_requests.fetchAdd(1, .seq_cst);
            return .{ .disposition = .accepted, .body = try alloc.print(
                "{{\"device_code\":\"device\",\"user_code\":\"USER-CODE\",\"verification_uri\":\"{s}/oauth/device\"," ++
                    "\"verification_uri_complete\":\"{s}\",\"expires_in\":{d},\"interval\":1}}",
                .{ issuer, verification_url, self.device_expires_in },
            ) };
        }
        if (std.mem.eql(u8, request.url, issuer ++ "/oauth/token")) {
            if (std.mem.find(u8, payload, "grant_type=refresh_token") != null) {
                _ = self.refresh_requests.fetchAdd(1, .seq_cst);
                return .{ .disposition = .rejected, .body = try alloc.dupe(u8, self.refresh_body) };
            }
            _ = self.token_polls.fetchAdd(1, .seq_cst);
            if (!self.approved.load(.seq_cst)) return .{ .disposition = .rejected, .body = try alloc.dupe(u8, "{\"error\":\"authorization_pending\"}") };
            return .{ .disposition = self.token_disposition, .body = try alloc.dupe(u8, self.token_body) };
        }
        if (std.mem.eql(u8, request.url, "https://api.vercel.com/v2/teams")) return accepted(alloc, self.teams_body);
        return error.UnexpectedOAuthRequest;
    }

    fn accepted(alloc: Allocator, body: []const u8) !oauth_transport.Response {
        return .{ .disposition = .accepted, .body = try alloc.dupe(u8, body) };
    }

    fn open(raw: ?*anyopaque, _: Allocator, url: []const u8) host.UrlOpenError!bool {
        const self: *FakeVercel = @ptrCast(@alignCast(raw.?));
        if (!std.mem.eql(u8, url, verification_url)) return false;
        self.opened.store(true, .seq_cst);
        return true;
    }
};

/// A Gateway catalog with one model, so switching the profile can pick it.
fn fetchOneModel(_: ?*anyopaque, alloc: Allocator, _: model_catalog.FetchInput) Allocator.Error!model_catalog.ProviderResult {
    var entries: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &entries);
    const id = try alloc.dupe(u8, "openai/gpt-5.5");
    errdefer alloc.free(id);
    const model_type = try alloc.dupe(u8, "language");
    errdefer alloc.free(model_type);
    try entries.append(alloc, .{ .id = id, .model_type = model_type });
    return .{ .catalog = entries };
}

/// Every frame the connection writes, from any thread.
const Frames = struct {
    alloc: Allocator,
    mutex: std.Io.Mutex = .init,
    list: std.ArrayList([]u8) = .empty,

    fn write(raw: ?*anyopaque, frame: []const u8) anyerror!void {
        const self: *Frames = @ptrCast(@alignCast(raw.?));
        const copy = try self.alloc.dupe(u8, frame);
        errdefer self.alloc.free(copy);
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        try self.list.append(self.alloc, copy);
    }

    fn deinit(self: *Frames) void {
        for (self.list.items) |frame| self.alloc.free(frame);
        self.list.deinit(self.alloc);
    }

    /// The frame answering request `id`, parsed; the caller deinits it.
    fn answer(self: *Frames, id: i64) !?std.json.Parsed(std.json.Value) {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        for (self.list.items) |frame| {
            const parsed = try std.json.parseFromSlice(std.json.Value, self.alloc, frame, .{});
            const frame_id = parsed.value.object.get("id");
            if (frame_id != null and frame_id.? == .integer and frame_id.?.integer == id) return parsed;
            parsed.deinit();
        }
        return null;
    }

    /// Waits up to 10 s for the answer to request `id`.
    fn waitFor(self: *Frames, id: i64) !std.json.Parsed(std.json.Value) {
        const deadline = io_mod.awakeMilliTimestamp() + 10_000;
        while (io_mod.awakeMilliTimestamp() < deadline) {
            if (try self.answer(id)) |parsed| return parsed;
            io_mod.sleep(10 * std.time.ns_per_ms);
        }
        return error.TestAnswerMissing;
    }
};

fn waitForCount(counter: *const std.atomic.Value(usize), at_least: usize) !void {
    const deadline = io_mod.awakeMilliTimestamp() + 10_000;
    while (counter.load(.seq_cst) < at_least) {
        if (io_mod.awakeMilliTimestamp() >= deadline) return error.TestCountNotReached;
        io_mod.sleep(10 * std.time.ns_per_ms);
    }
}

/// Points fd 1 and fd 2 at files until `end`, so a test reads what reached
/// stdout, the JSON-RPC channel, and stderr. Ends before a test asserts, so a
/// failure still reaches the real stderr.
const StdStreamTrap = struct {
    saved_stdout: std.c.fd_t,
    saved_stderr: std.c.fd_t,
    stdout_file: std.Io.File,
    stderr_file: std.Io.File,
    active: bool = true,

    fn begin(dir: std.Io.Dir) !StdStreamTrap {
        const stdout_file = try dir.createFile(io_mod.getIo(), "stdout.txt", .{ .read = true });
        errdefer stdout_file.close(io_mod.getIo());
        const stderr_file = try dir.createFile(io_mod.getIo(), "stderr.txt", .{ .read = true });
        errdefer stderr_file.close(io_mod.getIo());
        const saved_stdout = std.c.dup(1);
        if (saved_stdout < 0) return error.TestStreamTrapFailed;
        errdefer _ = std.c.close(saved_stdout);
        const saved_stderr = std.c.dup(2);
        if (saved_stderr < 0) return error.TestStreamTrapFailed;
        errdefer _ = std.c.close(saved_stderr);
        if (std.c.dup2(stdout_file.handle, 1) < 0) return error.TestStreamTrapFailed;
        if (std.c.dup2(stderr_file.handle, 2) < 0) {
            _ = std.c.dup2(saved_stdout, 1);
            return error.TestStreamTrapFailed;
        }
        return .{ .saved_stdout = saved_stdout, .saved_stderr = saved_stderr, .stdout_file = stdout_file, .stderr_file = stderr_file };
    }

    fn end(self: *StdStreamTrap) void {
        if (!self.active) return;
        self.active = false;
        _ = std.c.dup2(self.saved_stdout, 1);
        _ = std.c.dup2(self.saved_stderr, 2);
        _ = std.c.close(self.saved_stdout);
        _ = std.c.close(self.saved_stderr);
        self.stdout_file.close(io_mod.getIo());
        self.stderr_file.close(io_mod.getIo());
    }
};

/// A temporary HOME without a keychain, named by the process environment
/// until `deinit`.
const SignInTestHome = struct {
    alloc: Allocator,
    tmp: std.testing.TmpDir,
    home: []u8,
    env: std.process.Environ.Map,

    const Options = struct {
        open_browser: bool = true,
        /// HOME names a directory that does not exist.
        missing: bool = false,
    };

    fn install(alloc: Allocator, options: Options) !*SignInTestHome {
        const self = try alloc.create(SignInTestHome);
        errdefer alloc.destroy(self);
        self.alloc = alloc;
        self.tmp = std.testing.tmpDir(.{});
        errdefer self.tmp.cleanup();
        self.home = try io_mod.dirRealpathAlloc(alloc, self.tmp.dir, ".");
        errdefer alloc.free(self.home);
        if (options.missing) {
            const missing = try std.Io.Dir.path.join(alloc, &.{ self.home, "missing-home" });
            alloc.free(self.home);
            self.home = missing;
        }
        self.env = std.process.Environ.Map.init(alloc);
        errdefer self.env.deinit();
        try self.env.put("HOME", self.home);
        try self.env.put("LIA_DISABLE_KEYCHAIN", "1");
        if (!options.open_browser) try self.env.put("LIA_NO_OPEN_BROWSER", "1");
        io_mod.setEnvironMap(&self.env);
        return self;
    }

    fn deinit(self: *SignInTestHome) void {
        io_mod.resetEnvironForTest();
        self.env.deinit();
        self.alloc.free(self.home);
        self.tmp.cleanup();
        self.alloc.destroy(self);
    }

    /// The file at `name` under HOME; the caller frees it.
    fn read(self: *SignInTestHome, name: []const u8) ![]u8 {
        var file = try self.tmp.dir.openFile(io_mod.getIo(), name, .{});
        defer file.close(io_mod.getIo());
        return io_mod.readFileToEnd(self.alloc, &file, 64 * 1024);
    }

    fn writePrivate(self: *SignInTestHome, name: []const u8, data: []const u8, mode: u32) !void {
        try self.tmp.dir.createDirPath(io_mod.getIo(), ".lia");
        try self.tmp.dir.writeFile(io_mod.getIo(), .{ .sub_path = name, .data = data, .flags = .{ .permissions = .fromMode(mode) } });
    }

    /// Saves a `lia login` for `team`, expiring at `expires_at_ms`.
    fn saveLogin(self: *SignInTestHome, team: ?[]const u8, expires_at_ms: i64) !void {
        try oauth_session.saveNewSession(self.alloc, .{
            .issuer = @constCast(FakeVercel.issuer),
            .client_id = @constCast("client"),
            .access_token = @constCast("saved-access"),
            .refresh_token = @constCast("saved-refresh"),
            .expires_at_ms = expires_at_ms,
            .scope = @constCast("openid offline_access"),
            .token_type = @constCast("Bearer"),
            .team_id = if (team) |value| @constCast(value) else null,
        });
    }
};

/// A Gateway connection, initialized and awaiting sign-in, whose sign-in
/// requests reach `fake`. Free it with `deinit`, which is also how the
/// connection ends when the client goes away.
fn signInTestState(alloc: Allocator, frames: *Frames, fake: *FakeVercel) ServerState {
    var cfg = sessions.acpSessionTestConfig();
    cfg.gateway_provider.oauth_transport = fake.transport();
    cfg.url_opener = fake.opener();
    cfg.provider_set = provider_set.gateway_only(.{ .model_catalog = .{ .context = null, .fetch_fn = fetchOneModel } });
    return .{
        .alloc = alloc,
        .cfg = cfg,
        .writer = jsonrpc.Writer.initCallback(frames, Frames.write),
        .initialized = true,
        .provider = .gateway,
        .auth_pending = true,
    };
}

fn dispatchForTest(state: *ServerState, id: i64, method: []const u8, params: []const u8) !void {
    var msg = jsonrpc.Message{ .id = .{ .integer = id }, .method = method, .params_raw = params };
    try server.dispatch(state, state.alloc, &msg);
}

fn authenticateForTest(state: *ServerState, id: i64) !void {
    try dispatchForTest(state, id, "authenticate", "{\"methodId\":\"" ++ acp_types.agent_auth_method_id ++ "\"}");
}

fn expectSignedIn(answer: std.json.Parsed(std.json.Value)) !void {
    const result = answer.value.object.get("result") orelse {
        std.debug.print("answer: {f}\n", .{std.json.fmt(answer.value, .{})});
        return error.TestExpectedSignedIn;
    };
    try std.testing.expectEqual(@as(usize, 0), result.object.count());
}

fn expectError(answer: std.json.Parsed(std.json.Value), code: i64, message: []const u8) !void {
    const err = (answer.value.object.get("error") orelse {
        std.debug.print("answer: {f}\n", .{std.json.fmt(answer.value, .{})});
        return error.TestExpectedError;
    }).object;
    try std.testing.expectEqual(code, err.get("code").?.integer);
    try std.testing.expectEqualStrings(message, err.get("message").?.string);
}

test "lia-login signs in, saves the login, switches the profile to it and adopts it" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    // The profile names a stored API key that is no longer saved.
    try home.writePrivate(".lia/settings.json", "{\"credential_source\":\"stored_key\"}", 0o600);
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = signInTestState(alloc, &frames, &fake);
    defer state.deinit();
    state.gateway_source_preference = .stored_key;

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    // The next request adopts the sign-in.
    try dispatchForTest(&state, 8, "lia/unknown", "{}");
    trap.end();

    try expectSignedIn(answer);
    const stdout_bytes = try home.read("stdout.txt");
    defer alloc.free(stdout_bytes);
    try std.testing.expectEqualStrings("", stdout_bytes);
    const stderr_bytes = try home.read("stderr.txt");
    defer alloc.free(stderr_bytes);
    try std.testing.expect(std.mem.find(u8, stderr_bytes, FakeVercel.verification_url) != null);
    try std.testing.expect(std.mem.find(u8, stderr_bytes, "USER-CODE") != null);
    try std.testing.expect(fake.opened.load(.seq_cst));

    try std.testing.expect(!state.auth_pending);
    try std.testing.expectEqualStrings("signed-in-access", state.api_key);
    try std.testing.expectEqual(types.CredentialSource.fx_login, state.credential_source.?);
    try std.testing.expectEqualStrings("team_solo", state.gateway_team.?);
    const settings = try home.read(".lia/settings.json");
    defer alloc.free(settings);
    try std.testing.expect(std.mem.find(u8, settings, "\"credential_source\":\"fx_login\"") != null);
    const saved = try home.read(".lia/auth.json");
    defer secret.zeroAndFree(alloc, saved);
    try std.testing.expect(std.mem.find(u8, saved, "signed-in-refresh") != null);
}

test "a retry after the sign-in was saved answers {} and switches the profile without a second sign-in" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    {
        var first = signInTestState(alloc, &frames, &fake);
        defer first.deinit();
        var trap = try StdStreamTrap.begin(home.tmp.dir);
        defer trap.end();
        try authenticateForTest(&first, 7);
        const answer = try frames.waitFor(7);
        answer.deinit();
    }
    // The profile still names a stored key, as when switching it failed.
    try home.writePrivate(".lia/settings.json", "{\"credential_source\":\"stored_key\"}", 0o600);
    var state = signInTestState(alloc, &frames, &fake);
    defer state.deinit();
    state.gateway_source_preference = .stored_key;

    try authenticateForTest(&state, 9);
    const answer = try frames.waitFor(9);
    defer answer.deinit();
    try dispatchForTest(&state, 10, "lia/unknown", "{}");

    try expectSignedIn(answer);
    try std.testing.expectEqual(@as(usize, 1), fake.device_requests.load(.seq_cst));
    try std.testing.expect(!state.auth_pending);
    try std.testing.expectEqual(types.CredentialSource.fx_login, state.credential_source.?);
    const settings = try home.read(".lia/settings.json");
    defer alloc.free(settings);
    try std.testing.expect(std.mem.find(u8, settings, "\"credential_source\":\"fx_login\"") != null);
}

test "lia-login with a valid saved login answers {} without signing in" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    try home.saveLogin("team_saved", std.math.maxInt(i64));
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = signInTestState(alloc, &frames, &fake);
    defer state.deinit();

    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();

    try expectSignedIn(answer);
    try std.testing.expect(!state.auth_pending);
    try std.testing.expectEqualStrings("team_saved", state.gateway_team.?);
    try std.testing.expectEqual(@as(usize, 0), fake.device_requests.load(.seq_cst));
    try std.testing.expectEqual(@as(usize, 0), fake.token_polls.load(.seq_cst));
}

test "requests are answered while a sign-in waits, and $/cancel_request ends it as cancelled" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    var fake: FakeVercel = .{ .approved = .init(false) };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = signInTestState(alloc, &frames, &fake);
    defer state.deinit();

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    try waitForCount(&fake.token_polls, 1);
    try dispatchForTest(&state, 8, "lia/unknown", "{}");
    var other = try frames.answer(8);
    defer if (other) |*parsed| parsed.deinit();
    var waiting = try frames.answer(7);
    defer if (waiting) |*parsed| parsed.deinit();
    var cancel = jsonrpc.Message{ .method = "$/cancel_request", .params_raw = "{\"requestId\":7}" };
    try server.dispatchNotification(&state, alloc, &cancel);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    trap.end();

    if (waiting) |early| {
        std.debug.print("answered before the cancel: {f}\n", .{std.json.fmt(early.value, .{})});
        return error.TestAnsweredEarly;
    }
    const other_answer = other orelse return error.TestAnswerMissing;
    try std.testing.expectEqual(@as(i64, ErrorCode.method_not_found), other_answer.value.object.get("error").?.object.get("code").?.integer);
    try expectError(answer, ErrorCode.request_cancelled, cancelled_message);
    try std.testing.expect(state.auth_pending);
    try std.testing.expectError(error.FileNotFound, home.tmp.dir.statFile(io_mod.getIo(), ".lia/auth.json", .{}));
}

test "a client that goes away stops the sign-in and its authenticate is answered as cancelled" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    var fake: FakeVercel = .{ .approved = .init(false) };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = signInTestState(alloc, &frames, &fake);

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    authenticateForTest(&state, 7) catch |err| {
        state.deinit();
        return err;
    };
    waitForCount(&fake.token_polls, 1) catch |err| {
        state.deinit();
        return err;
    };
    // The request loop ends at EOF and releases the connection.
    state.deinit();
    trap.end();

    const answer = (try frames.answer(7)) orelse return error.TestAnswerMissing;
    defer answer.deinit();
    try expectError(answer, ErrorCode.request_cancelled, cancelled_message);
}

test "without a browser, authenticate answers with the sign-in URL and code and the next one waits on that sign-in" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{ .open_browser = false });
    defer home.deinit();
    var fake: FakeVercel = .{ .approved = .init(false) };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = signInTestState(alloc, &frames, &fake);
    defer state.deinit();

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const code_answer = try frames.waitFor(7);
    defer code_answer.deinit();
    try authenticateForTest(&state, 8);
    const second_waits = (try frames.answer(8)) == null;
    try authenticateForTest(&state, 9);
    const third = try frames.waitFor(9);
    defer third.deinit();
    fake.approved.store(true, .seq_cst);
    const signed_in = try frames.waitFor(8);
    defer signed_in.deinit();
    try dispatchForTest(&state, 10, "lia/unknown", "{}");
    trap.end();

    const err = code_answer.value.object.get("error").?.object;
    try std.testing.expectEqual(@as(i64, ErrorCode.auth_required), err.get("code").?.integer);
    const message = err.get("message").?.string;
    try std.testing.expect(std.mem.find(u8, message, FakeVercel.verification_url) != null);
    try std.testing.expect(std.mem.find(u8, message, "USER-CODE") != null);
    try std.testing.expect(err.get("data").?.object.get("authMethods").?.array.items.len > 0);
    const stderr_bytes = try home.read("stderr.txt");
    defer alloc.free(stderr_bytes);
    try std.testing.expect(std.mem.find(u8, stderr_bytes, "USER-CODE") != null);
    try std.testing.expect(!fake.opened.load(.seq_cst));

    try std.testing.expect(second_waits);
    try expectError(third, ErrorCode.invalid_request, signInFailureMessage(error.SignInAlreadyRunning));
    try expectSignedIn(signed_in);
    try std.testing.expectEqual(@as(usize, 1), fake.device_requests.load(.seq_cst));
    try std.testing.expect(!state.auth_pending);
}

test "a sign-in with several teams is saved but asks for lia teams, and a retry runs no second sign-in" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    var fake: FakeVercel = .{ .teams_body = "{\"teams\":[{\"id\":\"team_a\",\"slug\":\"a\",\"name\":\"A\"}," ++
        "{\"id\":\"team_b\",\"slug\":\"b\",\"name\":\"B\"}]}" };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = signInTestState(alloc, &frames, &fake);
    defer state.deinit();

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    try authenticateForTest(&state, 8);
    const retry = try frames.waitFor(8);
    defer retry.deinit();
    trap.end();

    try expectError(answer, ErrorCode.auth_required, team_required_message);
    try expectError(retry, ErrorCode.auth_required, team_required_message);
    try std.testing.expectEqual(@as(usize, 1), fake.device_requests.load(.seq_cst));
    try std.testing.expect(state.auth_pending);
    const saved = try home.read(".lia/auth.json");
    defer secret.zeroAndFree(alloc, saved);
    try std.testing.expect(std.mem.find(u8, saved, "signed-in-refresh") != null);
}

test "a saved login whose refresh token is revoked is replaced by a new sign-in" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    try home.saveLogin("team_saved", 0);
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = signInTestState(alloc, &frames, &fake);
    defer state.deinit();

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    try dispatchForTest(&state, 8, "lia/unknown", "{}");
    trap.end();

    try expectSignedIn(answer);
    try std.testing.expect(fake.refresh_requests.load(.seq_cst) >= 1);
    try std.testing.expectEqual(@as(usize, 1), fake.device_requests.load(.seq_cst));
    try std.testing.expectEqualStrings("team_solo", state.gateway_team.?);
}

test "a saved login that cannot be read is replaced by a new sign-in" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    try home.writePrivate(".lia/auth.json", "not a session", 0o600);
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = signInTestState(alloc, &frames, &fake);
    defer state.deinit();

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    trap.end();

    try expectSignedIn(answer);
    try std.testing.expectEqual(@as(usize, 1), fake.device_requests.load(.seq_cst));
}

test "a failed sign-in answers with what failed" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const Case = struct { fake: FakeVercel, saved_expired_login: bool = false, message: []const u8 };
    const cases = [_]Case{
        .{ .fake = .{ .token_disposition = .rejected, .token_body = "{\"error\":\"access_denied\"}" }, .message = signInFailureMessage(error.AccessDenied) },
        .{ .fake = .{ .token_disposition = .rejected, .token_body = "{\"error\":\"expired_token\"}" }, .message = signInFailureMessage(error.ExpiredToken) },
        .{ .fake = .{ .approved = .init(false), .device_expires_in = 1 }, .message = signInFailureMessage(error.LoginTimedOut) },
        .{ .fake = .{ .request_error = error.ConnectionRefused }, .message = signInFailureMessage(error.ConnectionRefused) },
        .{ .fake = .{ .teams_body = "{}" }, .message = signInFailureMessage(error.NoTeams) },
        .{ .fake = .{ .refresh_body = "{\"error\":\"temporarily_unavailable\"}" }, .saved_expired_login = true, .message = signInFailureMessage(error.CredentialTemporarilyUnavailable) },
    };
    for (cases) |case| {
        const home = try SignInTestHome.install(alloc, .{});
        defer home.deinit();
        if (case.saved_expired_login) try home.saveLogin("team_saved", 0);
        var fake = case.fake;
        var frames: Frames = .{ .alloc = alloc };
        defer frames.deinit();
        var state = signInTestState(alloc, &frames, &fake);
        defer state.deinit();

        var trap = try StdStreamTrap.begin(home.tmp.dir);
        defer trap.end();
        try authenticateForTest(&state, 7);
        const answer = try frames.waitFor(7);
        defer answer.deinit();
        trap.end();

        try expectError(answer, ErrorCode.invalid_request, case.message);
        try std.testing.expect(state.auth_pending);
    }
}

test "each sign-in failure has its own message" {
    const errors = [_]anyerror{
        error.AccessDenied,                          error.ExpiredToken,                     error.LoginTimedOut,
        error.SignInAlreadyRunning,                  error.CredentialPersistenceFailed,      error.TeamSaveFailed,
        error.NoTeams,                               error.CredentialTemporarilyUnavailable, error.CredentialStorageUnavailable,
        error.CredentialRefreshPersistenceUncertain, error.CredentialAuthorityChanged,       error.OutOfMemory,
        error.ConnectionRefused,
    };
    for (errors, 0..) |err, i| {
        for (errors[i + 1 ..]) |other| {
            std.testing.expect(!std.mem.eql(u8, signInFailureMessage(err), signInFailureMessage(other))) catch |failure| {
                std.debug.print("{s} and {s} share a message\n", .{ @errorName(err), @errorName(other) });
                return failure;
            };
        }
    }
}

test "storage that cannot save a sign-in is named in the offer and the authenticate answer, and no sign-in runs" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const Case = struct { home: SignInTestHome.Options, insecure_login: bool = false, block: acp_types.SignInBlock };
    const cases = [_]Case{
        .{ .home = .{}, .insecure_login = true, .block = .storage_unusable },
        .{ .home = .{ .missing = true }, .block = .home_unavailable },
    };
    for (cases) |case| {
        const home = try SignInTestHome.install(alloc, case.home);
        defer home.deinit();
        if (case.insecure_login) try home.writePrivate(".lia/auth.json", "{}", 0o644);
        var fake: FakeVercel = .{};
        var frames: Frames = .{ .alloc = alloc };
        defer frames.deinit();
        var state = signInTestState(alloc, &frames, &fake);
        defer state.deinit();

        try authenticateForTest(&state, 7);
        const answer = (try frames.answer(7)) orelse return error.TestAnswerMissing;
        defer answer.deinit();

        try expectError(answer, ErrorCode.invalid_request, case.block.reason());
        try std.testing.expectEqual(@as(?acp_types.SignInBlock, case.block), server.authOffer(&state).sign_in_block);
        var offer: std.Io.Writer.Allocating = .init(alloc);
        defer offer.deinit();
        try acp_types.writeAuthMethods(&offer.writer, server.authOffer(&state));
        try std.testing.expect(std.mem.find(u8, offer.written(), "sign-in unavailable") != null);
        try std.testing.expect(std.mem.find(u8, offer.written(), "Sign in to Vercel AI Gateway") == null);
        try std.testing.expectEqual(@as(usize, 0), fake.device_requests.load(.seq_cst));
        try std.testing.expect(state.sign_in == null);
    }
}
