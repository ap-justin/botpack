//! `lia config`: show the values set in lia's settings files in git's
//! `key=value` format, and set or unset the plain preferences in the profile.

const std = @import("std");
const builtin_commands = @import("../../builtins/commands.zig");
const cli_flags = @import("cli_flags.zig");
const app_lifecycle = @import("../app/app_lifecycle.zig");
const config_runtime = @import("../config/config_runtime.zig");
const env_settings = @import("../config/env_settings.zig");
const model_provider = @import("../config/model_provider.zig");
const output_contracts = @import("../output/output_contracts.zig");
const profile_paths = @import("../shared/profile_paths.zig");
const settings_entries = @import("../config/settings_entries.zig");
const settings_keys = @import("../config/settings_keys.zig");
const settings_messages = @import("settings_messages.zig");
const settings_store = @import("../config/settings_store.zig");
const text_utils = @import("../shared/text_utils.zig");
const theme = @import("../shared/theme.zig");
const types = @import("../shared/types.zig");
const compactor = @import("../compactor/compactor.zig");
const tool_result_limits = @import("../tooling/tool_result_limits.zig");

const Allocator = std.mem.Allocator;

fn profileDisplay() []const u8 {
    return profile_paths.displayText("~/.lia/settings.json");
}
pub const project_display = ".lia.json";

pub const Action = enum { list, get, set, unset, schema };

pub const Options = struct {
    action: Action = .list,
    /// The key `get`, `set`, or `unset` names; null for `list`.
    key: ?[]const u8 = null,
    /// The value `set` writes, as typed.
    value: ?[]const u8 = null,
    scope: settings_entries.Scope = .all,
    show_origin: bool = false,
    format: output_contracts.OutputFormat = .text,
    /// `schema --project`: describe `.lia.json` instead of `settings.json`.
    project: bool = false,
};

const ConfigFlag = enum { global, workspace, show_origin, json, project };
const config_flag_ids = cli_flags.idTable(ConfigFlag, &builtin_commands.config_parse_options);

/// Parses `lia config [list|get <key>|set <key> <value>|unset <key>]` and its
/// flags. On a key that names no setting, sets `unknown_key` to the part that
/// isn't known; on other mistakes in the words, sets `problem` to what is
/// wrong. A value may start with a dash, as `-5` does. Slices borrow from
/// `args`.
pub fn parseArgs(
    args: []const [:0]const u8,
    unknown_key: *?settings_keys.UnknownPart,
    problem: *?[]const u8,
) error{ InvalidConfigArgs, UnknownConfigSetting, WorkspaceConfigWrite }!Options {
    var options: Options = .{};
    var words: [3][]const u8 = undefined;
    var word_count: usize = 0;
    var parser: cli_flags.Parser = .initDashOperands(&builtin_commands.config_parse_options, args);
    while (parser.next() catch return error.InvalidConfigArgs) |item| switch (item) {
        .positional => |word| {
            if (word_count == words.len) return wordsProblem(problem, "takes at most a command, a key, and a value; quote a value with spaces");
            words[word_count] = word;
            word_count += 1;
        },
        .option => |match| switch (config_flag_ids[match.index].?) {
            .global => options.scope = .global,
            .workspace => options.scope = .workspace,
            .show_origin => options.show_origin = true,
            .json => options.format = .json,
            .project => options.project = true,
        },
    };

    if (word_count == 0) {
        if (options.project) return wordsProblem(problem, "--project goes with lia config schema");
        return options;
    }
    options.action = std.meta.stringToEnum(Action, words[0]) orelse
        return wordsProblem(problem, "the first word is list, get, set, unset, or schema");
    if (options.project and options.action != .schema) return wordsProblem(problem, "--project goes with lia config schema");
    switch (options.action) {
        .list, .schema => if (word_count > 1) return wordsProblem(problem, "list and schema take no key"),
        .get, .unset => {
            if (word_count < 2) return wordsProblem(problem, "get and unset need a key, as in lia config get fast_mode");
            if (word_count > 2) return wordsProblem(problem, "get and unset take one key");
        },
        .set => if (word_count < 3) return wordsProblem(problem, if (std.mem.findScalar(u8, words[word_count - 1], '=') != null)
            "set takes the key and the value as two words, as in lia config set fast_mode true"
        else
            "set needs a key and a value, as in lia config set fast_mode true"),
    }
    if (options.action == .list) return options;
    // The schema is already JSON and describes files, not one scope's values.
    if (options.action == .schema) {
        if (options.scope != .all or options.show_origin or options.format == .json) return wordsProblem(problem, "schema takes only --project");
        return options;
    }

    // An older name, such as `statusLine.context`, means its current one.
    const key = settings_keys.currentPath(words[1]);
    if (key.len == 0) return wordsProblem(problem, "the key is empty");
    if (settings_keys.unknownPart(key)) |part| {
        unknown_key.* = part;
        return error.UnknownConfigSetting;
    }
    options.key = key;
    if (options.action == .get) return options;

    // Writes go to the profile's top level only: lia treats preferences in a
    // workspace override as legacy and removes them when it saves.
    if (options.show_origin) return wordsProblem(problem, "--show-origin goes with list and get");
    if (options.scope == .workspace) return error.WorkspaceConfigWrite;
    if (options.action == .set) options.value = words[2];
    return options;
}

/// The plain preferences `set` and `unset` change, named by their dotted keys.
/// Security and account keys aren't here on purpose: an agent can run
/// `lia config` through its shell tool, so it must not be able to raise its own
/// permissions or swap the model behind permission reviews.
const Writable = enum {
    auto_compact_percent,
    cache_warming,
    context,
    effort,
    fast_mode,
    max_agent_steps,
    max_tool_result_bytes,
    @"prompt_history.enabled",
    provider_strict,
    session_titles,
    @"sound.attention_required",
    @"sound.max",
    @"sound.turn_end",
    theme,
    ultrafast_mode,
};

pub const Change = struct {
    patch: settings_store.UserSettingsPatch,
    /// The value as it will be saved, or null for `unset`. Strings borrow from
    /// the arguments.
    value: ?std.json.Value,
};

pub const WriteProblem = union(enum) {
    none,
    /// The key isn't changed with `lia config`; what to use instead.
    refused: []const u8,
    /// The value doesn't fit the key; what the key takes.
    invalid_value: []const u8,
};

/// The profile change `set` or `unset` makes for `options`. Sets `problem` and
/// fails for a key `lia config` doesn't change or a value the key can't take.
pub fn change(options: Options, problem: *WriteProblem) error{ RefusedConfigSetting, InvalidConfigValue }!Change {
    const key = options.key.?;
    const writable = std.meta.stringToEnum(Writable, key) orelse {
        problem.* = .{ .refused = ownerHint(key) };
        return error.RefusedConfigSetting;
    };
    if (options.action == .unset) return .{ .patch = .{ .remove = key }, .value = null };

    const raw = options.value.?;
    var patch: settings_store.UserSettingsPatch = .{};
    switch (writable) {
        .effort => {
            patch.effort = types.ReasoningEffort.parse(raw) orelse
                return invalid(problem, "auto or an effort name such as high");
            return .{ .patch = patch, .value = .{ .string = raw } };
        },
        .theme => {
            const saved: []const u8 = switch (theme.classifyValue(raw) orelse return invalid(problem, profile_paths.displayText(theme_values))) {
                .pin_light => "light",
                .pin_dark => "dark",
                .custom => |name| if (theme.validThemeName(name)) name else return invalid(problem, profile_paths.displayText(theme_values)),
            };
            patch.theme = saved;
            return .{ .patch = patch, .value = .{ .string = saved } };
        },
        .max_agent_steps => {
            const steps = std.fmt.parseUnsigned(u32, raw, 10) catch
                return invalid(problem, "a whole number of steps; 0 means no limit");
            patch.max_agent_steps = steps;
            return .{ .patch = patch, .value = .{ .integer = steps } };
        },
        .max_tool_result_bytes => {
            const bytes = std.fmt.parseUnsigned(u32, raw, 10) catch 0;
            if (bytes < tool_result_limits.min_configured_tool_result_bytes) {
                return invalid(problem, "a whole number of bytes, at least 1024");
            }
            patch.max_tool_result_bytes = bytes;
            return .{ .patch = patch, .value = .{ .integer = bytes } };
        },
        .auto_compact_percent => {
            const percent = std.fmt.parseUnsigned(u8, raw, 10) catch 0;
            if (!compactor.isValidPercent(percent)) return invalid(problem, "a whole number from 10 to 80");
            patch.auto_compact_percent = percent;
            return .{ .patch = patch, .value = .{ .integer = percent } };
        },
        else => {},
    }

    const enabled = parseSwitch(raw) orelse return invalid(problem, "true or false");
    switch (writable) {
        .cache_warming => patch.cache_warming = enabled,
        .context => patch.context = enabled,
        .fast_mode => patch.fast_mode = enabled,
        .@"prompt_history.enabled" => patch.prompt_history_enabled = enabled,
        .provider_strict => patch.provider_strict = enabled,
        .session_titles => patch.session_titles = enabled,
        .@"sound.attention_required" => patch.notification_attention_required = enabled,
        .@"sound.max" => patch.notification_max = enabled,
        .@"sound.turn_end" => patch.notification_turn_end = enabled,
        .ultrafast_mode => patch.ultrafast_mode = enabled,
        .effort, .theme, .max_agent_steps, .max_tool_result_bytes, .auto_compact_percent => unreachable,
    }
    return .{ .patch = patch, .value = .{ .bool = enabled } };
}

const theme_values = "light, dark, or the name of a theme file in ~/.lia/themes";

fn invalid(problem: *WriteProblem, expected: []const u8) error{InvalidConfigValue} {
    problem.* = .{ .invalid_value = expected };
    return error.InvalidConfigValue;
}

fn parseSwitch(raw: []const u8) ?bool {
    if (std.mem.eql(u8, raw, "true") or std.mem.eql(u8, raw, "on")) return true;
    if (std.mem.eql(u8, raw, "false") or std.mem.eql(u8, raw, "off")) return false;
    return null;
}

fn wordsProblem(problem: *?[]const u8, text: []const u8) error{InvalidConfigArgs} {
    problem.* = text;
    return error.InvalidConfigArgs;
}

/// Whether `lia config set` and `unset` change `key`.
pub fn settable(key: []const u8) bool {
    return std.meta.stringToEnum(Writable, key) != null;
}

/// What to use instead of `lia config` for a setting it doesn't change.
fn ownerHint(key: []const u8) []const u8 {
    const head = key[0 .. std.mem.findScalar(u8, key, '.') orelse key.len];
    const hints = [_]struct { keys: []const []const u8, hint: []const u8 }{
        .{ .keys = &.{ "model", "models" }, .hint = profile_paths.displayText("use --model for one run, or edit ~/.lia/settings.json") },
        .{ .keys = &.{"provider"}, .hint = "use lia provider <name>" },
        .{ .keys = &.{"permission_mode"}, .hint = profile_paths.displayText("use --permission-mode for one run, or edit ~/.lia/settings.json") },
        .{ .keys = &.{"credential_source"}, .hint = "use lia login" },
        .{ .keys = &.{"review_model"}, .hint = profile_paths.displayText("edit ~/.lia/settings.json, or set LIA_REVIEW_MODEL for one run") },
        .{ .keys = &.{ "workspaces", "additional_directories" }, .hint = "use lia workspace" },
        .{ .keys = &.{ "enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers" }, .hint = "use lia mcp approve or reject" },
        .{ .keys = &.{"context_limits"}, .hint = profile_paths.displayText("use --context-limit for one run, or edit ~/.lia/settings.json") },
        .{ .keys = &.{"provider_order"}, .hint = profile_paths.displayText("use --provider-order for one run, or edit ~/.lia/settings.json") },
        .{ .keys = &.{ "yolo_acknowledged", "fast_mode_model_bound", "skill_match_fuzzy" }, .hint = "lia manages it" },
        .{ .keys = &.{"sound"}, .hint = "set sound.turn_end, sound.attention_required, or sound.max" },
        .{ .keys = &.{"prompt_history"}, .hint = "set prompt_history.enabled" },
    };
    for (hints) |entry| {
        for (entry.keys) |name| {
            if (std.mem.eql(u8, name, head)) return entry.hint;
        }
    }
    return profile_paths.displayText("edit ~/.lia/settings.json");
}

/// `can't change permission_mode with lia config; use --permission-mode ...` or
/// `invalid value for fast_mode: maybe (use true or false)`, where `via` names
/// the surface, such as `lia config` or `--config`. Caller owns the result.
pub fn formatWriteProblem(alloc: Allocator, key: []const u8, value: ?[]const u8, problem: WriteProblem, via: []const u8) ![]u8 {
    return switch (problem) {
        .none => alloc.dupe(u8, key),
        .refused => |hint| alloc.print("can't change {f} with {s}; {s}", .{ text_utils.terminalSafe(key), via, hint }),
        .invalid_value => |expected| alloc.print("invalid value for {f}: {f} (use {s})", .{ text_utils.terminalSafe(key), text_utils.terminalSafe(value orelse ""), expected }),
    };
}

pub const OverrideProblem = union(enum) {
    none,
    /// The argument isn't `key=value`.
    malformed,
    unknown: settings_keys.UnknownPart,
    write: struct { key: []const u8, value: []const u8, problem: WriteProblem },
};

/// Parses one `--config key=value` for `lia ask`, with the keys, values, and
/// checks of `lia config set`. On failure, `problem` says why. Slices borrow
/// from `text`.
pub fn parseOverride(text: []const u8, problem: *OverrideProblem) error{InvalidConfigOverride}!config_runtime.SettingOverride {
    const at = std.mem.findScalar(u8, text, '=') orelse return overrideProblem(problem, .malformed);
    const key = settings_keys.currentPath(text[0..at]);
    const value = text[at + 1 ..];
    if (key.len == 0) return overrideProblem(problem, .malformed);
    if (settings_keys.unknownPart(key)) |part| return overrideProblem(problem, .{ .unknown = part });
    var write_problem: WriteProblem = .none;
    const planned = change(.{ .action = .set, .key = key, .value = value }, &write_problem) catch
        return overrideProblem(problem, .{ .write = .{ .key = key, .value = value, .problem = write_problem } });
    return .{ .key = key, .value = planned.value.? };
}

fn overrideProblem(problem: *OverrideProblem, why: OverrideProblem) error{InvalidConfigOverride} {
    problem.* = why;
    return error.InvalidConfigOverride;
}

/// The message for a rejected `--config` value, such as `--config needs
/// key=value` or `unknown setting fast_mdoe (did you mean fast_mode?)`.
/// Caller owns the result.
pub fn formatOverrideProblem(alloc: Allocator, problem: OverrideProblem) ![]u8 {
    return switch (problem) {
        .none, .malformed => alloc.dupe(u8, "--config needs key=value, such as --config fast_mode=on"),
        .unknown => |part| settings_messages.formatUnknownPath(alloc, part),
        .write => |bad| formatWriteProblem(alloc, bad.key, bad.value, bad.problem, "--config"),
    };
}

pub const Loaded = struct {
    profile: ?std.json.Parsed(std.json.Value) = null,
    project: ?std.json.Parsed(std.json.Value) = null,
    entries: settings_entries.Entries,
    unknown: []output_contracts.ConfigUnknownSetting,
    /// Holds the values of the `LIA_*` entries.
    env: std.heap.ArenaAllocator,

    pub fn deinit(self: *Loaded, alloc: Allocator) void {
        alloc.free(self.unknown);
        self.entries.deinit(alloc);
        self.env.deinit();
        if (self.project) |*parsed| parsed.deinit();
        if (self.profile) |*parsed| parsed.deinit();
        self.* = undefined;
    }
};

/// Reads the settings files in `paths` and collects the entries and unknown
/// keys for `scope`. Without a scope, the `LIA_*` setting overrides set in this
/// process come last, as lia applies them. When a file can't be read or parsed,
/// sets `failed_file` to its display name and returns the error. Caller deinits
/// the result.
pub fn load(
    alloc: Allocator,
    paths: config_runtime.Paths,
    workspace_root: []const u8,
    scope: settings_entries.Scope,
    failed_file: *?[]const u8,
) !Loaded {
    var profile: ?std.json.Parsed(std.json.Value) = null;
    errdefer if (profile) |*parsed| parsed.deinit();
    if (paths.user_settings) |path| {
        failed_file.* = profileDisplay();
        profile = try config_runtime.readSettingsFileJson(alloc, path);
    }
    var project: ?std.json.Parsed(std.json.Value) = null;
    errdefer if (project) |*parsed| parsed.deinit();
    if (scope == .all) {
        failed_file.* = project_display;
        project = try config_runtime.readSettingsFileJson(alloc, paths.workspace_settings);
    }
    failed_file.* = null;

    var entries = try settings_entries.collect(alloc, .{
        .profile = if (profile) |parsed| parsed.value else null,
        .project = if (project) |parsed| parsed.value else null,
        .workspace_root = workspace_root,
    }, scope);
    errdefer entries.deinit(alloc);

    var env: std.heap.ArenaAllocator = .init(alloc);
    errdefer env.deinit();
    if (scope == .all) {
        const overrides = try env_settings.collect(env.allocator(), savedProvider(entries.items));
        try settings_entries.appendEnv(alloc, &entries, overrides);
    }

    var unknown: std.ArrayList(output_contracts.ConfigUnknownSetting) = .empty;
    errdefer unknown.deinit(alloc);
    if (profile) |parsed| {
        const found = try settings_keys.findUnknown(alloc, parsed.value, .profile);
        defer alloc.free(found);
        for (found) |key| {
            const shown = if (key.workspace) |workspace|
                scope != .global and std.mem.eql(u8, workspace, workspace_root)
            else
                scope != .workspace;
            if (shown) try unknown.append(alloc, unknownSetting(key, profileDisplay()));
        }
    }
    if (project) |parsed| {
        const found = try settings_keys.findUnknown(alloc, parsed.value, .project);
        defer alloc.free(found);
        for (found) |key| try unknown.append(alloc, unknownSetting(key, project_display));
    }

    return .{
        .profile = profile,
        .project = project,
        .entries = entries,
        .unknown = try unknown.toOwnedSlice(alloc),
        .env = env,
    };
}

/// A key's value in a run, as `lia config` reports it.
pub const Effective = union(enum) {
    /// lia resolves the key where `lia config` doesn't look, so it reports the
    /// value the files set.
    unresolved,
    /// lia uses no value, such as an unset theme.
    none,
    value: std.json.Value,
};

/// The keys `lia config` reads from the resolved state instead of the files.
/// A test checks that each plain key is here or in `files_only_keys`.
pub const resolved_keys = [_][]const u8{
    "auto_compact_percent", "cache_warming",
    "context",              "effort",
    "fast_mode",            "first_call_tool_choice",
    "max_agent_steps",      "max_tool_result_bytes",
    "permission_mode",      "prompt_history.enabled",
    "provider",             "provider_order",
    "provider_strict",      "review_model",
    "session_titles",       "sound.attention_required",
    "sound.max",            "sound.turn_end",
    "theme",                "ultrafast_mode",
};

/// Keys `lia config` shows as the files set them: objects lia checks with its
/// own rules, model choices, editor hints, and values lia manages itself.
const files_only_keys = [_][]const u8{
    "$schema",                   "additional_directories",
    "context_limits",            "credential_source",
    "disabledMcpjsonServers",    "enableAllProjectMcpServers",
    "enabledMcpjsonServers",     "fast_mode_model_bound",
    "model",                     "models",
    "permission",                "providers",
    "skill_symlink_authorities", "workspaces",
    "yolo_acknowledged",
};

/// The value a run uses for `key`, read from a state that
/// `app_lifecycle.resolveSettings` filled; `provider` is the provider the run
/// selects. Strings borrow from `state`, and `arena` holds anything built here.
pub fn effectiveValue(
    arena: Allocator,
    state: *const app_lifecycle.StartupState,
    provider: model_provider.ProviderId,
    key: []const u8,
) Allocator.Error!Effective {
    const eql = std.mem.eql;
    if (eql(u8, key, "auto_compact_percent")) return integer(arena, state.auto_compact_percent);
    if (eql(u8, key, "context")) return boolean(state.context_enabled);
    if (eql(u8, key, "effort")) return string(state.effort.label());
    if (eql(u8, key, "fast_mode")) return boolean(state.fast_mode);
    if (eql(u8, key, "first_call_tool_choice")) return string(state.first_call_tool_choice.label());
    if (eql(u8, key, "max_agent_steps")) return integer(arena, state.agent_step_limit);
    if (eql(u8, key, "max_tool_result_bytes")) return integer(arena, state.max_tool_result_bytes);
    if (eql(u8, key, "permission_mode")) return string(state.permission_mode.label());
    if (eql(u8, key, "prompt_history.enabled")) return boolean(state.prompt_history_enabled);
    if (eql(u8, key, "provider")) return string(try arena.dupe(u8, provider.label()));
    if (eql(u8, key, "provider_order")) {
        if (state.provider_order.len == 0) return .none;
        var array: std.json.Array = .init(arena);
        for (state.provider_order) |slug| try array.append(.{ .string = slug });
        return .{ .value = .{ .array = array } };
    }
    if (eql(u8, key, "provider_strict")) return boolean(state.provider_strict);
    if (eql(u8, key, "review_model")) return if (state.review_model.len == 0) .none else string(state.review_model);
    if (eql(u8, key, "session_titles")) return boolean(state.session_title_generation);
    if (eql(u8, key, "cache_warming")) return boolean(state.cache_warming);
    if (eql(u8, key, "sound.attention_required")) return boolean(state.notification_attention_required);
    if (eql(u8, key, "sound.max")) return boolean(state.notification_max);
    if (eql(u8, key, "sound.turn_end")) return boolean(state.notification_turn_end);
    if (eql(u8, key, "theme")) {
        if (app_lifecycle.themeEnvOverride()) |value| return string(value);
        return if (state.theme) |value| string(value) else .none;
    }
    if (eql(u8, key, "ultrafast_mode")) return boolean(state.ultrafast_mode);
    return .unresolved;
}

fn boolean(value: bool) Effective {
    return .{ .value = .{ .bool = value } };
}

fn string(value: []const u8) Effective {
    return .{ .value = .{ .string = value } };
}

fn integer(arena: Allocator, value: usize) Allocator.Error!Effective {
    if (std.math.cast(i64, value)) |fits| return .{ .value = .{ .integer = fits } };
    return .{ .value = .{ .number_string = try std.fmt.allocPrint(arena, "{d}", .{value}) } };
}

/// The entries `lia config get` looks a key up in when no scope is chosen.
/// `set` holds the values the files and `LIA_*` variables set, lowest
/// precedence first. Every resolved key gets the value a run uses, labeled
/// with the highest layer that sets that value, or `default` when none does,
/// as when nothing sets it or lia rejects or ignores what a file says. A key
/// lia doesn't resolve keeps its last entry in `set`. Everything is in `arena`.
pub fn effectiveEntries(
    arena: Allocator,
    state: *const app_lifecycle.StartupState,
    provider: model_provider.ProviderId,
    set: []const settings_entries.Entry,
) ![]settings_entries.Entry {
    var out: std.ArrayList(settings_entries.Entry) = .empty;
    var seen: std.StringHashMapUnmanaged(void) = .empty;
    for (set) |entry| {
        if (seen.contains(entry.key)) continue;
        try seen.put(arena, entry.key, {});
        switch (try effectiveValue(arena, state, provider, entry.key)) {
            .unresolved => try out.append(arena, lastEntry(set, entry.key)),
            .none => {},
            .value => |value| try out.append(arena, labeled(set, entry.key, value)),
        }
    }
    for (resolved_keys) |key| {
        if (seen.contains(key)) continue;
        switch (try effectiveValue(arena, state, provider, key)) {
            .value => |value| try out.append(arena, .{ .key = key, .value = value, .origin = .default }),
            .none, .unresolved => {},
        }
    }
    return out.toOwnedSlice(arena);
}

fn lastEntry(set: []const settings_entries.Entry, key: []const u8) settings_entries.Entry {
    var index = set.len;
    while (index > 0) {
        index -= 1;
        if (std.mem.eql(u8, set[index].key, key)) return set[index];
    }
    unreachable;
}

/// `value` labeled with the highest layer in `set` that sets it.
fn labeled(set: []const settings_entries.Entry, key: []const u8, value: std.json.Value) settings_entries.Entry {
    var index = set.len;
    while (index > 0) {
        index -= 1;
        const entry = set[index];
        if (!std.mem.eql(u8, entry.key, key)) continue;
        if (sameValue(key, entry.value, value)) return .{ .key = key, .value = value, .origin = entry.origin, .variable = entry.variable };
    }
    return .{ .key = key, .value = value, .origin = .default };
}

/// Whether a file's `raw` value is the resolved `value`. Words are compared
/// after the runtime's own parse, so an older spelling such as `yolo` matches
/// `full-access`.
fn sameValue(key: []const u8, raw: std.json.Value, value: std.json.Value) bool {
    switch (raw) {
        .string => |text| if (value == .string) {
            const eql = std.mem.eql;
            if (eql(u8, key, "permission_mode")) {
                const mode = types.PermissionMode.parse(text) orelse return false;
                return eql(u8, mode.label(), value.string);
            }
            if (eql(u8, key, "effort")) {
                const effort = types.ReasoningEffort.parse(text) orelse return false;
                return eql(u8, effort.label(), value.string);
            }
            return eql(u8, text, value.string);
        },
        else => {},
    }
    return jsonEqual(raw, value);
}

fn jsonEqual(a: std.json.Value, b: std.json.Value) bool {
    return switch (a) {
        .null => b == .null,
        .bool => |x| b == .bool and b.bool == x,
        .integer => |x| b == .integer and b.integer == x,
        .float => |x| b == .float and b.float == x,
        .number_string => |x| b == .number_string and std.mem.eql(u8, x, b.number_string),
        .string => |x| b == .string and std.mem.eql(u8, x, b.string),
        .array => |x| blk: {
            if (b != .array or b.array.items.len != x.items.len) break :blk false;
            for (x.items, b.array.items) |left, right| if (!jsonEqual(left, right)) break :blk false;
            break :blk true;
        },
        .object => false,
    };
}

/// The provider the settings files choose, which `LIA_MODEL` applies to unless
/// `LIA_PROVIDER` picks another.
fn savedProvider(entries: []const settings_entries.Entry) model_provider.ProviderId {
    var index = entries.len;
    while (index > 0) {
        index -= 1;
        if (!std.mem.eql(u8, entries[index].key, "provider")) continue;
        return model_provider.parse_saved(entries[index].value) catch .gateway;
    }
    return .gateway;
}

fn unknownSetting(key: settings_keys.UnknownKey, file: []const u8) output_contracts.ConfigUnknownSetting {
    return .{ .key = key, .file = file, .suggestion = settings_messages.closest(key.name, key.known) };
}

/// Why a settings file couldn't be loaded, in words, as in
/// `~/.lia/settings.json can't be read: permission denied`.
pub fn loadFailureReason(err: anyerror) []const u8 {
    return switch (err) {
        error.StreamTooLong => "is larger than 64 KiB",
        error.SyntaxError, error.UnexpectedEndOfInput, error.InvalidNumber => "isn't valid JSON",
        error.DurablePathUnsafe => "can't be read: " ++ unsafe_settings_path,
        error.AccessDenied, error.PermissionDenied => "can't be read: permission denied",
        error.NotDir => "can't be read: a folder in its path is a file",
        else => "can't be read",
    };
}

/// Why saving the profile's settings file failed, in words, with what to do
/// where there is something, as in `failed to save ~/.lia/settings.json:
/// another lia is saving settings; try again`.
pub fn saveFailureReason(err: anyerror) []const u8 {
    return switch (err) {
        error.DurablePathUnsafe => unsafe_settings_path,
        error.SettingsPrimaryTooLarge, error.FileTooBig => "it is larger than 64 KiB; remove settings you no longer use",
        error.SettingsLockBusy => "another lia is saving settings; try again",
        error.AccessDenied, error.PermissionDenied => "permission denied",
        error.ReadOnlyFileSystem => "the disk is read-only",
        error.NoSpaceLeft => "the disk is full",
        error.NotDir => "a folder in its path is a file",
        error.PrivateStatePermissionsUnsupported => "the file system can't keep the file private",
        error.InvalidSettingsFormat => "it isn't valid JSON; fix it or move it aside",
        else => @errorName(err),
    };
}

const unsafe_settings_path = "lia keeps settings only in a regular file in a folder it owns, not through a symlink or a hard link";

test "settings failures name the cause in words" {
    try std.testing.expectEqualStrings("can't be read: permission denied", loadFailureReason(error.AccessDenied));
    try std.testing.expectEqualStrings("can't be read", loadFailureReason(error.Unexpected));
    try std.testing.expectEqualStrings("another lia is saving settings; try again", saveFailureReason(error.SettingsLockBusy));
    try std.testing.expect(std.mem.find(u8, saveFailureReason(error.DurablePathUnsafe), "symlink") != null);
    try std.testing.expectEqualStrings("Unexpected", saveFailureReason(error.Unexpected));
}

fn parseForTest(args: []const [:0]const u8) error{ InvalidConfigArgs, UnknownConfigSetting, WorkspaceConfigWrite }!Options {
    var unknown: ?settings_keys.UnknownPart = null;
    var problem: ?[]const u8 = null;
    return parseArgs(args, &unknown, &problem);
}

test "config args default to list and take scope, origin, and json flags" {
    const bare = try parseForTest(&.{});
    try std.testing.expect(bare.key == null and bare.scope == .all and !bare.show_origin);

    const listed = try parseForTest(&.{ "list", "--global", "--workspace", "--show-origin", "--json" });
    try std.testing.expectEqual(settings_entries.Scope.workspace, listed.scope);
    try std.testing.expect(listed.show_origin);
    try std.testing.expectEqual(output_contracts.OutputFormat.json, listed.format);

    // An older name means its current one.
    const got = try parseForTest(&.{ "get", "notifications.max", "--global" });
    try std.testing.expectEqualStrings("sound.max", got.key.?);
    try std.testing.expectEqual(settings_entries.Scope.global, got.scope);
}

test "config args reject extra words, missing keys, and unknown flags" {
    const bad = [_][]const [:0]const u8{
        &.{"set"},
        &.{ "list", "extra" },
        &.{"get"},
        &.{ "get", "" },
        &.{ "get", "model", "extra" },
        &.{"--globl"},
    };
    for (bad) |args| try std.testing.expectError(error.InvalidConfigArgs, parseForTest(args));
}

test "config set and unset take a key, and set takes a value" {
    const set = try parseForTest(&.{ "set", "fast_mode", "on", "--global" });
    try std.testing.expectEqual(Action.set, set.action);
    try std.testing.expectEqualStrings("fast_mode", set.key.?);
    try std.testing.expectEqualStrings("on", set.value.?);

    const unset = try parseForTest(&.{ "unset", "notifications.max", "--json" });
    try std.testing.expectEqual(Action.unset, unset.action);
    try std.testing.expect(unset.value == null);

    for ([_][]const [:0]const u8{ &.{ "set", "fast_mode" }, &.{ "unset", "fast_mode", "x" }, &.{ "set", "fast_mode", "on", "--show-origin" } }) |args| {
        try std.testing.expectError(error.InvalidConfigArgs, parseForTest(args));
    }
    try std.testing.expectError(error.WorkspaceConfigWrite, parseForTest(&.{ "set", "fast_mode", "on", "--workspace" }));
    try std.testing.expectError(error.WorkspaceConfigWrite, parseForTest(&.{ "unset", "fast_mode", "--workspace" }));
}

fn changeForTest(args: []const [:0]const u8, problem: *WriteProblem) !Change {
    return change(try parseForTest(args), problem);
}

test "config set turns each value into the patch the save path writes" {
    var problem: WriteProblem = .none;
    const fast = try changeForTest(&.{ "set", "fast_mode", "off" }, &problem);
    try std.testing.expectEqual(false, fast.patch.fast_mode.?);
    try std.testing.expect(!fast.value.?.bool);

    const sound = try changeForTest(&.{ "set", "notifications.max", "true" }, &problem);
    try std.testing.expect(sound.patch.notification_max.?);

    const steps = try changeForTest(&.{ "set", "max_agent_steps", "0" }, &problem);
    try std.testing.expectEqual(@as(u32, 0), steps.patch.max_agent_steps.?);

    const pinned = try changeForTest(&.{ "set", "theme", "LIGHT" }, &problem);
    try std.testing.expectEqualStrings("light", pinned.patch.theme.?);

    const removed = try changeForTest(&.{ "unset", "notifications.max" }, &problem);
    try std.testing.expectEqualStrings("sound.max", removed.patch.remove.?);
    try std.testing.expect(removed.value == null);
}

test "config set explains a bad value or a key it doesn't change" {
    const alloc = std.testing.allocator;
    const cases = [_]struct { args: []const [:0]const u8, err: anyerror, message: []const u8 }{
        .{ .args = &.{ "set", "fast_mode", "maybe" }, .err = error.InvalidConfigValue, .message = "invalid value for fast_mode: maybe (use true or false)" },
        .{ .args = &.{ "set", "max_tool_result_bytes", "12" }, .err = error.InvalidConfigValue, .message = "invalid value for max_tool_result_bytes: 12 (use a whole number of bytes, at least 1024)" },
        .{ .args = &.{ "set", "permission_mode", "full-access" }, .err = error.RefusedConfigSetting, .message = "can't change permission_mode with lia config; use --permission-mode for one run, or edit ~/.lia/settings.json" },
        .{ .args = &.{ "set", "permission.bash", "allow" }, .err = error.RefusedConfigSetting, .message = "can't change permission.bash with lia config; edit ~/.lia/settings.json" },
        .{ .args = &.{ "unset", "review_model" }, .err = error.RefusedConfigSetting, .message = "can't change review_model with lia config; edit ~/.lia/settings.json, or set LIA_REVIEW_MODEL for one run" },
        .{ .args = &.{ "set", "models.gateway", "gpt" }, .err = error.RefusedConfigSetting, .message = "can't change models.gateway with lia config; use --model for one run, or edit ~/.lia/settings.json" },
        .{ .args = &.{ "set", "model", "gpt" }, .err = error.RefusedConfigSetting, .message = "can't change model with lia config; use --model for one run, or edit ~/.lia/settings.json" },
        .{ .args = &.{ "set", "yolo_acknowledged", "true" }, .err = error.RefusedConfigSetting, .message = "can't change yolo_acknowledged with lia config; lia manages it" },
    };
    for (cases) |case| {
        const options = try parseForTest(case.args);
        var problem: WriteProblem = .none;
        try std.testing.expectError(case.err, change(options, &problem));
        const message = try formatWriteProblem(alloc, options.key.?, options.value, problem, "lia config");
        defer alloc.free(message);
        try std.testing.expectEqualStrings(case.message, message);
    }
}

test "--config takes key=value with the keys and checks of config set" {
    const alloc = std.testing.allocator;
    var problem: OverrideProblem = .none;
    const fast = try parseOverride("fast_mode=on", &problem);
    try std.testing.expectEqualStrings("fast_mode", fast.key);
    try std.testing.expect(fast.value.bool);
    const sound = try parseOverride("notifications.max=false", &problem);
    try std.testing.expectEqualStrings("sound.max", sound.key);

    const cases = [_]struct { text: []const u8, message: []const u8 }{
        .{ .text = "fast_mode", .message = "--config needs key=value, such as --config fast_mode=on" },
        .{ .text = "=on", .message = "--config needs key=value, such as --config fast_mode=on" },
        .{ .text = "fast_mdoe=on", .message = "unknown setting fast_mdoe (did you mean fast_mode?)" },
        .{ .text = "fast_mode=maybe", .message = "invalid value for fast_mode: maybe (use true or false)" },
        .{ .text = "permission_mode=full-access", .message = "can't change permission_mode with --config; use --permission-mode for one run, or edit ~/.lia/settings.json" },
    };
    for (cases) |case| {
        problem = .none;
        try std.testing.expectError(error.InvalidConfigOverride, parseOverride(case.text, &problem));
        const message = try formatOverrideProblem(alloc, problem);
        defer alloc.free(message);
        try std.testing.expectEqualStrings(case.message, message);
    }
}

test "every key config set writes is a plain setting in the list" {
    inline for (@typeInfo(Writable).@"enum".field_names) |name| {
        try std.testing.expect(settings_keys.unknownPart(name) == null);
        const dot = comptime std.mem.findScalar(u8, name, '.');
        const key = settings_keys.find(name[0 .. dot orelse name.len]).?;
        try std.testing.expect(!key.map and key.where != .retired and key.renamed_to == null);
    }
}

test "config get names the part of a key that isn't a setting" {
    var unknown: ?settings_keys.UnknownPart = null;
    var problem: ?[]const u8 = null;
    try std.testing.expectError(error.UnknownConfigSetting, parseArgs(&.{ "get", "notifications.mx" }, &unknown, &problem));
    try std.testing.expectEqualStrings("mx", unknown.?.name);
    try std.testing.expectEqualStrings("sound", unknown.?.parent.?);
}

test "config set treats the terminal UI settings as retired, as it does auto_upgrade" {
    const cases = [_]struct { key: [:0]const u8, name: []const u8 }{
        .{ .key = "auto_upgrade", .name = "auto_upgrade" },
        .{ .key = "collapse_tool_calls", .name = "collapse_tool_calls" },
        .{ .key = "slash_menu_categories", .name = "slash_menu_categories" },
        .{ .key = "startup_scrollback", .name = "startup_scrollback" },
        .{ .key = "status_line.context", .name = "status_line" },
        .{ .key = "statusLine.session", .name = "statusLine" },
    };
    for (cases) |case| {
        var unknown: ?settings_keys.UnknownPart = null;
        var problem: ?[]const u8 = null;
        const args = [_][:0]const u8{ "set", case.key, "false" };
        try std.testing.expectError(error.UnknownConfigSetting, parseArgs(&args, &unknown, &problem));
        try std.testing.expectEqualStrings(case.name, unknown.?.name);
        try std.testing.expect(unknown.?.parent == null);
        try std.testing.expect(!settable(case.key));
    }
}

test "load reads both files and keeps unknown keys for the scope" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.writeFile(io, .{
        .sub_path = "settings.json",
        .data = "{\"fast_mode\":true,\"fast_mdoe\":1,\"workspaces\":{\"/w\":{\"efort\":\"x\",\"effort\":\"high\"},\"/other\":{\"nope\":1}}}",
    });
    try tmp.dir.writeFile(io, .{ .sub_path = ".lia.json", .data = "{\"max_agent_steps\":3,\"max_agent_step\":4}" });
    const settings_path = try @import("../shared/io.zig").dirRealpathAlloc(alloc, tmp.dir, "settings.json");
    const project_path = try @import("../shared/io.zig").dirRealpathAlloc(alloc, tmp.dir, ".lia.json");
    var paths: config_runtime.Paths = .{
        .user_settings = settings_path,
        .workspace_settings = project_path,
        .workspace_root = try alloc.dupe(u8, "/w"),
    };
    defer paths.deinit(alloc);

    var failed: ?[]const u8 = null;
    var all = try load(alloc, paths, "/w", .all, &failed);
    defer all.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 3), all.entries.items.len);
    try std.testing.expectEqual(@as(usize, 3), all.unknown.len);
    try std.testing.expectEqualStrings("fast_mdoe", all.unknown[0].key.name);
    try std.testing.expectEqualStrings("fast_mode", all.unknown[0].suggestion.?);
    try std.testing.expectEqualStrings("efort", all.unknown[1].key.name);
    try std.testing.expectEqualStrings(".lia.json", all.unknown[2].file);

    var global = try load(alloc, paths, "/w", .global, &failed);
    defer global.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 1), global.unknown.len);
    try std.testing.expectEqualStrings("fast_mdoe", global.unknown[0].key.name);
}

test "load ends with the LIA_* overrides lia applies, only without a scope" {
    const alloc = std.testing.allocator;
    const io_mod = @import("../shared/io.zig");
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "settings.json", .data = "{\"provider\":\"gateway\",\"max_agent_steps\":3}" });
    const dir = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(dir);
    var paths: config_runtime.Paths = .{
        .user_settings = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "settings.json"),
        .workspace_settings = try std.mem.concat(alloc, u8, &.{ dir, "/missing.lia.json" }),
        .workspace_root = try alloc.dupe(u8, "/w"),
    };
    defer paths.deinit(alloc);

    const restore = io_mod.environMap() orelse try env_settings.emptyTestEnviron();
    var env: std.process.Environ.Map = .init(alloc);
    defer env.deinit();
    try env.put("LIA_MAX_AGENT_STEPS", "9");
    try env.put("LIA_MODEL", "gpt-env");
    io_mod.setEnvironMap(&env);
    defer io_mod.setEnvironMap(restore);

    var failed: ?[]const u8 = null;
    var all = try load(alloc, paths, "/w", .all, &failed);
    defer all.deinit(alloc);
    const steps = try settings_entries.lookup(alloc, all.entries.items, "max_agent_steps");
    defer alloc.free(steps);
    try std.testing.expectEqual(settings_entries.Origin.env, steps[0].origin);
    try std.testing.expectEqualStrings("LIA_MAX_AGENT_STEPS", steps[0].variable.?);
    try std.testing.expectEqual(@as(i64, 9), steps[0].value.integer);
    // The saved provider decides which model LIA_MODEL replaces.
    const models = try settings_entries.lookup(alloc, all.entries.items, "models.gateway");
    defer alloc.free(models);
    try std.testing.expectEqualStrings("gpt-env", models[0].value.string);

    var global = try load(alloc, paths, "/w", .global, &failed);
    defer global.deinit(alloc);
    for (global.entries.items) |entry| try std.testing.expect(entry.origin != .env);
}

test "load names the file it can't parse" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "settings.json", .data = "{\"fast_mode\":" });
    var paths: config_runtime.Paths = .{
        .user_settings = try @import("../shared/io.zig").dirRealpathAlloc(alloc, tmp.dir, "settings.json"),
        .workspace_settings = try alloc.dupe(u8, "/nonexistent/.lia.json"),
        .workspace_root = try alloc.dupe(u8, "/w"),
    };
    defer paths.deinit(alloc);

    var failed: ?[]const u8 = null;
    if (load(alloc, paths, "/w", .all, &failed)) |loaded| {
        var unexpected = loaded;
        unexpected.deinit(alloc);
        return error.TestExpectedError;
    } else |err| {
        try std.testing.expectEqualStrings(profileDisplay(), failed.?);
        try std.testing.expectEqualStrings("isn't valid JSON", loadFailureReason(err));
    }
}

test "lia config set writes each key with the type the settings list gives it" {
    inline for (@typeInfo(Writable).@"enum".field_names) |path| {
        errdefer std.debug.print("key {s}\n", .{path});
        const dot = comptime std.mem.findScalar(u8, path, '.');
        const key = settings_keys.find(path[0 .. dot orelse path.len]).?;
        // Every child of an object setting is a switch.
        const kind: settings_keys.Kind = if (dot != null) .boolean else key.kind;
        var buffer: [32]u8 = undefined;
        const sample: []const u8 = switch (kind) {
            .boolean => "true",
            .integer => try std.mem.print(&buffer, "{d}", .{key.minimum orelse 0}),
            .string => if (key.values.len > 0) key.values[0] else "dark",
            .string_or_null => "auto",
            else => return error.TestUnexpectedResult,
        };
        var problem: WriteProblem = .none;
        const planned = try change(.{ .action = .set, .key = path, .value = sample }, &problem);
        const want: std.meta.Tag(std.json.Value) = switch (kind) {
            .boolean => .bool,
            .integer => .integer,
            else => .string,
        };
        try std.testing.expectEqual(want, std.meta.activeTag(planned.value.?));
    }
}

test "lia config schema takes only --project" {
    var unknown: ?settings_keys.UnknownPart = null;
    var problem: ?[]const u8 = null;
    const plain = try parseForTest(&.{"schema"});
    try std.testing.expectEqual(Action.schema, plain.action);
    try std.testing.expect(!plain.project);
    try std.testing.expect((try parseForTest(&.{ "schema", "--project" })).project);
    for ([_][]const [:0]const u8{
        &.{"--project"},
        &.{ "list", "--project" },
        &.{ "schema", "--json" },
        &.{ "schema", "--global" },
        &.{ "schema", "--show-origin" },
        &.{ "schema", "extra" },
    }) |args| try std.testing.expectError(error.InvalidConfigArgs, parseArgs(args, &unknown, &problem));
}

test "lia config names what is wrong with its words" {
    var unknown: ?settings_keys.UnknownPart = null;
    for ([_]struct { args: []const [:0]const u8, problem: []const u8 }{
        .{ .args = &.{ "set", "fast_mode" }, .problem = "set needs a key and a value, as in lia config set fast_mode true" },
        .{ .args = &.{ "set", "fast_mode=true" }, .problem = "set takes the key and the value as two words, as in lia config set fast_mode true" },
        .{ .args = &.{"get"}, .problem = "get and unset need a key, as in lia config get fast_mode" },
        .{ .args = &.{"sett"}, .problem = "the first word is list, get, set, unset, or schema" },
        .{ .args = &.{ "set", "theme", "--show-origin", "dark" }, .problem = "--show-origin goes with list and get" },
    }) |case| {
        var problem: ?[]const u8 = null;
        try std.testing.expectError(error.InvalidConfigArgs, parseArgs(case.args, &unknown, &problem));
        try std.testing.expectEqualStrings(case.problem, problem.?);
    }
    // A value may start with a dash; the value check rejects it later.
    const negative = try parseForTest(&.{ "set", "max_agent_steps", "-5" });
    try std.testing.expectEqualStrings("-5", negative.value.?);
}

test "every plain setting is resolved or deliberately shown from the files" {
    for (settings_keys.keys) |key| {
        switch (key.where) {
            .retired => continue,
            else => {},
        }
        if (key.kind == .refused or key.renamed_to != null) continue;
        if (key.kind == .switches) {
            for (key.children) |child| {
                var buf: [96]u8 = undefined;
                const path = try std.fmt.bufPrint(&buf, "{s}.{s}", .{ key.name, child });
                try std.testing.expect(inList(&resolved_keys, path) or inList(&files_only_keys, key.name));
            }
            continue;
        }
        if (!inList(&resolved_keys, key.name) and !inList(&files_only_keys, key.name)) {
            std.debug.print("unclassified setting {s}\n", .{key.name});
            return error.TestUnexpectedResult;
        }
    }
}

fn inList(list: []const []const u8, name: []const u8) bool {
    for (list) |item| if (std.mem.eql(u8, item, name)) return true;
    return false;
}

test "effective entries show the value in use and the layer that set it" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var state = app_lifecycle.StartupState{ .agent_step_limit = 25 };
    state.permission_mode = .yolo;
    state.agent_step_limit = 25;
    const set = [_]settings_entries.Entry{
        // A rejected file value: the run uses the default.
        .{ .key = "max_agent_steps", .value = .{ .integer = -3 }, .origin = .global },
        // An older spelling of the value in use.
        .{ .key = "permission_mode", .value = .{ .string = "yolo" }, .origin = .global },
        .{ .key = "models.gateway", .value = .{ .string = "m" }, .origin = .global },
    };
    const all = try effectiveEntries(arena, &state, .gateway, &set);
    // The keys something sets come first, in order.
    try std.testing.expectEqualStrings("max_agent_steps", all[0].key);
    try std.testing.expectEqual(@as(i64, 25), all[0].value.integer);
    try std.testing.expectEqual(settings_entries.Origin.default, all[0].origin);
    try std.testing.expectEqualStrings("full-access", all[1].value.string);
    try std.testing.expectEqual(settings_entries.Origin.global, all[1].origin);
    try std.testing.expectEqualStrings("m", all[2].value.string);
    var fast_mode: ?settings_entries.Entry = null;
    for (all) |entry| if (std.mem.eql(u8, entry.key, "fast_mode")) {
        fast_mode = entry;
    };
    try std.testing.expect(!fast_mode.?.value.bool);
    try std.testing.expectEqual(settings_entries.Origin.default, fast_mode.?.origin);
}

test "a step count past a JSON integer is shown, not cast" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    const effective = try integer(arena_state.allocator(), std.math.maxInt(usize));
    try std.testing.expectEqualStrings("18446744073709551615", effective.value.number_string);
}
