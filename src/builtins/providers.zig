const provider_set = @import("../core/gateway/provider_set.zig");
const gateway = @import("gateway.zig");
const chat_completions = @import("../gateway/chat_completions.zig");
const configured_provider = @import("../core/config/configured_provider.zig");

fn configuredBundle(_: ?*anyopaque, definition: *const configured_provider.Definition) provider_set.Bundle {
    return chat_completions.bundle(definition);
}

pub const native = provider_set.Set{
    .configured_fn = configuredBundle,
    .gateway = gateway.provider_bundle,
};
