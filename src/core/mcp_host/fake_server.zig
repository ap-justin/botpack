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
        .newest => method_not_found ++ nl ++ comptime initializeResult("2025-11-25"),
        .older => method_not_found ++ nl ++ comptime initializeResult("2025-03-26"),
        .older_error => method_not_found ++ nl ++ initialize_accepts_2025_06_18 ++ comptime initializeRefusal("\"2025-06-18\""),
        .older_error_stuck => method_not_found ++ nl ++ comptime initializeRefusal("\"2025-06-18\""),
        .per_request => discover_modern ++ nl,
        .unsupported_initialize => method_not_found ++ nl ++ comptime initializeResult("2024-11-05"),
        .unsupported_initialize_error => method_not_found ++ nl ++ comptime initializeRefusal("\"2024-11-05\""),
        .unsupported_discover => discover_unsupported ++ nl,
    } ++ rest;
}

const rest =
    \\    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echoes","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
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
