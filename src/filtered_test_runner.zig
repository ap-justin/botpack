//! Zig's test runner, failing when `-Dtest-filter` matched no test. Zig
//! applies test filters at compile time and keeps unnamed `test {}` blocks
//! whatever the filter, so a filter with a typo would otherwise build a
//! runner with only those to run, and it would pass.
const builtin = @import("builtin");
const std = @import("std");
const zig_test_runner = @import("zig_test_runner");

pub const std_options = zig_test_runner.std_options;
pub const fuzz = zig_test_runner.fuzz;

pub fn main(init: std.process.Init.Minimal) void {
    for (builtin.test_functions) |test_fn| {
        if (!isUnnamed(test_fn.name)) break;
    } else std.process.fatal("no unit test name contains the -Dtest-filter text", .{});
    zig_test_runner.main(init);
}

/// Zig names an unnamed test block `<namespace>.test_<n>`.
fn isUnnamed(name: []const u8) bool {
    const last = name[if (std.mem.findScalarLast(u8, name, '.')) |dot| dot + 1 else 0..];
    const index = std.mem.cutPrefix(u8, last, "test_") orelse return false;
    _ = std.fmt.parseUnsigned(usize, index, 10) catch return false;
    return true;
}
