//! The documented `LIA_*` variables that override a setting for the whole
//! process, read the way lia reads them, so `lia config list` and `get` can show
//! the value lia uses and where it came from.

const std = @import("std");
const agent_steps = @import("agent_steps.zig");
const compactor = @import("../compactor/compactor.zig");
const config_runtime = @import("config_runtime.zig");
const io_mod = @import("../shared/io.zig");
const model_provider = @import("model_provider.zig");
const settings_store = @import("settings_store.zig");
const types = @import("../shared/types.zig");

const Allocator = std.mem.Allocator;

pub const Override = struct {
    /// The variable, such as `LIA_MAX_AGENT_STEPS`.
    variable: []const u8,
    /// The dotted setting it overrides, such as `max_agent_steps`.
    key: []const u8,
    /// The value lia uses, in settings-file form.
    value: std.json.Value,
};

/// `LIA_SOUND` is a preset for the whole `sound` group.
pub const SoundPreset = enum {
    /// Every sound off.
    off,
    /// Turn-end and attention sounds on, `max` off.
    on,
    /// Every sound on.
    max,
};

/// The preset `LIA_SOUND` names: `max`, or `0`, `false`, or `off` for off.
/// Any other non-blank value turns sounds on.
pub fn soundPreset(raw: []const u8) ?SoundPreset {
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == 0) return null;
    if (std.ascii.eqlIgnoreCase(trimmed, "max")) return .max;
    const off = std.mem.eql(u8, trimmed, "0") or
        std.ascii.eqlIgnoreCase(trimmed, "false") or
        std.ascii.eqlIgnoreCase(trimmed, "off");
    return if (off) .off else .on;
}

/// Every documented `LIA_*` setting override set in this process, in a fixed
/// order, with the value lia uses. A value lia ignores or rejects, such as
/// `LIA_MAX_AGENT_STEPS=many`, is left out. `LIA_MODEL` overrides the model of
/// `provider`, the provider lia would use without it. Everything, including
/// the returned slice, is allocated with `arena`.
pub fn collect(arena: Allocator, provider: model_provider.ProviderId) ![]Override {
    var list: std.ArrayList(Override) = .empty;
    const getenv = io_mod.getenv;

    var model_provider_id = provider;
    if (config_runtime.providerEnvOverride()) |raw| {
        if (model_provider.parse(std.mem.trim(u8, raw, " \t\r\n"))) |parsed| {
            model_provider_id = parsed;
            try list.append(arena, .{ .variable = "LIA_PROVIDER", .key = "provider", .value = .{ .string = try arena.dupe(u8, parsed.label()) } });
        }
    }
    if (config_runtime.modelEnvOverride()) |model| {
        const key = try std.mem.concat(arena, u8, &.{ "models.", model_provider.NameKey.fromProvider(model_provider_id).label() });
        try list.append(arena, .{ .variable = "LIA_MODEL", .key = key, .value = .{ .string = model } });
    }
    if (config_runtime.ultrafastModeEnvOverride() catch null) |enabled| {
        try list.append(arena, .{ .variable = "LIA_ULTRAFAST", .key = "ultrafast_mode", .value = .{ .bool = enabled } });
    }
    if (getenv("LIA_REVIEW_MODEL")) |raw| {
        const trimmed = std.mem.trim(u8, raw, " \t\r\n");
        if (trimmed.len > 0) {
            if (settings_store.validateModel(trimmed)) |_| {
                try list.append(arena, .{ .variable = "LIA_REVIEW_MODEL", .key = "review_model", .value = .{ .string = trimmed } });
            } else |_| {}
        }
    }
    if (getenv("LIA_PROVIDER_ORDER")) |raw| {
        switch (config_runtime.parseProviderOrderList(arena, raw)) {
            .ok => |maybe_order| if (maybe_order) |order| {
                var array: std.json.Array = .init(arena);
                for (order) |slug| try array.append(.{ .string = slug });
                try list.append(arena, .{ .variable = "LIA_PROVIDER_ORDER", .key = "provider_order", .value = .{ .array = array } });
            },
            .invalid => {},
        }
    }
    if (getenv("LIA_PROVIDER_STRICT")) |raw| {
        if (config_runtime.parseEnvBool(std.mem.trim(u8, raw, " \t\r\n"))) |strict| {
            try list.append(arena, .{ .variable = "LIA_PROVIDER_STRICT", .key = "provider_strict", .value = .{ .bool = strict } });
        }
    }
    if (getenv("LIA_PERMISSION_MODE")) |raw| {
        if (types.PermissionMode.parse(raw)) |mode| {
            try list.append(arena, .{ .variable = "LIA_PERMISSION_MODE", .key = "permission_mode", .value = .{ .string = mode.label() } });
        }
    }
    if (agent_steps.parseMaxAgentSteps(getenv("LIA_MAX_AGENT_STEPS"))) |steps| {
        // lia accepts any usize, which can exceed a JSON integer.
        const value: std.json.Value = if (std.math.cast(i64, steps)) |fits|
            .{ .integer = fits }
        else
            .{ .number_string = try std.fmt.allocPrint(arena, "{d}", .{steps}) };
        try list.append(arena, .{ .variable = "LIA_MAX_AGENT_STEPS", .key = "max_agent_steps", .value = value });
    }
    if (compactor.parsePercent(getenv("LIA_AUTO_COMPACT_PERCENT"))) |percent| {
        try list.append(arena, .{ .variable = "LIA_AUTO_COMPACT_PERCENT", .key = "auto_compact_percent", .value = .{ .integer = percent } });
    }
    if (getenv("LIA_THEME")) |raw| {
        if (raw.len > 0) try list.append(arena, .{ .variable = "LIA_THEME", .key = "theme", .value = .{ .string = raw } });
    }
    if (getenv("LIA_SOUND")) |raw| {
        if (soundPreset(raw)) |preset| {
            const values = [_]struct { key: []const u8, on: bool }{
                .{ .key = "sound.turn_end", .on = preset != .off },
                .{ .key = "sound.attention_required", .on = preset != .off },
                .{ .key = "sound.max", .on = preset == .max },
            };
            for (values) |entry| try list.append(arena, .{ .variable = "LIA_SOUND", .key = entry.key, .value = .{ .bool = entry.on } });
        }
    }
    return list.toOwnedSlice(arena);
}

var test_empty_environ: ?*std.process.Environ.Map = null;

/// An empty environment that outlives every test, for a test that installs
/// its own to restore afterwards.
pub fn emptyTestEnviron() !*const std.process.Environ.Map {
    if (test_empty_environ) |map| return map;
    const map = try std.heap.page_allocator.create(std.process.Environ.Map);
    map.* = .init(std.heap.page_allocator);
    test_empty_environ = map;
    return map;
}

test "collect shows each set override as the setting lia uses, and skips ignored values" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const restore = io_mod.environMap() orelse try emptyTestEnviron();
    var env: std.process.Environ.Map = .init(std.testing.allocator);
    defer env.deinit();
    for ([_][2][]const u8{
        .{ "LIA_PROVIDER", "gateway" },
        .{ "LIA_MODEL", " gpt-test " },
        .{ "LIA_MAX_AGENT_STEPS", "12" },
        // Out of range, so lia ignores it.
        .{ "LIA_AUTO_COMPACT_PERCENT", "5" },
        .{ "LIA_PERMISSION_MODE", "yolo" },
        .{ "LIA_SOUND", "max" },
    }) |entry| try env.put(entry[0], entry[1]);
    io_mod.setEnvironMap(&env);
    defer io_mod.setEnvironMap(restore);

    const found = try collect(arena.allocator(), .gateway);
    const expected = [_]struct { variable: []const u8, key: []const u8 }{
        .{ .variable = "LIA_PROVIDER", .key = "provider" },
        .{ .variable = "LIA_MODEL", .key = "models.gateway" },
        .{ .variable = "LIA_PERMISSION_MODE", .key = "permission_mode" },
        .{ .variable = "LIA_MAX_AGENT_STEPS", .key = "max_agent_steps" },
        .{ .variable = "LIA_SOUND", .key = "sound.turn_end" },
        .{ .variable = "LIA_SOUND", .key = "sound.attention_required" },
        .{ .variable = "LIA_SOUND", .key = "sound.max" },
    };
    try std.testing.expectEqual(expected.len, found.len);
    for (expected, found) |want, got| {
        try std.testing.expectEqualStrings(want.variable, got.variable);
        try std.testing.expectEqualStrings(want.key, got.key);
    }
    try std.testing.expectEqualStrings("gpt-test", found[1].value.string);
    try std.testing.expectEqualStrings("full-access", found[2].value.string);
    try std.testing.expectEqual(@as(i64, 12), found[3].value.integer);
    try std.testing.expect(found[6].value.bool);
}
