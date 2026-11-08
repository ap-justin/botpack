const std = @import("std");
const text_utils = @import("text_utils.zig");

const containsIgnoreCase = text_utils.containsIgnoreCase;

/// Scores prefix and substring matches above token, subsequence, and partial matches.
/// Higher scores rank first; zero means no match.
pub fn fuzzyModelScore(id: []const u8, query: []const u8) i32 {
    if (query.len == 0) return 0;
    if (id.len == 0) return 0;

    if (containsIgnoreCase(id, query)) {
        const bonus: i32 = @intCast(@min(query.len, 50));
        if (std.mem.startsWith(u8, id, query) or
            (id.len > query.len and id[id.len - query.len - 1] == '/' and
                std.ascii.eqlIgnoreCase(id[id.len - query.len ..], query)))
        {
            return 120 + bonus;
        }
        return 100 + bonus;
    }

    var tokens_buf: [16][]const u8 = undefined;
    const token_count = splitQueryTokens(query, &tokens_buf);
    if (token_count > 1) {
        var all_present = true;
        for (tokens_buf[0..token_count]) |token| {
            if (!containsIgnoreCase(id, token)) {
                all_present = false;
                break;
            }
        }
        if (all_present) {
            return 80 + @as(i32, @intCast(token_count)) * 5;
        }
    }

    var qi: usize = 0;
    var matched: usize = 0;
    for (id) |c| {
        if (qi < query.len and std.ascii.toLower(c) == std.ascii.toLower(query[qi])) {
            qi += 1;
            matched += 1;
        }
    }
    if (qi == query.len) {
        return 40 + @as(i32, @intCast(@min(matched, 20)));
    }

    if (token_count >= 1) {
        var any_match = false;
        for (tokens_buf[0..token_count]) |token| {
            if (containsIgnoreCase(id, token)) {
                any_match = true;
                break;
            }
        }
        if (any_match) return 20;
    }

    return 0;
}

fn splitQueryTokens(query: []const u8, out: *[16][]const u8) usize {
    var count: usize = 0;
    var i: usize = 0;
    while (i < query.len and count < 16) {
        while (i < query.len and isSplitter(query[i])) : (i += 1) {}
        const start = i;
        while (i < query.len and !isSplitter(query[i])) : (i += 1) {}
        if (i > start) {
            out[count] = query[start..i];
            count += 1;
        }
    }
    return count;
}

fn isSplitter(c: u8) bool {
    return c == ' ' or c == '-' or c == '/' or c == '_';
}

test "fuzzyModelScore returns high score for exact substring" {
    const score = fuzzyModelScore("anthropic/claude-sonnet-4-20250514", "claude-sonnet");
    try std.testing.expect(score >= 100);
}

test "fuzzyModelScore returns higher score for prefix match" {
    const prefix = fuzzyModelScore("openai/gpt-4o", "openai/gpt-4o");
    const substr = fuzzyModelScore("openai/gpt-4o-mini", "gpt-4o");
    try std.testing.expect(prefix > substr);
}

test "fuzzyModelScore returns positive for multi-token match" {
    const score = fuzzyModelScore("anthropic/claude-sonnet-4-20250514", "claude sonnet");
    try std.testing.expect(score >= 80);
}

test "fuzzyModelScore returns positive for subsequence match" {
    const score = fuzzyModelScore("anthropic/claude-sonnet-4-20250514", "anth son");
    try std.testing.expect(score > 0);
}

test "fuzzyModelScore returns zero for no match" {
    const score = fuzzyModelScore("openai/gpt-4o", "zzzzz");
    try std.testing.expectEqual(@as(i32, 0), score);
}

test "fuzzyModelScore returns zero for empty query" {
    try std.testing.expectEqual(@as(i32, 0), fuzzyModelScore("openai/gpt-4o", ""));
}

test "splitQueryTokens splits on separators" {
    var buf: [16][]const u8 = undefined;
    const count = splitQueryTokens("claude-sonnet/fast", &buf);
    try std.testing.expectEqual(@as(usize, 3), count);
    try std.testing.expectEqualStrings("claude", buf[0]);
    try std.testing.expectEqualStrings("sonnet", buf[1]);
    try std.testing.expectEqualStrings("fast", buf[2]);
}

test "isSplitter recognizes separator characters" {
    try std.testing.expect(isSplitter(' '));
    try std.testing.expect(isSplitter('-'));
    try std.testing.expect(isSplitter('/'));
    try std.testing.expect(isSplitter('_'));
    try std.testing.expect(!isSplitter('a'));
    try std.testing.expect(!isSplitter('0'));
}
