//! A fake MCP server for the host's tests, in sh, so they need no network
//! or package. Imported only from tests.

const std = @import("std");
const io_mod = @import("../shared/io.zig");
const Options = @import("runtime.zig").Options;
const testing = std.testing;

/// A 2025 MCP server in sh: discovery gets an error, so the engine falls back
/// to `initialize`; it lists one `echo` tool and answers calls, except a call
/// that mentions "slow", which never answers. A call that mentions
/// "withdraw" asks form question Q1, withdraws it, asks Q2, and once Q2 is
/// answered, returns what reached each: "e1 " if Q1 got an answer, then
/// "e2=" and Q2's `name`. A call that mentions "confirm" asks question c1
/// and returns "c1=" and the answer's action. A call that mentions "pid"
/// returns the server's process id, as "pid=" and the number. Started with
/// `linger` as its first argument, it exits a second after its stdin ends.
pub const script = scriptFor(.newest);

/// Which MCP versions the fake server speaks.
pub const Mode = enum {
    /// Only 2025-11-25: discovery fails, initialize succeeds.
    newest,
    /// Only 2025-03-26: initialize is answered with that version, whatever it offered.
    older,
    /// Only 2025-06-18: any other version in initialize is refused with an error listing it.
    older_error,
    /// Refuses every initialize with an error listing 2025-06-18, even one that offers it.
    older_error_stuck,
    /// Only 2026-07-28: discovery lists it, requests must carry it, initialize fails.
    per_request,
    /// Only 2024-11-05, which fx doesn't speak: discovery fails, initialize is answered with it.
    unsupported_initialize,
    /// Only 2024-11-05, which fx doesn't speak: discovery fails, initialize is refused with an error listing it.
    unsupported_initialize_error,
    /// A modern server that lists only a version fx doesn't speak.
    unsupported_discover,
    /// Like `.newest`, and it also lists `tool_call`, whose `arguments` is an
    /// open object; a call to it answers "arguments=object" or
    /// "arguments=string" for what its `arguments` arrived as.
    open_object,
};

const head =
    \\#!/bin/sh
    \\while IFS= read -r line; do
    \\  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
;

const per_request_guard =
    \\  case "$line" in
    \\    *'"method":"server/discover"'*|*'"method":"initialize"'*) ;;
    \\    *'"method":"tools/'*)
    \\      case "$line" in
    \\        *'"io.modelcontextprotocol/protocolVersion":"2026-07-28"'*) ;;
    \\        *) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"missing protocol version"}}\n' "$id"; continue ;;
    \\      esac ;;
    \\  esac
;

const body_start =
    \\  case "$line" in
;

const method_not_found =
    \\    *'"method":"server/discover"'*) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id" ;;
;

fn initializeResult(comptime version: []const u8) []const u8 {
    return "    *'\"method\":\"initialize\"'*) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"protocolVersion\":\"" ++ version ++
        "\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"fake\",\"version\":\"1\"}}}\n' \"$id\" ;;\n";
}

const initialize_accepts_2025_06_18 =
    \\    *'"method":"initialize"'*'"protocolVersion":"2025-06-18"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"1"}}}\n' "$id" ;;
    \\
;

/// Refuses initialize with -32602, listing `supported` (JSON array elements).
fn initializeRefusal(comptime supported: []const u8) []const u8 {
    return "    *'\"method\":\"initialize\"'*) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"error\":{\"code\":-32602,\"message\":\"Unsupported protocol version\",\"data\":{\"supported\":[" ++ supported ++
        "],\"requested\":\"other\"}}}\\n' \"$id\" ;;\n";
}

const discover_modern =
    \\    *'"method":"server/discover"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"1"}}}\n' "$id" ;;
    \\    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32600,"message":"initialize is not served"}}\n' "$id" ;;
;

const discover_unsupported =
    \\    *'"method":"server/discover"'*) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32022,"message":"Unsupported protocol version","data":{"supported":["2027-01-01"]}}}\n' "$id" ;;
;

/// The script for `mode`; `script` is the `.newest` one.
pub fn scriptFor(comptime mode: Mode) []const u8 {
    const nl = "\n";
    return head ++ nl ++ (if (mode == .per_request) per_request_guard ++ nl else "") ++ body_start ++ nl ++ switch (mode) {
        .newest, .open_object => method_not_found ++ nl ++ comptime initializeResult("2025-11-25"),
        .older => method_not_found ++ nl ++ comptime initializeResult("2025-03-26"),
        .older_error => method_not_found ++ nl ++ initialize_accepts_2025_06_18 ++ comptime initializeRefusal("\"2025-06-18\""),
        .older_error_stuck => method_not_found ++ nl ++ comptime initializeRefusal("\"2025-06-18\""),
        .per_request => discover_modern ++ nl,
        .unsupported_initialize => method_not_found ++ nl ++ comptime initializeResult("2024-11-05"),
        .unsupported_initialize_error => method_not_found ++ nl ++ comptime initializeRefusal("\"2024-11-05\""),
        .unsupported_discover => discover_unsupported ++ nl,
    } ++ (if (mode == .open_object) open_object_list else default_list) ++ calls;
}

const default_list =
    \\    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echoes","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
    \\
;

const open_object_list =
    \\    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echoes","inputSchema":{"type":"object"}},{"name":"tool_call","description":"Calls a tool by name","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"object","additionalProperties":true}},"required":["name"]}}]}}\n' "$id" ;;
    \\    *'"method":"tools/call"'*'"name":"tool_call","arguments":{'*'"arguments":{'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"arguments=object"}]}}\n' "$id" ;;
    \\    *'"method":"tools/call"'*'"name":"tool_call","arguments":{'*'"arguments":"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"arguments=string"}]}}\n' "$id" ;;
    \\
;

const calls =
    \\    *'"method":"tools/call"'*slow*) ;;
    \\    *'"method":"tools/call"'*withdraw*)
    \\      call=$id
    \\      printf '{"jsonrpc":"2.0","id":"e1","method":"elicitation/create","params":{"mode":"form","message":"Q1","requestedSchema":{"type":"object","properties":{"name":{"type":"string"}}}}}\n'
    \\      printf '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"e1"}}\n'
    \\      printf '{"jsonrpc":"2.0","id":"e2","method":"elicitation/create","params":{"mode":"form","message":"Q2","requestedSchema":{"type":"object","properties":{"name":{"type":"string"}}}}}\n' ;;
    \\    *'"method":"tools/call"'*confirm*)
    \\      call=$id
    \\      printf '{"jsonrpc":"2.0","id":"c1","method":"elicitation/create","params":{"mode":"form","message":"Confirm?","requestedSchema":{"type":"object","properties":{"ok":{"type":"boolean"}}}}}\n' ;;
    \\    *'"id":"c1"'*)
    \\      action=$(printf '%s' "$line" | sed -n 's/.*"action":"\([a-z]*\)".*/\1/p')
    \\      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"c1=%s"}]}}\n' "$call" "$action" ;;
    \\    *'"id":"e1"'*) got="${got}e1 " ;;
    \\    *'"id":"e2"'*)
    \\      name=$(printf '%s' "$line" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
    \\      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%se2=%s"}]}}\n' "$call" "$got" "$name" ;;
    \\    *'"method":"tools/call"'*pid*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"pid=%s"}]}}\n' "$id" "$$" ;;
    \\    *'"method":"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"hi"}]}}\n' "$id" ;;
    \\  esac
    \\done
    \\if [ "$1" = linger ]; then sleep 1; fi
    \\
;

/// What the HTTP fake answers.
pub const HttpMode = enum {
    /// A 2026 server behind a proxy that drops request headers: the server
    /// sees no `Mcp-Method` and answers `server/discover` with 400 and
    /// -32020. fx's client does send the header; the fake treats it as
    /// absent. It accepts `initialize` 2025-11-25, which needs no
    /// `Mcp-Method`, and serves one `echo` tool on that session.
    header_stripped,
    /// Like `.header_stripped`, and `initialize` gets 400 and -32020 too.
    header_stripped_refused,
    /// A 2026 server that reads the headers: discovery lists 2026-07-28, and
    /// a tools request is served when its `Mcp-Method` names its method and
    /// its `_meta` carries that version.
    per_request,
    /// A 2026 server that lists only 2027-01-01, which fx doesn't speak.
    unsupported_discover,
    /// A 2026 server that answers discovery with 400 and -32021.
    missing_capability,
};

/// The message of the fake's -32020 answers, which name the request's method.
const header_mismatch_format = "Bad Request: the request headers and body disagree: the body names method {s} but the required Mcp-Method header is absent";
pub const header_mismatch_message = std.fmt.comptimePrint(header_mismatch_format, .{"server/discover"});
pub const missing_capability_message = "Missing required client capability: sampling";

/// A streamable HTTP MCP server on a loopback port, for the host's tests.
/// It answers one request per connection, one connection at a time, and
/// counts the `server/discover` requests it gets. It must not move once
/// started.
pub const HttpFake = struct {
    server: std.Io.net.Server,
    mode: HttpMode,
    discovers: std.atomic.Value(u32) = .init(0),
    serving: ?std.Io.Future(std.Io.Cancelable!void) = null,
    url_buffer: [64]u8 = undefined,
    url: []const u8 = "",

    pub fn start(f: *HttpFake, mode: HttpMode) !void {
        var address: std.Io.net.IpAddress = .{ .ip4 = .loopback(0) };
        f.* = .{ .server = try address.listen(testing.io, .{ .reuse_address = true }), .mode = mode };
        errdefer f.server.deinit(testing.io);
        f.url = try std.mem.print(&f.url_buffer, "http://127.0.0.1:{d}/mcp", .{f.server.socket.address.getPort()});
        f.serving = try testing.io.concurrent(serve, .{f});
    }

    pub fn stop(f: *HttpFake) void {
        if (f.serving) |*s| s.cancel(testing.io) catch {};
        f.server.deinit(testing.io);
    }

    fn serve(f: *HttpFake) std.Io.Cancelable!void {
        while (true) {
            const stream = f.server.accept(testing.io) catch |err| switch (err) {
                error.Canceled => return error.Canceled,
                else => return,
            };
            defer stream.close(testing.io);
            // A connection that fails is the client's to notice.
            f.answer(stream) catch {};
        }
    }

    fn answer(f: *HttpFake, stream: std.Io.net.Stream) !void {
        var in: [16 * 1024]u8 = undefined;
        var r = stream.reader(testing.io, &in);
        const request_line = try r.interface.takeDelimiterInclusive('\n');
        const is_post = std.mem.startsWith(u8, request_line, "POST ");
        var length: usize = 0;
        var mcp_method_buf: [64]u8 = undefined;
        var mcp_method: []const u8 = "";
        while (true) {
            const line = try r.interface.takeDelimiterInclusive('\n');
            if (line.len <= 2) break;
            const colon = std.mem.findScalar(u8, line, ':') orelse continue;
            const value = std.mem.trim(u8, line[colon + 1 ..], " \r\n");
            if (std.ascii.eqlIgnoreCase(line[0..colon], "content-length")) length = try std.fmt.parseInt(usize, value, 10);
            if (std.ascii.eqlIgnoreCase(line[0..colon], "mcp-method") and value.len <= mcp_method_buf.len) {
                @memcpy(mcp_method_buf[0..value.len], value);
                mcp_method = mcp_method_buf[0..value.len];
            }
        }
        const body = try r.interface.take(length);
        var out: [4096]u8 = undefined;
        var w = stream.writer(testing.io, &out);
        // The listening GET and the session's DELETE.
        if (!is_post) return respond(&w.interface, "405 Method Not Allowed", "");
        const id = idOf(body);
        const method = methodOf(body);
        var text: [1024]u8 = undefined;
        const stripped = f.mode == .header_stripped or f.mode == .header_stripped_refused;
        if (std.mem.eql(u8, method, "server/discover")) {
            _ = f.discovers.fetchAdd(1, .monotonic);
            return switch (f.mode) {
                .header_stripped, .header_stripped_refused => respond(&w.interface, "400 Bad Request", try headerMismatch(&text, id, method)),
                .per_request => respond(&w.interface, "200 OK", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{{\"resultType\":\"complete\",\"supportedVersions\":[\"2026-07-28\"],\"capabilities\":{{\"tools\":{{}}}},\"serverInfo\":{{\"name\":\"fake\",\"version\":\"1\"}}}}}}", .{id})),
                .unsupported_discover => respond(&w.interface, "400 Bad Request", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":-32022,\"message\":\"Unsupported protocol version\",\"data\":{{\"supported\":[\"2027-01-01\"],\"requested\":\"2026-07-28\"}}}}}}", .{id})),
                .missing_capability => respond(&w.interface, "400 Bad Request", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":-32021,\"message\":\"" ++ missing_capability_message ++ "\",\"data\":{{\"requiredCapabilities\":{{\"sampling\":{{}}}}}}}}}}", .{id})),
            };
        }
        if (std.mem.eql(u8, method, "initialize")) {
            if (f.mode == .header_stripped_refused) return respond(&w.interface, "400 Bad Request", try headerMismatch(&text, id, method));
            if (f.mode != .header_stripped) return respond(&w.interface, "400 Bad Request", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":-32600,\"message\":\"initialize is not served\"}}}}", .{id}));
            return respond(&w.interface, "200 OK", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{{\"tools\":{{}}}},\"serverInfo\":{{\"name\":\"fake\",\"version\":\"1\"}}}}}}", .{id}));
        }
        if (std.mem.startsWith(u8, method, "notifications/")) return respond(&w.interface, "202 Accepted", "");
        if (f.mode == .per_request) {
            const modern = std.mem.find(u8, body, "\"io.modelcontextprotocol/protocolVersion\":\"2026-07-28\"") != null;
            if (!modern or !std.mem.eql(u8, mcp_method, method)) return respond(&w.interface, "400 Bad Request", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":-32020,\"message\":\"Bad Request: headers and body disagree\"}}}}", .{id}));
        } else if (!stripped) return respond(&w.interface, "400 Bad Request", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":-32600,\"message\":\"not served\"}}}}", .{id}));
        if (std.mem.eql(u8, method, "tools/list")) return respond(&w.interface, "200 OK", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{{\"tools\":[{{\"name\":\"echo\",\"description\":\"Echoes\",\"inputSchema\":{{\"type\":\"object\"}}}}]}}}}", .{id}));
        if (std.mem.eql(u8, method, "tools/call")) return respond(&w.interface, "200 OK", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"hi\"}}]}}}}", .{id}));
        return respond(&w.interface, "200 OK", try std.mem.print(&text, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":-32601,\"message\":\"Method not found\"}}}}", .{id}));
    }

    fn headerMismatch(buf: []u8, id: []const u8, method: []const u8) ![]const u8 {
        return std.mem.print(buf, "{{\"jsonrpc\":\"2.0\",\"error\":{{\"code\":-32020,\"message\":\"" ++ header_mismatch_format ++
            "\",\"data\":{{\"mismatch\":{{\"header\":\"(missing)\",\"body\":\"{s}\"}}}}}},\"id\":{s}}}", .{ method, method, id });
    }

    fn respond(w: *std.Io.Writer, status: []const u8, body: []const u8) !void {
        const content_type = if (body.len > 0) "content-type: application/json\r\n" else "";
        try w.print("HTTP/1.1 {s}\r\n{s}content-length: {d}\r\nconnection: close\r\n\r\n", .{ status, content_type, body.len });
        try w.writeAll(body);
        try w.flush();
    }

    /// The request's numeric id, or `null` for a notification.
    fn idOf(body: []const u8) []const u8 {
        const key = "\"id\":";
        const from = (std.mem.find(u8, body, key) orelse return "null") + key.len;
        var end = from;
        while (end < body.len and std.ascii.isDigit(body[end])) end += 1;
        return if (end == from) "null" else body[from..end];
    }

    fn methodOf(body: []const u8) []const u8 {
        const key = "\"method\":\"";
        const from = (std.mem.find(u8, body, key) orelse return "") + key.len;
        const end = std.mem.findScalarPos(u8, body, from, '"') orelse return "";
        return body[from..end];
    }
};

pub const Fixture = struct {
    tmp: testing.TmpDir,
    home: []u8,
    server: []u8,
    inherited: std.process.Environ.Map,

    pub fn init(f: *Fixture) !void {
        try f.initMode(.newest);
    }

    pub fn initMode(f: *Fixture, comptime mode: Mode) !void {
        f.tmp = testing.tmpDir(.{});
        errdefer f.tmp.cleanup();
        try f.tmp.dir.writeFile(testing.io, .{ .sub_path = "server", .data = scriptFor(mode), .flags = .{ .permissions = .executable_file } });
        f.home = try io_mod.dirRealpathAlloc(testing.allocator, f.tmp.dir, ".");
        errdefer testing.allocator.free(f.home);
        f.server = try std.Io.Dir.path.join(testing.allocator, &.{ f.home, "server" });
        f.inherited = .init(testing.allocator);
    }

    pub fn deinit(f: *Fixture) void {
        f.inherited.deinit();
        testing.allocator.free(f.server);
        testing.allocator.free(f.home);
        f.tmp.cleanup();
    }

    pub fn options(f: *const Fixture) Options {
        return .{ .client_version = "test", .credentials = .{ .store = .{ .home = f.home, .backend = .file } } };
    }
};
