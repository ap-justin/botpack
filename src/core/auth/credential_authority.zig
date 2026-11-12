const std = @import("std");
const types = @import("../shared/types.zig");

const Sha256 = std.crypto.hash.sha2.Sha256;

pub const Identity = struct {
    bytes: [Sha256.digest_length]u8,

    pub fn eql(self: Identity, other: Identity) bool {
        return std.mem.eql(u8, &self.bytes, &other.bytes);
    }
};

/// Derives a persistable, non-secret identity. Gateway sources use the selected
/// credential slot; provider subscriptions require a stable account ID.
pub fn derive(
    source: types.CredentialSource,
    account_id: ?[]const u8,
) ?Identity {
    _ = account_id;
    var hash = Sha256.init(.{});
    // Stored data: saved checkpoints carry this hash, so the fx name stays.
    hash.update("fx-credential-authority-v1\x00");
    hash.update(@tagName(source));
    switch (source) {
        .vercel_oidc_token,
        .ai_gateway_api_key,
        .fx_login,
        .stored_key,
        .host_managed,
        .configured,
        => hash.update("\x00slot\x00"),
    }
    var bytes: [Sha256.digest_length]u8 = undefined;
    hash.final(&bytes);
    return .{ .bytes = bytes };
}

test "credential authority is a 32 byte digest" {
    try std.testing.expect(@sizeOf(Identity) == 32);
}

test "credential authority uses non-secret Gateway credential slots" {
    const api_key = derive(.ai_gateway_api_key, null).?;
    const same_slot = derive(.ai_gateway_api_key, "ignored-account").?;
    const stored_key = derive(.stored_key, null).?;
    try std.testing.expect(api_key.eql(same_slot));
    try std.testing.expect(!api_key.eql(stored_key));
    try std.testing.expect(derive(.vercel_oidc_token, null) != null);
    try std.testing.expect(derive(.fx_login, null) != null);
    try std.testing.expect(derive(.host_managed, null) != null);
}
