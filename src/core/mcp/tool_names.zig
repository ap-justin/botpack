const std = @import("std");
const tool_dispatch = @import("../tooling/tool_dispatch.zig");
const Allocator = std.mem.Allocator;
const collections = @import("../shared/collections.zig");
const max_mcp_tool_tags: usize = 16;

/// One alias authority for a session. Retired names remain reserved so a later
/// catalog cannot silently assign an advertised name to a different tool.
pub const Registry = struct {
    const max_aliases: usize = 64 * 1024;
    alloc: Allocator,
    mutex: std.Io.Mutex = .init,
    by_identity: std.StringHashMapUnmanaged([]u8) = .empty,
    aliases: std.StringHashMapUnmanaged([]const u8) = .empty,

    pub fn init(alloc: Allocator) Registry {
        return .{ .alloc = alloc };
    }

    pub fn deinit(self: *Registry) void {
        var entries = self.by_identity.iterator();
        while (entries.next()) |entry| {
            self.alloc.free(entry.key_ptr.*);
            self.alloc.free(entry.value_ptr.*);
        }
        self.by_identity.deinit(self.alloc);
        self.aliases.deinit(self.alloc);
    }

    /// Borrows the server identity until the registry is destroyed.
    pub fn serverName(self: *Registry, alias: []const u8) ?[]const u8 {
        const io = @import("../shared/io.zig").getIo();
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        return self.aliases.get(alias);
    }

    /// Returns an owned alias. Concurrent startup, refresh, and recovery share
    /// this assignment; published catalogs never own the reservation storage.
    pub fn name(self: *Registry, alloc: Allocator, builtins: tool_dispatch.Registry, server: []const u8, tool: []const u8) (Allocator.Error || error{McpToolNameLimitExceeded})![]u8 {
        const io = @import("../shared/io.zig").getIo();
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const identity = try self.alloc.print("{d}:{s}{s}", .{ server.len, server, tool });
        defer self.alloc.free(identity);
        if (self.by_identity.get(identity)) |existing| return alloc.dupe(u8, existing);
        if (self.by_identity.count() >= max_aliases) return error.McpToolNameLimitExceeded;
        const base = buildBaseToolName(self.alloc, server, tool) catch return error.OutOfMemory;
        defer self.alloc.free(base);
        var suffix: ?usize = null;
        while (true) {
            const candidate = try candidateWithSuffix(self.alloc, base, suffix);
            if (builtins.lookup(candidate) != null or self.aliases.contains(candidate)) {
                self.alloc.free(candidate);
                suffix = if (suffix) |value| value + 1 else 2;
                continue;
            }
            errdefer self.alloc.free(candidate);
            const owned_key = try self.alloc.dupe(u8, identity);
            errdefer self.alloc.free(owned_key);
            const result = try alloc.dupe(u8, candidate);
            errdefer alloc.free(result);
            try self.by_identity.ensureUnusedCapacity(self.alloc, 1);
            try self.aliases.ensureUnusedCapacity(self.alloc, 1);
            self.by_identity.putAssumeCapacityNoClobber(owned_key, candidate);
            const server_end = owned_key.len - tool.len;
            self.aliases.putAssumeCapacityNoClobber(candidate, owned_key[server_end - server.len .. server_end]);
            return result;
        }
    }
};

/// Match the configured namespace without allocating or interpreting tool arguments.
pub fn matchesServer(name: []const u8, server_name: []const u8) bool {
    if (!std.mem.startsWith(u8, name, "mcp_")) return false;
    const source = if (server_name.len == 0) "server" else server_name;
    const segment = name[4..];
    for (source, 0..) |byte, index| {
        if (index >= segment.len) return false;
        const normalized = if (isIdentifierByte(byte)) byte else '_';
        if (segment[index] != normalized) return false;
    }
    return segment.len > source.len and segment[source.len] == '_';
}

const QualifiedForm = struct { prefix: []const u8, sep: []const u8 };

/// The ways a model writes a tool's server-qualified name besides fx's own
/// `mcp_<server>_<tool>` alias.
const qualified_forms = [_]QualifiedForm{
    .{ .prefix = "", .sep = "." },
    .{ .prefix = "", .sep = "/" },
    .{ .prefix = "mcp__", .sep = "__" },
    .{ .prefix = "mcp_", .sep = "_" },
};

/// Whether `text` is `raw` as written or as `writeSanitizedSegment` writes it.
fn segmentEql(text: []const u8, raw: []const u8, fallback: []const u8) bool {
    const source = if (raw.len == 0) fallback else raw;
    if (text.len != source.len) return false;
    if (std.mem.eql(u8, text, source)) return true;
    for (text, source) |t, r| {
        if (t != (if (isIdentifierByte(r)) r else '_')) return false;
    }
    return true;
}

/// Whether `name` is a qualified spelling of `tool` on `server`: the server
/// and tool names as the server gives them, or as fx sanitizes them, joined as
/// `<server>.<tool>`, `<server>/<tool>`, `mcp__<server>__<tool>`, or
/// `mcp_<server>_<tool>`.
pub fn namesQualifiedTool(name: []const u8, server: []const u8, tool: []const u8) bool {
    const server_len = if (server.len == 0) "server".len else server.len;
    for (qualified_forms) |form| {
        const rest = std.mem.cutPrefix(u8, name, form.prefix) orelse continue;
        const tool_start = server_len + form.sep.len;
        if (rest.len < tool_start) continue;
        if (!segmentEql(rest[0..server_len], server, "server")) continue;
        if (!std.mem.eql(u8, rest[server_len..tool_start], form.sep)) continue;
        if (segmentEql(rest[tool_start..], tool, "tool")) return true;
    }
    return false;
}

/// Whether `name` is a qualified spelling that begins with `server`'s name,
/// whichever tool it goes on to name.
pub fn namesQualifiedServer(name: []const u8, server: []const u8) bool {
    const server_len = if (server.len == 0) "server".len else server.len;
    for (qualified_forms) |form| {
        const rest = std.mem.cutPrefix(u8, name, form.prefix) orelse continue;
        if (rest.len <= server_len + form.sep.len) continue;
        if (!segmentEql(rest[0..server_len], server, "server")) continue;
        if (std.mem.startsWith(u8, rest[server_len..], form.sep)) return true;
    }
    return false;
}

/// Whether the model wrote `name` as a reference to an MCP tool rather than
/// as a plain tool name.
pub fn looksQualified(name: []const u8) bool {
    return std.mem.startsWith(u8, name, "mcp_") or
        std.mem.findAny(u8, name, "./") != null;
}

test "qualified spellings name the tool on its server, sanitized or not" {
    try std.testing.expect(namesQualifiedTool("openbot.send_message", "openbot", "send_message"));
    try std.testing.expect(namesQualifiedTool("openbot/send_message", "openbot", "send_message"));
    try std.testing.expect(namesQualifiedTool("mcp__openbot__send_message", "openbot", "send_message"));
    try std.testing.expect(namesQualifiedTool("mcp_openbot_send_message", "openbot", "send_message"));
    try std.testing.expect(namesQualifiedTool("my_server.send_it", "my server", "send it"));
    try std.testing.expect(!namesQualifiedTool("openbot.send_messages", "openbot", "send_message"));
    try std.testing.expect(!namesQualifiedTool("other.send_message", "openbot", "send_message"));
    try std.testing.expect(!namesQualifiedTool("send_message", "openbot", "send_message"));
    try std.testing.expect(namesQualifiedServer("openbot.anything", "openbot"));
    try std.testing.expect(!namesQualifiedServer("openbot", "openbot"));
}

fn buildBaseToolName(alloc: Allocator, server_name: []const u8, tool_name: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try out.writer.writeAll("mcp_");
    if (server_name.len == 0) {
        try out.writer.writeAll("server");
    } else {
        try writeSanitizedSegment(&out.writer, server_name);
    }
    try out.writer.writeByte('_');
    if (tool_name.len == 0) {
        try out.writer.writeAll("tool");
    } else {
        try writeSanitizedSegment(&out.writer, tool_name);
    }

    return try out.toOwnedSlice();
}

fn writeSanitizedSegment(writer: *std.Io.Writer, segment: []const u8) !void {
    for (segment) |byte| {
        if (isIdentifierByte(byte)) {
            try writer.writeByte(byte);
        } else {
            try writer.writeByte('_');
        }
    }
}

fn candidateWithSuffix(alloc: Allocator, base: []const u8, suffix_index: ?usize) ![]u8 {
    const max_name_len = 64;
    if (suffix_index) |index| {
        const suffix = try alloc.print("_{d}", .{index});
        defer alloc.free(suffix);

        const prefix_len = @min(base.len, max_name_len - suffix.len);
        return alloc.print("{s}{s}", .{ base[0..prefix_len], suffix });
    }

    return alloc.dupe(u8, base[0..@min(base.len, max_name_len)]);
}

test "session tool aliases survive replacement and cannot retarget a collision" {
    const alloc = std.testing.allocator;
    var registry = Registry.init(alloc);
    defer registry.deinit();
    const first = try registry.name(alloc, .{}, "a/b", "c");
    defer alloc.free(first);
    const collision = try registry.name(alloc, .{}, "a_b", "c");
    defer alloc.free(collision);
    try std.testing.expect(!std.mem.eql(u8, first, collision));
    const refreshed = try registry.name(alloc, .{}, "a/b", "c");
    defer alloc.free(refreshed);
    try std.testing.expectEqualStrings(first, refreshed);
    const recovered = try registry.name(alloc, .{}, "a_b", "c");
    defer alloc.free(recovered);
    try std.testing.expectEqualStrings(collision, recovered);
}

pub fn tagsFor(alloc: Allocator, server_name: []const u8, tool_name: []const u8) ![]const []u8 {
    var tags: std.ArrayList([]u8) = .empty;
    errdefer collections.freeStringList(alloc, &tags);

    try appendTag(alloc, &tags, "mcp");
    try appendTagTokens(alloc, &tags, server_name);
    try appendTagTokens(alloc, &tags, tool_name);

    return try tags.toOwnedSlice(alloc);
}

fn appendTagTokens(alloc: Allocator, tags: *std.ArrayList([]u8), text: []const u8) !void {
    var start: ?usize = null;
    for (text, 0..) |byte, index| {
        if (isIdentifierByte(byte)) {
            if (start == null) start = index;
            continue;
        }
        if (start) |s| {
            try appendTag(alloc, tags, text[s..index]);
            start = null;
        }
    }
    if (start) |s| try appendTag(alloc, tags, text[s..]);
}

fn appendTag(alloc: Allocator, tags: *std.ArrayList([]u8), raw: []const u8) !void {
    if (raw.len == 0 or tags.items.len >= max_mcp_tool_tags) return;

    const normalized = try std.ascii.allocLowerString(alloc, raw);
    errdefer alloc.free(normalized);
    for (tags.items) |tag| {
        if (std.mem.eql(u8, tag, normalized)) {
            alloc.free(normalized);
            return;
        }
    }
    try tags.append(alloc, normalized);
}

pub fn isIdentifierByte(byte: u8) bool {
    return std.ascii.isAlphanumeric(byte) or byte == '_' or byte == '-';
}
