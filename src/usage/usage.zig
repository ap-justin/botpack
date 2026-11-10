//! `lia usage`: the module's front door. lia hands in a `Host` (HTTP, clock,
//! home directory) and a `Credential` for the provider in use; the CLI calls
//! the `Dashboard` and renders its `Snapshot`. AI Gateway sign-ins read usage
//! reports. All usage logic lives here.

const std = @import("std");
const builtin = @import("builtin");
pub const report = @import("report.zig");
pub const policy = @import("policy.zig");
pub const cache = @import("cache.zig");
pub const view = @import("view.zig");

const Allocator = std.mem.Allocator;
const Io = std.Io;

pub const Period = view.Period;
pub const View = view.View;
pub const Scope = report.Scope;

/// Which service a request goes to; lia resolves the origin.
pub const Service = enum {
    /// `ai-gateway.vercel.sh` (`/v1/report`).
    gateway,
    /// `api.vercel.com` (`/ai-gateway/usage-report`).
    vercel_api,
};

pub const Request = struct {
    service: Service,
    path: []const u8,
    bearer: []const u8,
    /// Sent as `x-vercel-ai-gateway-team` when set.
    team: ?[]const u8,
    /// The provider account the request is for, when it has one.
    account_id: ?[]const u8 = null,
};

pub const Response = struct {
    status: u16,
    body: []u8,
};

pub const FetchError = error{ Cancelled, Unavailable, OutOfMemory };

pub const Host = struct {
    ctx: ?*anyopaque = null,
    /// Performs one GET. The body is allocated with `alloc`; caller frees it.
    fetch_fn: *const fn (ctx: ?*anyopaque, alloc: Allocator, request: Request, cancel: *std.atomic.Value(bool)) FetchError!Response,
    /// Milliseconds since the Unix epoch.
    now_fn: *const fn (ctx: ?*anyopaque) i64,
    /// The I/O implementation for files, locks and the worker.
    io_fn: *const fn (ctx: ?*anyopaque) Io,
    /// The folder that holds lia's folder: the user's home directory, or the
    /// parent of `$LIA_HOME`. The cache lives in `<home>/<lia_dir_name>`.
    home: []const u8,
    /// The name of lia's folder inside `home`.
    lia_dir_name: []const u8 = ".lia",
};

/// The sign-in `/usage` reads with. The bearer is borrowed only for the call
/// that receives it; the dashboard keeps its own copy.
pub const Credential = struct {
    scope: Scope,
    bearer: []const u8,
    /// Required for `.member`.
    team: ?[]const u8,
    /// Stable per person: the lia login account or the API key itself.
    subject: []const u8,
    /// The provider account the numbers belong to, when it has one.
    account_id: ?[]const u8 = null,
    /// Who the numbers belong to, shown in the heading, e.g.
    /// `acme-design-tools-platform (lia login)`. Never a secret.
    label: []const u8 = "",
};

/// Why usage cannot be shown at all.
pub const Unavailable = enum {
    /// Not signed in to AI Gateway (a subscription provider, or no sign-in).
    no_gateway_sign_in,
    /// lia login without a team.
    no_team,
    /// Signed in to a provider whose usage `/usage` cannot show yet.
    unsupported_provider,
    /// The provider's sign-in has expired; it renews on the next message.
    refresh_needed,
};

/// Why the last refresh failed. Cached numbers stay on screen.
pub const Failure = enum {
    network,
    /// 401/403: the provider refused this sign-in.
    refused,
    /// 402/404: the team cannot use usage reports.
    not_available,
    rate_limited,
    server,
    bad_response,
    cache,
};

pub const Status = union(enum) {
    ready,
    fetching,
    failed: Failure,
    unavailable: Unavailable,
};

/// Everything `/usage` shows at one moment: a view per period, the status,
/// and who the numbers belong to. Caller owns it.
pub const Snapshot = struct {
    arena: std.heap.ArenaAllocator,
    /// Indexed by `@intFromEnum(Period)`.
    views: [Period.all.len]View,
    status: Status,
    label: []const u8,
    /// When the snapshot was taken, for "updated Nm ago".
    now_ms: i64,
    /// Whose usage this is; null when there is no usable sign-in.
    scope: ?Scope = null,

    pub fn of(self: *const Snapshot, period: Period) *const View {
        return &self.views[@backingInt(period)];
    }

    /// The member's budget, when AI Gateway reported one.
    pub fn budget(self: *const Snapshot) ?report.Budget {
        return self.views[0].budget;
    }

    /// The UTC day the budget next resets, when known.
    pub fn budgetResetDay(self: *const Snapshot) ?i64 {
        const b = self.budget() orelse return null;
        return report.budgetResetDay(b.period, report.utcDay(self.now_ms));
    }

    /// The first and last UTC day of `period`, ending today.
    fn days(self: *const Snapshot, period: Period) [2]i64 {
        const today = report.utcDay(self.now_ms);
        return .{ switch (period) {
            .today => today,
            .days_7 => today - 6,
            .month => report.monthStart(today),
        }, today };
    }

    /// When the numbers on screen were fetched, if any are shown.
    pub fn fetchedAtMs(self: *const Snapshot) ?i64 {
        return self.views[0].fetched_at_ms;
    }

    pub fn deinit(self: *Snapshot) void {
        for (&self.views) |*v| v.deinit();
        self.arena.deinit();
    }
};

const Session = struct {
    identity: cache.Identity,
    scope: Scope,
    bearer: []u8,
    team: ?[]u8,
    label: []u8,
    account_id: ?[]u8 = null,

    fn deinit(self: *Session, gpa: Allocator) void {
        std.crypto.secureZero(u8, self.bearer);
        gpa.free(self.bearer);
        if (self.team) |t| gpa.free(t);
        gpa.free(self.label);
        if (self.account_id) |a| gpa.free(a);
    }
};

pub const Dashboard = struct {
    gpa: Allocator,
    host: Host,

    mutex: Io.Mutex = .init,
    is_open: bool = false,
    fetch_state: policy.State = .{},
    /// A new sign-in that has not had a fetch of its own finish or start yet,
    /// because the previous sign-in's fetch was still running when it arrived.
    fetch_owed: bool = false,
    session: ?Session = null,
    unavailable: ?Unavailable = null,
    entry: ?cache.Owned = null,
    failure: ?Failure = null,
    /// Bumps on every change the UI should redraw for. `usize` keeps it
    /// atomic on wasm32; readers only compare it, so wrapping is harmless.
    generation: std.atomic.Value(usize) = .init(0),
    worker: ?std.Thread = null,
    /// Runs each fetch inside `tick` and `waitForFetch` instead of on a worker
    /// thread: always in single-threaded builds (wasm), and in tests of that
    /// path.
    inline_fetches: bool = builtin.single_threaded,
    /// A fetch `inline_fetches` started, waiting for `tick` or `waitForFetch`
    /// to run it outside the lock.
    queued_job: ?Job = null,
    cancel: std.atomic.Value(bool) = .init(false),

    /// Comptime-callable, so an owner can hold a default dashboard.
    pub fn init(gpa: Allocator, host: Host) Dashboard {
        return .{ .gpa = gpa, .host = host };
    }

    fn io(self: *const Dashboard) Io {
        return self.host.io_fn(self.host.ctx);
    }

    /// Cancels the fetch in flight and frees everything. Safe to call twice.
    pub fn deinit(self: *Dashboard) void {
        self.cancel.store(true, .release);
        self.joinWorker();
        self.mutex.lockUncancelable(self.io());
        defer self.mutex.unlock(self.io());
        if (self.queued_job) |*job| job.deinit(self.gpa);
        self.queued_job = null;
        if (self.session) |*s| s.deinit(self.gpa);
        self.session = null;
        if (self.entry) |*e| e.deinit();
        self.entry = null;
        self.is_open = false;
    }

    /// Enter on `/usage`: show what is cached for this sign-in at once, and
    /// fetch when the floor allows. Never waits on the network.
    pub fn open(self: *Dashboard, credential: ?Credential) void {
        self.mutex.lockUncancelable(self.io());
        defer self.mutex.unlock(self.io());
        self.is_open = true;
        self.installCredentialLocked(credential);
        _ = self.maybeStartLocked(.open);
        self.bump();
    }

    /// Enter on `/usage` when there is nothing to fetch with: shows why.
    pub fn openUnavailable(self: *Dashboard, reason: Unavailable) void {
        self.mutex.lockUncancelable(self.io());
        defer self.mutex.unlock(self.io());
        self.is_open = true;
        self.dropSessionLocked(reason);
        self.bump();
    }

    pub fn close(self: *Dashboard) void {
        self.mutex.lockUncancelable(self.io());
        defer self.mutex.unlock(self.io());
        self.is_open = false;
    }

    /// `r`. Returns whether a fetch started.
    pub fn refresh(self: *Dashboard) bool {
        self.mutex.lockUncancelable(self.io());
        defer self.mutex.unlock(self.io());
        const started = self.maybeStartLocked(.manual);
        if (started) self.bump();
        return started;
    }

    /// Call from the event loop; starts the 15-minute refresh when due, and a
    /// new sign-in's first fetch once the previous sign-in's has finished.
    /// With `inline_fetches`, it also runs the fetch `open`, `refresh` or this
    /// call started, so call it only where the host's fetch may pulse the
    /// event loop.
    pub fn tick(self: *Dashboard) void {
        {
            self.mutex.lockUncancelable(self.io());
            defer self.mutex.unlock(self.io());
            if (self.maybeStartLocked(if (self.fetch_owed) .open else .timer)) self.bump();
        }
        self.runQueuedFetch();
    }

    /// The host's clock, which snapshots are taken by.
    pub fn nowMs(self: *const Dashboard) i64 {
        return self.host.now_fn(self.host.ctx);
    }

    /// Changes whenever the snapshot may differ; redraw when it moves.
    pub fn generationCount(self: *const Dashboard) u64 {
        return self.generation.load(.acquire);
    }

    pub fn snapshot(self: *Dashboard, gpa: Allocator) Allocator.Error!Snapshot {
        self.mutex.lockUncancelable(self.io());
        defer self.mutex.unlock(self.io());
        self.reloadEntryLocked();
        const now = self.host.now_fn(self.host.ctx);
        const entry: ?cache.Entry = if (self.entry) |e| e.entry else null;
        var arena = std.heap.ArenaAllocator.init(gpa);
        errdefer arena.deinit();
        const label = try arena.allocator().dupe(u8, if (self.session) |s| s.label else "");
        var views: [Period.all.len]View = undefined;
        var built: usize = 0;
        errdefer for (views[0..built]) |*v| v.deinit();
        for (Period.all, 0..) |period, i| {
            views[i] = try view.build(gpa, entry, period, now);
            built += 1;
        }
        const status: Status = if (self.unavailable) |u|
            .{ .unavailable = u }
        else if (self.fetch_state.in_flight)
            .fetching
        else if (self.failure) |f|
            .{ .failed = f }
        else
            .ready;
        return .{
            .arena = arena,
            .views = views,
            .status = status,
            .label = label,
            .now_ms = now,
            .scope = if (self.session) |s| s.scope else null,
        };
    }

    /// Waits for the fetch in flight, if any. For `lia usage` and tests.
    pub fn waitForFetch(self: *Dashboard) void {
        self.runQueuedFetch();
        self.joinWorker();
    }

    /// Runs a fetch `inline_fetches` queued, without the lock: while a request
    /// waits, the host's fetch may pulse the event loop, which calls back into
    /// the dashboard to redraw.
    fn runQueuedFetch(self: *Dashboard) void {
        const job = blk: {
            self.mutex.lockUncancelable(self.io());
            defer self.mutex.unlock(self.io());
            const queued = self.queued_job orelse return;
            self.queued_job = null;
            break :blk queued;
        };
        runJob(self, job);
    }

    fn bump(self: *Dashboard) void {
        _ = self.generation.fetchAdd(1, .acq_rel);
    }

    fn joinWorker(self: *Dashboard) void {
        const thread = blk: {
            self.mutex.lockUncancelable(self.io());
            defer self.mutex.unlock(self.io());
            const t = self.worker orelse return;
            self.worker = null;
            break :blk t;
        };
        thread.join();
    }

    fn installCredentialLocked(self: *Dashboard, credential: ?Credential) void {
        const c = credential orelse {
            self.dropSessionLocked(.no_gateway_sign_in);
            return;
        };
        const team = c.team orelse "";
        if (c.scope == .member and team.len == 0) {
            self.dropSessionLocked(.no_team);
            return;
        }
        const identity = cache.identityOf(c.scope, c.subject, team);
        if (self.session) |*s| {
            if (std.mem.eql(u8, &s.identity, &identity)) {
                // Same person; take the fresher token.
                const bearer = self.gpa.dupe(u8, c.bearer) catch return;
                std.crypto.secureZero(u8, s.bearer);
                self.gpa.free(s.bearer);
                s.bearer = bearer;
                return;
            }
        }
        const bearer = self.gpa.dupe(u8, c.bearer) catch return self.dropSessionLocked(.no_gateway_sign_in);
        const team_copy: ?[]u8 = if (c.team) |t| (self.gpa.dupe(u8, t) catch {
            self.gpa.free(bearer);
            return self.dropSessionLocked(.no_gateway_sign_in);
        }) else null;
        const label = self.gpa.dupe(u8, c.label) catch {
            self.gpa.free(bearer);
            if (team_copy) |t| self.gpa.free(t);
            return self.dropSessionLocked(.no_gateway_sign_in);
        };
        const account_copy: ?[]u8 = if (c.account_id) |a| (self.gpa.dupe(u8, a) catch {
            self.gpa.free(bearer);
            if (team_copy) |t| self.gpa.free(t);
            self.gpa.free(label);
            return self.dropSessionLocked(.no_gateway_sign_in);
        }) else null;
        if (self.session) |*s| s.deinit(self.gpa);
        self.session = .{
            .identity = identity,
            .scope = c.scope,
            .bearer = bearer,
            .team = team_copy,
            .label = label,
            .account_id = account_copy,
        };
        self.unavailable = null;
        self.failure = null;
        // The floor is per sign-in: another sign-in's fetch says nothing about
        // how fresh these numbers are. A fetch still running for it finishes
        // first, so the first fetch for this one may be owed to `tick`.
        self.fetch_state.last_start_ms = null;
        self.fetch_state.failed_at_ms = null;
        self.fetch_owed = true;
        // Another identity's numbers never stay on screen (ShowsOwnIdentity).
        if (self.entry) |*e| e.deinit();
        self.entry = self.readCache(identity);
    }

    fn dropSessionLocked(self: *Dashboard, reason: Unavailable) void {
        if (self.session) |*s| s.deinit(self.gpa);
        self.session = null;
        if (self.entry) |*e| e.deinit();
        self.entry = null;
        self.unavailable = reason;
    }

    /// Re-reads this sign-in's entry from the shared cache, which other lia
    /// processes may have written since, keeping the newer of each part. The
    /// file normally holds at least what is in memory, but after it was
    /// unreadable a store may have started over from less. A missing or
    /// unreadable file keeps what is in memory.
    fn reloadEntryLocked(self: *Dashboard) void {
        const s = self.session orelse return;
        var fresh = self.readCache(s.identity) orelse return;
        const current = if (self.entry) |*e| e else {
            self.entry = fresh;
            return;
        };
        const now = self.host.now_fn(self.host.ctx);
        const merged = cache.own(self.gpa, s.identity, cache.merge(current.entry, fresh.entry, now)) catch {
            current.deinit();
            self.entry = fresh;
            return;
        };
        fresh.deinit();
        current.deinit();
        self.entry = merged;
    }

    /// A copy of the entry the dashboard holds, when it is for `identity`.
    /// Called by the worker; the copy outlives the lock.
    fn ownedEntryFor(self: *Dashboard, identity: cache.Identity) ?cache.Owned {
        self.mutex.lockUncancelable(self.io());
        defer self.mutex.unlock(self.io());
        const s = self.session orelse return null;
        if (!std.mem.eql(u8, &s.identity, &identity)) return null;
        const e = self.entry orelse return null;
        return cache.own(self.gpa, identity, e.entry) catch null;
    }

    fn readCache(self: *Dashboard, identity: cache.Identity) ?cache.Owned {
        var lia_dir = self.openFxDir() orelse return null;
        defer lia_dir.close(self.io());
        return cache.read(self.gpa, self.io(), lia_dir, identity);
    }

    /// The home directory, if the host gave an absolute one. An empty or
    /// relative `$HOME` counts as none, as everywhere else in lia.
    fn openHome(self: *Dashboard) ?Io.Dir {
        if (!Io.Dir.path.isAbsolute(self.host.home)) return null;
        return Io.Dir.openDirAbsolute(self.io(), self.host.home, .{}) catch null;
    }

    fn openFxDir(self: *Dashboard) ?Io.Dir {
        var home = self.openHome() orelse return null;
        defer home.close(self.io());
        return home.openDir(self.io(), self.host.lia_dir_name, .{}) catch null;
    }

    /// `~/.lia`, created private when missing: `lia usage` with only an API
    /// key may run before anything else made it.
    fn openOrCreateFxDir(self: *Dashboard) ?Io.Dir {
        var home = self.openHome() orelse return null;
        defer home.close(self.io());
        home.createDir(self.io(), self.host.lia_dir_name, .fromMode(0o700)) catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => return null,
        };
        return home.openDir(self.io(), self.host.lia_dir_name, .{}) catch null;
    }

    fn maybeStartLocked(self: *Dashboard, trigger: policy.Trigger) bool {
        const s = self.session orelse return false;
        const now = self.host.now_fn(self.host.ctx);
        if (!policy.due(trigger, self.is_open, self.fetch_state, now)) return false;
        // Another process may already hold today's finished days.
        self.reloadEntryLocked();
        const finished_day: ?i64 = if (self.entry) |e| (if (e.entry.finished) |f| f.day else null) else null;
        const job = Job.init(self.gpa, s, policy.plan(s.scope, finished_day, now), now) catch return false;
        if (builtin.single_threaded or self.inline_fetches) {
            // `open` and `refresh` only queue it, because a key read during
            // a model turn can call them; `tick` or `waitForFetch` runs it
            // once the lock is free.
            self.cancel.store(false, .release);
            self.queued_job = job;
        } else {
            // The previous worker has finished (in_flight is false); reap it.
            if (self.worker) |t| {
                t.join();
                self.worker = null;
            }
            self.cancel.store(false, .release);
            self.worker = std.Thread.spawn(.{}, runJob, .{ self, job }) catch {
                var j = job;
                j.deinit(self.gpa);
                return false;
            };
        }
        self.fetch_state.in_flight = true;
        self.fetch_state.last_start_ms = now;
        self.fetch_owed = false;
        return true;
    }

    fn finishJob(self: *Dashboard, job: *const Job, outcome: Outcome) void {
        self.mutex.lockUncancelable(self.io());
        defer self.mutex.unlock(self.io());
        self.fetch_state.in_flight = false;
        switch (outcome) {
            .stored => |owned| {
                self.fetch_state.failed_at_ms = null;
                const current = if (self.session) |s| std.mem.eql(u8, &s.identity, &job.identity) else false;
                if (current) {
                    // This sign-in has had its fetch.
                    self.fetch_owed = false;
                    self.failure = null;
                    if (self.entry) |*e| e.deinit();
                    self.entry = owned;
                } else {
                    // The sign-in changed mid-fetch: the answer is cached
                    // for its own identity but not shown.
                    var o = owned;
                    o.deinit();
                }
            },
            .failed => |failure| {
                // Only this sign-in's own failures hold its floor.
                const current = if (self.session) |s| std.mem.eql(u8, &s.identity, &job.identity) else false;
                if (current) {
                    self.fetch_owed = false;
                    self.fetch_state.failed_at_ms = self.host.now_fn(self.host.ctx);
                    self.failure = failure;
                }
            },
            .cancelled => {},
        }
        self.bump();
    }
};

const Outcome = union(enum) {
    stored: cache.Owned,
    failed: Failure,
    cancelled,
};

const Job = struct {
    identity: cache.Identity,
    scope: Scope,
    bearer: []u8,
    team: ?[]u8,
    account_id: ?[]u8,
    plan: policy.Plan,
    started_ms: i64,

    fn init(gpa: Allocator, s: Session, plan: policy.Plan, now: i64) !Job {
        const bearer = try gpa.dupe(u8, s.bearer);
        errdefer gpa.free(bearer);
        const team = if (s.team) |t| try gpa.dupe(u8, t) else null;
        errdefer if (team) |t| gpa.free(t);
        return .{
            .identity = s.identity,
            .scope = s.scope,
            .bearer = bearer,
            .team = team,
            .account_id = if (s.account_id) |a| try gpa.dupe(u8, a) else null,
            .plan = plan,
            .started_ms = now,
        };
    }

    fn deinit(self: *Job, gpa: Allocator) void {
        std.crypto.secureZero(u8, self.bearer);
        gpa.free(self.bearer);
        if (self.team) |t| gpa.free(t);
        if (self.account_id) |a| gpa.free(a);
    }
};

fn runJob(dashboard: *Dashboard, job_value: Job) void {
    var job = job_value;
    defer job.deinit(dashboard.gpa);
    const outcome = fetchAll(dashboard, &job);
    dashboard.finishJob(&job, outcome);
}

/// The failure that stopped a fetch, carried beside `error.Stop`.
const Run = struct {
    dashboard: *Dashboard,
    job: *const Job,
    stop: Outcome = .cancelled,
    parts: std.ArrayList(report.Rows) = .empty,

    fn deinit(self: *Run) void {
        for (self.parts.items) |*p| p.deinit();
        self.parts.deinit(self.dashboard.gpa);
    }

    fn fail(self: *Run, outcome: Outcome) error{Stop} {
        self.stop = outcome;
        return error.Stop;
    }
};

fn fetchAll(dashboard: *Dashboard, job: *const Job) Outcome {
    var run: Run = .{ .dashboard = dashboard, .job = job };
    defer run.deinit();
    const fetched = collect(&run) catch return run.stop;

    const now = dashboard.host.now_fn(dashboard.host.ctx);
    // What the dashboard holds now counts too: the plan may have skipped
    // parts it already had, and the file may hold less after it was unreadable.
    var latest = dashboard.ownedEntryFor(job.identity);
    defer if (latest) |*l| l.deinit();
    const held: ?cache.Entry = if (latest) |l| l.entry else null;
    var lia_dir = dashboard.openOrCreateFxDir() orelse return unsaved(dashboard, job, fetched, now, held);
    defer lia_dir.close(dashboard.io());
    const stored = cache.store(dashboard.gpa, dashboard.io(), lia_dir, job.identity, fetched, now, held) catch |err| switch (err) {
        // The fetch itself is unfit to keep.
        error.InvalidCache => return .{ .failed = .cache },
        else => return unsaved(dashboard, job, fetched, now, held),
    };
    return .{ .stored = stored };
}

/// What a fetch shows when the cache cannot be written (a read-only or
/// misplaced `~/.lia/usage-cache`): the fetch merged with whatever can still
/// be read, or else with what the dashboard holds, kept in memory only.
fn unsaved(dashboard: *Dashboard, job: *const Job, fetched: cache.Entry, now: i64, held: ?cache.Entry) Outcome {
    var on_disk = dashboard.readCache(job.identity);
    defer if (on_disk) |*d| d.deinit();
    const base: cache.Entry = if (on_disk) |d| (if (held) |h| cache.merge(h, d.entry, now) else d.entry) else held orelse .{};
    const merged = cache.merge(base, fetched, now);
    const owned = cache.own(dashboard.gpa, job.identity, merged) catch return .{ .failed = .cache };
    return .{ .stored = owned };
}

fn collect(run: *Run) error{Stop}!cache.Entry {
    const job = run.job;
    var fetched: cache.Entry = .{
        .today = .{ .day = job.plan.day, .at_ms = job.started_ms, .models = try fetchRows(run, job.plan.todayRange()) },
    };
    if (job.plan.finished) {
        fetched.finished = .{
            .day = job.plan.day,
            .at_ms = job.started_ms,
            .days_7 = try fetchRows(run, job.plan.weekRange()),
            .month = if (job.plan.monthRange()) |range| try fetchRows(run, range) else &.{},
        };
    }
    if (job.plan.budget) {
        // The budget line is extra: a failure here keeps the usage numbers.
        if (fetchBudget(run)) |budget| {
            if (budget) |value| fetched.budget = .{ .at_ms = job.started_ms, .value = value };
        } else |_| {}
    }
    return fetched;
}

fn fetchRows(run: *Run, range: [2]i64) error{Stop}![]const report.ModelRow {
    const job = run.job;
    const gpa = run.dashboard.gpa;
    var path_buf: [256]u8 = undefined;
    const path = report.reportPath(&path_buf, job.scope, range[0], range[1]) catch return run.fail(.{ .failed = .bad_response });
    const body = try get(run, .{
        .service = .gateway,
        .path = path,
        .bearer = job.bearer,
        .team = if (job.scope == .member) job.team else null,
    });
    defer gpa.free(body);
    var rows = report.parseModelRows(gpa, body) catch return run.fail(.{ .failed = .bad_response });
    run.parts.append(gpa, rows) catch {
        rows.deinit();
        return run.fail(.{ .failed = .bad_response });
    };
    return rows.models;
}

fn fetchBudget(run: *Run) error{Stop}!?report.Budget {
    const job = run.job;
    const team = job.team orelse return null;
    var path_buf: [256]u8 = undefined;
    const path = report.budgetPath(&path_buf, team, job.plan.day) catch return null;
    const body = try get(run, .{ .service = .vercel_api, .path = path, .bearer = job.bearer, .team = null });
    defer run.dashboard.gpa.free(body);
    return report.parseBudget(run.dashboard.gpa, body) catch run.fail(.{ .failed = .bad_response });
}

/// One GET; returns the body of a 200, or stops with the failure it maps to.
fn get(run: *Run, request: Request) error{Stop}![]u8 {
    const dashboard = run.dashboard;
    const response = dashboard.host.fetch_fn(dashboard.host.ctx, dashboard.gpa, request, &dashboard.cancel) catch |err| return run.fail(switch (err) {
        error.Cancelled => .cancelled,
        error.Unavailable, error.OutOfMemory => .{ .failed = .network },
    });
    if (response.status == 200) return response.body;
    dashboard.gpa.free(response.body);
    return run.fail(.{ .failed = statusFailure(response.status) });
}

fn statusFailure(status: u16) Failure {
    return switch (status) {
        401, 403 => .refused,
        402, 404 => .not_available,
        429 => .rate_limited,
        else => if (status >= 500) .server else .bad_response,
    };
}

test {
    _ = report;
    _ = policy;
    _ = cache;
    _ = view;
}

// ---------------------------------------------------------------------------
// Dashboard tests

const testing = std.testing;

const FakeGateway = struct {
    mutex: Io.Mutex = .init,
    now_ms: i64 = 20737 * std.time.ms_per_day + 3 * std.time.ms_per_hour,
    status: u16 = 200,
    paths: [16][160]u8 = undefined,
    path_lens: [16]usize = undefined,
    teams: [16]bool = undefined,
    accounts: [16]bool = undefined,
    count: usize = 0,
    /// While set, every request waits, so a test can keep a fetch in flight.
    held: std.atomic.Value(bool) = .init(false),
    /// When set, every request first redraws and ticks this dashboard, as the
    /// WebAssembly terminal's pulse does while a request waits.
    reenter: ?*Dashboard = null,
    reentries: usize = 0,

    const today_body = "{\"results\":[{\"model\":\"anthropic/claude-opus-5.5\",\"request_count\":10,\"input_tokens\":5,\"total_cost\":2.5}]}";
    const window_body = "{\"results\":[{\"model\":\"anthropic/claude-opus-5.5\",\"request_count\":90,\"total_cost\":40},{\"model\":\"openai/gpt-5.6-luna\",\"request_count\":7,\"total_cost\":0.5}]}";
    const budget_body = "{\"users\":[{\"budget\":{\"limitAmount\":31600,\"currentSpend\":6596.55,\"refreshPeriod\":\"monthly\"}}]}";

    const profile_body = "{\"profile\":{\"display_name\":\"samdoe\"},\"stats\":{\"lifetime_tokens\":1000," ++
        "\"daily_usage_buckets\":[{\"start_date\":\"2026-10-11\",\"tokens\":40},{\"start_date\":\"2026-10-06\",\"tokens\":2}]," ++
        "\"top_invocations\":[{\"type\":\"skill\",\"skill_name\":\"lia-review\",\"usage_count\":3}]}," ++
        "\"metadata\":{\"stats_as_of\":\"2026-10-11\"}}";
    const breakdown_body = "{\"data\":[" ++
        "{\"date\":\"2026-10-05\",\"product_surface_usage_values\":{\"desktop_app\":4},\"models\":[{\"model\":\"gpt-6-astra\",\"speed\":\"fast\",\"credits\":4}]}," ++
        "{\"date\":\"2026-10-11\",\"product_surface_usage_values\":{\"cli\":4},\"models\":[{\"model\":\"gpt-6.1-sol\",\"speed\":\"fast\",\"credits\":3},{\"model\":\"gpt-6.1-sol\",\"speed\":\"standard\",\"credits\":1}]}]," ++
        "\"units\":\"percent\",\"group_by\":\"day\"}";

    fn host(self: *FakeGateway, home: []const u8) Host {
        return .{ .ctx = self, .fetch_fn = fetch, .now_fn = now, .io_fn = testIo, .home = home };
    }

    fn now(ctx: ?*anyopaque) i64 {
        const self: *FakeGateway = @ptrCast(@alignCast(ctx.?));
        return self.now_ms;
    }

    fn testIo(_: ?*anyopaque) Io {
        return testing.io;
    }

    fn fetch(ctx: ?*anyopaque, alloc: Allocator, request: Request, _: *std.atomic.Value(bool)) FetchError!Response {
        const self: *FakeGateway = @ptrCast(@alignCast(ctx.?));
        if (self.reenter) |dashboard| {
            var redraw = try dashboard.snapshot(alloc);
            redraw.deinit();
            dashboard.tick();
            self.reentries += 1;
        }
        while (self.held.load(.acquire)) std.atomic.spinLoopHint();
        self.mutex.lockUncancelable(testing.io);
        defer self.mutex.unlock(testing.io);
        const i = self.count;
        self.count += 1;
        @memcpy(self.paths[i][0..request.path.len], request.path);
        self.path_lens[i] = request.path.len;
        self.teams[i] = request.team != null;
        self.accounts[i] = request.account_id != null;
        const body = if (request.service == .vercel_api)
            budget_body
        else if (std.mem.find(u8, request.path, "start_date=2026-10-11") != null)
            today_body
        else
            window_body;
        return .{ .status = self.status, .body = try alloc.dupe(u8, body) };
    }

    fn path(self: *FakeGateway, i: usize) []const u8 {
        return self.paths[i][0..self.path_lens[i]];
    }
};

const member: Credential = .{ .scope = .member, .bearer = "vca_token", .team = "team_1", .subject = "acct_1", .label = "team-one (lia login)" };
const api_key: Credential = .{ .scope = .api_key, .bearer = "vck_key", .team = null, .subject = "vck_key" };

fn testHome(tmp: *std.testing.TmpDir) ![:0]u8 {
    try tmp.dir.createDir(testing.io, ".lia", .fromMode(0o700));
    return tmp.dir.realPathFileAlloc(testing.io, ".", testing.allocator);
}

test "opening shows the cache at once and fills it from AI Gateway in the background" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();

    dashboard.open(member);
    dashboard.waitForFetch();
    // First fetch: today, the finished week and month, and the budget.
    try testing.expectEqual(@as(usize, 4), gateway.count);
    try testing.expectEqualStrings("/v1/report?start_date=2026-10-11&end_date=2026-10-11&group_by=model&metered_scope=user", gateway.path(0));
    try testing.expect(gateway.teams[0]);
    try testing.expectEqualStrings("/ai-gateway/usage-report?teamId=team_1&scope=user&start=2026-10-11&end=2026-10-11", gateway.path(3));

    var snap = try dashboard.snapshot(testing.allocator);
    defer snap.deinit();
    try testing.expect(snap.status == .ready);
    try testing.expectEqualStrings("team-one (lia login)", snap.label);
    try testing.expectApproxEqAbs(@as(f64, 2.5), snap.of(.today).totals.total_cost, 1e-9);
    try testing.expectApproxEqAbs(@as(f64, 43), snap.of(.days_7).totals.total_cost, 1e-9);
    try testing.expectApproxEqAbs(@as(f64, 43), snap.of(.month).totals.total_cost, 1e-9);
    try testing.expectEqual(@as(usize, 2), snap.of(.days_7).models.len);
    try testing.expectApproxEqAbs(@as(f64, 6596.55), snap.budget().?.spent, 1e-9);
    // 2026-10-11: a monthly budget resets on Nov 1.
    try testing.expectEqual(report.MonthDay{ .year = 2026, .month = 11, .day = 1 }, report.monthDay(snap.budgetResetDay().?));

    // A second process opening later reads the shared cache immediately.
    var other_gateway: FakeGateway = .{ .now_ms = gateway.now_ms + 1000 };
    var other = Dashboard.init(testing.allocator, other_gateway.host(home));
    defer other.deinit();
    other.open(member);
    var instant = try other.snapshot(testing.allocator);
    defer instant.deinit();
    try testing.expectApproxEqAbs(@as(f64, 2.5), instant.of(.today).totals.total_cost, 1e-9);
    other.waitForFetch();
    // It already has today's finished days: only today and the budget.
    try testing.expectEqual(@as(usize, 2), other_gateway.count);
}

test "without a worker thread, tick runs the fetch open started, outside the lock" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    dashboard.inline_fetches = true;
    defer dashboard.deinit();
    gateway.reenter = &dashboard;

    dashboard.open(api_key);
    // Opening only queues the fetch.
    try testing.expectEqual(@as(usize, 0), gateway.count);
    {
        var queued = try dashboard.snapshot(testing.allocator);
        defer queued.deinit();
        try testing.expect(queued.status == .fetching);
    }

    dashboard.tick();
    // Today and the finished week and month, each redrawing and ticking the
    // dashboard while it waited, without starting another fetch.
    try testing.expectEqual(@as(usize, 3), gateway.count);
    try testing.expectEqual(@as(usize, 3), gateway.reentries);
    var snap = try dashboard.snapshot(testing.allocator);
    defer snap.deinit();
    try testing.expect(snap.status == .ready);
    try testing.expectApproxEqAbs(@as(f64, 2.5), snap.of(.today).totals.total_cost, 1e-9);

    // `r` queues the next fetch, and `lia usage` runs one by waiting for it.
    try testing.expect(dashboard.refresh());
    try testing.expectEqual(@as(usize, 3), gateway.count);
    dashboard.waitForFetch();
    try testing.expectEqual(@as(usize, 4), gateway.count);
}

test "a fetch queued without a worker thread is freed if it never runs" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    dashboard.inline_fetches = true;

    dashboard.open(member);
    dashboard.deinit();
    try testing.expectEqual(@as(usize, 0), gateway.count);
    // A second deinit finds nothing left to free.
    dashboard.deinit();
}

test "a dashboard reads what another lia process stored since" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);

    // The first process fetches on Oct 10, finished days included.
    var first_gateway: FakeGateway = .{ .now_ms = 20736 * std.time.ms_per_day + 23 * std.time.ms_per_hour };
    var first = Dashboard.init(testing.allocator, first_gateway.host(home));
    defer first.deinit();
    first.open(api_key);
    first.waitForFetch();
    try testing.expectEqual(@as(usize, 3), first_gateway.count);
    first.close();

    // On Oct 11 a second process stores today and today's finished days.
    var second_gateway: FakeGateway = .{};
    var second = Dashboard.init(testing.allocator, second_gateway.host(home));
    defer second.deinit();
    second.open(api_key);
    second.waitForFetch();
    try testing.expectEqual(@as(usize, 3), second_gateway.count);

    // The first reopens and its own fetch fails: it shows the second's today.
    first_gateway.now_ms = second_gateway.now_ms + 30 * std.time.ms_per_s;
    first_gateway.status = 500;
    first.open(api_key);
    first.waitForFetch();
    try testing.expectEqual(@as(usize, 4), first_gateway.count);
    {
        var shown = try first.snapshot(testing.allocator);
        defer shown.deinit();
        try testing.expectEqual(@as(?i64, second_gateway.now_ms), shown.of(.today).fetched_at_ms);
    }

    // While the first stays open, the second stores Oct 12: the first's
    // next redraw shows it.
    second_gateway.now_ms += std.time.ms_per_day;
    try testing.expect(second.refresh());
    second.waitForFetch();
    first_gateway.now_ms = second_gateway.now_ms + 30 * std.time.ms_per_s;
    first_gateway.status = 200;
    {
        var shown = try first.snapshot(testing.allocator);
        defer shown.deinit();
        try testing.expectEqual(@as(?i64, second_gateway.now_ms), shown.of(.today).fetched_at_ms);
    }

    // On Oct 13 the second stores the finished days first; the first's
    // refresh then reads only today.
    second_gateway.now_ms += std.time.ms_per_day;
    try testing.expect(second.refresh());
    second.waitForFetch();
    first_gateway.now_ms = second_gateway.now_ms + 30 * std.time.ms_per_s;
    try testing.expect(first.refresh());
    first.waitForFetch();
    try testing.expectEqual(@as(usize, 5), first_gateway.count);
}

test "a first fetch creates a private ~/.lia for its cache" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try tmp.dir.realPathFileAlloc(testing.io, ".", testing.allocator);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();

    dashboard.open(api_key);
    dashboard.waitForFetch();
    var snap = try dashboard.snapshot(testing.allocator);
    defer snap.deinit();
    try testing.expect(snap.status == .ready);
    const stat = try tmp.dir.statFile(testing.io, ".lia", .{});
    try testing.expectEqual(std.Io.File.Kind.directory, stat.kind);
    try testing.expectEqual(@as(u32, 0o700), @as(u32, @intCast(stat.permissions.toMode() & 0o777)));
}

test "the floor holds open and the 15-minute timer, never r" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();

    dashboard.open(api_key);
    dashboard.waitForFetch();
    try testing.expectEqual(@as(usize, 3), gateway.count); // no budget for an API key
    try testing.expect(!gateway.teams[0]);
    try testing.expect(std.mem.endsWith(u8, gateway.path(0), "&api_key_id=self"));

    gateway.now_ms += 30 * std.time.ms_per_s;
    dashboard.tick();
    try testing.expectEqual(@as(usize, 3), gateway.count);
    // r fetches at once, inside the floor or not, and again after that.
    try testing.expect(dashboard.refresh());
    dashboard.waitForFetch();
    try testing.expectEqual(@as(usize, 4), gateway.count);
    try testing.expect(dashboard.refresh());
    dashboard.waitForFetch();
    try testing.expectEqual(@as(usize, 5), gateway.count);
    // Reopening inside the floor shows the cache without fetching.
    dashboard.close();
    dashboard.open(api_key);
    try testing.expectEqual(@as(usize, 5), gateway.count);

    gateway.now_ms += policy.timer_ms - 1;
    dashboard.tick();
    try testing.expectEqual(@as(usize, 5), gateway.count);
    gateway.now_ms += 1;
    dashboard.tick();
    dashboard.waitForFetch();
    try testing.expectEqual(@as(usize, 6), gateway.count);

    dashboard.close();
    gateway.now_ms += policy.timer_ms;
    dashboard.tick();
    try testing.expectEqual(@as(usize, 6), gateway.count);
}

test "a refused refresh keeps the cached numbers and says why" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();
    dashboard.open(member);
    dashboard.waitForFetch();

    gateway.status = 403;
    gateway.now_ms += policy.floor_ms;
    try testing.expect(dashboard.refresh());
    dashboard.waitForFetch();
    var today = try dashboard.snapshot(testing.allocator);
    defer today.deinit();
    try testing.expectEqual(Status{ .failed = .refused }, today.status);
    try testing.expectApproxEqAbs(@as(f64, 2.5), today.of(.today).totals.total_cost, 1e-9);
}

test "another sign-in never shows the previous one's numbers" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();
    dashboard.open(member);
    dashboard.waitForFetch();

    dashboard.close();
    dashboard.open(.{ .scope = .member, .bearer = "vca_other", .team = "team_1", .subject = "acct_2" });
    var other = try dashboard.snapshot(testing.allocator);
    defer other.deinit();
    try testing.expectEqual(@as(usize, 0), other.of(.today).models.len);
    try testing.expectEqualStrings("", other.label);
    dashboard.waitForFetch();

    dashboard.open(null);
    var none = try dashboard.snapshot(testing.allocator);
    defer none.deinit();
    try testing.expectEqual(Status{ .unavailable = .no_gateway_sign_in }, none.status);
    try testing.expectEqual(@as(usize, 0), none.of(.month).models.len);

    dashboard.open(.{ .scope = .member, .bearer = "vca_token", .team = null, .subject = "acct_1" });
    var no_team = try dashboard.snapshot(testing.allocator);
    defer no_team.deinit();
    try testing.expectEqual(Status{ .unavailable = .no_team }, no_team.status);

    dashboard.openUnavailable(.unsupported_provider);
    var elsewhere = try dashboard.snapshot(testing.allocator);
    defer elsewhere.deinit();
    try testing.expectEqual(Status{ .unavailable = .unsupported_provider }, elsewhere.status);
    try testing.expectEqual(@as(usize, 0), elsewhere.of(.month).models.len);
}

test "a clock corrected backward does not freeze /usage" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    const real = gateway.now_ms;
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();

    // The clock ran a day ahead when this was fetched and stored.
    gateway.now_ms = real + std.time.ms_per_day;
    dashboard.open(api_key);
    dashboard.waitForFetch();
    dashboard.close();

    // Corrected: reopening fetches at once, and the result is shown and kept.
    gateway.now_ms = real;
    const before = gateway.count;
    dashboard.open(api_key);
    dashboard.waitForFetch();
    // Today plus the finished days, which were stored for tomorrow.
    try testing.expectEqual(@as(usize, 3), gateway.count - before);
    {
        var shown = try dashboard.snapshot(testing.allocator);
        defer shown.deinit();
        try testing.expectEqual(Status.ready, shown.status);
        try testing.expect(shown.of(.today).today_current);
        try testing.expectEqual(real, shown.of(.today).fetched_at_ms.?);
        try testing.expect(shown.of(.days_7).finished_current);
    }

    // The next refresh reads only today again.
    gateway.now_ms = real + 2 * std.time.ms_per_min;
    const again = gateway.count;
    try testing.expect(dashboard.refresh());
    dashboard.waitForFetch();
    try testing.expectEqual(@as(usize, 1), gateway.count - again);
}

test "an unreadable cache file keeps the finished days on screen and in the file" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();

    dashboard.open(api_key);
    dashboard.waitForFetch();

    // Something else (garbage, or another lia version's schema) replaces the file.
    const identity = cache.identityOf(.api_key, api_key.subject, "");
    var name_buf: [128]u8 = undefined;
    const name = try std.mem.print(&name_buf, ".lia/{s}/{s}.json", .{ cache.dir_name, &identity });
    try tmp.dir.writeFile(testing.io, .{ .sub_path = name, .data = "{\"schema_version\":3}" });

    gateway.now_ms += 2 * std.time.ms_per_min;
    const before = gateway.count;
    try testing.expect(dashboard.refresh());
    dashboard.waitForFetch();
    // Only today is read; the finished days come from what the fetch was planned from.
    try testing.expectEqual(@as(usize, 1), gateway.count - before);
    {
        var shown = try dashboard.snapshot(testing.allocator);
        defer shown.deinit();
        try testing.expect(shown.of(.days_7).finished_current);
        try testing.expect(shown.of(.days_7).totals.total_cost > 40);
    }
    // The file has them again for every other lia process.
    var other = Dashboard.init(testing.allocator, gateway.host(home));
    defer other.deinit();
    other.open(api_key);
    var seen = try other.snapshot(testing.allocator);
    defer seen.deinit();
    try testing.expect(seen.of(.days_7).finished_current);
}

test "a cache that cannot be written still shows what was fetched" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    // `usage-cache` is a file, so nothing can be stored.
    try tmp.dir.writeFile(testing.io, .{ .sub_path = ".lia/" ++ cache.dir_name, .data = "not a directory" });
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();

    dashboard.open(api_key);
    dashboard.waitForFetch();
    var shown = try dashboard.snapshot(testing.allocator);
    defer shown.deinit();
    try testing.expectEqual(Status.ready, shown.status);
    try testing.expect(shown.of(.today).today_current);
    try testing.expect(shown.of(.days_7).finished_current);
}

test "a dashboard never shows less than it had when the file goes back" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();
    dashboard.open(api_key);
    dashboard.waitForFetch();

    // A store that started over from an unreadable file left an older entry.
    const identity = cache.identityOf(.api_key, api_key.subject, "");
    const older = try cache.encode(testing.allocator, identity, .{
        .today = .{ .day = report.utcDay(gateway.now_ms), .at_ms = gateway.now_ms - std.time.ms_per_hour, .models = &.{} },
    });
    defer testing.allocator.free(older);
    var name_buf: [128]u8 = undefined;
    const name = try std.mem.print(&name_buf, ".lia/{s}/{s}.json", .{ cache.dir_name, &identity });
    try tmp.dir.writeFile(testing.io, .{ .sub_path = name, .data = older });

    var shown = try dashboard.snapshot(testing.allocator);
    defer shown.deinit();
    try testing.expectEqual(gateway.now_ms, shown.of(.today).fetched_at_ms.?);
    try testing.expect(shown.of(.days_7).finished_current);
}

test "an empty or relative home is no home, and a fetch still shows" {
    for ([_][]const u8{ "", "relative/home" }) |home| {
        var gateway: FakeGateway = .{};
        var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
        defer dashboard.deinit();
        dashboard.open(api_key);
        dashboard.waitForFetch();
        var shown = try dashboard.snapshot(testing.allocator);
        defer shown.deinit();
        try testing.expectEqual(@as(?i64, gateway.now_ms), shown.of(.today).fetched_at_ms);
    }
}

test "a sign-in that arrives during another's fetch gets its fetch when that one ends" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try testHome(&tmp);
    defer testing.allocator.free(home);
    var gateway: FakeGateway = .{};
    var dashboard = Dashboard.init(testing.allocator, gateway.host(home));
    defer dashboard.deinit();
    gateway.held.store(true, .release);
    dashboard.open(member);

    dashboard.close();
    dashboard.open(api_key);
    gateway.held.store(false, .release);
    dashboard.waitForFetch();
    var before = try dashboard.snapshot(testing.allocator);
    defer before.deinit();
    // The member's numbers are cached for the member, not shown to the key.
    try testing.expectEqual(@as(?Scope, .api_key), before.scope);
    try testing.expect(before.of(.today).fetched_at_ms == null);

    // The next event-loop pass starts it, without waiting out any floor.
    dashboard.tick();
    dashboard.waitForFetch();
    var after = try dashboard.snapshot(testing.allocator);
    defer after.deinit();
    try testing.expectEqual(@as(?Scope, .api_key), after.scope);
    try testing.expectEqual(@as(?i64, gateway.now_ms), after.of(.today).fetched_at_ms);
    // Owed once: later passes wait for the 15-minute timer.
    const fetched = gateway.count;
    dashboard.tick();
    dashboard.waitForFetch();
    try testing.expectEqual(fetched, gateway.count);
}
