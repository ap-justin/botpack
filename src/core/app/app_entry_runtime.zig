const std = @import("std");
const builtin = @import("builtin");
const acp_runner = @import("../cli/acp_runner.zig");
const cli_surface = @import("../cli/cli_surface.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const types = @import("../shared/types.zig");
const config_runtime = @import("../config/config_runtime.zig");
const output_contracts = @import("../output/output_contracts.zig");
const credentials = @import("../auth/credentials.zig");
const process_provider = @import("../execution/process_provider.zig");
const gateway_provider = @import("../gateway/gateway_provider.zig");
const provider_set = @import("../gateway/provider_set.zig");
const host = @import("../hosts/host.zig");
const host_target = @import("../hosts/target.zig");
const io_mod = @import("../shared/io.zig");
const prompt_policy = @import("../config/prompt_policy.zig");
const skill_contract = @import("../skills/skill_contract.zig");
const command_specs = @import("../slash_commands/command_specs.zig");
const context_contract = @import("../workspace/context_contract.zig");
const mode_registry = @import("../modes/mode_registry.zig");
const mcp_contract = @import("../mcp/mcp_contract.zig");
const mcp_health = @import("../mcp/health.zig");
const mcp_host = @import("../mcp_host/host.zig");
const tool_set_contract = @import("../tooling/tool_set.zig");
const update_target = @import("../upgrade/update_target.zig");
const test_builtin_gateway = if (builtin.is_test)
    @import("../../builtins/gateway.zig")
else
    struct {};
const test_builtin_commands = if (builtin.is_test)
    @import("../../builtins/commands.zig")
else
    struct {};

const Allocator = std.mem.Allocator;

pub const Config = struct {
    version: []const u8 = "",
    revision: []const u8 = "",
    build_channel: update_target.Channel = .stable,
    auth_mode: credentials.AuthMode = .local,
    command_catalog: command_specs.TopLevelRegistry,
    default_model: []const u8,
    default_agent_step_limit: usize,
    models_path: []const u8,
    gateway_retry_count: usize,
    gateway_chat_url: []const u8,
    gateway_provider: gateway_provider.Provider,
    provider_set: provider_set.Set,
    process_provider: process_provider.Provider = process_provider.unavailable_provider,
    url_opener: host.UrlOpener,
    secret_store: host.SecretStore,
    prompt_policy: prompt_policy.Policy,
    skill_root_policy: skill_contract.RootPolicy,
    ignored_list_entries: []const []const u8,
    max_list_entries: usize,
    max_read_file_bytes: usize,
    max_read_file_lines: usize,
    max_read_file_line_len: usize,
    max_command_output_bytes: usize,
    max_tool_result_bytes: usize,
    max_history_turns: usize,
    context_registry: context_contract.Registry,
    mode_registry: mode_registry.Registry,
    tool_set: tool_set_contract.ToolSet,
    inspect_mcp_profile_config: mcp_contract.InspectProfileConfigFn,
    inspect_mcp_local_config: mcp_health.InspectLocalConfigFn =
        mcp_health.inspectLocalConfigUnavailable,
    load_mcp_host: ?mcp_host.LoadFn = null,
    acp_runner: acp_runner.Runner,
};

pub const RunOutcome = union(enum) {
    returned,
    exit: u8,
};

pub const BeforeInteractiveResult = union(enum) {
    returned,
    exit: u8,
};

const interactive_unavailable_message = "fx: this build has no interactive terminal UI; use fx ask or fx acp\n";

const RunIfRequestedFn = *const fn (?*anyopaque, Allocator, []const [:0]const u8, cli_surface.Config) anyerror!cli_surface.RunResult;
const GetenvFn = *const fn (?*anyopaque, []const u8) ?[]const u8;
const WriteFn = *const fn (?*anyopaque, []const u8) anyerror!void;
const RunDeps = struct {
    cli_ctx: ?*anyopaque = null,
    run_if_requested: RunIfRequestedFn = if (host_target.is_wasm)
        unavailableCliDispatch
    else
        runIfRequestedDefault,
    env_ctx: ?*anyopaque = null,
    getenv: GetenvFn = getenvDefault,
    stderr_ctx: ?*anyopaque = null,
    write_stderr: WriteFn = writeRealStderr,
};

fn runWithDeps(alloc: Allocator, args: []const [:0]const u8, cfg: Config, deps: RunDeps) !RunOutcome {
    return switch (try runBeforeInteractiveWithDeps(alloc, args, cfg, deps)) {
        .returned => .returned,
        .exit => |code| .{ .exit = code },
    };
}

pub fn runBeforeInteractive(alloc: Allocator, args: []const [:0]const u8, cfg: Config) !BeforeInteractiveResult {
    return runBeforeInteractiveWithDeps(alloc, args, cfg, .{});
}

fn runBeforeInteractiveWithDeps(alloc: Allocator, args: []const [:0]const u8, cfg: Config, deps: RunDeps) !BeforeInteractiveResult {
    const run_result = deps.run_if_requested(deps.cli_ctx, alloc, args, cliSurfaceConfig(cfg)) catch |err| switch (err) {
        error.UnknownCliCommand => return .{ .exit = output_contracts.usage_exit_code },
        else => return commandFailure(deps, err),
    };

    return beforeInteractiveResultFromRunResult(deps, alloc, run_result, deps.getenv(deps.env_ctx, "FX_BENCH") != null);
}

fn beforeInteractiveResultFromRunResult(deps: RunDeps, alloc: Allocator, run_result: cli_surface.RunResult, bench: bool) BeforeInteractiveResult {
    switch (run_result) {
        .interactive => |launch| {
            var mutable_launch = launch;
            mutable_launch.deinit(alloc);
            if (bench) return .returned;
            writeStderr(deps, interactive_unavailable_message);
            return .{ .exit = 1 };
        },
        .handled_success => return .returned,
        .handled_failure => return .{ .exit = 1 },
        .handled_exit => |code| return if (code == 0) .returned else .{ .exit = code },
    }
}

fn unavailableCliDispatch(_: ?*anyopaque, _: Allocator, _: []const [:0]const u8, _: cli_surface.Config) anyerror!cli_surface.RunResult {
    return error.UnknownCliCommand;
}

fn cliSurfaceConfig(cfg: Config) cli_surface.Config {
    return .{
        .version = cfg.version,
        .revision = cfg.revision,
        .build_channel = cfg.build_channel,
        .auth_mode = cfg.auth_mode,
        .command_catalog = cfg.command_catalog,
        .default_model = cfg.default_model,
        .default_agent_step_limit = cfg.default_agent_step_limit,
        .models_path = cfg.models_path,
        .gateway_retry_count = cfg.gateway_retry_count,
        .gateway_chat_url = cfg.gateway_chat_url,
        .gateway_provider = cfg.gateway_provider,
        .provider_set = cfg.provider_set,
        .process_provider = cfg.process_provider,
        .url_opener = cfg.url_opener,
        .secret_store = cfg.secret_store,
        .prompt_policy = cfg.prompt_policy,
        .skill_root_policy = cfg.skill_root_policy,
        .ignored_list_entries = cfg.ignored_list_entries,
        .max_list_entries = cfg.max_list_entries,
        .max_read_file_bytes = cfg.max_read_file_bytes,
        .max_read_file_lines = cfg.max_read_file_lines,
        .max_read_file_line_len = cfg.max_read_file_line_len,
        .max_command_output_bytes = cfg.max_command_output_bytes,
        .max_tool_result_bytes = cfg.max_tool_result_bytes,
        .max_history_turns = cfg.max_history_turns,
        .context_registry = cfg.context_registry,
        .mode_registry = cfg.mode_registry,
        .tool_set = cfg.tool_set,
        .inspect_mcp_profile_config = cfg.inspect_mcp_profile_config,
        .inspect_mcp_local_config = cfg.inspect_mcp_local_config,
        .load_mcp_host = cfg.load_mcp_host,
        .acp_runner = cfg.acp_runner,
    };
}

fn runIfRequestedDefault(_: ?*anyopaque, alloc: Allocator, args: []const [:0]const u8, cfg: cli_surface.Config) !cli_surface.RunResult {
    return cli_surface.runIfRequested(alloc, args, cfg);
}

fn getenvDefault(_: ?*anyopaque, key: []const u8) ?[]const u8 {
    return io_mod.getenv(key);
}

fn writeRealStderr(_: ?*anyopaque, text: []const u8) !void {
    try std.Io.File.stderr().writeStreamingAll(io_mod.getIo(), text);
}

fn writeRealStdout(_: ?*anyopaque, text: []const u8) !void {
    try std.Io.File.stdout().writeStreamingAll(io_mod.getIo(), text);
}

fn writeStderr(deps: RunDeps, text: []const u8) void {
    deps.write_stderr(deps.stderr_ctx, text) catch {};
}

/// The status a shell reports for a process SIGPIPE ended: 128 + 13.
const output_reader_gone_exit_code: u8 = 141;

/// How a command that ended on `err` exits. One whose output reader went
/// away, as `head` does, ends quietly with SIGPIPE's status, as the commands
/// that finish before fx's I/O starts do when SIGPIPE ends them.
fn commandFailure(deps: RunDeps, err: anyerror) BeforeInteractiveResult {
    if (err == error.OutputReaderGone) {
        debug_trace.logf("core", "command ended after its output reader went away", .{});
        return .{ .exit = output_reader_gone_exit_code };
    }
    tryWriteErrorMessage(deps, err);
    return .{ .exit = 1 };
}

/// Reports an error that ended a command, such as `fx ask`, in plain words
/// (`types.plainErrorText`). The raw name goes only to the trace.
fn tryWriteErrorMessage(deps: RunDeps, err: anyerror) void {
    debug_trace.logf("core", "command error err={s}", .{@errorName(err)});
    var words: [128]u8 = undefined;
    writeStderr(deps, "fx: ");
    writeStderr(deps, config_runtime.modelNotSelectedMessage(err) orelse types.plainErrorText(@errorName(err), &words));
    writeStderr(deps, "\n");
}

fn gatherNoopContextForTest(_: Allocator, _: context_contract.InitialContextInput) context_contract.ProviderError!context_contract.ProviderContext {
    return .{};
}

fn appendNoopStaticContextForTest(_: context_contract.StaticContextInput, _: Allocator, _: *std.ArrayList(@import("../shared/types.zig").ChatMessage)) context_contract.ProviderError!void {}

fn appendNoopTransientContextForTest(_: context_contract.TransientContextInput, _: Allocator, _: *std.ArrayList(@import("../shared/types.zig").ChatMessage)) context_contract.ProviderError!void {}

const test_entry_context_registry = context_contract.Registry{ .default_provider = .{
    .id = "test.entry_context",
    .gather_project_context_fn = gatherNoopContextForTest,
    .select_applicable_project_context_fn = context_contract.selectNoApplicableProjectContext,
    .append_static_fn = appendNoopStaticContextForTest,
    .append_transient_fn = appendNoopTransientContextForTest,
} };

fn noMcpConfigInspectionForTest(
    _: Allocator,
) error{OutOfMemory}!mcp_contract.ProfileConfigDiagnostic {
    return .clear;
}

fn unexpectedAcpRunForTest(_: ?*anyopaque, _: Allocator, _: acp_runner.Config) anyerror!void {
    return error.TestUnexpectedAcpRun;
}

fn testConfig() Config {
    return .{
        .version = "0.2.10",
        .command_catalog = test_builtin_commands.top_level_registry,
        .default_model = "model",
        .default_agent_step_limit = 12,
        .models_path = "/models",
        .gateway_retry_count = 2,
        .gateway_chat_url = "https://gateway/chat",
        .gateway_provider = test_builtin_gateway.provider,
        .provider_set = provider_set.gateway_only(test_builtin_gateway.provider_bundle),
        .url_opener = host.unavailable_url_opener,
        .secret_store = host.unavailable_secret_store,
        .prompt_policy = .{ .system_prompt = "system" },
        .skill_root_policy = .{ .managed_root_source = .global_fx },
        .ignored_list_entries = &.{ ".git", "zig-out" },
        .max_list_entries = 100,
        .max_read_file_bytes = 1024,
        .max_read_file_lines = 10,
        .max_read_file_line_len = 80,
        .max_command_output_bytes = 2048,
        .max_tool_result_bytes = 2048,
        .max_history_turns = 32,
        .context_registry = test_entry_context_registry,
        .mode_registry = .{ .default_mode_id = "entry" },
        .inspect_mcp_profile_config = noMcpConfigInspectionForTest,
        .acp_runner = .{ .run_fn = unexpectedAcpRunForTest },
        .tool_set = .{
            .registry = .{ .tools = &.{} },
            .order = &.{"entry_test_tool"},
            .read_only_tool_names = &.{},
        },
    };
}

const TestCapture = struct {
    run_result: cli_surface.RunResult,
    /// The error the command run returns in place of `run_result`.
    cli_error: ?anyerror = null,
    cli_calls: usize = 0,
    seen_config: ?cli_surface.Config = null,
    stderr: std.Io.Writer.Allocating,
    bench_value: ?[]const u8 = null,

    fn init(run_result: cli_surface.RunResult) TestCapture {
        return .{
            .run_result = run_result,
            .stderr = .init(std.testing.allocator),
        };
    }

    fn deinit(self: *TestCapture) void {
        self.stderr.deinit();
    }

    fn deps(self: *TestCapture) RunDeps {
        return .{
            .cli_ctx = self,
            .run_if_requested = runIfRequestedForTest,
            .env_ctx = self,
            .getenv = getenvForTest,
            .stderr_ctx = self,
            .write_stderr = writeStderrForTest,
        };
    }
};

fn runIfRequestedForTest(ctx: ?*anyopaque, _: Allocator, _: []const [:0]const u8, cfg: cli_surface.Config) !cli_surface.RunResult {
    const capture: *TestCapture = @ptrCast(@alignCast(ctx.?));
    capture.cli_calls += 1;
    capture.seen_config = cfg;
    if (capture.cli_error) |err| return err;
    return capture.run_result;
}

fn getenvForTest(ctx: ?*anyopaque, key: []const u8) ?[]const u8 {
    const capture: *TestCapture = @ptrCast(@alignCast(ctx.?));
    if (std.mem.eql(u8, key, "FX_BENCH")) return capture.bench_value;
    return null;
}

fn writeStderrForTest(ctx: ?*anyopaque, text: []const u8) !void {
    const capture: *TestCapture = @ptrCast(@alignCast(ctx.?));
    try capture.stderr.writer.writeAll(text);
}

test "app entry returns after handled CLI success" {
    const alloc = std.testing.allocator;
    var capture = TestCapture.init(.handled_success);
    defer capture.deinit();
    const skill_roots = [_]skill_contract.RootSpec{
        .{ .source = .workspace_shared, .path = "skills" },
    };
    var cfg = testConfig();
    var url_opener_context: u8 = 0;
    var secret_store_context: u8 = 0;
    cfg.url_opener.context = &url_opener_context;
    cfg.secret_store.context = &secret_store_context;
    cfg.skill_root_policy.workspace_roots = &skill_roots;
    const outcome = try runWithDeps(alloc, &.{@constCast("help")}, cfg, capture.deps());

    try std.testing.expectEqual(RunOutcome.returned, outcome);
    try std.testing.expectEqual(@as(usize, 1), capture.cli_calls);
    try std.testing.expectEqualStrings("0.2.10", capture.seen_config.?.version);
    try std.testing.expectEqualStrings("help", capture.seen_config.?.command_catalog.specs[0].token);
    try std.testing.expectEqualStrings("test.entry_context", capture.seen_config.?.context_registry.defaultProvider().id);
    try std.testing.expectEqualStrings("entry", capture.seen_config.?.mode_registry.default_mode_id);
    try std.testing.expectEqualStrings("entry_test_tool", capture.seen_config.?.tool_set.order[0]);
    try std.testing.expectEqualStrings("skills", capture.seen_config.?.skill_root_policy.workspace_roots[0].path);
    try std.testing.expect(capture.seen_config.?.gateway_provider.chat_url.resolve_fn == test_builtin_gateway.chat_url_provider.resolve_fn);
    try std.testing.expect(capture.seen_config.?.url_opener.context == cfg.url_opener.context);
    try std.testing.expect(capture.seen_config.?.secret_store.context == cfg.secret_store.context);
    try std.testing.expect(capture.seen_config.?.inspect_mcp_profile_config == noMcpConfigInspectionForTest);
}

test "app entry exits after handled CLI failure" {
    const alloc = std.testing.allocator;
    var capture = TestCapture.init(.handled_failure);
    defer capture.deinit();
    const outcome = try runWithDeps(alloc, &.{@constCast("models")}, testConfig(), capture.deps());

    try std.testing.expectEqual(@as(u8, 1), outcome.exit);
}

test "app entry maps handled CLI exit" {
    const alloc = std.testing.allocator;
    var capture = TestCapture.init(.{ .handled_exit = 42 });
    defer capture.deinit();
    const outcome = try runWithDeps(alloc, &.{ @constCast("replay"), @constCast("tape") }, testConfig(), capture.deps());

    try std.testing.expectEqual(@as(u8, 42), outcome.exit);
    try std.testing.expectEqual(@as(usize, 1), capture.cli_calls);
}

test "app entry returns after handled zero exit" {
    const alloc = std.testing.allocator;
    var capture = TestCapture.init(.{ .handled_exit = 0 });
    defer capture.deinit();
    const outcome = try runWithDeps(alloc, &.{ @constCast("replay"), @constCast("tape") }, testConfig(), capture.deps());

    try std.testing.expectEqual(RunOutcome.returned, outcome);
}

test "app entry honors FX_BENCH for an interactive launch" {
    const alloc = std.testing.allocator;
    var capture = TestCapture.init(.{ .interactive = .{} });
    defer capture.deinit();
    capture.bench_value = "1";
    const outcome = try runWithDeps(alloc, &.{}, testConfig(), capture.deps());

    try std.testing.expectEqual(RunOutcome.returned, outcome);
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "an interactive launch says the build has no terminal UI" {
    const alloc = std.testing.allocator;
    var capture = TestCapture.init(.{ .interactive = .{} });
    defer capture.deinit();
    const outcome = try runWithDeps(alloc, &.{}, testConfig(), capture.deps());

    try std.testing.expectEqual(RunOutcome{ .exit = 1 }, outcome);
    try std.testing.expectEqualStrings(interactive_unavailable_message, capture.stderr.written());
}

test "a command that ends on an error reports it in plain words" {
    const alloc = std.testing.allocator;
    const cases = [_]struct { err: anyerror, stderr: []const u8 }{
        .{ .err = error.InvalidGatewaySseEvent, .stderr = "fx: unreadable reply\n" },
        .{ .err = error.NoSpaceLeft, .stderr = "fx: the disk is full\n" },
        .{ .err = error.ProviderRequestLimitReached, .stderr = "fx: provider request limit reached\n" },
        .{ .err = error.OutputWriteFailed, .stderr = "fx: couldn't write the output\n" },
    };
    for (cases) |case| {
        var capture = TestCapture.init(.{ .interactive = .{} });
        defer capture.deinit();
        capture.cli_error = case.err;

        const outcome = try runWithDeps(alloc, &.{"ask"}, testConfig(), capture.deps());
        try std.testing.expectEqual(RunOutcome{ .exit = 1 }, outcome);
        try std.testing.expectEqualStrings(case.stderr, capture.stderr.written());
    }
}

test "a command whose output reader went away ends quietly with SIGPIPE's status" {
    const alloc = std.testing.allocator;
    var capture = TestCapture.init(.{ .interactive = .{} });
    defer capture.deinit();
    capture.cli_error = error.OutputReaderGone;

    const outcome = try runWithDeps(alloc, &.{"ask"}, testConfig(), capture.deps());
    try std.testing.expectEqual(RunOutcome{ .exit = 141 }, outcome);
    try std.testing.expectEqualStrings("", capture.stderr.written());
}
