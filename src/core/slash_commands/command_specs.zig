const std = @import("std");
const io_mod = @import("../shared/io.zig");
const display_width = @import("../shared/display_width.zig");

const Allocator = std.mem.Allocator;

pub const TopLevelKind = enum {
    help,
    ask,
    acp,
    pr,
    issue,
    login,
    logout,
    setup,
    status,
    permissions,
    mcp,
    slack,
    models,
    provider,
    doctor,
    teams,
    session,
    sessions,
    credits,
    usage,
    upgrade,
    workspace,
    config,
    completion,
};

/// The release that drops every old spelling fx still reads with a warning,
/// such as `fx setup`, `--sessions-v2`, and `/allowlist user`. The CLI shape
/// check fails once fx's version reaches it, so they come out on time.
pub const old_spelling_removal = "0.0.18";
/// What every warning about an old spelling says.
pub const deprecated_until = "is deprecated and stops working in fx " ++ old_spelling_removal;

pub const OptionDoc = struct {
    flag: []const u8,
    description: []const u8,
    /// Set for a removed spelling: help omits it, and the parser rejects it
    /// with this hint, such as "use --resume <id>".
    replacement: ?[]const u8 = null,
    /// Help omits it, but the parser still reads it: a deprecated spelling
    /// that keeps working with a warning, such as `--sessions-v2`.
    hidden: bool = false,
    /// The fixed values the flag takes, which `fx completion` offers. A value
    /// written in the flag itself, such as `--period <today|7d|month>`, needs no
    /// list here. Leave it empty for free-form values.
    values: []const []const u8 = &.{},
};

/// A word that may follow a command, such as `set` in `fx config set`. Help
/// lists these under "Commands:", and `fx completion` offers them.
pub const SubcommandDoc = struct {
    /// The word, then its arguments as help shows them: `set <key> <value>`.
    /// A `<key>` right after the word means the next argument is a setting
    /// key, which completion offers.
    usage: []const u8,
    description: []const u8,
    /// Words that may follow this one, such as `install` after `slack`.
    subcommands: []const SubcommandDoc = &.{},
    /// The flags this word takes. Completion offers these, not the
    /// command's, after the word.
    options: []const OptionDoc = &.{},
    /// The `<key>` is one `fx config set` changes, so completion offers only
    /// those keys.
    settable_key: bool = false,

    /// The word itself: `set` in `set <key> <value>`.
    pub fn name(self: SubcommandDoc) []const u8 {
        const end = std.mem.findScalar(u8, self.usage, ' ') orelse self.usage.len;
        return self.usage[0..end];
    }

    /// Whether the argument after the word is a setting key.
    pub fn takesSettingKey(self: SubcommandDoc) bool {
        const rest = self.usage[self.name().len..];
        return std.mem.startsWith(u8, rest, " <key>");
    }
};

pub const TopLevelSpec = struct {
    kind: TopLevelKind,
    token: []const u8,
    aliases: []const []const u8 = &.{},
    usage: []const u8,
    summary: []const u8,
    options: []const OptionDoc = &.{},
    /// The words that may follow the command, listed under "Commands:".
    subcommands: []const SubcommandDoc = &.{},
    details: []const []const u8 = &.{},
    hidden_from_top_level_help: bool = false,
    /// Set on a deprecated command: the spelling that replaces it. Running the
    /// command prints a warning that names it.
    replaced_by: ?[]const u8 = null,
};

pub const TopLevelHelpEntry = struct {
    kind: ?TopLevelKind = null,
    usage: []const u8,
    summary: ?[]const u8 = null,
};

pub const TopLevelHelpGroup = struct {
    entries: []const TopLevelHelpEntry,
};

pub const TopLevelFlag = struct {
    usage: []const u8,
    description: []const u8,
};

pub const TopLevelExample = struct {
    command: []const u8,
    description: []const u8,
};

pub const TopLevelResource = struct {
    label: []const u8,
    value: []const u8,
    link: bool = false,
};

pub const TopLevelRegistry = struct {
    specs: []const TopLevelSpec = &.{},
    description: []const u8,
    interactive_hint: []const u8,
    help_groups: []const TopLevelHelpGroup = &.{},
    flags: []const TopLevelFlag = &.{},
    examples: []const TopLevelExample = &.{},
    notes: []const []const u8 = &.{},
    resources: []const TopLevelResource = &.{},
};

pub const top_level_help_default_width: usize = 80;

pub const HelpStyle = enum {
    plain,
    ansi,
};

const HelpRole = enum {
    brand,
    heading,
    syntax,
    muted,
    label,
    link,
};

pub fn matchesTopLevel(registry: TopLevelRegistry, token: []const u8, kind: TopLevelKind) bool {
    const spec = topLevelSpec(registry, kind);
    return matchesCommandToken(token, spec.token, spec.aliases);
}

pub fn renderTopLevelHelp(alloc: Allocator, registry: TopLevelRegistry, columns: usize, version: []const u8) ![]u8 {
    return renderTopLevelHelpWithStyle(alloc, registry, columns, version, .plain);
}

pub fn renderTopLevelHelpWithStyle(alloc: Allocator, registry: TopLevelRegistry, columns: usize, version: []const u8, style: HelpStyle) ![]u8 {
    const width = normalizedTopLevelHelpWidth(columns);
    const command_usage_width = maxTopLevelHelpUsageWidth(registry);
    const flag_usage_width = maxTopLevelFlagUsageWidth(registry);
    const resource_label_width = maxTopLevelResourceLabelWidth(registry);

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try writeStyled(&out.writer, style, .brand, "𝒇x");
    try out.writer.writeByte(' ');
    try writeStyleStart(&out.writer, style, .muted);
    try out.writer.writeByte('v');
    try out.writer.writeAll(version);
    try writeStyleEnd(&out.writer, style);
    try out.writer.writeByte('\n');
    try writeWrappedStyledLine(&out.writer, "", "", registry.description, width, style, .muted);
    try out.writer.writeByte('\n');
    try writeWrappedStyledLine(&out.writer, "", "", registry.interactive_hint, width, style, .muted);

    try writeSectionHeading(&out.writer, style, "Usage:");
    try writeWrappedStyledLine(&out.writer, "  ", "  ", "fx <command> [...flags] [...args]", width, style, .syntax);

    try writeSectionHeading(&out.writer, style, "Commands:");
    for (registry.help_groups, 0..) |group, group_index| {
        if (group_index > 0) try out.writer.writeByte('\n');
        for (group.entries) |entry| {
            try writeTopLevelHelpEntry(&out.writer, registry, entry, command_usage_width, width, style);
        }
    }

    try writeSectionHeading(&out.writer, style, "Flags:");
    for (registry.flags) |flag| {
        try writeTopLevelFlag(&out.writer, flag, flag_usage_width, width, style);
    }
    try out.writer.writeByte('\n');

    try writeStyled(&out.writer, style, .heading, "Examples:");
    try out.writer.writeByte('\n');
    for (registry.examples) |example| {
        try writeTopLevelExample(&out.writer, example, width, style);
    }

    for (registry.notes) |note| {
        try writeWrappedStyledLine(&out.writer, "", "", note, width, style, .muted);
    }

    try out.writer.writeByte('\n');
    for (registry.resources) |resource| {
        try writeTopLevelResource(&out.writer, resource, resource_label_width, width, style);
    }

    return try out.toOwnedSlice();
}

pub fn renderTopLevelCommandHelp(alloc: Allocator, registry: TopLevelRegistry, kind: TopLevelKind) ![]u8 {
    const spec = topLevelSpec(registry, kind);
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try out.writer.writeAll("fx ");
    try out.writer.writeAll(spec.token);
    try out.writer.writeAll("\n\n");
    try out.writer.writeAll(spec.summary);
    try out.writer.writeAll("\n\nUsage:\n");
    try out.writer.writeAll("  fx ");
    try out.writer.writeAll(spec.usage);
    try out.writer.writeByte('\n');

    if (spec.subcommands.len > 0) {
        try out.writer.writeAll("\nCommands:\n");
        try writeSubcommandRows(&out.writer, spec.subcommands, "", subcommandUsageWidth(spec.subcommands, 0));
    }

    if (spec.options.len > 0) {
        var flag_width: usize = 0;
        for (spec.options) |opt| {
            if (opt.replacement == null and !opt.hidden) flag_width = @max(flag_width, opt.flag.len);
        }

        try out.writer.writeAll("\nOptions:\n");
        for (spec.options) |opt| {
            if (opt.replacement != null or opt.hidden) continue;
            try out.writer.writeAll("  ");
            try out.writer.writeAll(opt.flag);
            try writePadding(&out.writer, flag_width - opt.flag.len + 2);
            try out.writer.writeAll(opt.description);
            try out.writer.writeByte('\n');
        }
    }

    if (spec.details.len > 0) {
        try out.writer.writeByte('\n');
        for (spec.details) |line| {
            try out.writer.writeAll(line);
            try out.writer.writeByte('\n');
        }
    }

    return try out.toOwnedSlice();
}

/// The widest `prefix usage` among the rows `writeSubcommandRows` prints.
fn subcommandUsageWidth(subcommands: []const SubcommandDoc, prefix_len: usize) usize {
    var width: usize = 0;
    for (subcommands) |sub| {
        if (sub.description.len > 0) width = @max(width, prefix_len + sub.usage.len);
        width = @max(width, subcommandUsageWidth(sub.subcommands, prefix_len + sub.name().len + 1));
    }
    return width;
}

/// One row per word that has a description, then its own words prefixed
/// with it, so `trust` lists `trust approve NAME`.
fn writeSubcommandRows(writer: *std.Io.Writer, subcommands: []const SubcommandDoc, prefix: []const u8, width: usize) std.Io.Writer.Error!void {
    for (subcommands) |sub| {
        if (sub.description.len > 0) {
            try writer.writeAll("  ");
            try writer.writeAll(prefix);
            try writer.writeAll(sub.usage);
            try writePadding(writer, width - prefix.len - sub.usage.len + 2);
            try writer.writeAll(sub.description);
            try writer.writeByte('\n');
        }
        if (sub.subcommands.len > 0) {
            var buffer: [128]u8 = undefined;
            const nested = std.mem.print(&buffer, "{s}{s} ", .{ prefix, sub.name() }) catch prefix;
            try writeSubcommandRows(writer, sub.subcommands, nested, width);
        }
    }
}

pub fn topLevelKindFromToken(registry: TopLevelRegistry, token: []const u8) ?TopLevelKind {
    for (registry.specs) |spec| {
        if (matchesCommandToken(token, spec.token, spec.aliases)) return spec.kind;
    }
    return null;
}

pub fn topLevelUsage(registry: TopLevelRegistry, kind: TopLevelKind) []const u8 {
    return topLevelSpec(registry, kind).usage;
}

/// The warning a deprecated command prints before it runs, or null for a
/// current command. Caller owns the returned text.
pub fn deprecationWarning(alloc: Allocator, registry: TopLevelRegistry, kind: TopLevelKind) !?[]u8 {
    for (registry.specs) |spec| {
        if (spec.kind != kind) continue;
        const replacement = spec.replaced_by orelse return null;
        return try alloc.print("fx {s} " ++ deprecated_until ++ "; use {s}\n", .{ spec.token, replacement });
    }
    return null;
}

fn topLevelSpec(registry: TopLevelRegistry, kind: TopLevelKind) TopLevelSpec {
    for (registry.specs) |spec| {
        if (spec.kind == kind) return spec;
    }
    unreachable;
}

fn matchesCommandToken(input: []const u8, primary: []const u8, aliases: []const []const u8) bool {
    if (std.mem.eql(u8, input, primary)) return true;
    for (aliases) |alias| {
        if (std.mem.eql(u8, input, alias)) return true;
    }

    if (input.len == 0) return false;
    const last = input[input.len - 1];
    if (last != ' ' and last != '\t') return false;

    const trimmed = std.mem.trimEnd(u8, input, " \t");
    if (std.mem.eql(u8, trimmed, primary)) return true;
    for (aliases) |alias| {
        if (std.mem.eql(u8, trimmed, alias)) return true;
    }
    return false;
}

fn normalizedTopLevelHelpWidth(columns: usize) usize {
    return if (columns == 0) top_level_help_default_width else columns;
}

fn maxTopLevelHelpUsageWidth(registry: TopLevelRegistry) usize {
    var width: usize = 0;
    for (registry.help_groups) |group| {
        for (group.entries) |entry| {
            if (entry.kind) |kind| {
                if (topLevelSpec(registry, kind).hidden_from_top_level_help) continue;
            }
            width = @max(width, entry.usage.len);
        }
    }
    return width;
}

fn maxTopLevelFlagUsageWidth(registry: TopLevelRegistry) usize {
    var width: usize = 0;
    for (registry.flags) |flag| {
        width = @max(width, flag.usage.len);
    }
    return width;
}

fn maxTopLevelResourceLabelWidth(registry: TopLevelRegistry) usize {
    var width: usize = 0;
    for (registry.resources) |resource| {
        width = @max(width, display_width.visibleWidth(resource.label));
    }
    return width;
}

fn writeTopLevelHelpEntry(writer: *std.Io.Writer, registry: TopLevelRegistry, entry: TopLevelHelpEntry, usage_width: usize, columns: usize, style: HelpStyle) !void {
    const spaces = "                                                                ";
    const summary = entry.summary orelse topLevelSpec(registry, entry.kind.?).summary;
    if (entry.kind) |kind| {
        if (topLevelSpec(registry, kind).hidden_from_top_level_help) return;
    }
    const padding = usage_width - entry.usage.len + 2;
    var prefix_buf: [128]u8 = undefined;
    var continuation_buf: [96]u8 = undefined;
    const prefix = try std.mem.print(&prefix_buf, "  {s}{s}{s}{s}", .{ styleStart(style, .syntax), entry.usage, styleEnd(style), spaces[0..padding] });
    const continuation = try std.mem.print(&continuation_buf, "  {s}", .{spaces[0 .. usage_width + 2]});
    try writeWrappedLine(writer, prefix, continuation, summary, columns);
}

fn writeTopLevelFlag(writer: *std.Io.Writer, flag: TopLevelFlag, usage_width: usize, columns: usize, style: HelpStyle) !void {
    const spaces = "                                                                ";
    const padding = usage_width - flag.usage.len + 2;
    var prefix_buf: [160]u8 = undefined;
    var continuation_buf: [96]u8 = undefined;
    const prefix = try std.mem.print(&prefix_buf, "  {s}{s}{s}{s}", .{ styleStart(style, .syntax), flag.usage, styleEnd(style), spaces[0..padding] });
    const continuation = try std.mem.print(&continuation_buf, "  {s}", .{spaces[0 .. usage_width + 2]});
    try writeWrappedLine(writer, prefix, continuation, flag.description, columns);
}

fn writeTopLevelExample(writer: *std.Io.Writer, example: TopLevelExample, columns: usize, style: HelpStyle) !void {
    try writeWrappedStyledLine(writer, "  ", "  ", example.command, columns, style, .syntax);
    try writeWrappedStyledLine(writer, "      ", "      ", example.description, columns, style, .muted);
    try writer.writeByte('\n');
}

fn writeTopLevelResource(writer: *std.Io.Writer, resource: TopLevelResource, label_width: usize, columns: usize, style: HelpStyle) !void {
    const spaces = "                                                                ";
    const padding = label_width - display_width.visibleWidth(resource.label) + 2;
    var prefix_buf: [128]u8 = undefined;
    const prefix = try std.mem.print(&prefix_buf, "{s}{s}{s}{s}", .{ styleStart(style, .label), resource.label, styleEnd(style), spaces[0..padding] });
    const value_role: HelpRole = if (resource.link) .link else .syntax;
    try writeWrappedStyledLine(writer, prefix, "  ", resource.value, columns, style, value_role);
}

fn writeSectionHeading(writer: *std.Io.Writer, style: HelpStyle, heading: []const u8) !void {
    try writer.writeByte('\n');
    try writeStyled(writer, style, .heading, heading);
    try writer.writeByte('\n');
}

fn writeStyled(writer: *std.Io.Writer, style: HelpStyle, role: HelpRole, text: []const u8) !void {
    try writeStyleStart(writer, style, role);
    try writer.writeAll(text);
    try writeStyleEnd(writer, style);
}

fn writeStyleStart(writer: *std.Io.Writer, style: HelpStyle, role: HelpRole) !void {
    try writer.writeAll(styleStart(style, role));
}

fn writeStyleEnd(writer: *std.Io.Writer, style: HelpStyle) !void {
    try writer.writeAll(styleEnd(style));
}

fn styleStart(style: HelpStyle, role: HelpRole) []const u8 {
    if (style == .plain) return "";
    return switch (role) {
        .brand => "\x1b[1m",
        .heading, .label => "\x1b[1m",
        .syntax => "\x1b[39m",
        .muted => "\x1b[38;5;243m",
        .link => "\x1b[4m",
    };
}

fn styleEnd(style: HelpStyle) []const u8 {
    return if (style == .ansi) "\x1b[0m" else "";
}

fn writeWrappedStyledLine(writer: *std.Io.Writer, prefix: []const u8, continuation_prefix: []const u8, text: []const u8, columns: usize, style: HelpStyle, role: HelpRole) !void {
    return writeWrappedLineDecorated(writer, prefix, continuation_prefix, text, columns, styleStart(style, role), styleEnd(style));
}

fn writeWrappedLine(writer: *std.Io.Writer, prefix: []const u8, continuation_prefix: []const u8, text: []const u8, columns: usize) !void {
    return writeWrappedLineDecorated(writer, prefix, continuation_prefix, text, columns, "", "");
}

fn writeWrappedLineDecorated(writer: *std.Io.Writer, prefix: []const u8, continuation_prefix: []const u8, text: []const u8, columns: usize, text_start: []const u8, text_end: []const u8) !void {
    const prefix_width = display_width.visibleWidthIgnoringAnsi(prefix);
    const continuation_width = display_width.visibleWidthIgnoringAnsi(continuation_prefix);
    var budget = if (columns > prefix_width) columns - prefix_width else 1;
    var words = std.mem.tokenizeScalar(u8, text, ' ');
    var line_width: usize = 0;

    try writer.writeAll(prefix);
    try writer.writeAll(text_start);
    while (words.next()) |word| {
        const word_width = display_width.visibleWidthIgnoringAnsi(word);
        if (line_width == 0) {
            try writer.writeAll(word);
            line_width = word_width;
            continue;
        }

        if (line_width + 1 + word_width <= budget) {
            try writer.writeByte(' ');
            try writer.writeAll(word);
            line_width += 1 + word_width;
            continue;
        }

        try writer.writeAll(text_end);
        try writer.writeByte('\n');
        try writer.writeAll(continuation_prefix);
        try writer.writeAll(text_start);
        budget = if (columns > continuation_width) columns - continuation_width else 1;
        try writer.writeAll(word);
        line_width = word_width;
    }
    try writer.writeAll(text_end);
    try writer.writeByte('\n');
}

fn writePadding(writer: *std.Io.Writer, count: usize) !void {
    var i: usize = 0;
    while (i < count) : (i += 1) {
        try writer.writeByte(' ');
    }
}

fn topLevelTokenOccurrences(registry: TopLevelRegistry, token: []const u8) usize {
    var count: usize = 0;
    for (registry.specs) |spec| {
        if (std.mem.eql(u8, token, spec.token)) count += 1;
        for (spec.aliases) |alias| {
            if (std.mem.eql(u8, token, alias)) count += 1;
        }
    }
    return count;
}

fn topLevelIndexOccurrences(registry: TopLevelRegistry, kind: TopLevelKind) usize {
    var count: usize = 0;
    for (registry.help_groups) |group| {
        for (group.entries) |entry| {
            if (entry.kind == kind) count += 1;
        }
    }
    return count;
}

fn topLevelHelpContainsCommandToken(text: []const u8, token: []const u8) bool {
    var index: usize = 0;
    while (std.mem.find(u8, text[index..], token)) |relative| {
        const start = index + relative;
        const end = start + token.len;
        const before_ok = start == 0 or isTopLevelTokenBoundary(text[start - 1]);
        const after_ok = end == text.len or isTopLevelTokenBoundary(text[end]);
        if (before_ok and after_ok) return true;
        index = end;
    }
    return false;
}

fn isTopLevelTokenBoundary(byte: u8) bool {
    return byte == ' ' or byte == '\t' or byte == '\n' or byte == ',' or byte == ':' or byte == '<' or byte == '>' or byte == '[' or byte == ']' or byte == '|';
}

fn expectAllLinesFit(text: []const u8, columns: usize) !void {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        try std.testing.expect(display_width.visibleWidth(line) <= columns);
    }
}

fn testTopLevelRegistry() TopLevelRegistry {
    const builtin_commands = @import("../../builtins/commands.zig");
    return builtin_commands.top_level_registry;
}

fn testTopLevelHelpText(alloc: Allocator) ![]u8 {
    const builtin_commands = @import("../../builtins/commands.zig");
    return builtin_commands.renderTopLevelHelp(alloc, top_level_help_default_width, "9.8.7");
}

fn stripAnsiForTest(alloc: Allocator, text: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    var index: usize = 0;
    while (index < text.len) {
        if (text[index] == 0x1b) {
            index = display_width.ansiSequenceEnd(text, index);
            continue;
        }
        try out.writer.writeByte(text[index]);
        index += 1;
    }
    return out.toOwnedSlice();
}

fn lineContainsBoth(text: []const u8, first: []const u8, second: []const u8) bool {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (std.mem.find(u8, line, first) != null and std.mem.find(u8, line, second) != null) return true;
    }
    return false;
}

test "top-level matcher recognizes help aliases" {
    const registry = testTopLevelRegistry();
    try std.testing.expect(matchesTopLevel(registry, "help", .help));
    try std.testing.expect(matchesTopLevel(registry, "--help", .help));
    try std.testing.expect(matchesTopLevel(registry, "-h", .help));
    try std.testing.expect(!matchesTopLevel(registry, "wat", .help));
}

test "rendered top-level help is a complete CLI navigation page" {
    const text = try testTopLevelHelpText(std.testing.allocator);
    defer std.testing.allocator.free(text);

    try std.testing.expect(std.mem.startsWith(u8, text, "𝒇x v9.8.7\nFast, native coding agent for the terminal."));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, text, "𝒇x"));
    try std.testing.expect(std.mem.find(u8, text, "fx is a command-line coding agent.") != null);
    try std.testing.expect(std.mem.find(u8, text, "fx <command> [...flags] [...args]") != null);
    try std.testing.expect(std.mem.find(u8, text, "Commands:") != null);
    try std.testing.expect(std.mem.find(u8, text, "ask <prompt>") != null);
    try std.testing.expect(std.mem.find(u8, text, "Run one noninteractive request") != null);
    try std.testing.expect(std.mem.find(u8, text, "Draft or publish a GitHub issue") != null);
    try std.testing.expect(std.mem.find(u8, text, "credits|balance") != null);
    try std.testing.expect(std.mem.find(u8, text, "upgrade|update") != null);
    try std.testing.expect(std.mem.find(u8, text, "Sign in to a model provider") != null);
    try std.testing.expect(std.mem.find(u8, text, "Sign out of a model provider") != null);
    try std.testing.expect(std.mem.find(u8, text, "Choose the active model provider") != null);
    // `fx setup` is deprecated and hidden; `fx login --api-key` replaces it.
    try std.testing.expect(std.mem.find(u8, text, "Configure a Vercel AI Gateway API key") == null);
    try std.testing.expect(std.mem.find(u8, text, "login [vercel|codex|grok] [--api-key]") != null);
    try std.testing.expect(std.mem.find(u8, text, "Choose a Vercel AI Gateway team") != null);
    try std.testing.expect(std.mem.find(u8, text, "Show Vercel AI Gateway credits") != null);
    try std.testing.expect(std.mem.find(u8, text, "Sign in to Vercel or a selected provider") == null);
    try std.testing.expect(std.mem.find(u8, text, "Flags:") != null);
    try std.testing.expect(std.mem.find(u8, text, "--context-limit <spec>") != null);
    try std.testing.expect(std.mem.find(u8, text, "Set name=bytes|off; repeatable") != null);
    try std.testing.expect(std.mem.find(u8, text, "--add-dir <path>") != null);
    try std.testing.expect(std.mem.find(u8, text, "-v, --version") != null);
    try std.testing.expect(std.mem.find(u8, text, "Must appear before the command. Accepted names:") == null);
    try std.testing.expect(std.mem.find(u8, text, "skill_description_bytes, skill_catalog_bytes") == null);
    try std.testing.expect(std.mem.find(u8, text, "FX_EXPERIMENTAL_WORKSPACE_ACCESS=1") == null);
    try std.testing.expect(std.mem.find(u8, text, "Supported for ask, ACP, PR, and issue launches") == null);
    try std.testing.expect(std.mem.find(u8, text, "Examples:") != null);
    try std.testing.expect(std.mem.find(u8, text, "fx ask \"Explain the changes in this repository\"") != null);
    try std.testing.expect(std.mem.find(u8, text, "fx status --json") != null);
    try std.testing.expect(std.mem.find(u8, text, "Run `fx <command> --help` for command-specific usage and options.") != null);
    try std.testing.expect(std.mem.find(u8, text, "command-specific options and examples") == null);
    try std.testing.expect(std.mem.find(u8, text, "Learn more about fx:  https://fx.sh/docs") != null);
    try std.testing.expect(std.mem.find(u8, text, "\n\n\nRun `fx <command> --help`") == null);
    try std.testing.expect(std.mem.find(u8, text, "Start:") == null);
    try std.testing.expect(std.mem.find(u8, text, "  Work      ") == null);
    try std.testing.expect(std.mem.find(u8, text, "More:") == null);
    try std.testing.expect(std.mem.find(u8, text, "resume [last|<id>] [--record]") == null);
    try std.testing.expect(std.mem.find(u8, text, "session migrate <id>|--id <id>") == null);
}

test "top-level help summary overrides do not change command-specific help" {
    const login = try renderTopLevelCommandHelp(std.testing.allocator, testTopLevelRegistry(), .login);
    defer std.testing.allocator.free(login);

    try std.testing.expect(std.mem.find(u8, login, "Sign in to Vercel or a selected provider") != null);
    try std.testing.expect(std.mem.find(u8, login, "Sign in to a model provider") == null);
}

test "terminal top-level help adds styling without changing visible content" {
    const plain = try renderTopLevelHelp(std.testing.allocator, testTopLevelRegistry(), top_level_help_default_width, "9.8.7");
    defer std.testing.allocator.free(plain);
    const terminal = try renderTopLevelHelpWithStyle(std.testing.allocator, testTopLevelRegistry(), top_level_help_default_width, "9.8.7", .ansi);
    defer std.testing.allocator.free(terminal);
    const stripped = try stripAnsiForTest(std.testing.allocator, terminal);
    defer std.testing.allocator.free(stripped);

    try std.testing.expect(std.mem.find(u8, plain, "\x1b[") == null);
    try std.testing.expect(std.mem.startsWith(u8, terminal, "\x1b[1m𝒇x\x1b[0m"));
    try std.testing.expect(std.mem.find(u8, terminal, "\x1b[1mUsage:\x1b[0m") != null);
    try std.testing.expect(std.mem.find(u8, terminal, "\x1b[39mask <prompt>\x1b[0m") != null);
    try std.testing.expect(std.mem.find(u8, terminal, "\x1b[38;5;243mFast, native coding agent") != null);
    try std.testing.expect(std.mem.find(u8, terminal, "\x1b[4mhttps://fx.sh/docs\x1b[0m") != null);
    try std.testing.expect(std.mem.find(u8, terminal, "\x1b[38;5;252m") == null);
    try std.testing.expect(std.mem.find(u8, terminal, "\x1b[38;5;245m") == null);
    try std.testing.expectEqualStrings(plain, stripped);
}

test "top-level help renders flags as compact aligned rows" {
    const wide = try renderTopLevelHelp(std.testing.allocator, testTopLevelRegistry(), 120, "9.8.7");
    defer std.testing.allocator.free(wide);
    const narrow = try renderTopLevelHelp(std.testing.allocator, testTopLevelRegistry(), 60, "9.8.7");
    defer std.testing.allocator.free(narrow);

    try std.testing.expect(lineContainsBoth(wide, "--context-limit <spec>", "Set name=bytes|off; repeatable"));
    try std.testing.expect(lineContainsBoth(wide, "--add-dir <path>", "Add a workspace directory; repeatable"));
    try std.testing.expect(std.mem.find(u8, wide, "Print the fx version and exit\n\nExamples:") != null);
    try std.testing.expect(std.mem.find(u8, wide, "List available models\n\n  teams") != null);
    try std.testing.expect(std.mem.find(u8, wide, "Show Vercel AI Gateway credits\n\n  usage") != null);
    try expectAllLinesFit(narrow, 60);
}

test "command help lists subcommands under Commands, nested words with their parent" {
    const specs = [_]TopLevelSpec{.{
        .kind = .mcp,
        .token = "mcp",
        .usage = "mcp <command> ...",
        .summary = "Manage MCP servers",
        .subcommands = &.{
            .{ .usage = "list", .description = "List servers" },
            .{ .usage = "trust", .description = "", .subcommands = &.{
                .{ .usage = "approve NAME", .description = "Approve a server" },
                .{ .usage = "reset", .description = "Forget approvals" },
            } },
        },
    }};
    const registry: TopLevelRegistry = .{ .specs = &specs, .description = "", .interactive_hint = "" };
    const text = try renderTopLevelCommandHelp(std.testing.allocator, registry, .mcp);
    defer std.testing.allocator.free(text);
    try std.testing.expect(std.mem.find(u8, text,
        \\Commands:
        \\  list                List servers
        \\  trust approve NAME  Approve a server
        \\  trust reset         Forget approvals
        \\
    ) != null);
    try std.testing.expectEqualStrings("set", (SubcommandDoc{ .usage = "set <key> <value>", .description = "" }).name());
    try std.testing.expect((SubcommandDoc{ .usage = "get <key>", .description = "" }).takesSettingKey());
    try std.testing.expect(!(SubcommandDoc{ .usage = "add PATH", .description = "" }).takesSettingKey());
}

test "default top-level help styles fit the startup buffer" {
    const builtin_commands = @import("../../builtins/commands.zig");
    for ([_]HelpStyle{ .plain, .ansi }) |style| {
        const text = try renderTopLevelHelpWithStyle(std.testing.allocator, testTopLevelRegistry(), top_level_help_default_width, "9.8.7", style);
        defer std.testing.allocator.free(text);

        try std.testing.expect(text.len <= builtin_commands.top_level_help_fast_buffer_bytes);
    }
}

test "per-command help renders header usage options and details" {
    const text = try renderTopLevelCommandHelp(std.testing.allocator, testTopLevelRegistry(), .permissions);
    defer std.testing.allocator.free(text);

    try std.testing.expect(std.mem.find(u8, text, "fx permissions\n") != null);
    try std.testing.expect(std.mem.find(u8, text, "Usage:\n  fx permissions [--json]") != null);
    try std.testing.expect(std.mem.find(u8, text, "Options:") != null);
    try std.testing.expect(std.mem.find(u8, text, "--json") != null);
    try std.testing.expect(std.mem.find(u8, text, "Modes:") != null);
}

test "ACP help documents accepted options" {
    const text = try renderTopLevelCommandHelp(std.testing.allocator, testTopLevelRegistry(), .acp);
    defer std.testing.allocator.free(text);

    try std.testing.expect(std.mem.find(u8, text, "fx acp\n") != null);
    try std.testing.expect(std.mem.find(u8, text, "Usage:\n  fx acp [--permission-mode <mode>|--ask|--auto|--full-access] [--provider <name>] [--model <id>] [--effort <level>] [--fast|--no-fast] [--ultrafast|--no-ultrafast] [--log-file <path>]") != null);
    try std.testing.expect(std.mem.find(u8, text, "--model <id>") != null);
    try std.testing.expect(std.mem.find(u8, text, "--effort <level>") != null);
    try std.testing.expect(std.mem.find(u8, text, "--log-file <path>") != null);
    // ACP sessions don't apply gateway provider routing.
    try std.testing.expect(std.mem.find(u8, text, "--provider-order") == null);
}

test "hidden top-level commands do not reserve help usage width" {
    const registry = testTopLevelRegistry();
    var visible_width: usize = 0;
    var all_width: usize = 0;
    for (registry.help_groups) |group| {
        for (group.entries) |entry| {
            all_width = @max(all_width, entry.usage.len);
            if (entry.kind) |kind| {
                if (topLevelSpec(registry, kind).hidden_from_top_level_help) continue;
            }
            visible_width = @max(visible_width, entry.usage.len);
        }
    }
    try std.testing.expectEqual(visible_width, maxTopLevelHelpUsageWidth(registry));
    try std.testing.expect(all_width >= visible_width);
}

test "top-level specs cover every TopLevelKind" {
    const registry = testTopLevelRegistry();
    var seen: [@typeInfo(TopLevelKind).@"enum".field_names.len]bool = @splat(false);
    for (registry.specs) |spec| {
        const index = @backingInt(spec.kind);
        try std.testing.expect(!seen[index]);
        seen[index] = true;
    }
    inline for (@typeInfo(TopLevelKind).@"enum".field_values) |field_value| {
        const kind: TopLevelKind = @fromBackingInt(@intCast(field_value));
        try std.testing.expect(seen[@backingInt(kind)]);
        try std.testing.expect(topLevelUsage(registry, kind).len > 0);
    }
}

test "top-level specs keep unique tokens and aliases" {
    const registry = testTopLevelRegistry();
    for (registry.specs) |spec| {
        try std.testing.expectEqual(@as(usize, 1), topLevelTokenOccurrences(registry, spec.token));
        for (spec.aliases) |alias| {
            try std.testing.expectEqual(@as(usize, 1), topLevelTokenOccurrences(registry, alias));
        }
    }
}

test "a deprecated command warns with its replacement and a current one does not" {
    const alloc = std.testing.allocator;
    const warning = (try deprecationWarning(alloc, testTopLevelRegistry(), .setup)).?;
    defer alloc.free(warning);
    try std.testing.expectEqualStrings("fx setup is deprecated and stops working in fx 0.0.18; use fx login vercel --api-key\n", warning);
    try std.testing.expect((try deprecationWarning(alloc, testTopLevelRegistry(), .login)) == null);
}

test "top-level help index covers visible commands once" {
    const registry = testTopLevelRegistry();
    for (registry.specs) |spec| {
        const expected: usize = if (spec.hidden_from_top_level_help) 0 else 1;
        try std.testing.expectEqual(expected, topLevelIndexOccurrences(registry, spec.kind));
    }
}

test "top-level help renders every visible command token" {
    const registry = testTopLevelRegistry();
    const text = try testTopLevelHelpText(std.testing.allocator);
    defer std.testing.allocator.free(text);

    for (registry.specs) |spec| {
        if (spec.hidden_from_top_level_help) continue;
        try std.testing.expect(topLevelHelpContainsCommandToken(text, spec.token));
    }
    for (registry.notes) |note| {
        try std.testing.expect(std.mem.find(u8, text, note) != null);
    }
}

test "top-level help lines fit representative terminal widths" {
    const registry = testTopLevelRegistry();
    const widths = [_]usize{ 60, 80, 120 };
    for (widths) |width| {
        const text = try renderTopLevelHelp(std.testing.allocator, registry, width, "9.8.7");
        defer std.testing.allocator.free(text);
        try expectAllLinesFit(text, width);
    }
}

pub const slack_options = [_]OptionDoc{.{ .flag = "--json", .description = "Emit installation metadata without credentials" }};

pub const slack_install_spec: TopLevelSpec = .{
    .kind = .slack,
    .token = "slack",
    .usage = "slack <install|status|refresh> [--json]",
    .summary = "Install and manage the workspace Slack bot locally",
    .subcommands = &.{
        .{ .usage = "install", .description = "Authorize the bot through fx.sh and save its credentials", .options = &slack_options },
        .{ .usage = "status", .description = "Show the local installation", .options = &slack_options },
        .{ .usage = "refresh", .description = "Renew the bot's tokens without the browser", .options = &slack_options },
    },
    .options = &slack_options,
    .details = &.{
        "install opens Slack authorization through fx.sh and saves the bot credentials on this computer.",
        "status shows local installation metadata; refresh renews tokens without browser authorization.",
        "This is a workspace bot installer. Employee MCP login remains fx mcp login NAME.",
        "Credentials are saved in ~/.fx/slack/installation.json with owner-only permissions.",
        "Refresh runs only when requested; no background service is installed.",
    },
};
