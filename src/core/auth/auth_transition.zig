const std = @import("std");
const credentials = @import("credentials.zig");
const model_provider = @import("../config/model_provider.zig");

pub const ProviderSwitchDecision = enum {
    no_change,
    busy,
    prepare,
};

pub const ProviderSwitchIntent = enum {
    manual,
    post_oauth,
};

pub const ProviderSwitchFacts = struct {
    current: model_provider.ProviderId,
    target: model_provider.ProviderId,
    target_credential_ready: bool,
    intent: ProviderSwitchIntent,
    stream_active: bool,
    queued_prompts: usize,
};

pub fn provider_work_busy(stream_active: bool, queued_prompts: usize) bool {
    return stream_active or queued_prompts > 0;
}

pub fn decideProviderSwitch(facts: ProviderSwitchFacts) ProviderSwitchDecision {
    if (facts.intent == .manual and facts.current.eql(facts.target) and facts.target_credential_ready) {
        return .no_change;
    }
    if (provider_work_busy(facts.stream_active, facts.queued_prompts)) return .busy;
    return .prepare;
}

pub const SignInCompletionAction = union(enum) {
    vercel,
    switch_provider: model_provider.ProviderId,
    activate_source: credentials.Source,
};

pub fn signInCompletion(
    provider: model_provider.ProviderId,
    provider_routing_supported: bool,
) SignInCompletionAction {
    _ = provider_routing_supported;
    return switch (provider) {
        .gateway => .vercel,
        .configured => .{ .switch_provider = provider },
    };
}

pub const CredentialAuthorityFacts = struct {
    provider: model_provider.ProviderId,
    source: credentials.Source,
    account_id: ?[]const u8,
    team: ?[]const u8,
};

pub const CredentialChange = enum {
    none,
    secret_only,
    authority,
};

pub fn decideCredentialChange(
    current: CredentialAuthorityFacts,
    candidate: CredentialAuthorityFacts,
    secret_changed: bool,
) CredentialChange {
    if (!current.provider.same_authority(candidate.provider) or
        current.source != candidate.source or
        !optionalBytesEqual(current.account_id, candidate.account_id) or
        !optionalBytesEqual(current.team, candidate.team))
    {
        return .authority;
    }
    return if (secret_changed) .secret_only else .none;
}

pub const AuthReplayFacts = struct {
    authentication_rejected: bool,
    refreshable: bool,
    delivery_safe: bool,
    already_replayed: bool,
};

pub const AuthReplayDecision = enum {
    fail,
    refresh_and_replay,
};

pub fn decideAuthReplay(facts: AuthReplayFacts) AuthReplayDecision {
    if (!facts.authentication_rejected or
        !facts.refreshable or
        !facts.delivery_safe or
        facts.already_replayed)
    {
        return .fail;
    }
    return .refresh_and_replay;
}

fn optionalBytesEqual(left: ?[]const u8, right: ?[]const u8) bool {
    if (left == null or right == null) return left == null and right == null;
    return std.mem.eql(u8, left.?, right.?);
}

test "auth replay is one delivery-safe refresh outside semantic policy" {
    const eligible = AuthReplayFacts{
        .authentication_rejected = true,
        .refreshable = true,
        .delivery_safe = true,
        .already_replayed = false,
    };
    try std.testing.expectEqual(AuthReplayDecision.refresh_and_replay, decideAuthReplay(eligible));

    var blocked = eligible;
    blocked.already_replayed = true;
    try std.testing.expectEqual(AuthReplayDecision.fail, decideAuthReplay(blocked));
    blocked = eligible;
    blocked.delivery_safe = false;
    try std.testing.expectEqual(AuthReplayDecision.fail, decideAuthReplay(blocked));
}

test "credential change distinguishes secret rotation from authority replacement" {
    const stable = CredentialAuthorityFacts{
        .provider = .gateway,
        .source = .lia_login,
        .account_id = null,
        .team = "team_1",
    };
    try std.testing.expectEqual(
        CredentialChange.none,
        decideCredentialChange(stable, stable, false),
    );
    try std.testing.expectEqual(
        CredentialChange.secret_only,
        decideCredentialChange(stable, stable, true),
    );
    try std.testing.expectEqual(
        CredentialChange.authority,
        decideCredentialChange(stable, .{
            .provider = .gateway,
            .source = .lia_login,
            .account_id = null,
            .team = "team_2",
        }, true),
    );
}
