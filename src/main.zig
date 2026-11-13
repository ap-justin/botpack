const std = @import("std");
const agents = @import("core/agents/agents.zig");
const builtin = @import("builtin");
const build_options = @import("build_options");
const io_mod = @import("core/shared/io.zig");
const profile_paths = @import("core/shared/profile_paths.zig");
const terminal_env = @import("core/shared/terminal_env.zig");
pub const version = "0.1.1";
const auth_runtime = @import("core/auth/auth_runtime.zig");
const credentials = @import("core/auth/credentials.zig");
const app_entry_runtime = @import("core/app/app_entry_runtime.zig");
const acp_runner = @import("core/cli/acp_runner.zig");
const acp_server = @import("acp/server.zig");
const context_contract = @import("core/workspace/context_contract.zig");
const agent_steps = @import("core/config/agent_steps.zig");
const prompt_policy = @import("core/config/prompt_policy.zig");
const builtin_commands = @import("builtins/commands.zig");
const command_specs = @import("core/slash_commands/command_specs.zig");
const builtin_context = @import("builtins/context.zig");
const builtin_gateway = @import("builtins/gateway.zig");
const builtin_providers = @import("builtins/providers.zig");
const gateway_provider = @import("core/gateway/gateway_provider.zig");
const provider_set = @import("core/gateway/provider_set.zig");
const builtin_mcp = @import("builtins/mcp.zig");
const builtin_modes = @import("builtins/modes.zig");
const builtin_skills = @import("builtins/skills.zig");
const host_target = @import("core/hosts/target.zig");
const native_host = @import("core/hosts/native.zig");
const cli_surface = @import("core/cli/cli_surface.zig");
const command_runner = @import("core/execution/command_runner.zig");
const shell_process_provider = @import("tools/shell/process_provider.zig");
const process_provider = @import("core/execution/process_provider.zig");
const terminal_native_session = @import("core/terminal/native_session.zig");
const builtin_tools = @import("builtins/tools.zig");
const url_opener = @import("core/hosts/url_opener.zig");

const Allocator = std.mem.Allocator;
const RawEnviron = io_mod.RawEnviron;
const default_max_agent_steps: usize = agent_steps.default_max_agent_steps;
const native_gateway_provider = builtin_gateway.provider;
const max_history_turns = agents.max_history_turns;
const max_list_entries: usize = 100;
const max_read_file_bytes: usize = 50 * 1024;
const max_read_file_lines: usize = 400;
const max_read_file_line_len: usize = 2000;
const max_command_output_bytes: usize = 64 * 1024;
const ignored_list_entries = [_][]const u8{
    ".git",
    ".zig-cache",
    "zig-out",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
};
const default_context_registry = context_contract.Registry{ .default_provider = builtin_context.provider };

comptime {
    if (!builtin.is_test and !host_target.is_wasm) {
        @export(&main, .{ .name = "main" });
    }
}

pub fn main(c_argc: c_int, c_argv: [*][*:0]c_char, c_envp: [*:null]?[*:0]c_char) callconv(.c) c_int {
    io_mod.reserveClosedStandardStreams();
    mainC(c_argc, c_argv, c_envp) catch return 1;
    return 0;
}

fn mainC(c_argc: c_int, c_argv: [*][*:0]c_char, c_envp: [*:null]?[*:0]c_char) !void {
    const raw_args = rawArgs(c_argc, c_argv);
    const raw_env: RawEnviron = @ptrCast(c_envp);
    // Before any mode runs, since terminal helpers write under lia's folder too.
    try useLiaHomeFromEnv(raw_env);

    if (comptime terminal_native_session.isSupported()) {
        if (terminal_native_session.isControlModeRaw(raw_args)) {
            io_mod.setRawEnviron(raw_env);
            const process_args = argsFromRaw(raw_args);
            var threaded = std.Io.Threaded.init(processAllocator(), processIoOptions(process_args, environBlockFromRaw(raw_env)));
            defer threaded.deinit();
            io_mod.setIo(threaded.io());
            try terminal_native_session.runControlMarker(raw_args);
            return;
        }
        if (terminal_native_session.isLauncherModeRaw(raw_args)) {
            io_mod.setRawEnviron(raw_env);
            const process_args = argsFromRaw(raw_args);
            var threaded = std.Io.Threaded.init(processAllocator(), processIoOptions(process_args, environBlockFromRaw(raw_env)));
            defer threaded.deinit();
            io_mod.setIo(threaded.io());
            try terminal_native_session.runLauncher(processAllocator());
            return;
        }
    }

    if (shouldRunBenchmarkNoArgRaw(raw_args, raw_env)) {
        switch (cli_surface.parse(builtin_commands.top_level_registry, &.{})) {
            .interactive => exitFast(0),
            else => exitFast(1),
        }
    }

    var cli_arg_buf: [64][:0]const u8 = undefined;
    const cli_args = if (raw_args.len <= 1) &.{} else try cliArgsFromRaw(raw_args, &cli_arg_buf);
    if (command_runner.isForegroundSessionInvocation(cli_args)) {
        io_mod.setRawEnviron(raw_env);
        const process_args = argsFromRaw(raw_args);
        var threaded = std.Io.Threaded.init(processAllocator(), processIoOptions(process_args, environBlockFromRaw(raw_env)));
        defer threaded.deinit();
        io_mod.setIo(threaded.io());
        try command_runner.runForegroundSessionBootstrap(cli_args);
        return;
    }
    if (cli_args.len > 0 and isTopLevelHelp(cli_args)) {
        try writeTopLevelHelpFast(raw_env);
        exitFast(0);
    }
    try runNonBenchmark(raw_args, raw_env, cli_args);
}

/// `LIA_HOME` replaces `~/.lia` for the whole process. A bad value stops
/// lia before it reads or writes anything there.
fn useLiaHomeFromEnv(raw_env: RawEnviron) !void {
    const value = rawEnvValue(raw_env, "LIA_HOME") orelse return;
    profile_paths.useLiaHome(value, rawEnvValue(raw_env, "HOME")) catch |err| {
        try writeStderrFast(switch (err) {
            error.LiaHomeNotAbsolute => "lia: LIA_HOME must be an absolute path\n",
            error.LiaHomeIsRoot => "lia: LIA_HOME can't be the root folder\n",
            error.LiaHomeIsHome => "lia: LIA_HOME can't be your home folder; lia keeps its folder private\n",
        });
        exitFast(1);
    };
    if (namesNonFolderRaw(value)) {
        try writeStderrFast("lia: LIA_HOME must name a folder, but it or a folder above it is a file\n");
        exitFast(1);
    }
    // lia creates its own folder on first use, but opens the folder that holds
    // it directly, so that one has to exist.
    if (profile_paths.liaHomeParent()) |parent| createFolderPathRaw(parent);
}

/// Whether `path` is a file, or a path through one, rather than a folder or
/// nothing yet. Asking for `path/` makes the system resolve it as a folder.
/// This runs before lia's I/O is set up, so it calls libc.
fn namesNonFolderRaw(path: []const u8) bool {
    var buffer: [std.Io.Dir.max_path_bytes + 2]u8 = undefined;
    const trimmed = std.mem.trimEnd(u8, path, "/");
    if (trimmed.len == 0 or trimmed.len + 2 > buffer.len) return false;
    @memcpy(buffer[0..trimmed.len], trimmed);
    buffer[trimmed.len] = '/';
    buffer[trimmed.len + 1] = 0;
    const rc = std.c.access(@ptrCast(&buffer), std.c.F_OK);
    return rc != 0 and std.posix.errno(rc) == .NOTDIR;
}

test "LIA_HOME is refused only when it is a file or a path through one" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io_mod.getIo(), .{ .sub_path = "file", .data = "" });
    try tmp.dir.createDirPath(io_mod.getIo(), "folder");
    const root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, ".");
    defer std.testing.allocator.free(root);

    const cases = [_]struct { sub: []const u8, refused: bool }{
        .{ .sub = "file", .refused = true },
        .{ .sub = "file/", .refused = true },
        .{ .sub = "file/lia", .refused = true },
        .{ .sub = "folder", .refused = false },
        .{ .sub = "folder/lia", .refused = false },
        .{ .sub = "missing", .refused = false },
    };
    for (cases) |case| {
        const path = try std.Io.Dir.path.join(std.testing.allocator, &.{ root, case.sub });
        defer std.testing.allocator.free(path);
        try std.testing.expectEqual(case.refused, namesNonFolderRaw(path));
    }
}

/// Creates `path` and every folder above it that is missing. This runs before
/// lia's I/O is set up, so it calls libc; a folder that already exists, or
/// one lia can't create, is left for the first use to report.
fn createFolderPathRaw(path: []const u8) void {
    var buffer: [std.Io.Dir.max_path_bytes + 1]u8 = undefined;
    if (path.len == 0 or path.len >= buffer.len) return;
    var end: usize = 1;
    while (end <= path.len) : (end += 1) {
        if (end != path.len and path[end] != '/') continue;
        @memcpy(buffer[0..end], path[0..end]);
        buffer[end] = 0;
        _ = std.c.mkdir(@ptrCast(&buffer), 0o755);
    }
}

fn writeTopLevelHelpFast(raw_env: RawEnviron) !void {
    const columns = topLevelHelpColumns(raw_env);
    const style = topLevelHelpStyle(raw_env);
    var buffer: [builtin_commands.top_level_help_fast_buffer_bytes]u8 = undefined;
    var fixed: std.heap.FixedBufferAllocator = .init(&buffer);
    const text = try command_specs.renderTopLevelHelpWithStyle(
        fixed.allocator(),
        builtin_commands.top_level_registry,
        columns,
        version,
        style,
    );
    try writeStdoutFast(text);
}

fn runNonBenchmark(raw_args: []const [*:0]const u8, raw_env: RawEnviron, cli_args: []const [:0]const u8) !void {
    io_mod.setRawEnviron(raw_env);

    const alloc = processAllocator();
    const auth_mode = credentials.parseAuthMode(rawEnvValue(raw_env, "LIA_AUTH_MODE")) catch {
        try writeStderrFast("lia: LIA_AUTH_MODE must be local or host-managed\n");
        exitFast(1);
    };
    const cfg = if (cli_args.len == 0)
        emptyEntryConfig(auth_mode)
    else if (needsFullEntryConfig(cli_args))
        fullEntryConfig(auth_mode)
    else
        localEntryConfig(auth_mode);

    var early_threaded: ?std.Io.Threaded = null;
    defer if (early_threaded) |*threaded| threaded.deinit();
    if (needsEarlyThreadedIo(cli_args)) {
        const env_block = environBlockFromRaw(raw_env);
        const process_args = argsFromRaw(raw_args);
        early_threaded = std.Io.Threaded.init(alloc, processIoOptions(process_args, env_block));
        if (early_threaded) |*threaded| io_mod.setIo(threaded.io());
    }

    const before = try app_entry_runtime.runBeforeInteractive(alloc, cli_args, cfg);
    switch (before) {
        .returned => exitFast(0),
        .exit => |code| exitFast(code),
    }
}

fn rawArgs(c_argc: c_int, c_argv: [*][*:0]c_char) []const [*:0]const u8 {
    const argc: usize = @intCast(c_argc);
    const argv: [*][*:0]const u8 = @ptrCast(c_argv);
    return argv[0..argc];
}

fn argsFromRaw(raw_args: []const [*:0]const u8) std.process.Args {
    return .{ .vector = raw_args };
}

/// Options for every process Io. lia starts its own tasks with `io.concurrent`,
/// and they count against the capacity that limits `io.async`. Once lia holds
/// that many tasks, std runs each `io.async` call inline, so
/// `HostName.connect` tries a host's addresses one at a time and waits on an
/// unreachable address instead of returning the reachable one.
fn processIoOptions(process_args: std.process.Args, env_block: std.process.Environ.Block) std.Io.Threaded.InitOptions {
    return .{
        .argv0 = .init(process_args),
        .environ = .{ .block = env_block },
        .async_limit = .unlimited,
    };
}

fn environBlockFromRaw(raw_env: RawEnviron) std.process.Environ.Block {
    var count: usize = 0;
    while (raw_env[count] != null) : (count += 1) {}
    return .{ .slice = raw_env[0..count :null] };
}

fn shouldRunBenchmarkNoArgRaw(raw_args: []const [*:0]const u8, raw_env: RawEnviron) bool {
    return raw_args.len <= 1 and benchmarkEnvPresent(raw_env);
}

fn benchmarkEnvPresent(raw_env: RawEnviron) bool {
    if (comptime builtin.link_libc) {
        if (std.c.getenv("LIA_BENCH") != null) return true;
    }
    return rawEnvHas(raw_env, "LIA_BENCH");
}

fn rawEnvHas(raw_env: RawEnviron, comptime key: []const u8) bool {
    return rawEnvValue(raw_env, key) != null;
}

fn rawEnvValue(raw_env: RawEnviron, comptime key: []const u8) ?[]const u8 {
    @setRuntimeSafety(false);
    var i: usize = 0;
    while (raw_env[i]) |entry_z| : (i += 1) {
        const entry = std.mem.sliceTo(entry_z, 0);
        if (entry.len <= key.len or entry[key.len] != '=') continue;
        if (std.mem.eql(u8, entry[0..key.len], key)) return entry[key.len + 1 ..];
    }
    return null;
}

fn topLevelHelpColumns(raw_env: RawEnviron) usize {
    if (stdoutTerminalColumns()) |columns| return columns;
    if (rawEnvValue(raw_env, "COLUMNS")) |value| {
        if (parseColumnCount(value)) |columns| return columns;
    }
    if (comptime builtin.link_libc) {
        if (std.c.getenv("COLUMNS")) |value_z| {
            if (parseColumnCount(std.mem.sliceTo(value_z, 0))) |columns| return columns;
        }
    }
    return command_specs.top_level_help_default_width;
}

fn topLevelHelpStyle(raw_env: RawEnviron) command_specs.HelpStyle {
    const no_color = terminal_env.noColorValue(rawEnvValue(raw_env, "NO_COLOR"));
    const dumb_terminal = terminal_env.dumbTerminalValue(rawEnvValue(raw_env, "TERM"));
    return topLevelHelpStyleForValues(stdoutIsTerminal(), no_color, dumb_terminal);
}

fn topLevelHelpStyleForValues(is_terminal: bool, no_color: bool, dumb_terminal: bool) command_specs.HelpStyle {
    return if (is_terminal and !no_color and !dumb_terminal) .ansi else .plain;
}

fn stdoutIsTerminal() bool {
    if (comptime builtin.target.os.tag == .windows or !builtin.link_libc) return false;
    return std.c.isatty(std.posix.STDOUT_FILENO) != 0;
}

fn stdoutTerminalColumns() ?usize {
    if (comptime builtin.target.os.tag == .windows or !builtin.link_libc) return null;

    var ws: std.posix.winsize = .{ .row = 0, .col = 0, .xpixel = 0, .ypixel = 0 };
    const req: c_int = @intCast(std.c.T.IOCGWINSZ);
    const rc = std.c.ioctl(std.posix.STDOUT_FILENO, req, &ws);
    if (rc == -1 or ws.col == 0) return null;
    return @intCast(ws.col);
}

fn parseColumnCount(value: []const u8) ?usize {
    const trimmed = std.mem.trim(u8, value, " \t");
    if (trimmed.len == 0) return null;
    const columns = std.fmt.parseUnsigned(usize, trimmed, 10) catch return null;
    return if (columns == 0) null else columns;
}

fn cliArgsFromRaw(raw_args: []const [*:0]const u8, stack_buf: [][:0]const u8) ![]const [:0]const u8 {
    @setRuntimeSafety(false);
    if (comptime hasPosixArgVector()) {
        if (raw_args.len <= 1) return &.{};
        const cli_len = raw_args.len - 1;
        if (cli_len <= stack_buf.len) {
            for (raw_args[1..], 0..) |arg, i| {
                stack_buf[i] = std.mem.sliceTo(arg, 0);
            }
            return stack_buf[0..cli_len];
        }
    }

    const args = try argsFromRaw(raw_args).toSlice(processAllocator());
    return if (args.len > 0) args[1..] else args[0..0];
}

fn isTopLevelHelp(args: []const [:0]const u8) bool {
    if (args.len == 0) return false;
    return command_specs.matchesTopLevel(builtin_commands.top_level_registry, args[0], .help);
}

fn processAllocator() Allocator {
    if (comptime builtin.link_libc) return std.heap.c_allocator;
    return std.heap.page_allocator;
}

fn writeStdoutFast(text: []const u8) !void {
    @setRuntimeSafety(false);
    if (comptime builtin.target.os.tag != .windows) {
        var remaining = text;
        while (remaining.len > 0) {
            const written = std.c.write(std.posix.STDOUT_FILENO, remaining.ptr, remaining.len);
            if (written <= 0) return error.WriteFailed;
            remaining = remaining[@intCast(written)..];
        }
        return;
    }
    try std.Io.File.stdout().writeStreamingAll(io_mod.getIo(), text);
}

fn writeStderrFast(text: []const u8) !void {
    @setRuntimeSafety(false);
    if (comptime builtin.target.os.tag != .windows) {
        var remaining = text;
        while (remaining.len > 0) {
            const written = std.c.write(std.posix.STDERR_FILENO, remaining.ptr, remaining.len);
            if (written <= 0) return error.WriteFailed;
            remaining = remaining[@intCast(written)..];
        }
        return;
    }
    try std.Io.File.stderr().writeStreamingAll(io_mod.getIo(), text);
}

fn exitFast(code: u8) noreturn {
    if (comptime builtin.link_libc and builtin.target.os.tag != .windows and builtin.target.os.tag != .wasi) {
        std.c._exit(@intCast(code));
    }
    std.process.exit(code);
}

fn hasPosixArgVector() bool {
    return switch (builtin.target.os.tag) {
        .windows, .freestanding, .other => false,
        .wasi => builtin.link_libc,
        else => true,
    };
}

fn needsFullEntryConfig(args: []const [:0]const u8) bool {
    const command = cli_surface.commandAfterGlobalLaunchArgs(args) orelse return false;
    return std.mem.eql(u8, command, "ask") or
        std.mem.eql(u8, command, "acp") or
        std.mem.eql(u8, command, "pr") or
        std.mem.eql(u8, command, "issue");
}

fn needsEarlyThreadedIo(args: []const [:0]const u8) bool {
    if (needsFullEntryConfig(args)) return true;
    const effective_args = cli_surface.argsAfterGlobalLaunchArgs(args);
    if (effective_args.len == 0) return false;
    const command = effective_args[0];
    if (std.mem.eql(u8, command, "mcp")) {
        if (effective_args.len < 2) return false;
        // `add` connects to a new HTTP server to sign in when it needs a login.
        return (effective_args.len >= 3 and std.mem.eql(u8, effective_args[1], "add")) or
            std.mem.eql(u8, effective_args[1], "auth") or
            std.mem.eql(u8, effective_args[1], "list") or
            std.mem.eql(u8, effective_args[1], "logout") or
            // The MCP verbs start a host or delete a stored login.
            std.mem.eql(u8, effective_args[1], "show") or
            std.mem.eql(u8, effective_args[1], "login") or
            std.mem.eql(u8, effective_args[1], "remove") or
            std.mem.eql(u8, effective_args[1], "approve") or
            std.mem.eql(u8, effective_args[1], "reject");
    }
    return std.mem.eql(u8, command, "login") or
        std.mem.eql(u8, command, "logout") or
        std.mem.eql(u8, command, "teams") or
        std.mem.eql(u8, command, "provider") or
        std.mem.eql(u8, command, "setup") or
        // Resolve a stored credential, which reads the platform key store out of process.
        std.mem.eql(u8, command, "status") or
        std.mem.eql(u8, command, "doctor") or
        std.mem.eql(u8, command, "models") or
        std.mem.eql(u8, command, "credits") or
        std.mem.eql(u8, command, "balance") or
        // Reads AI Gateway usage reports over HTTP with a deadline.
        std.mem.eql(u8, command, "usage");
}

test "every alias of an early threaded io command uses early threaded io" {
    const alloc = std.testing.allocator;
    for (builtin_commands.top_level_specs) |spec| {
        const token = try alloc.dupeSentinel(u8, spec.token, 0);
        defer alloc.free(token);
        if (!needsEarlyThreadedIo(&.{token})) continue;
        for (spec.aliases) |alias| {
            const alias_arg = try alloc.dupeSentinel(u8, alias, 0);
            defer alloc.free(alias_arg);
            try std.testing.expect(needsEarlyThreadedIo(&.{alias_arg}));
        }
    }
}

test "credential-reading commands use early threaded io without full entry config" {
    for ([_][:0]const u8{ "status", "doctor", "models", "credits" }) |command| {
        const args = &.{command};
        try std.testing.expect(!needsFullEntryConfig(args));
        try std.testing.expect(needsEarlyThreadedIo(args));
    }
}

test "MCP credential commands use early threaded io" {
    try std.testing.expect(needsEarlyThreadedIo(&.{ "mcp", "add", "slack" }));
    try std.testing.expect(needsEarlyThreadedIo(&.{ "mcp", "add", "web", "https://w.example/mcp" }));
    try std.testing.expect(needsEarlyThreadedIo(&.{ "mcp", "add", "--no-login", "web", "https://w.example/mcp" }));
    for ([_][:0]const u8{ "auth", "list", "logout", "show", "login", "remove", "approve", "reject" }) |operation| {
        try std.testing.expect(needsEarlyThreadedIo(&.{
            @as([:0]const u8, "mcp"),
            operation,
            @as([:0]const u8, "fixture"),
        }));
    }
    for ([_][:0]const u8{ "add", "path" }) |operation| {
        try std.testing.expect(!needsEarlyThreadedIo(&.{
            @as([:0]const u8, "mcp"),
            operation,
        }));
    }
}

test "early threaded io is resolved after global launch args" {
    try std.testing.expect(needsEarlyThreadedIo(&.{
        @as([:0]const u8, "--add-dir"),
        @as([:0]const u8, "/tmp/shared"),
        @as([:0]const u8, "status"),
    }));
    try std.testing.expect(needsEarlyThreadedIo(&.{
        @as([:0]const u8, "--no-additional-dirs"),
        @as([:0]const u8, "login"),
    }));
    try std.testing.expect(needsEarlyThreadedIo(&.{
        @as([:0]const u8, "--model"),
        @as([:0]const u8, "provider/model"),
        @as([:0]const u8, "--fast"),
        @as([:0]const u8, "status"),
    }));
    try std.testing.expect(needsEarlyThreadedIo(&.{
        @as([:0]const u8, "--provider"),
        @as([:0]const u8, "gateway"),
        @as([:0]const u8, "login"),
    }));
    try std.testing.expect(needsFullEntryConfig(&.{
        @as([:0]const u8, "--provider=gateway"),
        @as([:0]const u8, "ask"),
    }));
    try std.testing.expect(needsFullEntryConfig(&.{
        @as([:0]const u8, "--effort=high"),
        @as([:0]const u8, "--no-fast"),
        @as([:0]const u8, "ask"),
    }));
}

test "full entry config commands also use early threaded io" {
    try std.testing.expect(needsEarlyThreadedIo(&.{@as([:0]const u8, "ask")}));
    try std.testing.expect(needsEarlyThreadedIo(&.{@as([:0]const u8, "acp")}));
    try std.testing.expect(needsEarlyThreadedIo(&.{@as([:0]const u8, "pr")}));
    try std.testing.expect(needsEarlyThreadedIo(&.{@as([:0]const u8, "issue")}));
    try std.testing.expect(needsEarlyThreadedIo(&.{
        @as([:0]const u8, "--add-dir"),
        @as([:0]const u8, "/tmp/shared"),
        @as([:0]const u8, "ask"),
    }));
    try std.testing.expect(needsEarlyThreadedIo(&.{
        @as([:0]const u8, "--context-limit=project_bytes=2048"),
        @as([:0]const u8, "--no-additional-dirs"),
        @as([:0]const u8, "acp"),
    }));
}

test "lightweight local commands do not request early threaded io" {
    try std.testing.expect(!needsEarlyThreadedIo(&.{}));
    for ([_][:0]const u8{ "help", "sessions", "tasks", "permissions" }) |command| {
        try std.testing.expect(!needsEarlyThreadedIo(&.{command}));
    }
}

test "process io connects through a reachable address while lia tasks hold every async slot" {
    // This test builds the process Io from processIoOptions instead of using
    // std.testing.io, because those options are what it checks. Only name
    // lookup and the unreachable address are faked. std's HostName.connect,
    // Io.Threaded, and the loopback socket are real.
    const Fake = struct {
        var base: std.Io.VTable = undefined;
        var vtable: std.Io.VTable = undefined;
        var port: u16 = 0;

        // A connect to this address never completes, like a black-holed IPv6
        // route, until std cancels the losing attempt.
        fn blackHoleAt(port_number: u16) std.Io.net.IpAddress {
            return .{ .ip4 = .{ .bytes = .{ 192, 0, 2, 1 }, .port = port_number } };
        }

        fn lookup(
            userdata: ?*anyopaque,
            _: std.Io.net.HostName,
            resolved: *std.Io.Queue(std.Io.net.HostName.LookupResult),
            options: std.Io.net.HostName.LookupOptions,
        ) std.Io.net.HostName.LookupError!void {
            const io: std.Io = .{ .userdata = userdata, .vtable = &vtable };
            defer resolved.close(io);
            resolved.putAll(io, &.{
                .{ .address = blackHoleAt(options.port) },
                .{ .address = .{ .ip4 = .{ .bytes = .{ 127, 0, 0, 1 }, .port = options.port } } },
            }) catch return error.UnknownHostName;
        }

        fn connect(
            userdata: ?*anyopaque,
            address: *const std.Io.net.IpAddress,
            options: std.Io.net.IpAddress.ConnectOptions,
        ) std.Io.net.IpAddress.ConnectError!std.Io.net.Socket {
            if (address.eql(&blackHoleAt(address.getPort()))) {
                const io: std.Io = .{ .userdata = userdata, .vtable = &vtable };
                var never: std.Io.Event = .unset;
                try never.wait(io);
                unreachable;
            }
            return base.netConnectIp(userdata, address, options);
        }

        fn hold(gate: *std.Io.Event, io: std.Io) void {
            gate.wait(io) catch {};
        }

        fn dial(io: std.Io) !std.Io.net.Stream {
            const name = try std.Io.net.HostName.init("gateway.test");
            return name.connect(io, port, .{ .mode = .stream });
        }

        fn expire(io: std.Io) std.Io.Cancelable!void {
            try io.sleep(.fromMilliseconds(5000), .awake);
        }
    };

    const argv = [_][*:0]const u8{"lia"};
    const environ = [_:null]?[*:0]const u8{};
    var threaded = std.Io.Threaded.init(std.testing.allocator, processIoOptions(.{ .vector = &argv }, .{ .slice = &environ }));
    defer threaded.deinit();
    const real = threaded.io();
    Fake.base = real.vtable.*;
    Fake.vtable = Fake.base;
    Fake.vtable.netLookup = Fake.lookup;
    Fake.vtable.netConnectIp = Fake.connect;
    const io: std.Io = .{ .userdata = real.userdata, .vtable = &Fake.vtable };

    var server = try (try std.Io.net.IpAddress.parse("127.0.0.1", 0)).listen(io, .{ .reuse_address = true });
    defer server.deinit(io);
    Fake.port = server.socket.address.getPort();

    // Hold more tasks than there are CPUs, as running MCP servers, request
    // watches, and requests do.
    var gate: std.Io.Event = .unset;
    var holders: std.Io.Group = .init;
    defer {
        gate.set(io);
        holders.await(io) catch {};
    }
    const cpu_count = std.Thread.getCpuCount() catch 1;
    for (0..cpu_count + 1) |_| try holders.concurrent(io, Fake.hold, .{ &gate, io });

    const Event = union(enum) {
        dial: anyerror!std.Io.net.Stream,
        expire: std.Io.Cancelable!void,
    };
    var buffer: [2]Event = undefined;
    var select: std.Io.Select(Event) = .init(io, &buffer);
    defer while (select.cancel()) |event| switch (event) {
        .dial => |result| if (result) |stream| stream.close(io) else |_| {},
        .expire => {},
    };
    try select.concurrent(.dial, Fake.dial, .{io});
    try select.concurrent(.expire, Fake.expire, .{io});
    switch (try select.await()) {
        .dial => |result| {
            const stream = try result;
            defer stream.close(io);
            const accepted = try server.accept(io);
            accepted.close(io);
        },
        .expire => return error.ConnectWaitedOnUnreachableAddress,
    }
}

fn fullEntryConfig(auth_mode: credentials.AuthMode) app_entry_runtime.Config {
    return .{
        .version = version,
        .revision = build_options.git_commit,
        .build_channel = build_options.update_channel,
        .auth_mode = auth_mode,
        .command_catalog = builtin_commands.top_level_registry,
        .default_model = builtin_gateway.default_model,
        .default_agent_step_limit = default_max_agent_steps,
        .models_path = builtin_gateway.models_path,
        .gateway_retry_count = builtin_gateway.retry_count,
        .gateway_chat_url = builtin_gateway.default_chat_url,
        .gateway_provider = native_gateway_provider,
        .provider_set = builtin_providers.native,
        .process_provider = shell_process_provider.provider,
        .url_opener = url_opener.native_opener,
        .secret_store = native_host.secret_store,
        .prompt_policy = builtin_context.prompt_policy,
        .skill_root_policy = builtin_skills.root_policy,
        .ignored_list_entries = &ignored_list_entries,
        .max_list_entries = max_list_entries,
        .max_read_file_bytes = max_read_file_bytes,
        .max_read_file_lines = max_read_file_lines,
        .max_read_file_line_len = max_read_file_line_len,
        .max_command_output_bytes = max_command_output_bytes,
        .max_tool_result_bytes = @import("core/tooling/tool_result_limits.zig").default_max_tool_result_bytes,
        .max_history_turns = max_history_turns,
        .context_registry = default_context_registry,
        .mode_registry = builtin_modes.registry,
        .tool_set = builtin_tools.advertisement_set,
        .inspect_mcp_profile_config = builtin_mcp.inspectProfileConfig,
        .inspect_mcp_local_config = builtin_mcp.inspectLocalConfig,
        .load_mcp_host = builtin_mcp.loadHost,
        .acp_runner = .{ .run_fn = runAcpServer },
    };
}

fn localEntryConfig(auth_mode: credentials.AuthMode) app_entry_runtime.Config {
    return .{
        .version = version,
        .revision = build_options.git_commit,
        .build_channel = build_options.update_channel,
        .auth_mode = auth_mode,
        .command_catalog = builtin_commands.top_level_registry,
        .default_model = builtin_gateway.default_model,
        .default_agent_step_limit = default_max_agent_steps,
        .models_path = builtin_gateway.models_path,
        .gateway_retry_count = builtin_gateway.retry_count,
        .gateway_chat_url = builtin_gateway.default_chat_url,
        .gateway_provider = native_gateway_provider,
        .provider_set = builtin_providers.native,
        .process_provider = shell_process_provider.provider,
        .url_opener = url_opener.native_opener,
        .secret_store = native_host.secret_store,
        .prompt_policy = .{ .system_prompt = "" },
        .skill_root_policy = builtin_skills.root_policy,
        .ignored_list_entries = &.{},
        .max_list_entries = 0,
        .max_read_file_bytes = 0,
        .max_read_file_lines = 0,
        .max_read_file_line_len = 0,
        .max_command_output_bytes = 0,
        .max_tool_result_bytes = 0,
        .max_history_turns = 0,
        .context_registry = default_context_registry,
        .mode_registry = builtin_modes.registry,
        .tool_set = builtin_tools.advertisement_set,
        .inspect_mcp_profile_config = builtin_mcp.inspectProfileConfig,
        .inspect_mcp_local_config = builtin_mcp.inspectLocalConfig,
        .load_mcp_host = builtin_mcp.loadHost,
        .acp_runner = .{ .run_fn = runAcpServer },
    };
}

fn emptyEntryConfig(auth_mode: credentials.AuthMode) app_entry_runtime.Config {
    return .{
        .version = version,
        .revision = build_options.git_commit,
        .build_channel = build_options.update_channel,
        .auth_mode = auth_mode,
        .command_catalog = builtin_commands.top_level_registry,
        .default_model = "",
        .default_agent_step_limit = 0,
        .models_path = "",
        .gateway_retry_count = 0,
        .gateway_chat_url = "",
        .gateway_provider = native_gateway_provider,
        .provider_set = builtin_providers.native,
        .process_provider = shell_process_provider.provider,
        .url_opener = url_opener.native_opener,
        .secret_store = native_host.secret_store,
        .prompt_policy = .{ .system_prompt = "" },
        .skill_root_policy = builtin_skills.root_policy,
        .ignored_list_entries = &.{},
        .max_list_entries = 0,
        .max_read_file_bytes = 0,
        .max_read_file_lines = 0,
        .max_read_file_line_len = 0,
        .max_command_output_bytes = 0,
        .max_tool_result_bytes = 0,
        .max_history_turns = 0,
        .context_registry = default_context_registry,
        .mode_registry = builtin_modes.registry,
        .tool_set = builtin_tools.advertisement_set,
        .inspect_mcp_profile_config = builtin_mcp.inspectProfileConfig,
        .inspect_mcp_local_config = builtin_mcp.inspectLocalConfig,
        .load_mcp_host = builtin_mcp.loadHost,
        .acp_runner = .{ .run_fn = runAcpServer },
    };
}

fn runAcpServer(_: ?*anyopaque, alloc: Allocator, cfg: acp_runner.Config) anyerror!void {
    return acp_server.run(alloc, cfg);
}

test "raw benchmark preflight matches no-arg LIA_BENCH presence" {
    const no_args = [_][*:0]const u8{"lia"};
    const help_args = [_][*:0]const u8{ "lia", "help" };
    const bench_env = [_:null]?[*:0]const u8{"LIA_BENCH=1"};
    const empty_env = [_:null]?[*:0]const u8{};

    try std.testing.expect(shouldRunBenchmarkNoArgRaw(no_args[0..], @ptrCast(&bench_env)));
    try std.testing.expect(!shouldRunBenchmarkNoArgRaw(help_args[0..], @ptrCast(&bench_env)));
    try std.testing.expect(!shouldRunBenchmarkNoArgRaw(no_args[0..], @ptrCast(&empty_env)));
}

test "terminal help styling respects terminal capability and color opt-outs" {
    try std.testing.expectEqual(command_specs.HelpStyle.ansi, topLevelHelpStyleForValues(true, false, false));
    try std.testing.expectEqual(command_specs.HelpStyle.plain, topLevelHelpStyleForValues(false, false, false));
    try std.testing.expectEqual(command_specs.HelpStyle.plain, topLevelHelpStyleForValues(true, true, false));
    try std.testing.expectEqual(command_specs.HelpStyle.plain, topLevelHelpStyleForValues(true, false, true));
}

test {
    _ = @import("core/agent/runtime/journal.zig");
    _ = @import("acp/libfx_journal.zig");
    _ = @import("mcp/mcp.zig");
    _ = @import("core/mcp_host/runtime.zig");
    _ = @import("core/mcp_host/wire_tests.zig");
    _ = @import("core/mcp_host/mcp_call.zig");
    _ = @import("core/mcp_host/mcp_call_wire.zig");
    _ = @import("core/mcp_host/mcp_call_bridge.zig");
    _ = @import("core/mcp_host/mcp_call_client.zig");
    _ = @import("core/mcp_host/verbs.zig");
    _ = @import("core/mcp/tool_lookup.zig");
    _ = @import("core/recovery/recovery.zig");
    _ = @import("core/config/model_provider.zig");
    _ = @import("core/config/configured_provider.zig");
    _ = @import("gateway/chat_completions_protocol.zig");
    _ = @import("gateway/json_depth.zig");
    _ = @import("acp/prompt.zig");
    _ = @import("acp/server.zig");
    _ = @import("acp/sign_in.zig");
    _ = @import("acp/libfx_hooks.zig");
    _ = @import("acp/types.zig");
    _ = @import("acp/mcp_servers.zig");
    _ = @import("core/mcp_host/model.zig");
    _ = @import("core/agent/agent_runtime.zig");
    _ = @import("core/agent/execution_memory.zig");
    _ = @import("core/agent/runtime/assistant_stream.zig");
    _ = @import("core/agent/runtime/execution_memory.zig");
    _ = @import("core/agent/runtime/tool_admission.zig");
    _ = @import("core/agent/runtime/prompt_context.zig");
    _ = @import("core/agent/runtime/runtime_context.zig");
    _ = auth_runtime;
    _ = @import("core/auth/auth_transition.zig");
    _ = @import("core/workspace/context_contract.zig");
    _ = @import("core/workspace/workspace_access.zig");
    _ = @import("core/workspace/workspace_commands.zig");
    _ = @import("core/app/app_entry_runtime.zig");
    _ = @import("core/app/app_lifecycle.zig");
    _ = @import("core/app/app_runtime_setup.zig");
    _ = @import("core/app/session_persistence.zig");
    _ = @import("core/agent/assistant_presentation.zig");
    _ = @import("core/agent/presentation/inline_render.zig");
    _ = @import("core/cli/cli_ask.zig");
    _ = @import("core/cli/cli_surface.zig");
    _ = @import("core/workspace/change_tracker.zig");
    _ = @import("core/shared/collections.zig");
    _ = @import("core/slash_commands/command_specs.zig");
    _ = @import("core/config/config_runtime.zig");
    _ = @import("core/config/settings_store.zig");
    _ = @import("core/session/session_title_generation.zig");
    _ = @import("builtins/context.zig");
    _ = @import("builtins/gateway.zig");
    _ = @import("core/shared/debug_trace.zig");
    _ = @import("core/output/diff.zig");
    _ = @import("core/shared/display_width.zig");
    _ = @import("core/shared/gateway_error_format.zig");
    _ = @import("core/shared/history_range.zig");
    _ = @import("core/cli/doctor_runtime.zig");
    _ = @import("core/auth/login_flow.zig");
    _ = @import("core/auth/provider_catalog.zig");
    _ = @import("gateway/responses_protocol.zig");
    _ = credentials;
    _ = @import("core/auth/oauth.zig");
    _ = @import("core/auth/oauth_session.zig");
    _ = @import("core/workspace/file_index.zig");
    _ = @import("core/indexer/indexer.zig");
    _ = @import("core/agents/agents.zig");
    _ = @import("core/profiles/profiles.zig");
    _ = @import("gateway/vercel_protocol.zig");
    _ = @import("core/gateway/provider_set.zig");
    _ = @import("core/gateway/model_catalog.zig");
    _ = @import("core/gateway/gateway_provider.zig");
    _ = @import("gateway/chat_completions.zig");
    _ = @import("core/github/git_context.zig");
    _ = @import("core/github/github_workflows.zig");
    _ = @import("core/hosts/host.zig");
    _ = @import("core/hooks/common.zig");
    _ = @import("core/hooks/definitions.zig");
    _ = @import("core/hooks/prompt.zig");
    _ = @import("core/hooks/runtime.zig");
    _ = @import("core/images/image_attachments.zig");
    _ = @import("core/shared/input_loop_guard.zig");
    _ = @import("core/shared/io.zig");
    _ = @import("core/shared/leased_lock.zig");
    _ = @import("core/shared/message.zig");
    _ = @import("core/shared/token_estimate.zig");
    _ = @import("core/shell_command/command_effect.zig");
    _ = @import("core/shell_command/safe_git.zig");
    _ = @import("core/execution/router.zig");
    _ = @import("core/execution/command_runner.zig");
    _ = @import("core/permissions/direct_command.zig");
    _ = @import("core/permissions/auto_classifier.zig");
    _ = @import("core/permissions/command_admission.zig");
    _ = @import("core/mcp/tool_result.zig");
    _ = @import("core/mcp/tool_search.zig");
    _ = @import("core/mcp/http_config.zig");
    _ = @import("core/mcp/elicitation_interaction.zig");
    _ = @import("core/config/model_capabilities.zig");
    _ = @import("core/output/output_contracts.zig");
    _ = @import("core/workspace/pathing.zig");
    _ = @import("core/workspace/current_branch.zig");
    _ = @import("core/permissions/permission_gate.zig");
    _ = @import("core/permissions/permissions.zig");
    _ = @import("core/execution/process_identity.zig");
    _ = @import("core/execution/process_provider.zig");
    _ = @import("core/execution/managed_execution_contract.zig");
    _ = @import("core/execution/managed_execution.zig");
    _ = @import("core/execution/process_tree.zig");
    _ = @import("core/config/prompt_policy.zig");
    _ = @import("core/session/session.zig");
    _ = @import("core/session/session_json.zig");
    _ = @import("core/session/session_store.zig");
    _ = @import("core/session/session_adapter.zig");
    _ = @import("core/session/v1_conversion.zig");
    _ = @import("core/session/session_catalog_cache.zig");
    _ = @import("core/session/session_layout.zig");
    _ = @import("core/session/web_fetch_artifacts.zig");
    _ = @import("core/skills/skill_runtime.zig");
    _ = @import("core/subagent/domain.zig");
    _ = @import("core/subagent/child_state.zig");
    _ = @import("core/subagent/managed_owner.zig");
    _ = @import("core/subagent/execution.zig");
    _ = @import("core/subagent/agent_adapter.zig");
    _ = @import("core/subagent/tool_host.zig");
    _ = @import("core/subagent/authority.zig");
    _ = @import("core/subagent/approval_registry.zig");
    _ = @import("core/subagent/reports.zig");
    _ = @import("core/shared/agent_frame.zig");
    _ = @import("core/terminal/contracts.zig");
    _ = @import("core/terminal/operation.zig");
    _ = @import("core/terminal/shell_resolver.zig");
    _ = @import("core/terminal/shell_snapshot.zig");
    _ = @import("core/terminal/native_session.zig");
    _ = @import("core/terminal/recovery.zig");
    _ = @import("core/terminal/store.zig");
    _ = @import("core/terminal/client.zig");
    _ = @import("core/terminal/managed_observer.zig");
    _ = @import("tools/shell/shell.zig");
    _ = @import("tools/shell/process_provider.zig");
    _ = @import("acp/sessions.zig");
    _ = @import("core/shared/text_utils.zig");
    _ = @import("core/tooling/tool_projection.zig");
    _ = @import("core/tooling/tool_dispatch.zig");
    _ = @import("core/tooling/tool_set.zig");
    _ = @import("core/hosts/js_host_workspace.zig");
    _ = @import("core/tooling/tool_args.zig");
    _ = @import("core/tooling/tool_result_errors.zig");
    _ = @import("core/tooling/tool_runtime.zig");
    _ = @import("core/tooling/tool_specs.zig");
    _ = @import("builtins/commands.zig");
    _ = @import("builtins/mcp.zig");
    _ = @import("builtins/modes.zig");
    _ = @import("builtins/tools.zig");
    _ = @import("tools/agent/ask_user_question.zig");
    _ = @import("builtins/browser_workspace_tools.zig");
    _ = @import("core/tooling/model_request_budget.zig");
    _ = @import("core/tooling/web_fetch_runtime.zig");
    _ = @import("core/tooling/web_search_policy.zig");
    _ = @import("core/tooling/web_search_runtime.zig");
    _ = @import("gateway/web_search.zig");
    _ = @import("gateway/web_search_types.zig");
    _ = @import("tools/web/content.zig");
    _ = @import("tools/web/html_to_markdown.zig");
    _ = @import("tools/filesystem/read_file.zig");
    _ = @import("tools/session/read_tool_result.zig");
    _ = @import("tools/skills/install_skill.zig");
    _ = @import("tools/skills/skill.zig");
    _ = @import("core/shared/types.zig");
    _ = @import("core/agent/worker_runtime.zig");
    _ = @import("gateway/client.zig");
    _ = @import("gateway/host_stream_provider.zig");
    _ = @import("gateway/open_job.zig");
    _ = @import("gateway/vercel_failure_diagnostics.zig");
}
