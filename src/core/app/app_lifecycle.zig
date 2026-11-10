const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");
const agent_steps = @import("../config/agent_steps.zig");
const env_settings = @import("../config/env_settings.zig");
const config_runtime = @import("../config/config_runtime.zig");
const auth_runtime = @import("../auth/auth_runtime.zig");
const credentials = @import("../auth/credentials.zig");
const host = @import("../hosts/host.zig");
const oauth_transport = @import("../auth/oauth_transport.zig");
const model_provider = @import("../config/model_provider.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const skill_runtime = @import("../skills/skill_runtime.zig");
const workspace_access = @import("../workspace/workspace_access.zig");
const notification_sound = @import("../notifications/sound.zig");
const tool_result_limits = @import("../tooling/tool_result_limits.zig");
const compactor = @import("../compactor/compactor.zig");
const types = @import("../shared/types.zig");

const Allocator = std.mem.Allocator;
const PermissionMode = types.PermissionMode;
pub const default_permission_mode = config_runtime.default_permission_mode;

pub const StartupState = struct {
    workspace_root: []u8 = &.{},
    workspace_access: workspace_access.WorkspaceAccess = .{},
    credential: ?credentials.Credential = null,
    /// Set instead of `credential` when the interactive launch leaves a
    /// Keychain-backed credential to be resolved after the first frame.
    deferred_credential: ?auth_runtime.StartupCredentialRequest = null,
    credential_load_failure: ?credentials.LoadFailure = null,
    auth_mode: credentials.AuthMode = .local,
    credential_source_preference: ?credentials.Source = null,
    credential_onboarding_skipped: bool = false,
    stored_key_status: credentials.StoredKeyReadStatus = .not_attempted,
    lia_login_status: credentials.LiaLoginReadStatus = .not_attempted,
    configured_providers: @import("../config/configured_provider.zig").Registry = .{},
    model_requests_blocked: bool = false,
    provider: model_provider.ProviderId = .gateway,
    selected_model: []u8 = &.{},
    configured_model: []u8 = &.{},
    model_source: config_runtime.ModelSource = .compiled_default,
    permission_mode: PermissionMode = default_permission_mode,
    yolo_acknowledged: bool = false,
    permission_rules: types.PermissionRuleSet = .{},
    agent_step_limit: usize,
    max_tool_result_bytes: usize = tool_result_limits.default_max_tool_result_bytes,
    auto_compact_percent: u8 = compactor.default_percent,
    context_limits: config_runtime.context_limits.Values = .{},
    context_enabled: bool = true,
    fast_mode: bool = false,
    ultrafast_mode: bool = false,
    configured_ultrafast_mode: bool = false,
    ultrafast_process_override: ?bool = null,
    ultrafast_mode_source: config_runtime.ConfigSource = .compiled_default,
    fast_mode_model_bound: bool = false,
    fast_mode_source: config_runtime.ConfigSource = .compiled_default,
    prompt_history_enabled: bool = true,
    prompt_history_store_allowed: bool = true,
    config_diagnostics: []config_runtime.ConfigDiagnostic = &.{},
    effort: types.ReasoningEffort = .auto,
    /// Owned gateway provider slugs in preference order; empty leaves routing
    /// to the gateway.
    provider_order: [][]const u8 = &.{},
    provider_strict: bool = false,
    /// Resolved review-model override for automatic permission review. Owned;
    /// empty keeps the reviewer's compiled default.
    review_model: []u8 = &.{},
    first_call_tool_choice: types.ToolChoice = .auto,
    session_title_generation: bool = true,
    /// Resolved `cache_warming` preference.
    cache_warming: bool = true,
    notification_turn_end: bool = false,
    notification_attention_required: bool = false,
    notification_max: bool = false,
    theme_monitor_enabled: bool = false,
    theme: ?[]const u8 = null,

    pub fn deinit(self: *StartupState, alloc: Allocator) void {
        self.workspace_access.deinit(alloc);
        self.configured_providers.deinit(alloc);
        if (self.workspace_root.len > 0) alloc.free(self.workspace_root);
        if (self.credential) |*credential| credential.deinit(alloc);
        if (self.selected_model.len > 0) alloc.free(self.selected_model);
        if (self.configured_model.len > 0) alloc.free(self.configured_model);
        if (self.review_model.len > 0) alloc.free(self.review_model);
        if (self.provider_order.len > 0) {
            for (self.provider_order) |slug| alloc.free(@constCast(slug));
            alloc.free(self.provider_order);
        }
        self.permission_rules.deinit(alloc);
        if (self.config_diagnostics.len > 0) {
            for (self.config_diagnostics) |*diagnostic| diagnostic.deinit(alloc);
            alloc.free(self.config_diagnostics);
        }
        if (self.theme) |value| alloc.free(value);
        self.* = .{ .agent_step_limit = self.agent_step_limit };
    }

    pub fn takeWorkspaceRoot(self: *StartupState) []u8 {
        const value = self.workspace_root;
        self.workspace_root = &.{};
        return value;
    }

    pub fn takeWorkspaceAccess(self: *StartupState) workspace_access.WorkspaceAccess {
        const value = self.workspace_access;
        self.workspace_access = .{};
        return value;
    }

    pub fn apiKey(self: *const StartupState) ?[]const u8 {
        const credential = self.credential orelse return null;
        if (credential.needsRefreshAt(io_mod.milliTimestamp())) return null;
        return credential.token;
    }

    pub fn modelCatalogAccess(self: *const StartupState) credentials.CatalogAccess {
        if (self.auth_mode == .host_managed) return .host_managed;
        const access = credentials.catalogAccessAt(self.credential, io_mod.milliTimestamp());
        return if (self.credential_source_preference == null)
            access
        else
            access.withExplicitAuthority();
    }

    pub fn gatewayTeam(self: *const StartupState) ?[]const u8 {
        const credential = self.credential orelse return null;
        if (credential.needsRefreshAt(io_mod.milliTimestamp())) return null;
        return credential.gatewayTeam();
    }

    pub fn takeCredential(self: *StartupState) ?credentials.Credential {
        const value = self.credential;
        self.credential = null;
        return value;
    }

    pub fn takeSelectedModel(self: *StartupState) []u8 {
        const value = self.selected_model;
        self.selected_model = &.{};
        return value;
    }

    /// Applies an interactive launch `--model` override. Like LIA_MODEL, it
    /// marks a process override and drops compiled-default fast mode; an
    /// explicit --fast restores fast separately in applyLaunchTurnOverrides.
    pub fn applyLaunchModelOverride(self: *StartupState, alloc: Allocator, model: []const u8) !void {
        const owned = try alloc.dupe(u8, model);
        if (self.selected_model.len > 0) alloc.free(self.selected_model);
        self.selected_model = owned;
        self.model_source = .process_override;
        if (self.fast_mode_source == .compiled_default) {
            self.fast_mode = false;
            self.fast_mode_model_bound = false;
        }
    }

    /// Applies per-launch turn overrides after session preferences are
    /// configured, so they shape runtime state without rewriting persistence.
    pub fn applyLaunchTurnOverrides(self: *StartupState, effort: ?types.ReasoningEffort, fast: ?bool, ultrafast: ?bool) void {
        if (effort) |value| self.effort = value;
        if (fast) |value| {
            self.fast_mode = value;
            // An explicit --fast is bound to the launch model selection so the
            // footer indicator reflects it; --no-fast clears the binding.
            self.fast_mode_model_bound = value;
        }
        if (ultrafast) |value| {
            self.ultrafast_process_override = value;
            self.ultrafast_mode = value;
        }
        if (self.ultrafast_mode) self.fast_mode = false;
    }

    /// Applies per-launch `--provider-order`/`--provider-strict` flags. Like
    /// the turn overrides, flags shape this launch only and never rewrite
    /// stored settings.
    pub fn applyLaunchProviderRouting(self: *StartupState, alloc: Allocator, order: ?[]const []const u8, strict: ?bool) !void {
        if (order) |slugs| {
            const owned = try alloc.alloc([]const u8, slugs.len);
            var filled: usize = 0;
            errdefer {
                for (owned[0..filled]) |slug| alloc.free(@constCast(slug));
                alloc.free(owned);
            }
            for (slugs, 0..) |slug, index| {
                owned[index] = try alloc.dupe(u8, slug);
                filled += 1;
            }
            if (self.provider_order.len > 0) {
                for (self.provider_order) |slug| alloc.free(@constCast(slug));
                alloc.free(self.provider_order);
            }
            self.provider_order = owned;
        }
        if (strict) |value| self.provider_strict = value;
    }

    pub fn takePermissionRules(self: *StartupState) types.PermissionRuleSet {
        const value = self.permission_rules;
        self.permission_rules = .{};
        return value;
    }

    /// Moves the owned review-model override out; caller owns the bytes.
    pub fn takeReviewModel(self: *StartupState) []u8 {
        const value = self.review_model;
        self.review_model = &.{};
        return value;
    }
};

/// Where `lia status` found the selected model.
pub const ModelOrigin = enum {
    env,
    settings,
    default,

    pub fn label(self: ModelOrigin) []const u8 {
        return switch (self) {
            .env => "LIA_MODEL",
            .settings => "settings",
            .default => "default",
        };
    }

    fn of(settings: *const config_runtime.Settings, provider: model_provider.ProviderId, env_model: ?[]const u8) ModelOrigin {
        if (env_model != null) return .env;
        return if (settings.models.get(provider) != null) .settings else .default;
    }
};

pub const StartupStatus = struct {
    workspace_root: []u8,
    provider_endpoint: ?[]u8 = null,
    provider: model_provider.ProviderId = .gateway,
    selected_model: []const u8,
    owned_selected_model: ?[]u8 = null,
    model_origin: ModelOrigin = .default,
    /// The reasoning effort a new session starts with, as `StartupState` resolves it.
    effort: types.ReasoningEffort = .auto,
    ultrafast_mode: bool = false,
    auth: auth_runtime.StatusSnapshot = .{},
    permission_mode: PermissionMode,
    agent_step_limit: usize,
    config_diagnostics: []config_runtime.ConfigDiagnostic = &.{},

    pub fn deinit(self: *StartupStatus, alloc: Allocator) void {
        alloc.free(self.workspace_root);
        if (self.provider_endpoint) |endpoint| alloc.free(endpoint);
        if (self.owned_selected_model) |model| alloc.free(model);
        self.auth.deinit(alloc);
        if (self.config_diagnostics.len > 0) {
            for (self.config_diagnostics) |*diagnostic| diagnostic.deinit(alloc);
            alloc.free(self.config_diagnostics);
        }
        self.* = undefined;
    }
};

const StartupStatusModel = struct {
    value: []const u8,
    owned: ?[]u8 = null,
};

pub fn loadStartupState(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    default_model: []const u8,
    default_agent_step_limit: usize,
) !StartupState {
    return loadStartupStateWithAuthMode(
        alloc,
        transport,
        secret_store,
        default_model,
        default_agent_step_limit,
        .local,
    );
}

pub fn loadStartupStateWithAuthMode(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    default_model: []const u8,
    default_agent_step_limit: usize,
    auth_mode: credentials.AuthMode,
) !StartupState {
    return loadStartupStateForRun(alloc, transport, secret_store, default_model, default_agent_step_limit, auth_mode, null, null);
}

/// `provider_override` is the run's `--provider`; it wins over LIA_PROVIDER and
/// settings and binds configured provider names like the launch flag does.
/// `model_override` is the run's `--model`. It stands in for a provider without
/// a saved model; callers still apply it over the selected or resumed model.
pub fn loadStartupStateForRun(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    default_model: []const u8,
    default_agent_step_limit: usize,
    auth_mode: credentials.AuthMode,
    provider_override: ?model_provider.ProviderId,
    model_override: ?[]const u8,
) !StartupState {
    return loadStartupStateForRunWithOverrides(alloc, transport, secret_store, default_model, default_agent_step_limit, auth_mode, provider_override, model_override, &.{});
}

/// `loadStartupStateForRun` with one run's `--config` values applied as the top
/// settings layer (`lia ask --config key=value`).
pub fn loadStartupStateForRunWithOverrides(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    default_model: []const u8,
    default_agent_step_limit: usize,
    auth_mode: credentials.AuthMode,
    provider_override: ?model_provider.ProviderId,
    model_override: ?[]const u8,
    settings_overrides: []const config_runtime.SettingOverride,
) !StartupState {
    const workspace_root = try io_mod.realpathAlloc(alloc, ".");
    return loadStartupStateWithKeychainRead(alloc, transport, secret_store, workspace_root, default_model, default_agent_step_limit, auth_mode, null, .refresh_if_needed, provider_override, model_override, .blocking, settings_overrides);
}

pub fn loadStartupStateWithoutCredentials(alloc: Allocator, default_model: []const u8, default_agent_step_limit: usize) !StartupState {
    const workspace_root = try io_mod.realpathAlloc(alloc, ".");
    return loadStartupStateFromOwnedWorkspace(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, workspace_root, default_model, default_agent_step_limit, .local, null, null, null, null);
}

pub fn loadEmbeddedStartupState(
    alloc: Allocator,
    home_dir: []const u8,
    workspace_root: []const u8,
    default_model: []const u8,
    default_agent_step_limit: usize,
    model_override: ?[]const u8,
) !StartupState {
    const owned_workspace_root = try io_mod.realpathAlloc(alloc, workspace_root);
    return loadStartupStateFromOwnedWorkspace(
        alloc,
        oauth_transport.unavailable_provider,
        host.unavailable_secret_store,
        owned_workspace_root,
        default_model,
        default_agent_step_limit,
        .local,
        home_dir,
        null,
        null,
        model_override,
    );
}

pub fn loadLibfxStartupState(
    alloc: Allocator,
    workspace_root: []const u8,
    model: []const u8,
    default_agent_step_limit: usize,
) Allocator.Error!StartupState {
    const owned_workspace = try alloc.dupe(u8, workspace_root);
    errdefer alloc.free(owned_workspace);
    const selected_model = try alloc.dupe(u8, model);
    errdefer alloc.free(selected_model);
    const configured_model = try alloc.dupe(u8, model);
    return .{
        .workspace_root = owned_workspace,
        .selected_model = selected_model,
        .configured_model = configured_model,
        .permission_mode = .auto,
        .agent_step_limit = default_agent_step_limit,
        .context_enabled = false,
        .prompt_history_enabled = false,
        .prompt_history_store_allowed = false,
    };
}

pub fn loadCatalogStartupStateWithAuthMode(
    alloc: Allocator,
    secret_store: host.SecretStore,
    default_model: []const u8,
    default_agent_step_limit: usize,
    auth_mode: credentials.AuthMode,
    provider_override: ?model_provider.ProviderId,
    model_override: ?[]const u8,
) !StartupState {
    const workspace_root = try io_mod.realpathAlloc(alloc, ".");
    return loadStartupStateFromOwnedWorkspace(alloc, oauth_transport.unavailable_provider, secret_store, workspace_root, default_model, default_agent_step_limit, auth_mode, null, .stored, provider_override, model_override);
}

pub fn loadStartupStatus(
    alloc: Allocator,
    secret_store: host.SecretStore,
    default_model: []const u8,
    default_agent_step_limit: usize,
) !StartupStatus {
    return loadStartupStatusWithAuthMode(
        alloc,
        secret_store,
        default_model,
        default_agent_step_limit,
        .local,
    );
}

pub fn loadStartupStatusWithAuthMode(
    alloc: Allocator,
    secret_store: host.SecretStore,
    default_model: []const u8,
    default_agent_step_limit: usize,
    auth_mode: credentials.AuthMode,
) !StartupStatus {
    const workspace_root = try io_mod.realpathAlloc(alloc, ".");
    errdefer alloc.free(workspace_root);
    debug_trace.configureFromEnv(alloc, workspace_root);

    var detailed = try config_runtime.loadMergedSettingsDetailed(alloc, workspace_root);
    defer detailed.deinit(alloc);
    const settings = &detailed.settings;

    const run_model = config_runtime.modelEnvOverride();
    const configured_selection = try config_runtime.selectProviderModel(default_model, settings, null, run_model);
    const selected_model = try loadStartupStatusModel(alloc, configured_selection.model, null);
    errdefer if (selected_model.owned) |model| alloc.free(model);

    var auth_status = if (auth_mode == .host_managed)
        auth_runtime.StatusSnapshot{
            .active_source = .host_managed,
            .gateway_connected = true,
        }
    else
        try auth_runtime.loadStatusSnapshotForProvider(
            alloc,
            secret_store,
            configured_selection.provider,
            settings.credential_source,
        );
    errdefer auth_status.deinit(alloc);

    const definitions: @import("../config/configured_provider.zig").Registry = settings.providers orelse .{};
    const result = StartupStatus{
        .workspace_root = workspace_root,
        .provider_endpoint = if (definitions.get(configured_selection.provider.label())) |definition| try alloc.dupe(u8, definition.base_url) else null,
        .provider = configured_selection.provider,
        .selected_model = selected_model.value,
        .owned_selected_model = selected_model.owned,
        .model_origin = ModelOrigin.of(settings, configured_selection.provider, run_model),
        .effort = settings.effort orelse .auto,
        .ultrafast_mode = detailed.ultrafast_mode_env_override orelse (settings.ultrafast_mode orelse false),
        .auth = auth_status,
        .permission_mode = loadPermissionMode(settings.permission_mode),
        .agent_step_limit = loadAgentStepLimit(default_agent_step_limit, settings.max_agent_steps),
        .config_diagnostics = detailed.diagnostics,
    };
    auth_status.owned_team = null;
    detailed.diagnostics = &.{};
    return result;
}

pub fn applyWorkspaceLaunch(
    self: *StartupState,
    alloc: Allocator,
    command_line_directories: []const []const u8,
    saved_suppressed: bool,
) !void {
    try self.workspace_access.applyLaunch(
        alloc,
        self.workspace_root,
        command_line_directories,
        saved_suppressed,
    );
}

fn loadStartupStateForWorkspace(alloc: Allocator, workspace_root: []const u8, default_model: []const u8, default_agent_step_limit: usize) !StartupState {
    const owned_workspace_root = try alloc.dupe(u8, workspace_root);
    return loadStartupStateFromOwnedWorkspace(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, owned_workspace_root, default_model, default_agent_step_limit, .local, null, null, null, null);
}

const CredentialLoadMode = credentials.LoadMode;

/// Whether a launch credential stored in the macOS Keychain is read during
/// startup or left in `StartupState.deferred_credential` for the caller.
const KeychainRead = enum { blocking, deferred };

/// Reading the Keychain spawns a helper process that dominates launch time,
/// so only lookups that can reach it are worth resolving after the first
/// frame. An environment credential wins precedence without touching the
/// Keychain, and other providers read profile files.
fn keychainReadDeferrable(
    is_macos: bool,
    keychain_disabled: bool,
    provider: model_provider.ProviderId,
    preferred: ?credentials.Source,
    env_credential_present: bool,
) bool {
    if (!is_macos or keychain_disabled or provider != .gateway) return false;
    const source = preferred orelse return !env_credential_present;
    return switch (source) {
        .lia_login, .stored_key => true,
        .vercel_oidc_token, .ai_gateway_api_key, .host_managed, .configured => false,
    };
}

fn envCredentialPresent(secret_store: host.SecretStore) bool {
    return credentials.sourcePresence(secret_store, .vercel_oidc_token) == .present or
        credentials.sourcePresence(secret_store, .ai_gateway_api_key) == .present;
}

fn loadStartupStateFromOwnedWorkspace(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    owned_workspace_root: []u8,
    default_model: []const u8,
    default_agent_step_limit: usize,
    auth_mode: credentials.AuthMode,
    profile_home: ?[]const u8,
    credential_mode: ?CredentialLoadMode,
    provider_override: ?model_provider.ProviderId,
    model_override: ?[]const u8,
) !StartupState {
    return loadStartupStateWithKeychainRead(alloc, transport, secret_store, owned_workspace_root, default_model, default_agent_step_limit, auth_mode, profile_home, credential_mode, provider_override, model_override, .blocking, &.{});
}

fn loadStartupStateWithKeychainRead(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    owned_workspace_root: []u8,
    default_model: []const u8,
    default_agent_step_limit: usize,
    auth_mode: credentials.AuthMode,
    profile_home: ?[]const u8,
    credential_mode: ?CredentialLoadMode,
    provider_override: ?model_provider.ProviderId,
    model_override: ?[]const u8,
    keychain_read: KeychainRead,
    settings_overrides: []const config_runtime.SettingOverride,
) !StartupState {
    var state = StartupState{
        .agent_step_limit = default_agent_step_limit,
        .auth_mode = auth_mode,
    };
    errdefer state.deinit(alloc);

    state.workspace_root = owned_workspace_root;
    debug_trace.configureFromEnv(alloc, state.workspace_root);
    var detailed = if (profile_home) |home_dir|
        try config_runtime.loadMergedSettingsDetailedFromHome(alloc, home_dir, state.workspace_root)
    else
        try config_runtime.loadMergedSettingsDetailed(alloc, state.workspace_root);
    defer detailed.deinit(alloc);
    try config_runtime.applySettingOverrides(alloc, &detailed.settings, settings_overrides);
    const settings = &detailed.settings;
    // A malformed process override must never silently fall through to a
    // potentially paid profile preference, regardless of credential mode.
    for (detailed.diagnostics) |diagnostic| {
        if (diagnostic.cause == .invalid_ultrafast_mode_override) {
            return error.InvalidUltrafastOverride;
        }
    }
    // A rejected local profile cannot safely identify the destination of model data.
    if (auth_mode == .local) for (detailed.diagnostics) |diagnostic| {
        if (diagnostic.layer != .user) continue;
        switch (diagnostic.cause) {
            .durable_path_unsafe => {
                if (credential_mode != .stored) return error.InvalidProfileConfiguration;
                state.model_requests_blocked = true;
            },
            .malformed_settings,
            .settings_too_large,
            .invalid_model_id,
            => return error.InvalidProfileConfiguration,
            else => {},
        }
    };

    state.workspace_access = try workspace_access.WorkspaceAccess.init(
        alloc,
        state.workspace_root,
        detailed.additional_directory_sources orelse &.{},
        &.{},
        false,
    );
    // Skill authority checks run across discovery, refresh, and the skill tool,
    // so the profile setting is installed process-wide like the env var.
    try skill_runtime.setConfiguredSymlinkAuthorities(settings.skill_symlink_authorities orelse &.{});

    // A launch --provider override must bind configured provider names against
    // the registry just like the settings and LIA_PROVIDER paths do.
    const bound_override = if (provider_override) |override|
        try override.bind(settings.providers orelse .{})
    else
        null;
    const run_model = model_override orelse config_runtime.modelEnvOverride();
    const configured_selection = try config_runtime.selectProviderModel(default_model, settings, bound_override, run_model);
    state.provider = configured_selection.provider;
    state.configured_providers = settings.providers orelse .{};
    settings.providers = null;
    state.configured_model = try alloc.dupe(u8, configured_selection.model);
    state.model_source = if (bound_override) |override|
        detailed.sources.models.get(model_provider.NameKey.fromProvider(override))
    else
        detailed.model_source orelse .compiled_default;
    state.selected_model = try loadInitialModel(alloc, configured_selection.model, null);
    if (hasProcessModelOverride()) state.model_source = .process_override;
    state.config_diagnostics = detailed.diagnostics;
    detailed.diagnostics = &.{};
    state.prompt_history_store_allowed = detailed.prompt_history_store_allowed;
    state.credential_source_preference = settings.credential_source;
    if (auth_mode == .local and !state.model_requests_blocked) {
        if (credential_mode) |mode| defer_or_resolve: {
            if (keychain_read == .deferred and mode == .stored and keychainReadDeferrable(
                builtin.target.os.tag == .macos,
                secret_store.isDisabled(),
                state.provider,
                settings.credential_source,
                envCredentialPresent(secret_store),
            )) {
                state.deferred_credential = .{
                    .provider = state.provider,
                    .preferred = settings.credential_source,
                };
                break :defer_or_resolve;
            }
            const resolution = try credentials.resolveForProvider(
                alloc,
                transport,
                secret_store,
                mode,
                state.provider,
                settings.credential_source,
            );
            state.credential = resolution.credential;
            state.credential_load_failure = resolution.failure;
            state.stored_key_status = resolution.stored_key_status;
            state.lia_login_status = resolution.lia_login_status;
        }
    }
    try resolveSettings(alloc, &state, &detailed);

    return state;
}

/// Turns merged settings into the values a run uses, defaults and `LIA_*`
/// overrides included. The session and `lia config get` both read settings
/// through it, so the two can't disagree. Call it with `state.agent_step_limit`
/// holding the default and `state.model_source` already set.
pub fn resolveSettings(alloc: Allocator, state: *StartupState, detailed: *const config_runtime.DetailedSettings) !void {
    const settings = &detailed.settings;
    state.prompt_history_enabled = settings.prompt_history_enabled orelse true;
    state.permission_mode = loadPermissionMode(settings.permission_mode);
    state.yolo_acknowledged = settings.yolo_acknowledged orelse false;
    state.permission_rules = try types.dupePermissionRuleSet(alloc, settings.permission_rules);
    state.agent_step_limit = loadAgentStepLimit(state.agent_step_limit, settings.max_agent_steps);
    state.max_tool_result_bytes = tool_result_limits.resolveMaxToolResultBytes(settings.max_tool_result_bytes, tool_result_limits.default_max_tool_result_bytes);
    state.auto_compact_percent = compactor.resolvePercent(settings.auto_compact_percent, io_mod.getenv("LIA_AUTO_COMPACT_PERCENT"));
    state.context_limits = config_runtime.resolveContextLimits(settings, &.{});
    state.context_enabled = settings.context orelse true;
    const fast_mode = resolveStartupFastMode(
        state.model_source,
        settings.fast_mode,
        detailed.sources.fast_mode,
        settings.fast_mode_model_bound,
        detailed.sources.fast_mode_model_bound,
    );
    state.fast_mode = fast_mode.enabled;
    state.fast_mode_model_bound = fast_mode.model_bound;
    state.fast_mode_source = detailed.sources.fast_mode;
    state.configured_ultrafast_mode = settings.ultrafast_mode orelse false;
    state.ultrafast_process_override = detailed.ultrafast_mode_env_override;
    state.ultrafast_mode = state.ultrafast_process_override orelse state.configured_ultrafast_mode;
    state.ultrafast_mode_source = detailed.sources.ultrafast_mode;
    state.theme = if (settings.theme) |value| try alloc.dupe(u8, value) else null;
    state.effort = settings.effort orelse .auto;
    state.review_model = try alloc.dupe(u8, settings.review_model orelse "");
    state.first_call_tool_choice = settings.first_call_tool_choice orelse .auto;
    state.provider_strict = settings.provider_strict orelse false;
    if (settings.provider_order) |order| {
        const owned_order = try alloc.alloc([]const u8, order.len);
        var filled: usize = 0;
        errdefer {
            for (owned_order[0..filled]) |slug| alloc.free(@constCast(slug));
            alloc.free(owned_order);
        }
        for (order, 0..) |slug, index| {
            owned_order[index] = try alloc.dupe(u8, slug);
            filled += 1;
        }
        state.provider_order = owned_order;
    }
    state.session_title_generation = settings.session_titles orelse true;
    state.cache_warming = settings.cache_warming orelse true;
    const sound_override = soundEnvOverride();
    const sound_on_override: ?bool = if (sound_override) |level| level != .off else null;
    const max_override: ?bool = if (sound_override) |level| level == .max else null;
    state.notification_turn_end = sound_on_override orelse settings.notification_turn_end orelse notification_sound.default_enabled;
    state.notification_attention_required = sound_on_override orelse settings.notification_attention_required orelse notification_sound.default_enabled;
    state.notification_max = max_override orelse settings.notification_max orelse false;
}

/// `LIA_THEME`, which beats the `theme` setting. An empty value counts as unset.
pub fn themeEnvOverride() ?[]const u8 {
    const value = io_mod.getenv("LIA_THEME") orelse return null;
    return if (value.len > 0) value else null;
}

const StartupFastMode = struct {
    enabled: bool,
    model_bound: bool,
};

fn resolveStartupFastMode(
    model_source: config_runtime.ModelSource,
    configured_fast_mode: ?bool,
    fast_mode_source: config_runtime.ConfigSource,
    model_bound: ?bool,
    binding_source: config_runtime.ConfigSource,
) StartupFastMode {
    if (configured_fast_mode) |enabled| {
        return .{
            .enabled = enabled,
            .model_bound = enabled and
                model_bound == true and
                model_source == fast_mode_source and
                fast_mode_source == binding_source,
        };
    }
    return .{ .enabled = false, .model_bound = false };
}

fn loadPermissionMode(configured: ?PermissionMode) PermissionMode {
    const fallback = configured orelse default_permission_mode;
    const mode = io_mod.getenv("LIA_PERMISSION_MODE") orelse return fallback;
    return config_runtime.parsePermissionMode(mode) orelse fallback;
}

/// The permission mode startup would load now, including `LIA_PERMISSION_MODE`.
/// Long-running hosts read it when a session starts, so a mode saved by
/// another lia process since startup applies. `home_dir` defaults to `HOME`.
pub fn loadSavedPermissionMode(alloc: Allocator, home_dir: ?[]const u8, workspace_root: []const u8) !PermissionMode {
    var paths = if (home_dir) |home|
        try config_runtime.discoverPathsFromHome(alloc, home, workspace_root)
    else
        try config_runtime.discoverPaths(alloc, workspace_root);
    defer paths.deinit(alloc);
    var settings = try config_runtime.loadStartupStatusSettingsFromPaths(alloc, paths);
    defer settings.deinit(alloc);
    return loadPermissionMode(settings.permission_mode);
}

test "loadSavedPermissionMode reads the mode saved after startup" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.lia");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const home_root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home_root);
    const workspace_root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace_root);

    var env = try TestEnv.install(alloc, &.{.{ .key = "HOME", .value = home_root }});
    defer env.deinit();
    try std.testing.expectEqual(default_permission_mode, try loadSavedPermissionMode(alloc, null, workspace_root));

    try writeFixtureFile(tmp.dir, "home/.lia/settings.json", "{\"permission_mode\":\"ask\"}\n");
    try std.testing.expectEqual(PermissionMode.ask, try loadSavedPermissionMode(alloc, null, workspace_root));

    try writeFixtureFile(tmp.dir, "home/.lia/settings.json", "{\"permission_mode\":\"yolo\"}\n");
    try std.testing.expectEqual(PermissionMode.yolo, try loadSavedPermissionMode(alloc, home_root, workspace_root));
}

test "loadSavedPermissionMode keeps the LIA_PERMISSION_MODE override" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.lia");
    const home_root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home_root);
    try writeFixtureFile(tmp.dir, "home/.lia/settings.json", "{\"permission_mode\":\"yolo\"}\n");

    var env = try TestEnv.install(alloc, &.{
        .{ .key = "HOME", .value = home_root },
        .{ .key = "LIA_PERMISSION_MODE", .value = "ask" },
    });
    defer env.deinit();
    try std.testing.expectEqual(PermissionMode.ask, try loadSavedPermissionMode(alloc, null, home_root));
}

fn loadAgentStepLimit(fallback: usize, configured: ?usize) usize {
    return agent_steps.resolveMaxAgentStepsWithOverride(
        configured,
        fallback,
        io_mod.getenv("LIA_MAX_AGENT_STEPS"),
    );
}

fn initialModelId(default_model: []const u8, configured: ?[]const u8) []const u8 {
    return config_runtime.modelEnvOverride() orelse configured orelse default_model;
}

fn loadInitialModel(alloc: Allocator, default_model: []const u8, configured: ?[]const u8) ![]u8 {
    return alloc.dupe(u8, initialModelId(default_model, configured));
}

fn hasProcessModelOverride() bool {
    return config_runtime.modelEnvOverride() != null;
}

fn loadStartupStatusModel(alloc: Allocator, default_model: []const u8, configured: ?[]const u8) !StartupStatusModel {
    const owned = try alloc.dupe(u8, initialModelId(default_model, configured));
    return .{ .value = owned, .owned = owned };
}

fn credentialOnboardingDisabled() bool {
    const value = io_mod.getenv("LIA_TEST_SKIP_ONBOARDING") orelse return false;
    const trimmed = std.mem.trim(u8, value, " \t\r\n");
    if (trimmed.len == 0) return false;
    return !std.mem.eql(u8, trimmed, "0") and !std.ascii.eqlIgnoreCase(trimmed, "false");
}

fn soundEnvOverride() ?env_settings.SoundPreset {
    return env_settings.soundPreset(io_mod.getenv("LIA_SOUND") orelse return null);
}

const EnvEntry = struct {
    key: []const u8,
    value: []const u8,
};

const TestEnv = struct {
    alloc: Allocator,
    map: std.process.Environ.Map,

    fn install(alloc: Allocator, entries: []const EnvEntry) !*TestEnv {
        const self = try alloc.create(TestEnv);
        errdefer alloc.destroy(self);

        self.* = .{
            .alloc = alloc,
            .map = std.process.Environ.Map.init(alloc),
        };
        errdefer self.map.deinit();

        for (entries) |entry| {
            try self.map.put(entry.key, entry.value);
        }

        io_mod.setEnvironMap(&self.map);
        return self;
    }

    fn deinit(self: *TestEnv) void {
        io_mod.resetEnvironForTest();
        self.map.deinit();
        const alloc = self.alloc;
        alloc.destroy(self);
    }
};

test "permission mode parser accepts known modes" {
    try std.testing.expectEqual(PermissionMode.ask, config_runtime.parsePermissionMode("ask").?);
    try std.testing.expectEqual(PermissionMode.auto, config_runtime.parsePermissionMode("auto").?);
    try std.testing.expectEqual(PermissionMode.yolo, config_runtime.parsePermissionMode("yolo").?);
    try std.testing.expect(config_runtime.parsePermissionMode("weird") == null);
}

test "permission mode loader defaults to auto" {
    var env = try TestEnv.install(std.testing.allocator, &.{});
    defer env.deinit();

    try std.testing.expectEqual(PermissionMode.auto, loadPermissionMode(null));
    try std.testing.expectEqual(PermissionMode.ask, loadPermissionMode(.ask));
}

test "permission mode environment accepts yolo without changing fallback" {
    var env = try TestEnv.install(std.testing.allocator, &.{
        .{ .key = "LIA_PERMISSION_MODE", .value = "yolo" },
    });
    defer env.deinit();

    try std.testing.expectEqual(PermissionMode.yolo, loadPermissionMode(.ask));
}

test "agent step limit loader distinguishes missing and explicit zero" {
    var env = try TestEnv.install(std.testing.allocator, &.{});
    defer env.deinit();

    try std.testing.expectEqual(agent_steps.default_max_agent_steps, loadAgentStepLimit(agent_steps.default_max_agent_steps, null));
    try std.testing.expectEqual(@as(usize, 0), loadAgentStepLimit(agent_steps.default_max_agent_steps, 0));
    try std.testing.expectEqual(@as(usize, 50), loadAgentStepLimit(agent_steps.default_max_agent_steps, 50));
}

fn minimalLayout() types.Layout {
    return .{
        .rows = 1,
        .cols = 1,
        .content_bottom = 1,
        .divider_top_row = 1,
        .input_row = 1,
        .divider_bottom_row = 1,
        .hint_row = 1,
    };
}

test "minimal layout is safe for shutdown fallback" {
    const layout = minimalLayout();
    try std.testing.expectEqual(@as(u16, 1), layout.rows);
    try std.testing.expectEqual(@as(u16, 1), layout.cols);
    try std.testing.expectEqual(@as(u16, 1), layout.input_row);
}

test "startup credential modes select a refresh policy, never a narrower source set" {
    const modes = @typeInfo(CredentialLoadMode).@"enum".field_names;
    try std.testing.expectEqual(@as(usize, 2), modes.len);
    try std.testing.expectEqualStrings("stored", modes[0]);
    try std.testing.expectEqualStrings("refresh_if_needed", modes[1]);
}

test "loadStartupState applies core env overrides" {
    var env = try TestEnv.install(std.testing.allocator, &.{
        .{ .key = "LIA_MODEL", .value = "  env-model  " },
        .{ .key = "AI_GATEWAY_API_KEY", .value = "gateway-key" },
        .{ .key = "LIA_PERMISSION_MODE", .value = "auto" },
        .{ .key = "LIA_MAX_AGENT_STEPS", .value = "37" },
    });
    defer env.deinit();

    var state = try loadStartupState(
        std.testing.allocator,
        oauth_transport.unavailable_provider,
        host.unavailable_secret_store,
        "default-model",
        12,
    );
    defer state.deinit(std.testing.allocator);

    try std.testing.expect(state.workspace_root.len > 0);
    try std.testing.expectEqualStrings("env-model", state.selected_model);
    try std.testing.expectEqualStrings("default-model", state.configured_model);
    try std.testing.expectEqual(config_runtime.ModelSource.process_override, state.model_source);
    try std.testing.expect(!state.fast_mode);
    try std.testing.expectEqualStrings("gateway-key", state.apiKey().?);
    try std.testing.expectEqual(credentials.Source.ai_gateway_api_key, state.credential.?.source);
    try std.testing.expectEqual(PermissionMode.auto, state.permission_mode);
    try std.testing.expectEqual(@as(usize, 37), state.agent_step_limit);
}

test "ultrafast startup separates profile preferences from process overrides" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.lia");
    try tmp.dir.createDirPath(io_mod.getIo(), "profile-off");
    try tmp.dir.createDirPath(io_mod.getIo(), "profile-on");
    const home_root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home_root);
    const profile_off_root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "profile-off");
    defer alloc.free(profile_off_root);
    const profile_on_root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "profile-on");
    defer alloc.free(profile_on_root);
    const settings = try alloc.print(
        "{{\"workspaces\":{{\"{s}\":{{\"ultrafast_mode\":false}},\"{s}\":{{\"ultrafast_mode\":true}}}}}}\n",
        .{ profile_off_root, profile_on_root },
    );
    defer alloc.free(settings);
    try writeFixtureFile(tmp.dir, "home/.lia/settings.json", settings);

    const env = try TestEnv.install(alloc, &.{
        .{ .key = "HOME", .value = home_root },
        .{ .key = "LIA_ULTRAFAST", .value = "1" },
    });
    defer env.deinit();
    var profile_off_env_on = try loadStartupStateForWorkspace(alloc, profile_off_root, "default/model", 25);
    defer profile_off_env_on.deinit(alloc);
    try std.testing.expect(!profile_off_env_on.configured_ultrafast_mode);
    try std.testing.expect(profile_off_env_on.ultrafast_mode);
    try std.testing.expectEqual(@as(?bool, true), profile_off_env_on.ultrafast_process_override);

    try env.map.put("LIA_ULTRAFAST", "0");
    var profile_on_env_off = try loadStartupStateForWorkspace(alloc, profile_on_root, "default/model", 25);
    defer profile_on_env_off.deinit(alloc);
    try std.testing.expect(profile_on_env_off.configured_ultrafast_mode);
    try std.testing.expect(!profile_on_env_off.ultrafast_mode);
    try std.testing.expectEqual(@as(?bool, false), profile_on_env_off.ultrafast_process_override);

    try env.map.put("LIA_ULTRAFAST", "paid");
    try std.testing.expectError(
        error.InvalidUltrafastOverride,
        loadStartupStateForWorkspace(alloc, profile_on_root, "default/model", 25),
    );
}

test "host-managed startup skips every local credential source" {
    var env = try TestEnv.install(std.testing.allocator, &.{
        .{ .key = "AI_GATEWAY_API_KEY", .value = "must-not-load" },
    });
    defer env.deinit();

    var state = try loadStartupStateWithAuthMode(
        std.testing.allocator,
        oauth_transport.unavailable_provider,
        host.unavailable_secret_store,
        "default-model",
        12,
        .host_managed,
    );
    defer state.deinit(std.testing.allocator);

    try std.testing.expectEqual(credentials.AuthMode.host_managed, state.auth_mode);
    try std.testing.expect(state.credential == null);
    try std.testing.expect(state.apiKey() == null);
    try std.testing.expectEqual(credentials.CatalogAccess.host_managed, state.modelCatalogAccess());
}

test "loadStartupState starts with a profile that still sets the terminal UI settings" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.createDirPath(io_mod.getIo(), "home/.lia");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");

    const home_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "home");
    defer std.testing.allocator.free(home_root);
    const workspace_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "workspace");
    defer std.testing.allocator.free(workspace_root);

    try writeFixtureFile(
        tmp.dir,
        "home/.lia/settings.json",
        "{\"session_titles\":false,\"collapse_tool_calls\":\"off\",\"slash_menu_categories\":false,\"startup_scrollback\":1,\"status_line\":{\"context\":true},\"statusLine\":7}\n",
    );

    var env = try TestEnv.install(std.testing.allocator, &.{.{ .key = "HOME", .value = home_root }});
    defer env.deinit();

    var state = try loadStartupStateForWorkspace(std.testing.allocator, workspace_root, "default-model", 25);
    defer state.deinit(std.testing.allocator);
    // A profile lia discarded as malformed would leave the default, true.
    try std.testing.expect(!state.session_title_generation);
}

test "loadStartupState resolves max_agent_steps default zero and positive values" {
    var env = try TestEnv.install(std.testing.allocator, &.{});
    defer env.deinit();

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.createDirPath(io_mod.getIo(), "absent");
    try tmp.dir.createDirPath(io_mod.getIo(), "zero");
    try tmp.dir.createDirPath(io_mod.getIo(), "positive");
    try writeFixtureFile(tmp.dir, "zero/.lia.json", "{\"max_agent_steps\":0}");
    try writeFixtureFile(tmp.dir, "positive/.lia.json", "{\"max_agent_steps\":50}");

    const absent_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "absent");
    defer std.testing.allocator.free(absent_root);
    const zero_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "zero");
    defer std.testing.allocator.free(zero_root);
    const positive_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "positive");
    defer std.testing.allocator.free(positive_root);

    var absent = try loadStartupStateForWorkspace(std.testing.allocator, absent_root, "default-model", agent_steps.default_max_agent_steps);
    defer absent.deinit(std.testing.allocator);
    try std.testing.expectEqual(agent_steps.default_max_agent_steps, absent.agent_step_limit);

    var zero = try loadStartupStateForWorkspace(std.testing.allocator, zero_root, "default-model", agent_steps.default_max_agent_steps);
    defer zero.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), zero.agent_step_limit);

    var positive = try loadStartupStateForWorkspace(std.testing.allocator, positive_root, "default-model", agent_steps.default_max_agent_steps);
    defer positive.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 50), positive.agent_step_limit);
}

test "loadStartupState resolves max_tool_result_bytes default and explicit values" {
    var env = try TestEnv.install(std.testing.allocator, &.{});
    defer env.deinit();

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.createDirPath(io_mod.getIo(), "absent");
    try tmp.dir.createDirPath(io_mod.getIo(), "explicit");
    try writeFixtureFile(tmp.dir, "explicit/.lia.json", "{\"max_tool_result_bytes\":131072}");

    const absent_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "absent");
    defer std.testing.allocator.free(absent_root);
    const explicit_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "explicit");
    defer std.testing.allocator.free(explicit_root);

    var absent = try loadStartupStateForWorkspace(std.testing.allocator, absent_root, "default-model", 25);
    defer absent.deinit(std.testing.allocator);
    try std.testing.expectEqual(tool_result_limits.default_max_tool_result_bytes, absent.max_tool_result_bytes);

    var explicit = try loadStartupStateForWorkspace(std.testing.allocator, explicit_root, "default-model", 25);
    defer explicit.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 131072), explicit.max_tool_result_bytes);
}

test "loadStartupState falls back to auto for invalid first_call_tool_choice" {
    var env = try TestEnv.install(std.testing.allocator, &.{});
    defer env.deinit();

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    try writeFixtureFile(tmp.dir, "workspace/.lia.json", "{\"first_call_tool_choice\":\"required\"}");

    const workspace_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "workspace");
    defer std.testing.allocator.free(workspace_root);

    var state = try loadStartupStateForWorkspace(std.testing.allocator, workspace_root, "default-model", 25);
    defer state.deinit(std.testing.allocator);

    try std.testing.expectEqual(types.ToolChoice.auto, state.first_call_tool_choice);
}

test "loadStartupState diagnoses the retired fuzzy skill setting" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.lia");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");

    const home_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "home");
    defer std.testing.allocator.free(home_root);
    const workspace_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "workspace");
    defer std.testing.allocator.free(workspace_root);

    try writeFixtureFile(tmp.dir, "home/.lia/settings.json", "{\"skill_match_fuzzy\":true}");

    var env = try TestEnv.install(std.testing.allocator, &.{.{ .key = "HOME", .value = home_root }});
    defer env.deinit();

    var state = try loadStartupStateForWorkspace(std.testing.allocator, workspace_root, "default-model", 25);
    defer state.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), state.config_diagnostics.len);
    try std.testing.expectEqual(config_runtime.ConfigDiagnosticCause.retired_skill_match_fuzzy, state.config_diagnostics[0].cause);
}

test "credential onboarding can be skipped independently from Keychain" {
    var env = try TestEnv.install(std.testing.allocator, &.{
        .{ .key = "LIA_TEST_SKIP_ONBOARDING", .value = "1" },
        .{ .key = "LIA_DISABLE_KEYCHAIN", .value = "1" },
    });
    defer env.deinit();

    const onboarding_skipped = credentialOnboardingDisabled();
    try std.testing.expect(onboarding_skipped);
}

fn keychainEnabledForTest(_: ?*anyopaque) bool {
    return false;
}

test "interactive launch leaves a Keychain credential unresolved for the caller" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.lia");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    try writeFixtureFile(tmp.dir, "home/.lia/settings.json", "{\"credential_source\":\"lia_login\"}");
    const home_root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home_root);
    const workspace_root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace_root);
    // The real Keychain stays off; the fake store below reports it enabled.
    var env = try TestEnv.install(alloc, &.{
        .{ .key = "HOME", .value = home_root },
        .{ .key = "LIA_PROVIDER", .value = "" },
        .{ .key = "LIA_DISABLE_KEYCHAIN", .value = "1" },
    });
    defer env.deinit();

    var keychain_store = host.unavailable_secret_store;
    keychain_store.is_disabled_fn = keychainEnabledForTest;
    for ([_]KeychainRead{ .blocking, .deferred }) |keychain_read| {
        var state = try loadStartupStateWithKeychainRead(alloc, oauth_transport.unavailable_provider, keychain_store, try alloc.dupe(u8, workspace_root), "default/model", 25, .local, null, .stored, null, null, keychain_read, &.{});
        defer state.deinit(alloc);
        try std.testing.expect(state.credential == null);
        if (keychain_read == .deferred and builtin.target.os.tag == .macos) {
            const request = state.deferred_credential orelse return error.TestExpectedDeferredCredential;
            try std.testing.expectEqual(model_provider.ProviderId.gateway, request.provider);
            try std.testing.expectEqual(@as(?credentials.Source, .lia_login), request.preferred);
            try std.testing.expectEqual(credentials.LiaLoginReadStatus.not_attempted, state.lia_login_status);
        } else {
            // Test builds keep the lia login in the profile, where it is absent.
            try std.testing.expect(state.deferred_credential == null);
            try std.testing.expectEqual(credentials.LiaLoginReadStatus.absent, state.lia_login_status);
        }
    }
}

fn writeFixtureFile(dir: std.Io.Dir, sub_path: []const u8, text: []const u8) !void {
    var file = try dir.createFile(io_mod.getIo(), sub_path, .{ .truncate = true });
    defer file.close(io_mod.getIo());
    try file.writeStreamingAll(io_mod.getIo(), text);
}

test "loadStartupStatus reports where the selected model came from" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.lia");
    const home_root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home_root);

    {
        var env = try TestEnv.install(alloc, &.{
            .{ .key = "HOME", .value = home_root },
            .{ .key = "LIA_MODEL", .value = "gpt-env" },
        });
        defer env.deinit();
        var status = try loadStartupStatusWithAuthMode(alloc, host.unavailable_secret_store, "default/model", 25, .host_managed);
        defer status.deinit(alloc);
        try std.testing.expectEqualStrings("gpt-env", status.selected_model);
        try std.testing.expectEqual(ModelOrigin.env, status.model_origin);
    }
    {
        var env = try TestEnv.install(alloc, &.{.{ .key = "HOME", .value = home_root }});
        defer env.deinit();
        var status = try loadStartupStatusWithAuthMode(alloc, host.unavailable_secret_store, "default/model", 25, .host_managed);
        defer status.deinit(alloc);
        try std.testing.expectEqualStrings("default/model", status.selected_model);
        try std.testing.expectEqual(ModelOrigin.default, status.model_origin);
    }
    try writeFixtureFile(tmp.dir, "home/.lia/settings.json", "{\"models\":{\"gateway\":\"gpt-saved\"}}\n");
    {
        var env = try TestEnv.install(alloc, &.{.{ .key = "HOME", .value = home_root }});
        defer env.deinit();
        var status = try loadStartupStatusWithAuthMode(alloc, host.unavailable_secret_store, "default/model", 25, .host_managed);
        defer status.deinit(alloc);
        try std.testing.expectEqualStrings("gpt-saved", status.selected_model);
        try std.testing.expectEqual(ModelOrigin.settings, status.model_origin);
    }
}

test "loadStartupState defaults fast mode off and requires bound explicit preferences" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.createDirPath(io_mod.getIo(), "home/.lia");
    try tmp.dir.createDirPath(io_mod.getIo(), "absent");
    try tmp.dir.createDirPath(io_mod.getIo(), "configured");
    try tmp.dir.createDirPath(io_mod.getIo(), "disabled");
    try tmp.dir.createDirPath(io_mod.getIo(), "legacy-fast");
    try tmp.dir.createDirPath(io_mod.getIo(), "bound-fast");

    const home_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "home");
    defer std.testing.allocator.free(home_root);
    const absent_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "absent");
    defer std.testing.allocator.free(absent_root);
    const configured_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "configured");
    defer std.testing.allocator.free(configured_root);
    const disabled_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "disabled");
    defer std.testing.allocator.free(disabled_root);
    const legacy_fast_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "legacy-fast");
    defer std.testing.allocator.free(legacy_fast_root);
    const bound_fast_root = try io_mod.dirRealpathAlloc(std.testing.allocator, tmp.dir, "bound-fast");
    defer std.testing.allocator.free(bound_fast_root);

    const fixture = try std.testing.allocator.print(
        "{{\"workspaces\":{{\"{s}\":{{\"model\":\"openai/gpt-5\"}},\"{s}\":{{\"fast_mode\":false}},\"{s}\":{{\"model\":\"zai/glm-5.3\",\"fast_mode\":true}},\"{s}\":{{\"model\":\"provider/fast-toggle\",\"fast_mode\":true,\"fast_mode_model_bound\":true}}}}}}\n",
        .{ configured_root, disabled_root, legacy_fast_root, bound_fast_root },
    );
    defer std.testing.allocator.free(fixture);
    try writeFixtureFile(tmp.dir, "home/.lia/settings.json", fixture);

    var env = try TestEnv.install(std.testing.allocator, &.{.{ .key = "HOME", .value = home_root }});
    defer env.deinit();

    var absent = try loadStartupStateForWorkspace(std.testing.allocator, absent_root, "zai/glm-5.2", 25);
    defer absent.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("zai/glm-5.2", absent.selected_model);
    try std.testing.expectEqualStrings("zai/glm-5.2", absent.configured_model);
    try std.testing.expect(!absent.fast_mode);
    try std.testing.expect(!absent.fast_mode_model_bound);

    var configured = try loadStartupStateForWorkspace(std.testing.allocator, configured_root, "zai/glm-5.2", 25);
    defer configured.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("openai/gpt-5", configured.selected_model);
    try std.testing.expectEqualStrings("openai/gpt-5", configured.configured_model);
    try std.testing.expect(!configured.fast_mode);
    try std.testing.expect(!configured.fast_mode_model_bound);

    var disabled = try loadStartupStateForWorkspace(std.testing.allocator, disabled_root, "zai/glm-5.2", 25);
    defer disabled.deinit(std.testing.allocator);
    try std.testing.expect(!disabled.fast_mode);
    try std.testing.expect(!disabled.fast_mode_model_bound);

    var legacy_fast = try loadStartupStateForWorkspace(std.testing.allocator, legacy_fast_root, "zai/glm-5.2", 25);
    defer legacy_fast.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("zai/glm-5.3", legacy_fast.selected_model);
    try std.testing.expect(legacy_fast.fast_mode);
    try std.testing.expect(!legacy_fast.fast_mode_model_bound);

    var bound_fast = try loadStartupStateForWorkspace(std.testing.allocator, bound_fast_root, "zai/glm-5.2", 25);
    defer bound_fast.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("provider/fast-toggle", bound_fast.selected_model);
    try std.testing.expect(bound_fast.fast_mode);
    try std.testing.expect(bound_fast.fast_mode_model_bound);
}

test "only a Keychain-backed Gateway credential is deferred past the first frame" {
    try std.testing.expect(keychainReadDeferrable(true, false, .gateway, .lia_login, false));
    try std.testing.expect(keychainReadDeferrable(true, false, .gateway, .stored_key, true));
    try std.testing.expect(keychainReadDeferrable(true, false, .gateway, null, false));
    // An environment credential wins automatic precedence without the Keychain.
    try std.testing.expect(!keychainReadDeferrable(true, false, .gateway, null, true));
    try std.testing.expect(!keychainReadDeferrable(true, false, .gateway, .ai_gateway_api_key, false));
    try std.testing.expect(!keychainReadDeferrable(true, false, .gateway, .vercel_oidc_token, false));
    try std.testing.expect(!keychainReadDeferrable(true, true, .gateway, .lia_login, false));
    try std.testing.expect(!keychainReadDeferrable(false, false, .gateway, .lia_login, false));
}
