const std = @import("std");
const image_data = @import("../images/image_data.zig");

/// Replaces binary fields in a caller-owned parsed MCP block with delivery notes.
/// Images themselves travel through the typed result, never JSON text.
pub fn projectMediaForText(alloc: std.mem.Allocator, content: *std.json.Value) std.mem.Allocator.Error!void {
    if (content.* == .array) {
        for (content.array.items) |*item| try projectMediaBlock(alloc, item);
    } else try projectMediaBlock(alloc, content);
}

fn projectMediaBlock(alloc: std.mem.Allocator, item: *std.json.Value) std.mem.Allocator.Error!void {
    if (item.* != .object) return;
    const kind = item.object.get("type") orelse return;
    if (kind != .string) return;
    if (std.mem.eql(u8, kind.string, "image") or std.mem.eql(u8, kind.string, "audio")) {
        _ = item.object.swapRemove("data");
        const mime = item.object.get("mimeType");
        const supported = std.mem.eql(u8, kind.string, "image") and mime != null and mime.? == .string and image_data.supportedMediaType(mime.?.string);
        try item.object.put(alloc, "delivery", .{ .string = if (supported) "image content" else "unsupported media; content was not sent to the model" });
    } else if (std.mem.eql(u8, kind.string, "resource")) {
        if (item.object.getPtr("resource")) |resource| {
            if (resource.* == .object and resource.object.swapRemove("blob")) {
                const mime = resource.object.get("mimeType");
                const supported = mime != null and mime.? == .string and image_data.supportedMediaType(mime.?.string);
                try resource.object.put(alloc, "delivery", .{ .string = if (supported) "image content" else "binary resource content was not sent to the model" });
            }
        }
    }
}
