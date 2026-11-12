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
const config_runtime = @import("../core/config/config_runtime.zig");
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
const session_adapter = @import("../core/session/session_adapter.zig");

const Allocator = std.mem.Allocator;
const ErrorCode = jsonrpc.ErrorCode;
const ServerState = server.ServerState;

const poll_ms: u64 = 100;
pub const team_required_message = "Signed in to Vercel AI Gateway, but no team is selected. Run lia teams to choose one, then retry.";
/// How long a failure nobody was told of stays worth reporting when the
/// sign-in's device code gave no lifetime.
const kept_failure_default_ms: i64 = 15 * 60 * 1000;
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

/// A sign-in failure no `authenticate` was waiting for, kept for the next one.
pub const KeptFailure = struct {
    err: anyerror,
    /// Wall-clock milliseconds after which it is dropped instead of reported.
    expires_at_ms: i64,

    fn expired(self: KeptFailure, now_ms: i64) bool {
        return now_ms >= self.expires_at_ms;
    }
};

/// A failure stays for as long as the sign-in's device code lives, from when
/// it was kept; 15 minutes when no lifetime is known.
fn keptUntil(now_ms: i64, code_lifetime_s: i64) i64 {
    const lifetime_ms = if (code_lifetime_s > 0) std.math.mul(i64, code_lifetime_s, 1000) catch std.math.maxInt(i64) else kept_failure_default_ms;
    return now_ms +| lifetime_ms;
}

/// The one sign-in a connection runs at a time, owned by `ServerState.sign_in`.
/// Its worker reads `state.cfg` and writes through `state.writer`, and leaves
/// every other field to the request loop.
pub const Job = struct {
    state: *ServerState,
    /// The auth methods its `AUTH_REQUIRED` answers list, as the request
    /// loop saw them when the sign-in started.
    offer: acp_types.AuthOffer,
    /// Whose settings the profile switch reads, owned: the active session's
    /// workspace, else the connection's.
    workspace_root: []u8,
    thread: std.Thread = undefined,
    mutex: std.Io.Mutex = .init,
    /// The `authenticate` request this sign-in answers, owned; null once it
    /// is answered. Guarded by `mutex`.
    waiting: ?jsonrpc.RequestId,
    /// Set under `mutex` once the outcome is known, before it is written.
    finished: std.atomic.Value(bool) = .init(false),
    /// Set when the client cancels the waiting request or goes away.
    stop: std.atomic.Value(bool) = .init(false),
    /// Read only after `finished`.
    signed_in: bool = false,
    /// A failure no request was waiting for, as the next `lia-login` hears
    /// it. Read only after `finished`.
    unreported: ?KeptFailure = null,
    /// Seconds the device code lives, once known. Written and read by the
    /// worker alone.
    code_lifetime_s: i64 = 0,

    fn alloc(self: *const Job) Allocator {
        return self.state.alloc;
    }

    fn destroy(self: *Job) void {
        const owner = self.alloc();
        owner.free(self.workspace_root);
        owner.destroy(self);
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
            if (runtime.takeBrowserPending() and !self.stop.load(.seq_cst)) self.announce(runtime.snapshot());
            // A stop that loses to the approval finds the sign-in already
            // saved; it is finished below like any other, so the saved login
            // gets its team and the profile.
            if (self.stop.load(.seq_cst) and runtime.cancel(self.alloc())) return .cancelled;
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
            .workspace_root = self.workspace_root,
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
        self.code_lifetime_s = flow.expires_in;
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
        const waiting = self.waiting;
        self.waiting = null;
        // A stopped sign-in's request was already answered as cancelled.
        if (waiting == null and outcome == .failed and !self.stop.load(.seq_cst)) self.unreported = .{ .err = outcome.failed, .expires_at_ms = keptUntil(io_mod.milliTimestamp(), self.code_lifetime_s) };
        self.finished.store(true, .seq_cst);
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
            .failed => |err| try writeFailure(self.state, self.alloc(), id, err),
            .cancelled => try writeCancelled(self.state, self.alloc(), id),
        }
    }

    const Join = enum { waiting, busy, ended };

    /// Makes `id` the request this sign-in answers, unless one already is.
    /// `.ended` once the sign-in has its outcome or is stopping.
    fn join(self: *Job, id: ?jsonrpc.RequestId) Allocator.Error!Join {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        if (self.finished.load(.seq_cst) or self.stop.load(.seq_cst)) return .ended;
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
/// or a new browser sign-in resolves. Joins a sign-in already running; after
/// a cancelled one has stopped, starts a new one. A failure nobody was
/// waiting for is the answer once, unless a credential is usable by now.
pub fn authenticate(state: *ServerState, alloc: Allocator, id: ?jsonrpc.RequestId) !void {
    reap(state, false);
    if (state.sign_in) |job| switch (try job.join(id)) {
        .waiting => return,
        .busy => return state.writer.writeError(alloc, id, .{
            .code = ErrorCode.invalid_request,
            .message = signInFailureMessage(error.SignInAlreadyRunning),
        }),
        .ended => reap(state, true),
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
    // A usable credential makes a kept failure moot.
    if (pending != .unavailable) {
        state.sign_in_failure = null;
        return state.writer.writeResponse(alloc, id, "{}");
    }
    // Kept until reported: a refresh error above leaves it for the next one.
    if (state.sign_in_failure) |kept| {
        state.sign_in_failure = null;
        if (!kept.expired(io_mod.milliTimestamp())) return writeFailure(state, alloc, id, kept.err);
    }
    if (signInBlock()) |block| return state.writer.writeError(alloc, id, .{
        .code = ErrorCode.invalid_request,
        .message = block.reason(),
    });
    try start(state, id);
}

fn start(state: *ServerState, id: ?jsonrpc.RequestId) !void {
    const job = try state.alloc.create(Job);
    errdefer state.alloc.destroy(job);
    // The settings `lia login` would read run in this workspace; an editor
    // rarely launches lia there.
    const workspace_root = if (state.active_session) |*session| session.workspace_root else state.workspace_root;
    const owned_root = try state.alloc.dupe(u8, workspace_root);
    errdefer state.alloc.free(owned_root);
    job.* = .{
        .state = state,
        .offer = server.authOffer(state),
        .workspace_root = owned_root,
        .waiting = try dupeRequestId(state.alloc, id),
    };
    errdefer if (job.waiting) |owned| freeRequestId(state.alloc, owned);
    state.sign_in = job;
    errdefer state.sign_in = null;
    job.thread = try std.Thread.spawn(.{}, Job.run, .{job});
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
    if (job.unreported) |kept| state.sign_in_failure = kept;
    if (signed_in) rememberSwitchRoot(state, job.workspace_root);
    job.destroy();
    state.sign_in = null;
    if (!signed_in) return;
    state.gateway_source_preference = .fx_login;
    _ = server.refreshPendingAuth(state) catch |err| {
        debug_trace.logf("auth", "acp sign-in adoption failed err={s}", .{@errorName(err)});
    };
}

/// Keeps the folder the profile switch read, for `modelForSession`.
/// Without it the session keeps the model the connection already has.
fn rememberSwitchRoot(state: *ServerState, root: []const u8) void {
    const owned = state.alloc.dupe(u8, root) catch |err| {
        debug_trace.logf("auth", "acp sign-in could not keep its settings folder err={s}", .{@errorName(err)});
        return;
    };
    if (state.sign_in_root) |old| state.alloc.free(old);
    state.sign_in_root = owned;
}

/// The connection's next model, picked for a session's folder; both copies
/// owned by `state.alloc` until `sessionActivated` takes them.
pub const SessionModel = struct {
    selected: []u8,
    configured: []u8,

    pub fn deinit(self: SessionModel, alloc: Allocator) void {
        alloc.free(self.selected);
        alloc.free(self.configured);
    }
};

/// The model `session/new` gives a session in `workspace_root`, without
/// changing the connection. The sign-in's profile switch read the settings
/// of the folder it started in, which for ACP v1 is where lia was launched,
/// since `cwd` arrives only with the session. When the session's folder is
/// another one, picks the model again from that folder's settings, on top of
/// what the switch saved. Null keeps the connection's model: no sign-in
/// switched the profile since the last session, its folder is this one, the
/// model is fixed for the process, or the pick is the current model.
pub fn modelForSession(state: *const ServerState, workspace_root: []const u8) ?SessionModel {
    if (comptime host_target.is_wasm) return null;
    const switched_root = state.sign_in_root orelse return null;
    if (std.mem.eql(u8, switched_root, workspace_root)) return null;
    if (state.provider != .gateway or state.process_model_override) return null;
    var settings = (if (state.cfg.home_override) |home|
        config_runtime.loadMergedSettingsFromHome(state.alloc, home, workspace_root)
    else
        config_runtime.loadMergedSettings(state.alloc, workspace_root)) catch |err| {
        debug_trace.logf("config", "acp session settings load failed err={s}", .{@errorName(err)});
        return null;
    };
    defer settings.deinit(state.alloc);
    const selection = config_runtime.selectProviderModel(state.cfg.default_model, &settings, .gateway, null) catch return null;
    if (std.mem.eql(u8, selection.model, state.selected_model)) return null;
    const selected = state.alloc.dupe(u8, selection.model) catch return null;
    const configured = state.alloc.dupe(u8, selection.model) catch {
        state.alloc.free(selected);
        return null;
    };
    return .{ .selected = selected, .configured = configured };
}

/// Called once a session is active, after the previous one's turn is
/// reaped: the sign-in's folder is spent, and `picked`, from
/// `modelForSession`, becomes the connection's model.
pub fn sessionActivated(state: *ServerState, picked: ?SessionModel) void {
    if (state.sign_in_root) |root| state.alloc.free(root);
    state.sign_in_root = null;
    const model = picked orelse return;
    if (state.selected_model.len > 0) state.alloc.free(state.selected_model);
    if (state.configured_model.len > 0) state.alloc.free(state.configured_model);
    state.selected_model = model.selected;
    state.configured_model = model.configured;
}

/// Stops the sign-in that would answer `requested` and answers that request
/// as cancelled at once. False when no sign-in answers that request.
pub fn cancelRequest(state: *ServerState, requested: jsonrpc.RequestId) bool {
    if (comptime host_target.is_wasm) return false;
    const job = state.sign_in orelse return false;
    job.mutex.lockUncancelable(io_mod.getIo());
    const waiting = job.waiting;
    const matches = if (waiting) |id| server.requestIdsEqual(id, requested) else false;
    if (matches) {
        job.waiting = null;
        job.stop.store(true, .seq_cst);
    }
    job.mutex.unlock(io_mod.getIo());
    if (!matches) return false;
    const id = waiting.?;
    defer freeRequestId(state.alloc, id);
    writeCancelled(state, state.alloc, id) catch |err| {
        debug_trace.logf("auth", "acp sign-in cancel answer failed err={s}", .{@errorName(err)});
    };
    return true;
}

/// Stops the connection's sign-in when the client goes away, and waits for
/// its worker. A waiting `authenticate` is answered as cancelled, or `{}`
/// when the approval was already saved, while the channel still takes it.
pub fn stop(state: *ServerState) void {
    if (comptime host_target.is_wasm) return;
    const job = state.sign_in orelse return;
    job.stop.store(true, .seq_cst);
    job.thread.join();
    job.destroy();
    state.sign_in = null;
}

fn writeFailure(state: *ServerState, alloc: Allocator, id: ?jsonrpc.RequestId, err: anyerror) !void {
    debug_trace.logf("auth", "acp sign-in failed err={s}", .{@errorName(err)});
    try state.writer.writeError(alloc, id, .{
        .code = ErrorCode.invalid_request,
        .message = signInFailureMessage(err),
    });
}

fn writeCancelled(state: *ServerState, alloc: Allocator, id: jsonrpc.RequestId) !void {
    try state.writer.writeError(alloc, id, .{
        .code = ErrorCode.request_cancelled,
        .message = cancelled_message,
    });
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
    /// Opening the page waits until the sign-in is saved, then cancels the
    /// request that waits on it: the cancel lands just after the approval.
    cancel_once_saved: ?struct { state: *ServerState, home: *SignInTestHome, request: i64 } = null,

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
        if (self.cancel_once_saved) |target| {
            target.home.waitForFile(".lia/auth.json") catch return false;
            _ = cancelRequest(target.state, .{ .integer = target.request });
        }
        return true;
    }
};

/// A Gateway catalog with one model, so switching the profile can pick it.
fn fetchOneModel(_: ?*anyopaque, alloc: Allocator, _: model_catalog.FetchInput) Allocator.Error!model_catalog.ProviderResult {
    return catalogOf(alloc, &.{"openai/gpt-5.5"});
}

/// A Gateway catalog whose first model is not the one a workspace picks.
fn fetchTwoModels(_: ?*anyopaque, alloc: Allocator, _: model_catalog.FetchInput) Allocator.Error!model_catalog.ProviderResult {
    return catalogOf(alloc, &.{ "openai/gpt-5.5", workspace_model });
}

const workspace_model = "anthropic/claude-sonnet-4.6";

fn catalogOf(alloc: Allocator, ids: []const []const u8) Allocator.Error!model_catalog.ProviderResult {
    var entries: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &entries);
    for (ids) |model_id| {
        const id = try alloc.dupe(u8, model_id);
        errdefer alloc.free(id);
        const model_type = try alloc.dupe(u8, "language");
        errdefer alloc.free(model_type);
        try entries.append(alloc, .{ .id = id, .model_type = model_type });
    }
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

    /// Waits up to 10 s for the file at `name` under HOME to exist.
    fn waitForFile(self: *SignInTestHome, name: []const u8) !void {
        const deadline = io_mod.awakeMilliTimestamp() + 10_000;
        while (true) {
            if (self.tmp.dir.statFile(io_mod.getIo(), name, .{})) |_| return else |_| {}
            if (io_mod.awakeMilliTimestamp() >= deadline) return error.TestFileMissing;
            io_mod.sleep(10 * std.time.ns_per_ms);
        }
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

/// A Gateway connection, initialized in `home` and awaiting sign-in, whose
/// sign-in requests reach `fake`. Free it with `deinit`, which is also how
/// the connection ends when the client goes away.
fn signInTestState(alloc: Allocator, home: *SignInTestHome, frames: *Frames, fake: *FakeVercel) !ServerState {
    var cfg = sessions.acpSessionTestConfig();
    cfg.gateway_provider.oauth_transport = fake.transport();
    cfg.url_opener = fake.opener();
    cfg.provider_set = provider_set.gateway_only(.{ .model_catalog = .{ .context = null, .fetch_fn = fetchOneModel } });
    return .{
        .alloc = alloc,
        .cfg = cfg,
        .writer = jsonrpc.Writer.initCallback(frames, Frames.write),
        .initialized = true,
        .workspace_root = try alloc.dupe(u8, home.home),
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
    var state = try signInTestState(alloc, home, &frames, &fake);
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
        var first = try signInTestState(alloc, home, &frames, &fake);
        defer first.deinit();
        var trap = try StdStreamTrap.begin(home.tmp.dir);
        defer trap.end();
        try authenticateForTest(&first, 7);
        const answer = try frames.waitFor(7);
        answer.deinit();
    }
    // The profile still names a stored key, as when switching it failed.
    try home.writePrivate(".lia/settings.json", "{\"credential_source\":\"stored_key\"}", 0o600);
    var state = try signInTestState(alloc, home, &frames, &fake);
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
    var state = try signInTestState(alloc, home, &frames, &fake);
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
    var state = try signInTestState(alloc, home, &frames, &fake);
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

test "an authenticate right after a cancel starts a fresh sign-in instead of answering that one is waiting" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    var fake: FakeVercel = .{ .approved = .init(false) };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    try waitForCount(&fake.token_polls, 1);
    var cancel = jsonrpc.Message{ .method = "$/cancel_request", .params_raw = "{\"requestId\":7}" };
    try server.dispatchNotification(&state, alloc, &cancel);
    try authenticateForTest(&state, 8);
    var early = try frames.answer(8);
    defer if (early) |*parsed| parsed.deinit();
    try waitForCount(&fake.device_requests, 2);
    fake.approved.store(true, .seq_cst);
    const cancelled = try frames.waitFor(7);
    defer cancelled.deinit();
    const signed_in = try frames.waitFor(8);
    defer signed_in.deinit();
    trap.end();

    if (early) |answer| {
        std.debug.print("answered before the new sign-in resolved: {f}\n", .{std.json.fmt(answer.value, .{})});
        return error.TestAnsweredEarly;
    }
    try expectError(cancelled, ErrorCode.request_cancelled, cancelled_message);
    try expectSignedIn(signed_in);
}

test "a sign-in that fails with nobody waiting is reported to the next lia-login, then cleared" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{ .open_browser = false });
    defer home.deinit();
    var fake: FakeVercel = .{ .approved = .init(false), .device_expires_in = 1 };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const code_answer = try frames.waitFor(7);
    defer code_answer.deinit();
    try waitForSignInEnd(&state);
    try authenticateForTest(&state, 8);
    const expired = try frames.waitFor(8);
    defer expired.deinit();
    const device_requests_after_report = fake.device_requests.load(.seq_cst);
    try authenticateForTest(&state, 9);
    const next = try frames.waitFor(9);
    defer next.deinit();
    trap.end();

    try std.testing.expectEqual(@as(i64, ErrorCode.auth_required), code_answer.value.object.get("error").?.object.get("code").?.integer);
    try expectError(expired, ErrorCode.invalid_request, signInFailureMessage(error.LoginTimedOut));
    try std.testing.expectEqual(@as(usize, 1), device_requests_after_report);
    // Reported once: the next lia-login starts a new sign-in.
    try std.testing.expectEqual(@as(i64, ErrorCode.auth_required), next.value.object.get("error").?.object.get("code").?.integer);
    try std.testing.expectEqual(@as(usize, 2), fake.device_requests.load(.seq_cst));
}

test "a kept failure survives a credential refresh error and reaches the next lia-login" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{ .open_browser = false });
    defer home.deinit();
    try home.saveLogin("team_saved", 0);
    var fake: FakeVercel = .{ .refresh_body = "{\"error\":\"temporarily_unavailable\"}" };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();
    state.sign_in_failure = .{ .err = error.LoginTimedOut, .expires_at_ms = io_mod.milliTimestamp() + 60_000 };

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const refused = try frames.waitFor(7);
    defer refused.deinit();
    const kept_after_refresh_error = state.sign_in_failure != null;
    const sign_ins_after_refresh_error = fake.device_requests.load(.seq_cst);
    // The saved login is revoked now, so the refresh no longer errors.
    fake.refresh_body = "{\"error\":\"invalid_grant\"}";
    try authenticateForTest(&state, 8);
    const reported = try frames.waitFor(8);
    defer reported.deinit();
    trap.end();

    try expectError(refused, ErrorCode.invalid_request, signInFailureMessage(error.CredentialTemporarilyUnavailable));
    try std.testing.expect(kept_after_refresh_error);
    try std.testing.expectEqual(@as(usize, 0), sign_ins_after_refresh_error);
    try expectError(reported, ErrorCode.invalid_request, signInFailureMessage(error.LoginTimedOut));
    try std.testing.expect(state.sign_in_failure == null);
    try std.testing.expectEqual(@as(usize, 0), fake.device_requests.load(.seq_cst));
}

test "an expired kept failure is dropped and the next lia-login starts a new sign-in" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{ .open_browser = false });
    defer home.deinit();
    var fake: FakeVercel = .{ .approved = .init(false) };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();
    state.sign_in_failure = .{ .err = error.LoginTimedOut, .expires_at_ms = io_mod.milliTimestamp() - 1 };

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    trap.end();

    try std.testing.expectEqual(@as(i64, ErrorCode.auth_required), answer.value.object.get("error").?.object.get("code").?.integer);
    try std.testing.expect(state.sign_in_failure == null);
    try std.testing.expectEqual(@as(usize, 1), fake.device_requests.load(.seq_cst));
}

test "a kept failure lasts as long as the device code, or 15 minutes when that is unknown" {
    try std.testing.expectEqual(@as(i64, 1_000 + 300_000), keptUntil(1_000, 300));
    try std.testing.expectEqual(@as(i64, 1_000 + 900_000), keptUntil(1_000, 0));
    try std.testing.expectEqual(@as(i64, 1_000 + 900_000), keptUntil(1_000, -5));
    try std.testing.expectEqual(@as(i64, std.math.maxInt(i64)), keptUntil(std.math.maxInt(i64) - 1, std.math.maxInt(i64)));
    const kept: KeptFailure = .{ .err = error.LoginTimedOut, .expires_at_ms = 5_000 };
    try std.testing.expect(!kept.expired(4_999));
    try std.testing.expect(kept.expired(5_000));
}

test "a cancel that lands as the sign-in is saved still selects the team and switches the profile" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();
    fake.cancel_once_saved = .{ .state = &state, .home = home, .request = 7 };

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const cancelled = try frames.waitFor(7);
    defer cancelled.deinit();
    try authenticateForTest(&state, 8);
    const retry = try frames.waitFor(8);
    defer retry.deinit();
    trap.end();

    try expectError(cancelled, ErrorCode.request_cancelled, cancelled_message);
    try expectSignedIn(retry);
    try std.testing.expectEqual(@as(usize, 1), fake.device_requests.load(.seq_cst));
    try std.testing.expectEqualStrings("team_solo", state.gateway_team orelse "");
    const saved = try home.read(".lia/auth.json");
    defer secret.zeroAndFree(alloc, saved);
    try std.testing.expect(std.mem.find(u8, saved, "team_solo") != null);
    const settings = try home.read(".lia/settings.json");
    defer alloc.free(settings);
    try std.testing.expect(std.mem.find(u8, settings, "\"credential_source\":\"fx_login\"") != null);
}

test "the profile switch reads the connection's workspace settings, not the folder lia was launched in" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    try home.tmp.dir.createDirPath(io_mod.getIo(), "project");
    const project = try io_mod.dirRealpathAlloc(alloc, home.tmp.dir, "project");
    defer alloc.free(project);
    const profile = try alloc.print("{{\"workspaces\":{{\"{s}\":{{\"model\":\"{s}\"}}}}}}", .{ project, workspace_model });
    defer alloc.free(profile);
    try home.writePrivate(".lia/settings.json", profile, 0o600);
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();
    state.cfg.provider_set = provider_set.gateway_only(.{ .model_catalog = .{ .context = null, .fetch_fn = fetchTwoModels } });
    alloc.free(state.workspace_root);
    state.workspace_root = try alloc.dupe(u8, project);

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    trap.end();

    try expectSignedIn(answer);
    const settings = try home.read(".lia/settings.json");
    defer alloc.free(settings);
    std.testing.expect(std.mem.find(u8, settings, "\"models\":{\"gateway\":\"" ++ workspace_model ++ "\"}") != null) catch |err| {
        std.debug.print("settings.json: {s}\n", .{settings});
        return err;
    };
}

test "a session opened after the sign-in uses its own folder's settings, not the folder lia was launched in" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    try home.tmp.dir.createDirPath(io_mod.getIo(), "project");
    const project = try io_mod.dirRealpathAlloc(alloc, home.tmp.dir, "project");
    defer alloc.free(project);
    // `models`, as `lia config set` writes it: the sign-in's save clears a
    // workspace's older `model` key.
    const profile = try alloc.print("{{\"workspaces\":{{\"{s}\":{{\"models\":{{\"gateway\":\"{s}\"}}}}}}}}", .{ project, workspace_model });
    defer alloc.free(profile);
    try home.writePrivate(".lia/settings.json", profile, 0o600);
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    // Launched in HOME, as an editor does; the project arrives with session/new.
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();
    state.cfg.provider_set = provider_set.gateway_only(.{ .model_catalog = .{ .context = null, .fetch_fn = fetchTwoModels } });
    state.cfg.allow_acp_mcp = false;
    state.sessions_v2 = try session_adapter.Store.open(alloc, home.home);
    state.selected_model = try alloc.dupe(u8, "test/model");
    state.configured_model = try alloc.dupe(u8, "test/model");

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    try expectSignedIn(answer);
    const new_params = try alloc.print("{{\"cwd\":\"{s}\",\"mcpServers\":[]}}", .{project});
    defer alloc.free(new_params);
    try dispatchForTest(&state, 8, "session/new", new_params);
    trap.end();

    try std.testing.expect(!state.auth_pending);
    try std.testing.expectEqualStrings(project, state.active_session.?.workspace_root);
    try std.testing.expectEqualStrings(workspace_model, state.active_session.?.model);
    try std.testing.expectEqualStrings(workspace_model, state.selected_model);
    try std.testing.expect(state.sign_in_root == null);
}

test "a session/new that fails to create its session leaves the model, the running turn and the sign-in's folder for the next one" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    try home.tmp.dir.createDirPath(io_mod.getIo(), "project");
    const project = try io_mod.dirRealpathAlloc(alloc, home.tmp.dir, "project");
    defer alloc.free(project);
    const profile = try alloc.print("{{\"workspaces\":{{\"{s}\":{{\"models\":{{\"gateway\":\"{s}\"}}}}}}}}", .{ project, workspace_model });
    defer alloc.free(profile);
    try home.writePrivate(".lia/settings.json", profile, 0o600);
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();
    state.cfg.provider_set = provider_set.gateway_only(.{ .model_catalog = .{ .context = null, .fetch_fn = fetchTwoModels } });
    state.cfg.allow_acp_mcp = false;
    state.sessions_v2 = try session_adapter.Store.open(alloc, home.home);
    state.selected_model = try alloc.dupe(u8, "test/model");
    state.configured_model = try alloc.dupe(u8, "test/model");

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    try expectSignedIn(answer);
    // Adopts the sign-in before the turn starts, which would defer it.
    try dispatchForTest(&state, 8, "lia/unknown", "{}");
    try server.startIdlePromptForTest(&state);
    defer server.cancelAndReapActivePrompt(&state);
    // A file where the sessions folder goes: the session cannot be created.
    try home.writePrivate(".lia/sessions", "", 0o600);
    const new_params = try alloc.print("{{\"cwd\":\"{s}\",\"mcpServers\":[]}}", .{project});
    defer alloc.free(new_params);
    try dispatchForTest(&state, 9, "session/new", new_params);
    const failed = try frames.waitFor(9);
    defer failed.deinit();
    const selected_after_failure = try alloc.dupe(u8, state.selected_model);
    defer alloc.free(selected_after_failure);
    const configured_after_failure = try alloc.dupe(u8, state.configured_model);
    defer alloc.free(configured_after_failure);
    const turn_kept = state.active_prompt != null;
    const root_kept = state.sign_in_root != null;

    try home.tmp.dir.deleteFile(io_mod.getIo(), ".lia/sessions");
    try dispatchForTest(&state, 10, "session/new", new_params);
    trap.end();

    try expectError(failed, ErrorCode.internal_error, "Failed to create session");
    try std.testing.expectEqualStrings("test/model", selected_after_failure);
    try std.testing.expectEqualStrings("test/model", configured_after_failure);
    try std.testing.expect(turn_kept);
    try std.testing.expect(root_kept);
    try std.testing.expectEqualStrings(workspace_model, state.active_session.?.model);
    try std.testing.expectEqualStrings(workspace_model, state.selected_model);
    try std.testing.expect(state.sign_in_root == null);
}

test "a sign-in picks a session's model again only for another folder, on Gateway, with no model fixed for the process" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    try home.tmp.dir.createDirPath(io_mod.getIo(), "project");
    const project = try io_mod.dirRealpathAlloc(alloc, home.tmp.dir, "project");
    defer alloc.free(project);
    // The global model is what the sign-in's switch saved for the folder it read.
    const profile = try alloc.print("{{\"models\":{{\"gateway\":\"openai/gpt-5.5\"}},\"workspaces\":{{\"{s}\":{{\"models\":{{\"gateway\":\"{s}\"}}}}}}}}", .{ project, workspace_model });
    defer alloc.free(profile);
    try home.writePrivate(".lia/settings.json", profile, 0o600);
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();
    state.selected_model = try alloc.dupe(u8, "test/model");
    state.configured_model = try alloc.dupe(u8, "test/model");

    const without_sign_in = modelForSession(&state, project);
    state.sign_in_root = try alloc.dupe(u8, home.home);
    const picked = modelForSession(&state, project);
    defer if (picked) |model| model.deinit(alloc);
    const same_folder = modelForSession(&state, home.home);
    state.process_model_override = true;
    const pinned = modelForSession(&state, project);
    state.process_model_override = false;
    state.provider = .{ .configured = .{ .len = 0 } };
    const configured_provider = modelForSession(&state, project);
    state.provider = .gateway;

    try std.testing.expect(without_sign_in == null);
    try std.testing.expectEqualStrings(workspace_model, picked.?.selected);
    try std.testing.expectEqualStrings(workspace_model, picked.?.configured);
    try std.testing.expect(same_folder == null);
    try std.testing.expect(pinned == null);
    try std.testing.expect(configured_provider == null);
    // Picking changes nothing until the session is active.
    try std.testing.expectEqualStrings(home.home, state.sign_in_root.?);
    try std.testing.expectEqualStrings("test/model", state.selected_model);
}

test "session/new after a sign-in ends the running turn, takes its folder's model, and a second session/new keeps it" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    try home.tmp.dir.createDirPath(io_mod.getIo(), "project");
    try home.tmp.dir.createDirPath(io_mod.getIo(), "other");
    const project = try io_mod.dirRealpathAlloc(alloc, home.tmp.dir, "project");
    defer alloc.free(project);
    const other = try io_mod.dirRealpathAlloc(alloc, home.tmp.dir, "other");
    defer alloc.free(other);
    const profile = try alloc.print(
        "{{\"workspaces\":{{\"{s}\":{{\"models\":{{\"gateway\":\"{s}\"}}}},\"{s}\":{{\"models\":{{\"gateway\":\"openai/gpt-5.5\"}}}}}}}}",
        .{ project, workspace_model, other },
    );
    defer alloc.free(profile);
    try home.writePrivate(".lia/settings.json", profile, 0o600);
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();
    state.cfg.provider_set = provider_set.gateway_only(.{ .model_catalog = .{ .context = null, .fetch_fn = fetchTwoModels } });
    state.cfg.allow_acp_mcp = false;
    state.sessions_v2 = try session_adapter.Store.open(alloc, home.home);
    state.selected_model = try alloc.dupe(u8, "test/model");
    state.configured_model = try alloc.dupe(u8, "test/model");

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();
    // Adopts the sign-in before the turn starts, which would defer it.
    try dispatchForTest(&state, 8, "lia/unknown", "{}");
    try server.startIdlePromptForTest(&state);
    defer server.cancelAndReapActivePrompt(&state);
    const project_params = try alloc.print("{{\"cwd\":\"{s}\",\"mcpServers\":[]}}", .{project});
    defer alloc.free(project_params);
    try dispatchForTest(&state, 9, "session/new", project_params);
    const turn_ended = state.active_prompt == null;
    const first_model = try alloc.dupe(u8, state.selected_model);
    defer alloc.free(first_model);
    const other_params = try alloc.print("{{\"cwd\":\"{s}\",\"mcpServers\":[]}}", .{other});
    defer alloc.free(other_params);
    try dispatchForTest(&state, 10, "session/new", other_params);
    trap.end();

    try expectSignedIn(answer);
    try std.testing.expect(turn_ended);
    try std.testing.expectEqualStrings(workspace_model, first_model);
    try std.testing.expectEqualStrings(other, state.active_session.?.workspace_root);
    try std.testing.expectEqualStrings(workspace_model, state.active_session.?.model);
    try std.testing.expectEqualStrings(workspace_model, state.selected_model);
}

test "a failure kept from a real sign-in lasts as long as its device code" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{ .open_browser = false });
    defer home.deinit();
    var fake: FakeVercel = .{
        .approved = .init(false),
        .device_expires_in = 600,
        .token_disposition = .rejected,
        .token_body = "{\"error\":\"access_denied\"}",
    };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    try authenticateForTest(&state, 7);
    const code_answer = try frames.waitFor(7);
    defer code_answer.deinit();
    const before_ms = io_mod.milliTimestamp();
    // Denied at the next poll, with nobody waiting.
    fake.approved.store(true, .seq_cst);
    try waitForSignInEnd(&state);
    const after_ms = io_mod.milliTimestamp();
    try dispatchForTest(&state, 8, "lia/unknown", "{}");
    trap.end();

    try std.testing.expectEqual(@as(i64, ErrorCode.auth_required), code_answer.value.object.get("error").?.object.get("code").?.integer);
    const kept = state.sign_in_failure orelse return error.TestExpectedKeptFailure;
    try std.testing.expect(kept.expires_at_ms >= before_ms + 600_000);
    try std.testing.expect(kept.expires_at_ms <= after_ms + 600_000);
}

test "a device code whose lifetime is 0 keeps the failure for 15 minutes" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{ .open_browser = false });
    defer home.deinit();
    // The code is handed out, then polling it fails: it has no deadline.
    var fake: FakeVercel = .{ .approved = .init(false), .device_expires_in = 0 };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();

    var trap = try StdStreamTrap.begin(home.tmp.dir);
    defer trap.end();
    const before_ms = io_mod.milliTimestamp();
    try authenticateForTest(&state, 7);
    const code_answer = try frames.waitFor(7);
    defer code_answer.deinit();
    try waitForSignInEnd(&state);
    const after_ms = io_mod.milliTimestamp();
    try dispatchForTest(&state, 8, "lia/unknown", "{}");
    trap.end();

    try std.testing.expectEqual(@as(i64, ErrorCode.auth_required), code_answer.value.object.get("error").?.object.get("code").?.integer);
    const kept = state.sign_in_failure orelse return error.TestExpectedKeptFailure;
    try std.testing.expect(kept.expires_at_ms >= before_ms + kept_failure_default_ms);
    try std.testing.expect(kept.expires_at_ms <= after_ms + kept_failure_default_ms);
}

test "lia-login on a connection started on a configured provider runs no Gateway sign-in and keeps that provider" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    // Its key's variable is not set.
    try home.writePrivate(".lia/settings.json", "{\"providers\":{\"router\":{\"protocol\":\"openai-chat-completions\"," ++
        "\"base_url\":\"https://openrouter.ai/api/v1\",\"auth\":{\"type\":\"bearer\",\"env\":\"LIA_TEST_UNSET_ROUTER_KEY\"}}},\"provider\":\"router\"}", 0o600);
    var fake: FakeVercel = .{};
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);
    defer state.deinit();
    state.provider = @import("../core/config/model_provider.zig").parse("router").?;
    state.credential_source = .configured;

    try authenticateForTest(&state, 7);
    const answer = try frames.waitFor(7);
    defer answer.deinit();

    try expectError(answer, ErrorCode.invalid_request, server.configured_credential_unavailable_message);
    try std.testing.expect(state.sign_in == null);
    try std.testing.expectEqual(@as(usize, 0), fake.device_requests.load(.seq_cst));
    try std.testing.expect(state.provider == .configured);
}

/// Waits up to 10 s for the connection's sign-in to reach its outcome.
fn waitForSignInEnd(state: *ServerState) !void {
    const job = state.sign_in orelse return;
    const deadline = io_mod.awakeMilliTimestamp() + 10_000;
    while (!job.finished.load(.seq_cst)) {
        if (io_mod.awakeMilliTimestamp() >= deadline) return error.TestSignInStillRunning;
        io_mod.sleep(10 * std.time.ns_per_ms);
    }
}

test "a client that goes away stops the sign-in and its authenticate is answered as cancelled" {
    if (comptime @import("builtin").target.os.tag == .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const home = try SignInTestHome.install(alloc, .{});
    defer home.deinit();
    var fake: FakeVercel = .{ .approved = .init(false) };
    var frames: Frames = .{ .alloc = alloc };
    defer frames.deinit();
    var state = try signInTestState(alloc, home, &frames, &fake);

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
    var state = try signInTestState(alloc, home, &frames, &fake);
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
    var state = try signInTestState(alloc, home, &frames, &fake);
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
    var state = try signInTestState(alloc, home, &frames, &fake);
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
    var state = try signInTestState(alloc, home, &frames, &fake);
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
        var state = try signInTestState(alloc, home, &frames, &fake);
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
        var state = try signInTestState(alloc, home, &frames, &fake);
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
