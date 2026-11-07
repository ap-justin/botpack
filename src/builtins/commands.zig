const std = @import("std");
const command_specs = @import("../core/slash_commands/command_specs.zig");

const Allocator = std.mem.Allocator;

pub const TopLevelKind = command_specs.TopLevelKind;
pub const TopLevelSpec = command_specs.TopLevelSpec;
pub const TopLevelHelpGroup = command_specs.TopLevelHelpGroup;
pub const TopLevelFlag = command_specs.TopLevelFlag;
pub const TopLevelExample = command_specs.TopLevelExample;
pub const TopLevelResource = command_specs.TopLevelResource;
pub const TopLevelRegistry = command_specs.TopLevelRegistry;
pub const HelpStyle = command_specs.HelpStyle;

const json_option = command_specs.OptionDoc{ .flag = "--json", .description = "Emit machine-readable JSON instead of text" };

/// Options for `fx ask`. `cli_ask` parses against this list and its help is
/// rendered from it, so the two can't disagree.
/// Options for local commands that only take `--json`.
pub const json_only_options = [_]command_specs.OptionDoc{json_option};

const login_providers = [_]command_specs.SubcommandDoc{
    .{ .usage = "vercel", .description = "Vercel AI Gateway (the default)", .options = &login_options },
};

pub const login_options = [_]command_specs.OptionDoc{
    .{ .flag = "--api-key", .description = "Paste a Vercel AI Gateway API key instead of signing in through the browser" },
};

pub const sessions_options = [_]command_specs.OptionDoc{
    .{ .flag = "--all", .description = "List saved sessions across every workspace in this profile" },
    .{ .flag = "--limit <1-100>", .description = "Set the maximum sessions returned per page" },
    .{ .flag = "--cursor <cursor>", .description = "Continue from a prior sessions result" },
    json_option,
};

pub const sessions_convert_options = [_]command_specs.OptionDoc{json_option};

pub const usage_options = [_]command_specs.OptionDoc{
    .{ .flag = "--period <today|7d|month>", .description = "Select the period, in UTC days (default: month)" },
    json_option,
};

pub const workspace_options = [_]command_specs.OptionDoc{json_option};

const workspace_subcommands = [_]command_specs.SubcommandDoc{
    .{ .usage = "list", .description = "List the primary and additional directories (default)" },
    .{ .usage = "add PATH", .description = "Persist an existing additional directory" },
    .{ .usage = "remove PATH", .description = "Remove an additional directory" },
    .{ .usage = "clear", .description = "Remove all additional directories" },
};

const config_subcommands = [_]command_specs.SubcommandDoc{
    .{ .usage = "list", .description = "List the values set in each settings file (default)", .options = &config_options },
    .{ .usage = "get <key>", .description = "Print the value fx uses for a setting", .options = &config_options },
    .{ .usage = "set <key> <value>", .description = "Save a preference in ~/.fx/settings.json", .settable_key = true },
    .{ .usage = "unset <key>", .description = "Remove a preference from ~/.fx/settings.json", .settable_key = true },
    .{ .usage = "schema", .description = "Print the JSON Schema for ~/.fx/settings.json", .options = &config_schema_options },
};

const config_schema_options = [_]command_specs.OptionDoc{
    .{ .flag = "--project", .description = "Print the schema for a project .fx.json instead" },
};

/// Every flag `fx config` parses: its own and `schema --project`.
pub const config_parse_options = config_options ++ config_schema_options;

const config_options = [_]command_specs.OptionDoc{
    .{ .flag = "--global", .description = "Only the profile's own settings" },
    .{ .flag = "--workspace", .description = "Only this workspace's override in the profile (list and get)" },
    .{ .flag = "--show-origin", .description = "Start each line with where the value is set" },
    json_option,
};

const session_subcommands = [_]command_specs.SubcommandDoc{
    .{ .usage = "last", .description = "Inspect the current workspace session" },
    .{ .usage = "recover <id>", .description = "Copy a recoverable corrupt session into a new session" },
};

pub const session_options = [_]command_specs.OptionDoc{
    .{ .flag = "--id <id>", .description = "Inspect a saved session by exact id" },
    json_option,
};

pub const acp_options = agentRunOptions("sessions this server starts", .without_provider_order) ++ [_]command_specs.OptionDoc{
    .{ .flag = "--log-file <path>", .description = "Write ACP logs to a file" },
};

pub const acp_usage = "acp " ++ agent_run_usage_base ++ " [--log-file <path>]";

pub const pr_options = agentRunOptions("this request", .with_provider_order);

const issue_options = agentRunOptions("this request", .with_provider_order);

/// `fx mcp list` options; `fx mcp --help` shows them in its usage line.
const mcp_subcommands = [_]command_specs.SubcommandDoc{
    .{ .usage = "list", .description = "List configured servers; never connects", .options = &mcp_list_options },
    .{ .usage = "show NAME", .description = "Connect to a server: status, version, and tools", .options = &mcp_show_options },
    .{
        .usage = "add NAME URL",
        .description = "Add an HTTP server, or a command after --",
        .subcommands = &.{.{ .usage = "slack", .description = "Add Slack's server" }},
        .options = &mcp_add_options,
    },
    .{ .usage = "remove NAME", .description = "Remove a server and its login", .options = &mcp_scope_options },
    .{ .usage = "login NAME", .description = "Sign in to an HTTP server", .options = &mcp_login_options },
    .{ .usage = "logout NAME", .description = "Sign out and delete the login" },
    .{ .usage = "approve NAME", .description = "Approve a project server from .mcp.json", .options = &mcp_approve_options },
    .{ .usage = "reject NAME", .description = "Reject a project server" },
    .{
        .usage = "call TOOL [JSON | -]",
        .description = "Run an MCP tool from a command fx's shell tool runs",
        .subcommands = &.{
            .{ .usage = "list SERVER", .description = "List a server's tools" },
            .{ .usage = "search QUERY...", .description = "Find the tools that match QUERY" },
            .{ .usage = "help TOOL", .description = "Show a tool's arguments" },
        },
    },
};

// The flags of the `fx mcp` and `/mcp` verbs, which `src/core/mcp_host/verbs.zig`
// parses and completion offers.

/// `--global` names ~/.fx/mcp.json, the default, and `--project` the
/// project's .mcp.json. `--profile` is the older name for `--global`.
pub const mcp_scope_options = [_]command_specs.OptionDoc{
    .{ .flag = "--global", .description = "Use ~/.fx/mcp.json, the default" },
    .{ .flag = "--profile", .description = "Older name for --global", .hidden = true },
    .{ .flag = "--project", .description = "Use the project's .mcp.json" },
};
pub const mcp_add_options = mcp_scope_options ++ [_]command_specs.OptionDoc{
    .{ .flag = "--env <KEY=VALUE>", .description = "Set an environment variable for a command server" },
    .{ .flag = "--header <KEY=VALUE>", .description = "Send a header to an HTTP server" },
    .{ .flag = "--no-login", .description = "Don't sign in to an HTTP server that needs a login" },
};
/// `list --connect` moved to `show NAME`; it is read to say so.
const mcp_connect_option: command_specs.OptionDoc = .{ .flag = "--connect", .description = "Moved to show NAME", .hidden = true };
pub const mcp_list_options = [_]command_specs.OptionDoc{ json_option, mcp_connect_option };
/// `/mcp list` in a session prints no JSON.
pub const mcp_list_shell_options = [_]command_specs.OptionDoc{mcp_connect_option};
pub const mcp_show_options = [_]command_specs.OptionDoc{json_option};
pub const mcp_login_options = [_]command_specs.OptionDoc{
    .{ .flag = "--no-browser", .description = "Print the sign-in address instead of opening it" },
};
pub const mcp_approve_options = [_]command_specs.OptionDoc{
    .{ .flag = "--all", .description = "Approve every project server" },
};

const permission_modes = [_][]const u8{ "ask", "auto", "full-access" };
/// The built-in providers. A configured connection's name is also accepted.
const builtin_providers = [_][]const u8{"gateway"};

/// Whether a command takes the gateway provider-order flags.
const ProviderOrder = enum { with_provider_order, without_provider_order };

/// The flags that shape an agent run, the same on every command that runs the
/// agent: `fx ask`, `fx pr`, `fx issue`, and `fx acp`. `scope` names what they
/// shape, such as "this request". `src/core/cli/agent_run_flags.zig` parses
/// them. `fx acp` leaves out the provider-order flags, because ACP sessions
/// don't apply gateway provider routing.
fn agentRunOptions(comptime scope: []const u8, comptime provider_order: ProviderOrder) [if (provider_order == .with_provider_order) 15 else 12]command_specs.OptionDoc {
    const all = [_]command_specs.OptionDoc{
        .{ .flag = "--permission-mode <mode>", .description = "Set the permission mode for " ++ scope ++ ": ask, auto, or full-access", .values = &permission_modes },
        .{ .flag = "--ask", .description = "Ask before each action that needs permission" },
        .{ .flag = "--auto", .description = "Automatically review unresolved permission requests" },
        .{ .flag = "--full-access", .description = "Disable fx permission checks" },
        .{ .flag = "--yolo", .description = "Alias for --full-access" },
        .{ .flag = "--provider <name>", .description = "Override the model provider for " ++ scope ++ " (gateway or a configured name)", .values = &builtin_providers },
        .{ .flag = "--model <id>", .description = "Override the model for " ++ scope },
        .{ .flag = "--effort <level>", .description = "Override the reasoning effort for " ++ scope },
        .{ .flag = "--fast", .description = "Enable Fast mode for " ++ scope ++ " when the model supports it" },
        .{ .flag = "--no-fast", .description = "Disable Fast mode for " ++ scope },
        .{ .flag = "--ultrafast", .description = "Request Ultrafast mode for " ++ scope ++ " when the model supports it" },
        .{ .flag = "--no-ultrafast", .description = "Disable Ultrafast mode for " ++ scope },
        .{ .flag = "--provider-order <a,b,...>", .description = "Prefer these gateway providers in order for " ++ scope },
        .{ .flag = "--provider-strict", .description = "Restrict " ++ scope ++ " to only the providers in --provider-order" },
        .{ .flag = "--no-provider-strict", .description = "Clear the provider restriction for " ++ scope },
    };
    return if (provider_order == .with_provider_order) all else all[0..12].*;
}

/// The usage-line form of `agentRunOptions`.
const agent_run_usage_base = "[--permission-mode <mode>|--ask|--auto|--full-access] [--provider <name>] [--model <id>] [--effort <level>] [--fast|--no-fast] [--ultrafast|--no-ultrafast]";
const agent_run_usage = agent_run_usage_base ++ " [--provider-order <a,b,...>] [--provider-strict|--no-provider-strict]";

pub const ask_options = agentRunOptions("this request", .with_provider_order) ++ [_]command_specs.OptionDoc{
    .{ .flag = "--image PATH", .description = "Attach an image file; repeat for multiple images" },
    .{ .flag = "--system TEXT", .description = "Replace the built-in system prompt for this request" },
    json_option,
    .{ .flag = "--quiet", .description = "Suppress assistant output" },
    .{ .flag = "--prompt-permissions", .description = "Prompt for Y/N permission approval when stdin is a TTY" },
    .{ .flag = "--timeout <seconds>", .description = "Time limit for each shell command the agent runs" },
    .{ .flag = "--config <key=value>", .description = "Override a setting for this request, with the keys fx config set takes; repeatable" },
    .{ .flag = "--no-save", .description = "Do not save the session; incompatible with --resume" },
    .{ .flag = "--no-color", .description = "Print the full-access warning on stderr without color; NO_COLOR or TERM=dumb also turns color off" },
    .{ .flag = "--resume <last|<id>>", .description = "Continue the last session or a session by id" },
    .{ .flag = "--resume-id <id>", .description = "Continue a session by exact id", .replacement = "use --resume <id>" },
    .{ .flag = "--", .description = "Treat every following argument as prompt text" },
};

pub const top_level_specs = [_]TopLevelSpec{
    .{
        .kind = .help,
        .token = "help",
        .aliases = &.{ "--help", "-h" },
        .usage = "help",
        .summary = "Show this help",
    },
    .{
        .kind = .ask,
        .token = "ask",
        .usage = "ask " ++ agent_run_usage ++ " [--image PATH] [--system TEXT] [--json] [--quiet] [--prompt-permissions] [--timeout <seconds>] [--config <key=value>] [--no-save] [--no-color] [--resume <last|<id>>] [--] <prompt>",
        .summary = "Run one noninteractive request",
        .options = &ask_options,
        .details = &.{
            "The prompt may be passed as arguments or piped on stdin when no prompt args are given.",
            "Assistant output is raw Markdown on stdout.",
            "Operational progress and diagnostics are written to stderr. JSON `output` keeps accumulated assistant Markdown; `final_output` contains only the completed final response, or an empty string when absent.",
            "JSON usage sums reported main-agent input_tokens and output_tokens, including with --no-save; unreported counts are null. cache_read_tokens and cache_write_tokens appear only when the provider reports them. Nested usage and dollar spend are excluded.",
            "--system replaces only the built-in base prompt for this request; tool, skill, project, and runtime context still apply.",
            "With --prompt-permissions, JSON and quiet requests may prompt on stderr only when stdin is a TTY.",
        },
    },
    .{
        .kind = .acp,
        .token = "acp",
        .usage = acp_usage,
        .summary = "Start an ACP server over stdio",
        .options = &acp_options,
    },
    .{
        .kind = .pr,
        .token = "pr",
        .usage = "pr " ++ agent_run_usage ++ " [--] [context]",
        .summary = "Draft a pull request",
        .options = &pr_options,
        .details = &.{
            "Must run inside a git repository. The drafted PR is printed only.",
        },
    },
    .{
        .kind = .issue,
        .token = "issue",
        .usage = "issue " ++ agent_run_usage ++ " [--] [context]",
        .summary = "Draft a GitHub issue",
        .options = &issue_options,
    },
    .{
        .kind = .login,
        .token = "login",
        .usage = "login [vercel] [--api-key]",
        .summary = "Sign in to Vercel or a selected provider",
        .subcommands = &login_providers,
        .options = &login_options,
    },
    .{
        .kind = .logout,
        .token = "logout",
        .usage = "logout [vercel]",
        .summary = "Sign out of Vercel or a selected provider session",
        .subcommands = &login_providers,
    },
    .{
        .kind = .setup,
        .token = "setup",
        // Warns until it is removed.
        .hidden_from_top_level_help = true,
        .replaced_by = "fx login vercel --api-key",
        .usage = "setup",
        .summary = "Paste an AI Gateway API key (deprecated: use fx login vercel --api-key)",
    },
    .{
        .kind = .status,
        .token = "status",
        .usage = "status [--json]",
        .summary = "Show configuration and runtime information",
        .options = &.{json_option},
    },
    .{
        .kind = .permissions,
        .token = "permissions",
        .usage = "permissions [--json]",
        .summary = "Show the permission mode and rules",
        .options = &.{json_option},
        .details = &.{
            "Modes:",
            "  ask          Prompt before sensitive tool calls",
            "  auto         Apply rules, then review unresolved sensitive tool calls (default)",
            "  full-access  Disable fx permission checks",
            "",
            "Set the mode for one request with --permission-mode, or with --ask, --auto, or --full-access.",
        },
    },
    .{
        .kind = .mcp,
        .token = "mcp",
        .usage = "mcp <command> ...",
        // `fx mcp -h` is the verbs' own help (`mcp_host/verbs.zig` writeUsage).
        .summary = "Manage MCP servers",
        .subcommands = &mcp_subcommands,
    },
    .{
        .kind = .models,
        .token = "models",
        .usage = "models [--json]",
        .summary = "List available models",
        .options = &.{json_option},
    },
    .{
        .kind = .provider,
        .token = "provider",
        .usage = "provider <name>",
        .summary = "Choose the model provider used by fx",
    },
    .{
        .kind = .doctor,
        .token = "doctor",
        .usage = "doctor [--json]",
        .summary = "Run local health and preflight checks",
        .options = &.{json_option},
    },
    .{
        .kind = .teams,
        .token = "teams",
        .usage = "teams",
        .summary = "Choose the Vercel team used by AI Gateway",
    },
    .{
        .kind = .session,
        .token = "session",
        .usage = "session <last|id>|--id <id> [--json] | session recover <id>|--id <id> [--json]",
        .summary = "Inspect or recover saved sessions",
        .subcommands = &session_subcommands,
        .options = &session_options,
    },
    .{
        .kind = .sessions,
        .token = "sessions",
        .usage = "sessions [--all] [--limit <1-100>] [--cursor <cursor>] [--json] | sessions convert [--json]",
        .summary = "List saved sessions for the current workspace",
        .subcommands = &.{.{ .usage = "convert", .description = "Convert every session saved in the previous format", .options = &sessions_convert_options }},
        .options = &sessions_options,
    },
    .{
        .kind = .credits,
        .token = "credits",
        .aliases = &.{"balance"},
        .usage = "credits [--json]",
        .summary = "Show the AI Gateway credit balance",
        .options = &.{json_option},
    },
    .{
        .kind = .usage,
        .token = "usage",
        .usage = "usage [--period <today|7d|month>] [--json]",
        .summary = "Show your provider's usage and spend",
        .options = &usage_options,
        .details = &.{
            "With AI Gateway, reads its usage reports: with fx login, your spend on the team and your budget; with an API key, that key's spend.",
            "Finished days are cached under ~/.fx and fetched at most once a day.",
        },
    },
    .{
        .kind = .workspace,
        .token = "workspace",
        .usage = "workspace [list|add PATH|remove PATH|clear] [--json]",
        .summary = "Manage additional workspace directories",
        .subcommands = &workspace_subcommands,
        .options = &workspace_options,
        .details = &.{
            "Additional directories are stored for the current primary workspace.",
        },
    },
    .{
        .kind = .completion,
        .token = "completion",
        .usage = "completion bash|zsh|fish",
        .summary = "Print a shell completion script",
        .subcommands = &.{
            .{ .usage = "bash", .description = "Load it with: eval \"$(fx completion bash)\"" },
            .{ .usage = "zsh", .description = "Load it after compinit with: source <(fx completion zsh)" },
            .{ .usage = "fish", .description = "Load it with: fx completion fish | source" },
        },
        .details = &.{
            "Add the load line to ~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish to keep it in new shells.",
            "Tab completes commands, flags, setting keys after fx config get, set, and unset, and fixed flag values.",
        },
    },
    .{
        .kind = .config,
        .token = "config",
        .usage = "config [list|get <key>|set <key> <value>|unset <key>|schema [--project]] [--global|--workspace] [--show-origin] [--json]",
        .summary = "Show and change fx settings",
        .subcommands = &config_subcommands,
        .options = &config_options,
        .details = &.{
            "Values come from .fx.json, ~/.fx/settings.json, and this workspace's override in it. When a key repeats, the last line is the one fx uses.",
            "Keys are dotted, such as status_line.context. A flag or an FX_* variable can override a value for one run; fx status shows what a run uses.",
            "set and unset change plain preferences for every workspace, such as fast_mode, effort, theme, and status_line.context. Switches take true or false. Permission, model, provider, and account settings keep their own commands.",
            "schema prints a JSON Schema that editors use to complete and check ~/.fx/settings.json, and --project prints the one for .fx.json. A file whose \"$schema\" names https://fx.sh/schemas/settings.json or https://fx.sh/schemas/fx.json gets the same check.",
        },
    },
};

pub const top_level_help_default_width = command_specs.top_level_help_default_width;
pub const top_level_help_fast_buffer_bytes: usize = 32 * 1024;

pub const top_level_help_groups = [_]TopLevelHelpGroup{
    .{ .entries = &.{
        .{ .kind = .ask, .usage = "ask <prompt>" },
    } },
    .{ .entries = &.{
        .{ .kind = .pr, .usage = "pr [context]" },
        .{ .kind = .issue, .usage = "issue [context]" },
    } },
    .{ .entries = &.{
        .{ .kind = .sessions, .usage = "sessions" },
        .{ .kind = .session, .usage = "session <last|id>" },
        .{ .usage = "session recover <id>", .summary = "Copy a recoverable corrupt session" },
    } },
    .{ .entries = &.{
        .{ .kind = .login, .usage = "login [vercel] [--api-key]", .summary = "Sign in to a model provider" },
        .{ .kind = .logout, .usage = "logout [vercel]", .summary = "Sign out of a model provider" },
        .{ .kind = .provider, .usage = "provider <name>", .summary = "Choose the active model provider" },
        .{ .kind = .models, .usage = "models" },
    } },
    .{ .entries = &.{
        .{ .kind = .teams, .usage = "teams", .summary = "Choose a Vercel AI Gateway team" },
        .{ .kind = .credits, .usage = "credits|balance", .summary = "Show Vercel AI Gateway credits" },
    } },
    .{ .entries = &.{
        .{ .kind = .usage, .usage = "usage [--period <today|7d|month>]", .summary = "Show your provider's usage and spend" },
    } },
    .{ .entries = &.{
        .{ .kind = .status, .usage = "status" },
        .{ .kind = .doctor, .usage = "doctor" },
        .{ .kind = .mcp, .usage = "mcp <command> ..." },
        .{ .kind = .permissions, .usage = "permissions" },
        .{ .kind = .workspace, .usage = "workspace" },
        .{ .kind = .config, .usage = "config" },
        .{ .kind = .acp, .usage = "acp" },
        .{ .kind = .completion, .usage = "completion <shell>" },
        .{ .kind = .help, .usage = "help" },
    } },
};

/// The launch-wide flags: they go before a command, which can't take them
/// itself, as `git -C dir log` does.
pub const launch_wide_options = [_]command_specs.OptionDoc{
    .{ .flag = "--context-limit <spec>", .description = "" },
    .{ .flag = "--add-dir <path>", .description = "" },
    .{ .flag = "--no-additional-dirs", .description = "" },
};

/// The flags `fx` reads before a command, in the form the shared flag parser
/// reads. `top_level_flags` documents them in `fx --help`, and a test checks
/// that the two lists match. The usage line after a launch-flag mistake is
/// built from this list.
pub const launch_options = launch_wide_options ++ [_]command_specs.OptionDoc{
    .{ .flag = "--provider <name>", .description = "", .values = &builtin_providers },
    .{ .flag = "--provider-order <a,b,...>", .description = "" },
    .{ .flag = "--provider-strict", .description = "" },
    .{ .flag = "--no-provider-strict", .description = "" },
    .{ .flag = "--model <id>", .description = "" },
    .{ .flag = "--effort <level>", .description = "" },
    .{ .flag = "--fast", .description = "" },
    .{ .flag = "--no-fast", .description = "" },
    .{ .flag = "--ultrafast", .description = "" },
    .{ .flag = "--no-ultrafast", .description = "" },
    .{ .flag = "--permission-mode <mode>", .description = "", .values = &permission_modes },
    .{ .flag = "--ask", .description = "" },
    .{ .flag = "--auto", .description = "" },
    .{ .flag = "--full-access", .description = "" },
    .{ .flag = "--yolo", .description = "" },
};

/// `usage: fx [--context-limit <spec>] ... <command>`, from `launch_options`,
/// with each `--x` and `--no-x` pair written as `[--x|--no-x]`.
pub const launch_usage: []const u8 = blk: {
    @setEvalBranchQuota(20_000);
    var out: []const u8 = "usage: fx";
    var i: usize = 0;
    while (i < launch_options.len) : (i += 1) {
        const doc = launch_options[i];
        if (doc.hidden or doc.replacement != null) continue;
        const name = doc.flag[0 .. std.mem.findScalar(u8, doc.flag, ' ') orelse doc.flag.len];
        if (i + 1 < launch_options.len and std.mem.eql(u8, launch_options[i + 1].flag, "--no-" ++ name[2..])) {
            out = out ++ " [" ++ doc.flag ++ "|" ++ launch_options[i + 1].flag ++ "]";
            i += 1;
            continue;
        }
        out = out ++ " [" ++ doc.flag ++ "]";
    }
    break :blk out ++ " <command>\n";
};

pub const top_level_flags = [_]TopLevelFlag{
    .{
        .usage = "--context-limit <spec>",
        .description = "Set name=bytes|off; repeatable",
    },
    .{
        .usage = "--add-dir <path>",
        .description = "Add a workspace directory; repeatable",
    },
    .{
        .usage = "--no-additional-dirs",
        .description = "Ignore saved additional directories",
    },
    .{
        .usage = "--provider <name>",
        .description = "Override the model provider for this request (gateway or a configured name)",
    },
    .{
        .usage = "--provider-order <a,b,...>",
        .description = "Prefer these gateway providers in order for this request",
    },
    .{
        .usage = "--provider-strict, --no-provider-strict",
        .description = "Restrict this request to the providers in --provider-order, or clear the restriction",
    },
    .{
        .usage = "--model <id>",
        .description = "Override the model for this request",
    },
    .{
        .usage = "--effort <level>",
        .description = "Override the reasoning effort for this request",
    },
    .{
        .usage = "--fast, --no-fast",
        .description = "Turn Fast mode on or off for this request",
    },
    .{
        .usage = "--ultrafast, --no-ultrafast",
        .description = "Request Ultrafast mode on or off for this request",
    },
    .{
        .usage = "--permission-mode <mode>",
        .description = "Set the permission mode for this request: ask, auto, or full-access",
    },
    .{
        .usage = "--ask, --auto, --full-access",
        .description = "Shortcuts for each permission mode; --yolo means --full-access",
    },
    .{
        .usage = "-h, --help",
        .description = "Display this help and exit",
    },
    .{
        .usage = "-v, --version",
        .description = "Print the fx version and exit",
    },
};

pub const top_level_examples = [_]TopLevelExample{
    .{ .command = "fx ask \"Explain the changes in this repository\"", .description = "Run one request and exit" },
    .{ .command = "fx status --json", .description = "Inspect the current configuration as JSON" },
};

pub const top_level_notes = [_][]const u8{
    "Run `fx <command> --help` for command-specific usage and options.",
};

pub const top_level_resources = [_]TopLevelResource{
    .{ .label = "Learn more about fx:", .value = "https://fx.sh/docs", .link = true },
};

pub const top_level_registry = TopLevelRegistry{
    .specs = top_level_specs[0..],
    .description = "Fast, native coding agent for the terminal.",
    .interactive_hint = "fx is a command-line coding agent. Use `fx ask` to run one request, or `fx acp` to serve an editor over the Agent Client Protocol.",
    .help_groups = top_level_help_groups[0..],
    .flags = top_level_flags[0..],
    .examples = top_level_examples[0..],
    .notes = top_level_notes[0..],
    .resources = top_level_resources[0..],
};

pub fn matchesTopLevel(token: []const u8, kind: TopLevelKind) bool {
    return command_specs.matchesTopLevel(top_level_registry, token, kind);
}

pub fn renderTopLevelHelp(alloc: Allocator, columns: usize, version: []const u8) ![]u8 {
    return command_specs.renderTopLevelHelp(alloc, top_level_registry, columns, version);
}

pub fn renderTopLevelHelpWithStyle(alloc: Allocator, columns: usize, version: []const u8, style: HelpStyle) ![]u8 {
    return command_specs.renderTopLevelHelpWithStyle(alloc, top_level_registry, columns, version, style);
}

pub fn renderTopLevelCommandHelp(alloc: Allocator, kind: TopLevelKind) ![]u8 {
    return command_specs.renderTopLevelCommandHelp(alloc, top_level_registry, kind);
}

pub fn topLevelKindFromToken(token: []const u8) ?TopLevelKind {
    return command_specs.topLevelKindFromToken(top_level_registry, token);
}

pub fn topLevelUsage(kind: TopLevelKind) []const u8 {
    return command_specs.topLevelUsage(top_level_registry, kind);
}

test "fx config help names settings by their current keys" {
    const settings_keys = @import("../core/config/settings_keys.zig");
    const spec = for (top_level_specs) |spec| {
        if (spec.kind == .config) break spec;
    } else unreachable;
    var checked: usize = 0;
    for (spec.details) |line| {
        var words = std.mem.tokenizeAny(u8, line, " ,;:()");
        while (words.next()) |raw| {
            const word = std.mem.trimEnd(u8, raw, ".");
            const dot = std.mem.findScalar(u8, word, '.') orelse continue;
            const key = settings_keys.find(word[0..dot]) orelse continue;
            try std.testing.expectEqualStrings(settings_keys.currentPath(word), word);
            var known = false;
            for (key.children) |child| known = known or std.mem.eql(u8, child, word[dot + 1 ..]);
            try std.testing.expect(known);
            checked += 1;
        }
    }
    try std.testing.expect(checked > 0);
}

test "every launch flag appears in fx --help" {
    const cli_flags = @import("../core/cli/cli_flags.zig");
    outer: for (launch_options) |doc| {
        const name = cli_flags.flagName(doc);
        if (std.mem.eql(u8, name, "--yolo")) continue;
        for (top_level_flags) |flag| {
            var parts = std.mem.splitSequence(u8, flag.usage, ", ");
            while (parts.next()) |part| {
                const end = std.mem.findScalar(u8, part, ' ') orelse part.len;
                if (std.mem.eql(u8, part[0..end], name)) continue :outer;
            }
        }
        std.debug.print("{s} is parsed but missing from top_level_flags\n", .{name});
        return error.TestExpectedEqual;
    }
    // And the other way: help shows no launch flag the parser doesn't read,
    // apart from help and version, which fx reads first.
    for (top_level_flags) |flag| {
        var parts = std.mem.splitSequence(u8, flag.usage, ", ");
        part: while (parts.next()) |part| {
            const name = part[0 .. std.mem.findScalar(u8, part, ' ') orelse part.len];
            for ([_][]const u8{ "-h", "--help", "-v", "--version" }) |early| {
                if (std.mem.eql(u8, name, early)) continue :part;
            }
            for (launch_options) |doc| {
                if (std.mem.eql(u8, cli_flags.flagName(doc), name)) continue :part;
            }
            std.debug.print("{s} is in top_level_flags but the launch parser doesn't read it\n", .{name});
            return error.TestExpectedEqual;
        }
    }
}

test "the launch usage line pairs each --no- spelling with its flag" {
    try std.testing.expect(std.mem.startsWith(u8, launch_usage, "usage: fx [--context-limit <spec>] [--add-dir <path>] [--no-additional-dirs] "));
    try std.testing.expect(std.mem.find(u8, launch_usage, " [--fast|--no-fast] ") != null);
    try std.testing.expect(std.mem.endsWith(u8, launch_usage, " <command>\n"));
}
