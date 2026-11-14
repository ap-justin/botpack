const std = @import("std");
const build_options = @import("build_options");
const jsonrpc = @import("jsonrpc.zig");
const core_types = @import("../core/shared/types.zig");
const io_mod = @import("../core/shared/io.zig");
const credentials = @import("../core/auth/credentials.zig");
const model_provider = @import("../core/config/model_provider.zig");

const Allocator = std.mem.Allocator;
const writeJsonStr = jsonrpc.writeJsonStr;

pub const MessageIdBuffer = [32]u8;

pub fn generateMessageId(storage: *MessageIdBuffer) []const u8 {
    var random_bytes: [16]u8 = undefined;
    io_mod.getIo().random(&random_bytes);
    storage.* = std.fmt.bytesToHex(random_bytes, .lower);
    return storage;
}

pub const protocol_version: u32 = 1;

/// Returns the borrowed value at `_meta.lia.<key>` on an ACP params object.
/// lia reads and writes its protocol extensions under that one namespace.
pub fn liaMetaField(object: std.json.ObjectMap, key: []const u8) ?std.json.Value {
    const meta = object.get("_meta") orelse return null;
    if (meta != .object) return null;
    const lia = meta.object.get("lia") orelse return null;
    if (lia != .object) return null;
    return lia.object.get(key);
}

/// Returns `_meta.lia.<key>` when it is a JSON boolean.
pub fn liaMetaBool(object: std.json.ObjectMap, key: []const u8) ?bool {
    const value = liaMetaField(object, key) orelse return null;
    return if (value == .bool) value.bool else null;
}

const model_recovery_update_prefix = "{\"sessionUpdate\":\"session_info_update\",\"_meta\":{\"lia\":{\"modelResponseRecovery\":";

/// What a session load reports for a request an earlier lia process was
/// running when it stopped.
/// `_meta.lia.modelResponseRecovery`: the recovery module's shape, as in
/// `lia ask --json` (decision 38). Null clears the client's status.
pub fn writeModelRecoveryInfoUpdate(
    writer: *std.Io.Writer,
    status: ?core_types.RouteRecoveryStatus,
) !void {
    try writer.writeAll(model_recovery_update_prefix);
    const recovery = status orelse {
        try writer.writeAll("null}}}");
        return;
    };
    var label_buf: [core_types.RouteRecoveryStatus.label_max_bytes]u8 = undefined;
    try recovery.report(&label_buf).writeJson(writer);
    try writer.writeAll("}}}");
}

pub const StopReason = enum {
    end_turn,
    max_output_tokens,
    max_model_turns,
    refused,
    /// The provider's content filter blocked the reply, or the model refused it.
    content_filter,
    cancelled,
    /// The host gave the turn a time to stop at, and it stopped before its
    /// next model request with the turn kept open for a later resume.
    yielded,

    /// The ACP v1 `stopReason` value closest to this reason.
    pub fn jsonString(self: StopReason) []const u8 {
        return switch (self) {
            .end_turn => "end_turn",
            .max_output_tokens => "max_tokens",
            .max_model_turns => "max_turn_requests",
            .refused, .content_filter => "refusal",
            .cancelled => "cancelled",
            .yielded => "max_turn_requests",
        };
    }

    /// lia's own name for this reason, sent as `_meta.lia.stopReason` when it
    /// differs from the v1 value.
    fn liaString(self: StopReason) []const u8 {
        return switch (self) {
            .end_turn => "end_turn",
            .max_output_tokens => "max_output_tokens",
            .max_model_turns => "max_model_turns",
            .refused => "refused",
            .content_filter => "content_filter",
            .cancelled => "cancelled",
            .yielded => "yielded",
        };
    }

    fn hasLiaMeta(self: StopReason) bool {
        return !std.mem.eql(u8, self.jsonString(), self.liaString());
    }
};

/// Writes `"stopReason":"..."` inside an `_meta.lia` object; the caller writes
/// any separating comma.
fn writeLiaStopReasonField(w: *std.Io.Writer, reason: StopReason) !void {
    try w.writeAll("\"stopReason\":");
    try writeJsonStr(reason.liaString(), w);
}

pub const ToolCallKind = enum {
    read,
    edit,
    delete,
    move,
    search,
    execute,
    think,
    fetch,
    other,

    pub fn jsonString(self: ToolCallKind) []const u8 {
        return switch (self) {
            .read => "read",
            .edit => "edit",
            .delete => "delete",
            .move => "move",
            .search => "search",
            .execute => "execute",
            .think => "think",
            .fetch => "fetch",
            .other => "other",
        };
    }
};

pub const ToolCallStatus = enum {
    pending,
    in_progress,
    completed,
    failed,

    pub fn jsonString(self: ToolCallStatus) []const u8 {
        return switch (self) {
            .pending => "pending",
            .in_progress => "in_progress",
            .completed => "completed",
            .failed => "failed",
        };
    }
};

pub fn writeSessionUpdate(w: *std.Io.Writer, session_id: []const u8, update_json: []const u8) !void {
    try w.writeAll("{\"sessionId\":");
    try writeJsonStr(session_id, w);
    try w.writeAll(",\"update\":");
    try w.writeAll(update_json);
    try w.writeAll("}");
}

pub fn writeAgentMessageChunk(w: *std.Io.Writer, message_id: []const u8, text: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"agent_message_chunk\",\"messageId\":");
    try writeJsonStr(message_id, w);
    try w.writeAll(",\"content\":{\"type\":\"text\",\"text\":");
    try writeJsonStr(text, w);
    try w.writeAll("}}");
}

/// ACP v1 Session Notice: shown to the user, never part of the session's
/// history. Only for a client that advertised `session.notices`.
pub fn writeNotice(w: *std.Io.Writer, severity: []const u8, title: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"notice\",\"severity\":");
    try writeJsonStr(severity, w);
    try w.writeAll(",\"title\":");
    try writeJsonStr(title, w);
    try w.writeByte('}');
}

test "writeNotice writes an ACP v1 notice update" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeNotice(&out.writer, "info", "A \"quoted\" title");
    try std.testing.expectEqualStrings("{\"sessionUpdate\":\"notice\",\"severity\":\"info\",\"title\":\"A \\\"quoted\\\" title\"}", out.written());
}

pub fn writeAgentThoughtChunk(w: *std.Io.Writer, text: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"agent_thought_chunk\",\"content\":{\"type\":\"text\",\"text\":");
    try writeJsonStr(text, w);
    try w.writeAll("}}");
}

pub fn writeUserMessageChunk(w: *std.Io.Writer, message_id: []const u8, text: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"user_message_chunk\",\"messageId\":");
    try writeJsonStr(message_id, w);
    try w.writeAll(",\"content\":{\"type\":\"text\",\"text\":");
    try writeJsonStr(text, w);
    try w.writeAll("}}");
}

pub fn writeUserImageChunk(
    w: *std.Io.Writer,
    message_id: []const u8,
    media_type: []const u8,
    bytes: []const u8,
) !void {
    try w.writeAll("{\"sessionUpdate\":\"user_message_chunk\",\"messageId\":");
    try writeJsonStr(message_id, w);
    try w.writeAll(",\"content\":{\"type\":\"image\",\"data\":\"");
    try std.base64.standard.Encoder.encodeWriter(w, bytes);
    try w.writeAll("\",\"mimeType\":");
    try writeJsonStr(media_type, w);
    try w.writeAll("}}");
}

/// Host-facing identity of a tool call, sent as `_meta.lia.toolCall` so
/// clients never need to match on tool names.
pub const ToolCallMeta = struct {
    /// lia's own discovery or bookkeeping step, which hosts may hide.
    internal: bool = false,
    /// The MCP server and its own tool name, for MCP tool calls.
    mcp: ?struct { server: []const u8, tool: []const u8 } = null,
};

fn writeToolCallMeta(w: *std.Io.Writer, meta: ToolCallMeta) !void {
    try w.writeAll(",\"_meta\":{\"lia\":{\"toolCall\":{\"internal\":");
    try w.writeAll(if (meta.internal) "true" else "false");
    if (meta.mcp) |mcp| {
        try w.writeAll(",\"mcp\":{\"server\":");
        try writeJsonStr(mcp.server, w);
        try w.writeAll(",\"tool\":");
        try writeJsonStr(mcp.tool, w);
        try w.writeByte('}');
    }
    try w.writeAll("}}}");
}

pub fn writeToolCall(
    w: *std.Io.Writer,
    tool_call_id: []const u8,
    name: []const u8,
    title: []const u8,
    kind: ToolCallKind,
    status: ToolCallStatus,
    raw_input: ?std.json.Value,
    meta: ToolCallMeta,
) !void {
    try w.writeAll("{\"sessionUpdate\":\"tool_call\",\"toolCallId\":");
    try writeJsonStr(tool_call_id, w);
    try w.writeAll(",\"name\":");
    try writeJsonStr(name, w);
    try w.writeAll(",\"title\":");
    try writeJsonStr(title, w);
    try w.writeAll(",\"kind\":");
    try writeJsonStr(kind.jsonString(), w);
    try w.writeAll(",\"status\":");
    try writeJsonStr(status.jsonString(), w);
    if (raw_input) |value| {
        try w.writeAll(",\"rawInput\":");
        try std.json.Stringify.value(value, .{}, w);
    }
    try writeToolCallMeta(w, meta);
    try w.writeAll("}");
}

pub fn writeToolCallUpdate(w: *std.Io.Writer, tool_call_id: []const u8, status: ToolCallStatus, content_text: ?[]const u8) !void {
    try writeToolCallUpdateWithCommandResult(w, tool_call_id, status, content_text, null);
}

pub fn writeToolCallUpdateWithCommandResult(
    w: *std.Io.Writer,
    tool_call_id: []const u8,
    status: ToolCallStatus,
    content_text: ?[]const u8,
    command_result_json: ?[]const u8,
) !void {
    try w.writeAll("{\"sessionUpdate\":\"tool_call_update\",\"toolCallId\":");
    try writeJsonStr(tool_call_id, w);
    try w.writeAll(",\"status\":");
    try writeJsonStr(status.jsonString(), w);
    if (content_text) |text| {
        try w.writeAll(",\"content\":[{\"type\":\"content\",\"content\":{\"type\":\"text\",\"text\":");
        try writeJsonStr(text, w);
        try w.writeAll("}}]");
    }
    if (command_result_json) |json| {
        try w.writeAll(",\"command_result\":");
        try w.writeAll(json);
    }
    try w.writeAll("}");
}

pub const AgentCapabilities = struct {
    image_prompts: bool,
    /// Accepts client `mcpServers` on session setup.
    mcp_servers: bool = true,
    /// Accepts steering prompts through `session/prompt` during a turn.
    steering: bool = false,
    /// Accepts a client system prompt on `session/new` in append mode.
    system_prompt: bool = false,
    /// Serves `type: "acp"` MCP servers over this connection.
    mcp_over_acp: bool = false,
    /// Speaks MCP's HTTP+SSE transport (2024-11-05), which lia's MCP engine doesn't.
    mcp_sse: bool = true,
};

/// The `agent` auth method, always advertised: on Gateway, `authenticate` with
/// it runs the `lia login` browser sign-in when no credential is stored. The
/// registry's auth check never sends `auth.terminal`, so this is the entry that
/// keeps `authMethods` non-empty.
pub const agent_auth_method_id = "lia-login";
/// The Terminal Auth method, advertised only to a Gateway connection whose
/// client sent `clientCapabilities.auth.terminal: true`. It runs
/// `lia login vercel --api-key`.
pub const terminal_auth_method_id = "lia-login-api-key";

/// Whether `authenticate` accepts `method_id`. The terminal id is accepted
/// too, though ACP v1 clients must not send it, so older clients keep working.
pub fn isAuthMethodId(method_id: []const u8) bool {
    return std.mem.eql(u8, method_id, agent_auth_method_id) or
        std.mem.eql(u8, method_id, terminal_auth_method_id);
}

/// What yields a credential for the selected provider.
pub const AuthLogin = enum {
    /// A Vercel AI Gateway sign-in or API key.
    vercel,
    /// The environment variable a provider configured in settings.json reads
    /// its key from; no auth method can set it.
    configured,

    pub fn forProvider(provider: model_provider.ProviderId) AuthLogin {
        return switch (provider) {
            .gateway => .vercel,
            .configured => .configured,
        };
    }

    /// The missing-credential help text, also the `AUTH_REQUIRED` message.
    pub fn instruction(self: AuthLogin) []const u8 {
        return switch (self) {
            .vercel => credentials.missing_credential_message,
            .configured => "The selected provider is configured in settings.json and reads its API key from an environment variable. Set it where lia starts, then restart lia.",
        };
    }

    fn agentName(self: AuthLogin) []const u8 {
        return switch (self) {
            .vercel => "Sign in to Vercel AI Gateway",
            .configured => "Set the configured provider's API key",
        };
    }
};

/// Why this machine cannot save a `lia login` sign-in.
pub const SignInBlock = enum {
    home_unavailable,
    /// `~/.lia` or its `auth.json` is not private and writable, or the
    /// keychain cannot be read.
    storage_unusable,

    pub fn reason(self: SignInBlock) []const u8 {
        return switch (self) {
            .home_unavailable => "lia cannot save a sign-in because HOME is not set or does not exist. Set HOME to your home folder, then retry.",
            .storage_unusable => "lia cannot save a sign-in: ~/.lia or ~/.lia/auth.json is not private to you or not writable (auth.json must be mode 600), or the keychain cannot be read. Fix it, then retry.",
        };
    }
};

const terminal_auth_name = "Use a Vercel AI Gateway API key";
const terminal_auth_description = "Paste a Vercel AI Gateway API key in a terminal. lia saves it for later sessions.";
/// The `lia` arguments a terminal client appends; a login
/// `cli_surface.zig:parseLoginArgs` accepts.
const terminal_auth_args = [_][]const u8{ "login", "vercel", "--api-key" };

/// What one connection is offered: the login for its provider, and the
/// terminal method when the client can run one.
pub const AuthOffer = struct {
    login: AuthLogin = .vercel,
    client_terminal_auth: bool = false,
    /// Set when the Vercel sign-in cannot be saved here; the agent method
    /// then says why instead of offering it.
    sign_in_block: ?SignInBlock = null,
};

/// The `authMethods` array. `initialize` and `AUTH_REQUIRED` both write it, so
/// a connection sees one list.
pub fn writeAuthMethods(w: *std.Io.Writer, offer: AuthOffer) !void {
    const blocked = if (offer.login == .vercel) offer.sign_in_block else null;
    try w.writeAll("[{\"id\":\"" ++ agent_auth_method_id ++ "\",\"name\":");
    try writeJsonStr(if (blocked != null) "Vercel AI Gateway sign-in unavailable" else offer.login.agentName(), w);
    try w.writeAll(",\"description\":");
    try writeJsonStr(if (blocked) |block| block.reason() else offer.login.instruction(), w);
    try w.writeByte('}');
    if (offer.client_terminal_auth and offer.login == .vercel) {
        try w.writeAll(",{\"id\":\"" ++ terminal_auth_method_id ++ "\",\"name\":");
        try writeJsonStr(terminal_auth_name, w);
        try w.writeAll(",\"description\":");
        try writeJsonStr(terminal_auth_description, w);
        try w.writeAll(",\"type\":\"terminal\",\"args\":[");
        for (terminal_auth_args, 0..) |arg, i| {
            if (i > 0) try w.writeByte(',');
            try writeJsonStr(arg, w);
        }
        try w.writeAll("]}");
    }
    try w.writeByte(']');
}

/// The `data` of an `AUTH_REQUIRED` error.
pub fn writeAuthRequiredData(w: *std.Io.Writer, offer: AuthOffer) !void {
    try w.writeAll("{\"authMethods\":");
    try writeAuthMethods(w, offer);
    try w.writeByte('}');
}

pub fn writeInitializeResponse(w: *std.Io.Writer, capabilities: AgentCapabilities, auth: AuthOffer) !void {
    const mcp_servers = if (capabilities.mcp_servers) "true" else "false";
    try w.writeAll("{\"protocolVersion\":");
    try w.print("{d}", .{protocol_version});
    try w.writeAll(",\"agentCapabilities\":{");
    try w.writeAll("\"loadSession\":true,");
    try w.print("\"promptCapabilities\":{{\"image\":{s},\"audio\":false,\"embeddedContext\":true}},", .{if (capabilities.image_prompts) "true" else "false"});
    try w.print("\"mcpCapabilities\":{{\"http\":{s},\"sse\":{s},\"acp\":{s}}},", .{
        mcp_servers,
        if (capabilities.mcp_servers and capabilities.mcp_sse) "true" else "false",
        if (capabilities.mcp_over_acp) "true" else "false",
    });
    try w.writeAll("\"sessionCapabilities\":{\"list\":{},\"resume\":{},\"close\":{}");
    if (capabilities.system_prompt) try w.writeAll(",\"systemPrompt\":{}");
    try w.writeByte('}');
    try w.print(",\"_meta\":{{\"lia\":{{\"steering\":{s}}}}}", .{if (capabilities.steering) "true" else "false"});
    try w.writeAll("},\"agentInfo\":{\"name\":\"lia\",\"title\":\"lia\",\"version\":");
    try writeJsonStr(build_options.app_version, w);
    try w.writeAll("},\"authMethods\":");
    try writeAuthMethods(w, auth);
    try w.writeByte('}');
}

pub fn writePromptResponse(w: *std.Io.Writer, reason: StopReason) !void {
    try w.writeAll("{\"stopReason\":");
    try writeJsonStr(reason.jsonString(), w);
    if (reason.hasLiaMeta()) {
        try w.writeAll(",\"_meta\":{\"lia\":{");
        try writeLiaStopReasonField(w, reason);
        try w.writeAll("}}");
    }
    try w.writeAll("}");
}

/// How a steering `session/prompt` fared in the turn that received it.
pub const SteeringDelivery = enum {
    absorbed,
    dropped,
};

/// Answers a steering prompt with its receiving turn's stop reason. Usage is
/// reported once, on the response to the prompt that started the turn.
pub fn writeSteeringPromptResponse(w: *std.Io.Writer, reason: StopReason, delivery: SteeringDelivery) !void {
    try w.writeAll("{\"stopReason\":");
    try writeJsonStr(reason.jsonString(), w);
    try w.writeAll(",\"_meta\":{\"lia\":{\"steering\":");
    try writeJsonStr(@tagName(delivery), w);
    if (reason.hasLiaMeta()) {
        try w.writeByte(',');
        try writeLiaStopReasonField(w, reason);
    }
    try w.writeAll("}}}");
}

/// Replays delivered steering where the agent inserted it into the turn.
pub fn writeSteeringUserMessageChunk(
    w: *std.Io.Writer,
    message_id: []const u8,
    text: []const u8,
    request_id: ?jsonrpc.RequestId,
) !void {
    try w.writeAll("{\"sessionUpdate\":\"user_message_chunk\",\"messageId\":");
    try writeJsonStr(message_id, w);
    try w.writeAll(",\"content\":{\"type\":\"text\",\"text\":");
    try writeJsonStr(text, w);
    try w.writeAll("},\"_meta\":{\"lia\":{\"steering\":{\"requestId\":");
    try jsonrpc.Writer.writeId(w, request_id);
    try w.writeAll("}}}}");
}

test "steering replay carries the request id of its prompt" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeSteeringUserMessageChunk(&out.writer, "m1", "use tabs", .{ .integer = 4 });
    try std.testing.expectEqualStrings(
        "{\"sessionUpdate\":\"user_message_chunk\",\"messageId\":\"m1\",\"content\":{\"type\":\"text\",\"text\":\"use tabs\"},\"_meta\":{\"lia\":{\"steering\":{\"requestId\":4}}}}",
        out.written(),
    );
}

pub fn writePromptResponseWithUsage(
    w: *std.Io.Writer,
    reason: StopReason,
    usage: core_types.Usage,
) !void {
    try w.writeAll("{\"stopReason\":");
    try writeJsonStr(reason.jsonString(), w);
    try w.writeAll(",\"usage\":{");
    var first = true;
    inline for (.{
        .{ "inputTokens", usage.input_tokens },
        .{ "outputTokens", usage.output_tokens },
        .{ "cacheReadTokens", usage.cache_read_tokens },
        .{ "cacheWriteTokens", usage.cache_write_tokens },
        .{ "reasoningTokens", usage.reasoning_tokens },
    }) |field| {
        if (field[1]) |value| {
            if (!first) try w.writeByte(',');
            first = false;
            try writeJsonStr(field[0], w);
            try w.print(":{d}", .{value});
        }
    }
    try w.writeAll("}");
    if (reason.hasLiaMeta()) {
        try w.writeAll(",\"_meta\":{\"lia\":{");
        try writeLiaStopReasonField(w, reason);
        try w.writeAll("}}");
    }
    try w.writeAll("}");
}

pub fn writeAvailableCommandsUpdate(w: *std.Io.Writer, commands_json: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"available_commands_update\",\"availableCommands\":");
    try w.writeAll(commands_json);
    try w.writeAll("}");
}

pub fn writeSessionInfoUpdate(w: *std.Io.Writer, title: []const u8, updated_at: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"session_info_update\",\"title\":");
    try writeJsonStr(title, w);
    try w.writeAll(",\"updatedAt\":");
    try writeJsonStr(updated_at, w);
    try w.writeAll("}");
}

pub fn writeUsageUpdate(w: *std.Io.Writer, used: u64, size: u64) !void {
    try w.print("{{\"sessionUpdate\":\"usage_update\",\"used\":{d},\"size\":{d}}}", .{ used, size });
}

test "writeAgentMessageChunk produces valid json" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeAgentMessageChunk(&out.writer, "message-1", "Hello world");
    const expected = "{\"sessionUpdate\":\"agent_message_chunk\",\"messageId\":\"message-1\",\"content\":{\"type\":\"text\",\"text\":\"Hello world\"}}";
    try std.testing.expectEqualStrings(expected, out.writer.buffered());
}

test "writeToolCall produces valid json" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    var raw_input = try std.json.parseFromSlice(
        std.json.Value,
        alloc,
        "{\"path\":\"README.md\"}",
        .{},
    );
    defer raw_input.deinit();

    try writeToolCall(
        &out.writer,
        "call_001",
        "read_file",
        "Reading file",
        .read,
        .pending,
        raw_input.value,
        .{},
    );
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.writer.buffered(), .{});
    defer parsed.deinit();
    const tool_call_meta = parsed.value.object.get("_meta").?.object.get("lia").?.object.get("toolCall").?.object;
    try std.testing.expect(!tool_call_meta.get("internal").?.bool);
    try std.testing.expect(tool_call_meta.get("mcp") == null);

    try std.testing.expectEqualStrings("call_001", parsed.value.object.get("toolCallId").?.string);
    try std.testing.expectEqualStrings("read_file", parsed.value.object.get("name").?.string);
    try std.testing.expectEqualStrings("read", parsed.value.object.get("kind").?.string);
    try std.testing.expectEqualStrings(
        "README.md",
        parsed.value.object.get("rawInput").?.object.get("path").?.string,
    );
}

test "writePromptResponse produces valid json" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writePromptResponse(&out.writer, .end_turn);
    try std.testing.expectEqualStrings("{\"stopReason\":\"end_turn\"}", out.writer.buffered());
}

test "StopReason maps every reason to an ACP v1 value" {
    const cases = [_]struct { reason: StopReason, v1: []const u8, lia: ?[]const u8 }{
        .{ .reason = .end_turn, .v1 = "end_turn", .lia = null },
        .{ .reason = .cancelled, .v1 = "cancelled", .lia = null },
        .{ .reason = .max_output_tokens, .v1 = "max_tokens", .lia = "max_output_tokens" },
        .{ .reason = .max_model_turns, .v1 = "max_turn_requests", .lia = "max_model_turns" },
        .{ .reason = .refused, .v1 = "refusal", .lia = "refused" },
        .{ .reason = .content_filter, .v1 = "refusal", .lia = "content_filter" },
        .{ .reason = .yielded, .v1 = "max_turn_requests", .lia = "yielded" },
    };
    const alloc = std.testing.allocator;
    for (cases) |case| {
        try std.testing.expectEqualStrings(case.v1, case.reason.jsonString());
        var out: std.Io.Writer.Allocating = .init(alloc);
        defer out.deinit();
        try writePromptResponse(&out.writer, case.reason);
        const expected = if (case.lia) |lia|
            try alloc.print("{{\"stopReason\":\"{s}\",\"_meta\":{{\"lia\":{{\"stopReason\":\"{s}\"}}}}}}", .{ case.v1, lia })
        else
            try alloc.print("{{\"stopReason\":\"{s}\"}}", .{case.v1});
        defer alloc.free(expected);
        try std.testing.expectEqualStrings(expected, out.writer.buffered());
    }
}

test "steering and usage responses carry the lia stop reason" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeSteeringPromptResponse(&out.writer, .yielded, .absorbed);
    try std.testing.expectEqualStrings(
        "{\"stopReason\":\"max_turn_requests\",\"_meta\":{\"lia\":{\"steering\":\"absorbed\",\"stopReason\":\"yielded\"}}}",
        out.writer.buffered(),
    );
    var usage_out: std.Io.Writer.Allocating = .init(alloc);
    defer usage_out.deinit();
    try writePromptResponseWithUsage(&usage_out.writer, .refused, .{ .input_tokens = 3 });
    try std.testing.expectEqualStrings(
        "{\"stopReason\":\"refusal\",\"usage\":{\"inputTokens\":3},\"_meta\":{\"lia\":{\"stopReason\":\"refused\"}}}",
        usage_out.writer.buffered(),
    );

    // A reason ACP names itself adds no `_meta.lia.stopReason`.
    out.clearRetainingCapacity();
    try writeSteeringPromptResponse(&out.writer, .end_turn, .absorbed);
    try std.testing.expectEqualStrings(
        "{\"stopReason\":\"end_turn\",\"_meta\":{\"lia\":{\"steering\":\"absorbed\"}}}",
        out.written(),
    );
    out.clearRetainingCapacity();
    try writeSteeringPromptResponse(&out.writer, .cancelled, .dropped);
    try std.testing.expectEqualStrings(
        "{\"stopReason\":\"cancelled\",\"_meta\":{\"lia\":{\"steering\":\"dropped\"}}}",
        out.written(),
    );
    out.clearRetainingCapacity();
    try writePromptResponseWithUsage(&out.writer, .end_turn, .{ .input_tokens = 3 });
    try std.testing.expectEqualStrings(
        "{\"stopReason\":\"end_turn\",\"usage\":{\"inputTokens\":3}}",
        out.written(),
    );
    out.clearRetainingCapacity();
    try writePromptResponseWithUsage(&out.writer, .cancelled, .{ .output_tokens = 5 });
    try std.testing.expectEqualStrings(
        "{\"stopReason\":\"cancelled\",\"usage\":{\"outputTokens\":5}}",
        out.written(),
    );
}

test "ToolCallKind jsonString values" {
    try std.testing.expectEqualStrings("read", ToolCallKind.read.jsonString());
    try std.testing.expectEqualStrings("edit", ToolCallKind.edit.jsonString());
    try std.testing.expectEqualStrings("execute", ToolCallKind.execute.jsonString());
    try std.testing.expectEqualStrings("search", ToolCallKind.search.jsonString());
    try std.testing.expectEqualStrings("fetch", ToolCallKind.fetch.jsonString());
    try std.testing.expectEqualStrings("other", ToolCallKind.other.jsonString());
}

test "ToolCallStatus jsonString values" {
    try std.testing.expectEqualStrings("pending", ToolCallStatus.pending.jsonString());
    try std.testing.expectEqualStrings("in_progress", ToolCallStatus.in_progress.jsonString());
    try std.testing.expectEqualStrings("completed", ToolCallStatus.completed.jsonString());
    try std.testing.expectEqualStrings("failed", ToolCallStatus.failed.jsonString());
}

test "writeToolCallUpdate with content" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeToolCallUpdate(&out.writer, "call_002", .completed, "File written successfully");
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"tool_call_update\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"completed\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "File written successfully") != null);
}

test "writeToolCallUpdate can include structured command result" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try writeToolCallUpdateWithCommandResult(
        &out.writer,
        "call_002",
        .completed,
        "exit_code=0\n<stdout>\nok\n</stdout>\n",
        "{\"kind\":\"command\",\"command\":\"printf ok\",\"cwd\":\"/tmp\",\"exit_code\":0,\"signal\":null,\"timed_out\":false,\"stdout_bytes\":2,\"stderr_bytes\":0,\"truncated\":false}",
    );
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.writer.buffered(), .{});
    defer parsed.deinit();

    try std.testing.expectEqualStrings("tool_call_update", parsed.value.object.get("sessionUpdate").?.string);
    const command_result = parsed.value.object.get("command_result").?.object;
    try std.testing.expectEqualStrings("command", command_result.get("kind").?.string);
    try std.testing.expectEqual(@as(i64, 0), command_result.get("exit_code").?.integer);
    try std.testing.expect(parsed.value.object.get("content") != null);
}

test "writeToolCallUpdate without content" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeToolCallUpdate(&out.writer, "call_003", .in_progress, null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"in_progress\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "content") == null);
}

test "writeInitializeResponse contains required fields" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeInitializeResponse(&out.writer, .{ .image_prompts = true, .steering = true, .system_prompt = true, .mcp_over_acp = true }, .{});
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.writer.buffered(), .{});
    defer parsed.deinit();

    const agent_capabilities = parsed.value.object.get("agentCapabilities").?.object;
    const mcp_capabilities = agent_capabilities.get("mcpCapabilities").?.object;
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"protocolVersion\":1") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"loadSession\":true") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"name\":\"lia\"") != null);
    try std.testing.expectEqualStrings(
        build_options.app_version,
        parsed.value.object.get("agentInfo").?.object.get("version").?.string,
    );
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"image\":true") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"list\":{}") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"resume\":{}") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"close\":{}") != null);
    try std.testing.expect(mcp_capabilities.get("http").?.bool);
    try std.testing.expect(mcp_capabilities.get("sse").?.bool);
    try std.testing.expect(mcp_capabilities.get("acp").?.bool);
    const session_capabilities = agent_capabilities.get("sessionCapabilities").?.object;
    try std.testing.expectEqual(@as(usize, 0), session_capabilities.get("systemPrompt").?.object.count());
    const lia_meta = agent_capabilities.get("_meta").?.object.get("lia").?.object;
    try std.testing.expect(lia_meta.get("steering").?.bool);
}

test "writeInitializeResponse withholds MCP transports a host rejects" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeInitializeResponse(&out.writer, .{ .image_prompts = false, .mcp_servers = false }, .{});
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.writer.buffered(), .{});
    defer parsed.deinit();
    const mcp_capabilities = parsed.value.object.get("agentCapabilities").?.object.get("mcpCapabilities").?.object;
    try std.testing.expect(!mcp_capabilities.get("http").?.bool);
    try std.testing.expect(!mcp_capabilities.get("sse").?.bool);
}

test "writeToolCall separates MCP server and tool identity" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeToolCall(&out.writer, "call_mcp", "mcp_mini_browser_eval", "Evaluate JavaScript", .other, .pending, null, .{
        .mcp = .{ .server = "mini", .tool = "browser_eval" },
    });
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.writer.buffered(), .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("Evaluate JavaScript", parsed.value.object.get("title").?.string);
    const meta = parsed.value.object.get("_meta").?.object.get("lia").?.object.get("toolCall").?.object;
    try std.testing.expect(!meta.get("internal").?.bool);
    try std.testing.expectEqualStrings("mini", meta.get("mcp").?.object.get("server").?.string);
    try std.testing.expectEqualStrings("browser_eval", meta.get("mcp").?.object.get("tool").?.string);
}

test "writeUserMessageChunk produces valid json" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeUserMessageChunk(&out.writer, "message-2", "User says hello");
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"user_message_chunk\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "User says hello") != null);
}

test "writeUsageUpdate reports context used and size" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeUsageUpdate(&out.writer, 8, 128_000);
    try std.testing.expectEqualStrings(
        "{\"sessionUpdate\":\"usage_update\",\"used\":8,\"size\":128000}",
        out.writer.buffered(),
    );
}

test "writeSessionUpdate wraps update with sessionId" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeSessionUpdate(&out.writer, "sess_123", "{\"sessionUpdate\":\"test\"}");
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"sessionId\":\"sess_123\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"sessionUpdate\":\"test\"") != null);
}

test "model recovery info update wraps the shared report and is clearable" {
    // The report's shape is `types.zig` "recovery reports write the shape lia
    // ask and ACP share"; this pins the ACP envelope around it.
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeModelRecoveryInfoUpdate(&out.writer, .{
        .kind = .waiting,
        .text = core_types.testRecoveryText("Gateway error · next try in 8s · attempt 4 · 1m 12s"),
        .attempt = 4,
    });
    try std.testing.expectEqualStrings(
        "{\"sessionUpdate\":\"session_info_update\",\"_meta\":{\"lia\":{\"modelResponseRecovery\":{\"state\":\"waiting\",\"attempt\":4,\"message\":\"Gateway error · next try in 8s · attempt 4 · 1m 12s\"}}}}",
        out.writer.buffered(),
    );

    out.writer.end = 0;
    try writeModelRecoveryInfoUpdate(&out.writer, null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"modelResponseRecovery\":null") != null);
}

fn initializeAuthMethodsAlloc(alloc: Allocator, offer: AuthOffer) !std.json.Parsed(std.json.Value) {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeInitializeResponse(&out.writer, .{ .image_prompts = false }, offer);
    // alloc_always: the parsed strings outlive `out`.
    return std.json.parseFromSlice(std.json.Value, alloc, out.written(), .{ .allocate = .alloc_always });
}

test "initialize offers only the agent auth method without auth.terminal" {
    const alloc = std.testing.allocator;
    const vercel_help = "lia needs access to Vercel AI Gateway. Run lia login to sign in, lia login vercel --api-key to use an API key, or set AI_GATEWAY_API_KEY.";
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeAuthMethods(&out.writer, .{});
    try std.testing.expectEqualStrings(
        "[{\"id\":\"lia-login\",\"name\":\"Sign in to Vercel AI Gateway\",\"description\":\"" ++ vercel_help ++ "\"}]",
        out.written(),
    );

    const parsed = try initializeAuthMethodsAlloc(alloc, .{});
    defer parsed.deinit();
    const methods = parsed.value.object.get("authMethods").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), methods.len);
    try std.testing.expectEqualStrings("lia-login", methods[0].object.get("id").?.string);
    try std.testing.expect(methods[0].object.get("type") == null);
}

test "initialize adds the terminal auth method only with auth.terminal" {
    const alloc = std.testing.allocator;
    const parsed = try initializeAuthMethodsAlloc(alloc, .{ .client_terminal_auth = true });
    defer parsed.deinit();
    const methods = parsed.value.object.get("authMethods").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), methods.len);
    try std.testing.expectEqualStrings("lia-login", methods[0].object.get("id").?.string);
    try std.testing.expect(methods[0].object.get("type") == null);
    const terminal = methods[1].object;
    try std.testing.expectEqualStrings("lia-login-api-key", terminal.get("id").?.string);
    try std.testing.expectEqualStrings("Use a Vercel AI Gateway API key", terminal.get("name").?.string);
    try std.testing.expectEqualStrings("terminal", terminal.get("type").?.string);
    const args = terminal.get("args").?.array.items;
    try std.testing.expectEqual(@as(usize, 3), args.len);
    try std.testing.expectEqualStrings("login", args[0].string);
    try std.testing.expectEqualStrings("vercel", args[1].string);
    try std.testing.expectEqualStrings("--api-key", args[2].string);
}

test "a configured provider is offered no Vercel sign-in or API key method" {
    const alloc = std.testing.allocator;
    const parsed = try initializeAuthMethodsAlloc(alloc, .{ .login = .configured, .client_terminal_auth = true, .sign_in_block = .home_unavailable });
    defer parsed.deinit();
    const methods = parsed.value.object.get("authMethods").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), methods.len);
    try std.testing.expectEqualStrings("Set the configured provider's API key", methods[0].object.get("name").?.string);
    try std.testing.expect(std.mem.find(u8, methods[0].object.get("description").?.string, "settings.json") != null);
}

test "AUTH_REQUIRED data carries the same auth methods" {
    const alloc = std.testing.allocator;
    const offers = [_]AuthOffer{
        .{},
        .{ .client_terminal_auth = true },
    };
    for (offers) |offer| {
        var data: std.Io.Writer.Allocating = .init(alloc);
        defer data.deinit();
        try writeAuthRequiredData(&data.writer, offer);
        const parsed_data = try std.json.parseFromSlice(std.json.Value, alloc, data.written(), .{});
        defer parsed_data.deinit();
        const from_error = parsed_data.value.object.get("authMethods").?.array.items;

        const parsed_init = try initializeAuthMethodsAlloc(alloc, offer);
        defer parsed_init.deinit();
        const from_initialize = parsed_init.value.object.get("authMethods").?.array.items;

        try std.testing.expectEqual(from_initialize.len, from_error.len);
        for (from_initialize, from_error) |a, b| {
            try std.testing.expectEqualStrings(a.object.get("id").?.string, b.object.get("id").?.string);
            try std.testing.expectEqualStrings(a.object.get("name").?.string, b.object.get("name").?.string);
        }
    }
}

test "authenticate accepts the agent and terminal method ids only" {
    try std.testing.expect(isAuthMethodId("lia-login"));
    try std.testing.expect(isAuthMethodId("lia-login-api-key"));
    try std.testing.expect(!isAuthMethodId("lia-login-codex"));
    try std.testing.expect(!isAuthMethodId(""));
}
