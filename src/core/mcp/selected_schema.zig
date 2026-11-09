const std = @import("std");
const context_limits = @import("../config/context_limits.zig");
const model_context_encoding = @import("../shared/model_context_encoding.zig");
const model_tool_schema = @import("../tooling/model_tool_schema.zig");
const tool_mcp_runtime = @import("../tooling/tool_mcp_runtime.zig");
const McpTool = @import("catalog_state.zig").McpTool;
const Allocator = std.mem.Allocator;
const testing_allocator = @import("../shared/testing_allocator.zig");
const encodeScalarAlloc = model_context_encoding.scalarAlloc;

pub const AlwaysLoadedTools = struct {
    tools: []tool_mcp_runtime.SelectedTool,
    /// Owned context notice naming tools the schema budget left unloaded.
    notice: ?[]u8 = null,

    pub fn deinit(self: *AlwaysLoadedTools, alloc: Allocator) void {
        tool_mcp_runtime.freeSelectedTools(alloc, self.tools);
        if (self.notice) |notice| alloc.free(notice);
        self.* = undefined;
    }
};

/// Always-loaded tools share one `mcp_selected_schema_bytes` budget, in the
/// order they are added. Once one doesn't fit, it and every later one are
/// only counted, and stay reachable through capability_search.
pub const AlwaysLoaded = struct {
    selected: std.ArrayList(tool_mcp_runtime.SelectedTool) = .empty,
    remaining: usize,
    omitted: usize = 0,
    /// The server whose instructions the last-added tool carries. Tools are
    /// added a server at a time, and only a server's first tool carries its
    /// instructions, so they are in the model's context once.
    instructed: ?[]const u8 = null,

    pub fn init(limits: context_limits.Values) AlwaysLoaded {
        return .{ .remaining = limits.mcp_selected_schema_bytes.effectiveBytes() };
    }

    pub fn deinit(b: *AlwaysLoaded, alloc: Allocator) void {
        for (b.selected.items) |tool| tool.deinit(alloc);
        // The list's whole capacity, not just its tools.
        b.selected.deinit(alloc);
        b.* = undefined;
    }

    pub fn add(
        b: *AlwaysLoaded,
        alloc: Allocator,
        tool: McpTool,
        server: []const u8,
        server_instructions: ?[]const u8,
        binding: tool_mcp_runtime.Binding,
        limits: context_limits.Values,
    ) !void {
        if (b.omitted > 0) {
            b.omitted += 1;
            return;
        }
        const carries_instructions = b.instructed == null or !std.mem.eql(u8, b.instructed.?, server);
        var projection = try project(alloc, tool, server, if (carries_instructions) server_instructions else null, limits);
        const payload = switch (projection) {
            .selected, .rejected => |value| value,
        };
        if (projection == .rejected or payload.model_output.len > b.remaining) {
            if (projection == .selected) b.omitted += 1;
            projection.deinit(alloc);
            return;
        }
        if (payload.notice) |notice| alloc.free(notice);
        errdefer alloc.free(payload.model_output);
        const name = try alloc.dupe(u8, tool.prefixed_name);
        errdefer alloc.free(name);
        try b.selected.append(alloc, .{ .name = name, .schema_json = payload.model_output, .mcp_binding = binding });
        b.remaining -= payload.model_output.len;
        if (carries_instructions) b.instructed = server;
    }

    /// Hands the tools over, with a notice when the budget left any out.
    pub fn finish(b: *AlwaysLoaded, alloc: Allocator) !AlwaysLoadedTools {
        const notice = if (b.omitted > 0) try alloc.print(
            "[context] {d} always-loaded MCP tool{s} exceeded the mcp_selected_schema_bytes budget and stay available through capability_search",
            .{ b.omitted, if (b.omitted == 1) "" else "s" },
        ) else null;
        errdefer if (notice) |value| alloc.free(value);
        return .{ .tools = try b.selected.toOwnedSlice(alloc), .notice = notice };
    }
};

/// The tool's schema as the model sees it. `server_instructions` is null for
/// a tool whose server's instructions the model already has from another
/// schema; the truncation notice, raised for the schema that carries them,
/// names the server.
pub fn project(alloc: Allocator, tool: McpTool, server: []const u8, server_instructions: ?[]const u8, limits: context_limits.Values) !tool_mcp_runtime.ToolSchemaResult {
    const instruction_limit = limits.mcp_server_instructions_bytes;
    const observed = if (server_instructions) |value| value.len else 0;
    const instructions = if (server_instructions) |value| value[0..context_limits.lineSafePrefixLength(value, instruction_limit.effectiveBytes())] else null;
    const truncated = if (instructions) |value| value.len < observed else false;
    const schema = try buildToolSchemaJsonWithLimitMarker(alloc, tool, instructions, truncated, observed, instruction_limit);
    var schema_owned = true;
    errdefer if (schema_owned) alloc.free(schema);
    const limit = limits.mcp_selected_schema_bytes;
    if (schema.len > limit.effectiveBytes()) {
        const schema_bytes = schema.len;
        alloc.free(schema);
        schema_owned = false;
        var out: std.Io.Writer.Allocating = .init(alloc);
        defer out.deinit();
        try out.writer.writeAll("{\"context_limit_rejection\":{\"name\":\"mcp_selected_schema_bytes\",\"tool\":");
        try model_context_encoding.writeJsonScalar(alloc, &out.writer, tool.prefixed_name);
        try out.writer.print(",\"action\":\"rejected\",\"observed_bytes\":{d},\"effective_bytes\":{d},\"source\":\"{s}\",\"override\":\"--context-limit mcp_selected_schema_bytes=BYTES|off\"}}}}", .{ schema_bytes, limit.effectiveBytes(), limit.source.label() });
        const output = try out.toOwnedSlice();
        errdefer alloc.free(output);
        return .{ .rejected = .{ .model_output = output, .notice = try renderSchemaNotice(alloc, "schema", tool.prefixed_name, "rejected", schema_bytes, limit, "mcp_selected_schema_bytes") } };
    }
    return .{ .selected = .{ .model_output = schema, .notice = if (truncated) try renderSchemaNotice(alloc, "server", server, "instructions truncated", observed, instruction_limit, "mcp_server_instructions_bytes") else null } };
}

fn buildToolSchemaJsonWithLimitMarker(
    alloc: Allocator,
    tool: McpTool,
    instructions: ?[]const u8,
    instructions_truncated: bool,
    instruction_observed_bytes: usize,
    limit: context_limits.Resolved,
) ![]u8 {
    const encoded_description = try encodeScalarAlloc(alloc, tool.description);
    defer alloc.free(encoded_description);
    const encoded_instructions = if (instructions) |text| try encodeScalarAlloc(alloc, text) else null;
    defer if (encoded_instructions) |text| alloc.free(text);
    const merged_description = if (instructions != null)
        if (instructions_truncated)
            try alloc.print(
                "{s}\n\nServer instructions: {s}\n<context_limit name=\"mcp_server_instructions_bytes\" action=\"truncated\" observed_bytes=\"{d}\" effective_bytes=\"{d}\" source=\"{s}\" override=\"--context-limit mcp_server_instructions_bytes=BYTES|off\" />",
                .{ encoded_description, encoded_instructions.?, instruction_observed_bytes, limit.effectiveBytes(), limit.source.label() },
            )
        else
            try alloc.print("{s}\n\nServer instructions: {s}", .{ encoded_description, encoded_instructions.? })
    else
        try alloc.dupe(u8, encoded_description);
    defer alloc.free(merged_description);
    return model_tool_schema.dynamicFunctionSchemaJsonAlloc(
        alloc,
        tool.prefixed_name,
        merged_description,
        tool.input_schema_json,
    );
}

fn renderSchemaNotice(
    alloc: Allocator,
    subject_kind: []const u8,
    subject: []const u8,
    action: []const u8,
    observed_bytes: usize,
    limit: context_limits.Resolved,
    limit_name: []const u8,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.print("[context] MCP {s} \"", .{subject_kind});
    try model_context_encoding.writeScalar(&out.writer, subject);
    try out.writer.print(
        "\" {s}: observed={d} bytes effective={d} bytes source={s}; override with --context-limit {s}=BYTES|off",
        .{ action, observed_bytes, limit.effectiveBytes(), limit.source.label(), limit_name },
    );
    return try out.toOwnedSlice();
}

const testing = std.testing;

/// Adds four always-loaded tools and hands them over, as
/// `snapshotAlwaysLoadedTools` does. With four the list's capacity passes
/// its length.
fn loadFour(alloc: Allocator) !void {
    var loaded: AlwaysLoaded = .init(.{});
    errdefer loaded.deinit(alloc);
    var names = [_][5]u8{ "srv_a".*, "srv_b".*, "srv_c".*, "srv_d".* };
    var description = "Echoes text.".*;
    var schema = "{\"type\":\"object\"}".*;
    for (&names) |*name| {
        const tool: McpTool = .{ .original_name = name[4..], .prefixed_name = name, .description = &description, .input_schema_json = &schema, .tags = &.{} };
        // The schema's writer reports a failed allocation as WriteFailed.
        loaded.add(alloc, tool, "srv", null, .{ .runtime_generation = 1, .connection_generation = 1, .catalog_generation = 1, .auth_generation = 1 }, .{}) catch |err| return switch (err) {
            error.WriteFailed => error.OutOfMemory,
            else => err,
        };
    }
    var tools = try loaded.finish(alloc);
    defer tools.deinit(alloc);
    try testing.expectEqual(@as(usize, 4), tools.tools.len);
}

test "always-loaded tools are freed whole when memory runs out partway" {
    try testing.checkAllAllocationFailures(testing_allocator.no_resize, loadFour, .{});
}

test "a server's instructions ride in its first always-loaded tool only, and the cut notice names the server" {
    const alloc = testing.allocator;
    var loaded: AlwaysLoaded = .init(.{});
    defer loaded.deinit(alloc);
    var names = [_][5]u8{ "srv_a".*, "srv_b".*, "oth_c".* };
    const servers = [_][]const u8{ "srv", "srv", "oth" };
    var description = "Echoes text.".*;
    var schema = "{\"type\":\"object\"}".*;
    const instructions_text: [3000]u8 = @splat('x');
    const instructions: []const u8 = &instructions_text;
    for (&names, servers) |*name, server| {
        const tool: McpTool = .{ .original_name = name[4..], .prefixed_name = name, .description = &description, .input_schema_json = &schema, .tags = &.{} };
        try loaded.add(alloc, tool, server, instructions, .{ .runtime_generation = 1, .connection_generation = 1, .catalog_generation = 1, .auth_generation = 1 }, .{});
    }
    try testing.expectEqual(@as(usize, 3), loaded.selected.items.len);
    var carrying: usize = 0;
    for (loaded.selected.items) |tool| {
        if (std.mem.find(u8, tool.schema_json, "Server instructions:") != null) carrying += 1;
    }
    // One per server, not one per tool.
    try testing.expectEqual(@as(usize, 2), carrying);
    try testing.expect(std.mem.find(u8, loaded.selected.items[0].schema_json, "Server instructions:") != null);
    try testing.expect(std.mem.find(u8, loaded.selected.items[1].schema_json, "Server instructions:") == null);

    var projection = try project(alloc, .{ .original_name = names[0][4..], .prefixed_name = &names[0], .description = &description, .input_schema_json = &schema, .tags = &.{} }, "srv", instructions, .{});
    defer projection.deinit(alloc);
    const notice = projection.selected.notice.?;
    try testing.expect(std.mem.startsWith(u8, notice, "[context] MCP server \"srv\" instructions truncated:"));
    try testing.expect(std.mem.find(u8, notice, "srv_a") == null);
}
