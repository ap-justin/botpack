# lia control-surface rules

The full rules behind SKILL.md, by mechanism. Each rule says whether the code follows it today or whether it describes the target. Design new work toward the target. Never present a target piece as if it already exists.

## Contents

1. [Mechanisms](#mechanisms)
2. [Names](#names)
3. [Precedence](#precedence)
4. [Commands](#commands)
5. [Flags](#flags)
6. [Settings](#settings)
7. [Env vars](#env-vars)
8. [Slash commands](#slash-commands)
9. [Output, errors, and exit codes](#output-errors-and-exit-codes)
10. [Experiments](#experiments)
11. [Stability and deprecation](#stability-and-deprecation)
12. [One source of truth](#one-source-of-truth)

## Mechanisms

| Mechanism | Job | Lasts for | Example |
|---|---|---|---|
| Subcommand | An action | One run | `lia ask`, `lia workspace add` |
| Argument | What the action works on | One run | `lia session <id>` |
| Global flag | Shape the whole launch, before the subcommand | One run | `lia --add-dir ../lib ask ...` |
| Command flag | Shape this command's run | One run | `lia ask --model x` |
| Profile setting | A personal standing preference | Until changed | `~/.lia/settings.json` |
| Profile workspace entry | A personal preference for one folder | Until changed | `workspaces["<path>"]` in the profile |
| Project setting | A team default, untrusted | The repo's life | `.lia.json` |
| Env var | Context from CI, wrappers, terminals, diagnostics, tests | The process and its children | `LIA_TRACE=1` |
| Slash command | An action inside a running session | The session, or saved | `/model x` |
| State | Data lia writes for itself | Managed by lia | `~/.lia/sessions/` |
| Secret | Credentials | Managed separately | Keychain, `AI_GATEWAY_API_KEY` |
| Build option | Compiled-in features | The binary | `zig build -D...` |

## Names

- One concept has one name. Each surface writes it in its own case:

  | Surface | Case | Example |
  |---|---|---|
  | Setting key and JSON field | snake_case | `permission_mode` |
  | Flag | kebab-case | `--permission-mode` |
  | Env var | `LIA_` plus upper snake case | `LIA_PERMISSION_MODE` |
  | Slash command | `/` plus the setting or group name | `/permissions` |
  | ACP config options | ACP's own ids, each named in `run_options` | `mode` for `permission_mode` |

- Values use the same words everywhere, in storage too. Permission mode is `ask`, `auto`, or `full-access`: lia saves and prints `full-access` and reads `yolo` until 0.0.18. ACP's mode `_meta` keeps `yolo` because ACP clients may read it.
- Boolean env values accept `1`/`0`, `true`/`false`, `on`/`off`, and `yes`/`no`, trimmed and case-insensitive.
- The camelCase keys `enabledMcpjsonServers`, `disabledMcpjsonServers`, and `enableAllProjectMcpServers` keep the spelling other coding agents' project files already use, so the same files work with lia. To rename a key, keep the older name in `settings_keys.zig` with `renamed_to`: the parser reads both with the current one winning, saving moves the old value, `lia config` accepts both spellings, and `lia doctor` reports the older name, alone or beside the current one, with the release that drops it.

## Precedence

Highest first:

1. Managed by an administrator. Reserved; not built yet.
2. A flag on this command.
3. An env var.
4. The profile's entry for this folder, `workspaces["<path>"]`.
5. The profile, `~/.lia/settings.json`.
6. The project's `.lia.json`, project-safe keys only.
7. The built-in default.

Run flags and env vars never save; setter commands do (see Flags). Every effective value reports its layer: `lia config list --show-origin` shows each file value and, last, each documented `LIA_*` setting override that is set, as `env:LIA_NAME`. A new `LIA_*` setting override is applied where its setting is resolved: `resolveSettings` in `src/core/app/app_lifecycle.zig` for run values, or `config_runtime.applyEnvSettingOverrides` for a merged setting, which runs again after `lia ask --config` so the variable keeps beating it. List it in `src/core/config/env_settings.zig` too, which labels it `env:LIA_NAME` in `lia config --show-origin`.

## Commands

- A command is a verb (`lia ask`, `lia login`) or a noun plus a verb (`lia workspace add`, `lia session recover`).
- Plain `lia` with one argument that isn't a command reads it as a first prompt, as other coding agents' CLIs do: `lia "fix the login bug"`. This build has no interactive session, so it exits 1 and points to `lia ask` and `lia acp`. Several unquoted words fail and say to add quotes, and a word one or two edits from a command name, such as `stauts`, gets a suggestion instead. So every new command name is also a word lia no longer reads as a prompt; choose names people wouldn't type as a whole prompt.
- Group nouns are singular. Plural forms that already exist stay as aliases (`lia sessions`). The target adds `lia session list` as the full form.
- A command that only shows things never changes anything. A setter command, whose whole job is to change a setting, may save: `lia provider gateway`, `lia teams`.
- Existing aliases stay: `credits`/`balance`, `/credits`/`/balance`, `/usage`/`/cost`, `/quit`/`/exit`, `/image`/`/img`, `lia sessions`.
- User aliases are planned as `alias.<name>` settings that work as `lia <name>` and `/<name>`. An alias never shadows a built-in command.
- `lia foo` never runs an `lia-foo` program from `PATH`. Skills and MCP are the extension points.
- A hidden command is either internal, and labeled so in its spec, or deprecated. `lia replay` is hidden and labeled as a developer tool in its spec. A command that does nothing yet is removed rather than hidden, and a removed slash command keeps a line in the router's `parse rejects removed slash commands` test.
- A new top-level command needs a maintainer's explicit approval.

## Flags

- Long flags are kebab-case. Short flags are scarce and keep one meaning: `-h` help, `-v` version. A short flag means the same as its long form.
- `--x value` and `--x=value` both work on every command. The shared parser in `src/core/cli/cli_flags.zig` provides both.
- A boolean pairs `--x` with `--no-x`.
- When a flag repeats or conflicts, the last one wins, on every command. `--fast --no-fast` means Fast mode off; `--fast --ultrafast` means Ultrafast mode. Every command follows this.
- An enum is one flag that takes the value: `--permission-mode <ask|auto|full-access>`. Shortcut aliases stay: `--auto`, `--full-access`, `--yolo`, plus `--ask`. Every command that runs the agent takes the whole set.
- Flags people bring from other agents get a pointer, not an alias: `lia -p` and `lia --print` fail with exit 2 and say to use `lia ask "<prompt>"`.
- No flag carries a value in its name. `--resume-<id>` was removed and fails with a hint naming `--resume <id>`.
- A flag that shapes a run affects only that run and never saves anything. A setter command saves what it changes, and its flags name what to save. A setter should print one line naming the value and the file, as `lia config set fast_mode on` prints `fast_mode set to true in ~/.lia/settings.json.` A bad value names itself: `lia config: invalid value for fast_mode: maybe (use true or false)`.
- Agent-run flags form one shared set: `--model`, `--provider`, `--effort`, `--fast`/`--no-fast`, `--ultrafast`/`--no-ultrafast`, `--provider-order`, `--provider-strict`/`--no-provider-strict`, and `--permission-mode` with its shortcuts. Every command that runs the agent accepts the whole set after the subcommand: `lia ask`, `lia acp`, `lia pr`, `lia issue`. `commands.zig` generates the options from one list (`agentRunOptions`), and `agent_run_flags.zig` parses them, so a new agent-run flag is added once. `lia acp` takes the set without `--provider-order` and `--provider-strict`: ACP sessions don't apply gateway provider routing, so the flags would do nothing.
- Before the subcommand go only launch-wide flags: `--add-dir`, `--no-additional-dirs`, `--context-limit`. Agent-run flags before a subcommand stay an error whose message shows where they go: `lia: put agent-run flags after the command, as in lia ask --model <id>`. A launch-wide flag after the command gets the reverse hint: `lia ask: unknown flag --add-dir; it goes before the command: lia --add-dir <path> ask`.
- An unknown or invalid flag fails with a message naming it. Every accepted flag appears in help unless its `OptionDoc` is `hidden`, as a deprecated spelling is: the parser reads the same list help renders, and CI's `scripts/check_cli_shape.py` fails a flag compared by hand anywhere in `src/`.

## Settings

- Keys are snake_case; nested groups are fine (`sound.turn_end`).
- `.lia.json` accepts only project-safe keys. Today they are `context`, `max_agent_steps`, `max_tool_result_bytes`, `provider_order`, and `provider_strict`, enforced by `parseProjectSafeFields` in `src/core/config/config_runtime.zig`. A new project-safe key needs a maintainer's approval, because anyone who can commit to a repo controls that file.
- Every settings key goes in `src/core/config/settings_keys.zig`, the list of keys lia knows, marked `.profile` or `.project_safe`, with its `kind`, a one-line `description`, and its allowed `values` or bounds when lia accepts a fixed set. A project file that sets a `.profile` key is ignored with a warning, and `lia doctor` reports keys missing from the list, with the closest known one. A retired key stays listed as `.retired` so it is ignored without a report, and an older form lia still reads gets `superseded_by`.
- `lia config schema` builds the JSON Schema for `settings.json`, and `--project` the one for `.lia.json`, from that list. Unit tests fail when a key's kind, values, bounds, or placement disagree with what the parser accepts, or when `lia config set` writes a different type.
- Scope words are `--global` (the profile), `--workspace` (this folder's entry in the profile), and `--project` only for commands that write a committed file, such as `lia mcp` with `.mcp.json`. `lia mcp add` and `remove` take `--global`, the default, or `--project` for `.mcp.json`. The older `lia mcp --profile` still works until lia 0.0.18, with a warning; help, completion, and messages show only the new words.
- `lia config list` shows the values set in `.lia.json`, `~/.lia/settings.json`, this workspace's override in it, and the documented `LIA_*` setting overrides, in git's `key=value` format with dotted keys, lowest precedence first, as `git config --list` shows each file. `lia config get <key>` without a scope reports the value a run uses, defaults included, through the same `resolveSettings` the session uses, and prints the warnings `lia status` does. A variable lia ignores, such as `LIA_MAX_AGENT_STEPS=many`, isn't shown. `--show-origin` puts the origin first, or `default`; `--global` and `--workspace` narrow the scope to one file's values. `get` of a key with no value prints nothing and exits 1, and with `--json` reports `ConfigKeyNotSet`. `lia config set <key> <value>` and `lia config unset <key>` change plain preferences at the top level of `~/.lia/settings.json` and print one line on stdout naming the key, the value, and the file, like every setter: `fast_mode set to true in ~/.lia/settings.json.` They refuse `--workspace` and remove the key's copies from workspace overrides, because lia treats preferences there as legacy and the change must take effect. A value may start with a dash, as `-5` does; the value check rejects it, not the flag parser. They also refuse maps and the security and account keys, pointing to the command that owns each: an agent can run `lia config` through its shell tool, so it must not change `permission_mode` or `review_model` that way. `lia config` never writes committed files and never handles credentials. Unknown keys are ignored at startup, reported by `lia doctor` and `lia config list`, and rejected by `lia config get` and `set`.
- Slash commands that change a setting save to the profile and name the file in their confirmation.
- `lia mcp` stays the command for MCP servers.

## Env vars

Each env var has one job and that job's namespace:

| Job | Namespace | Example |
|---|---|---|
| Override a setting for one process | `LIA_<SETTING>`, same name and values as the setting | `LIA_MODEL` |
| CI credentials | The provider's own name | `AI_GATEWAY_API_KEY` |
| Location of lia's home | `LIA_HOME` | `LIA_HOME=/tmp/lia-test` |
| Integration with the surroundings | `LIA_<INTEGRATION>` | `LIA_HERDR=0`, `LIA_NO_OPEN_BROWSER=1` |
| Diagnostics | `LIA_TRACE*`, `LIA_RECORD*`, `LIA_DEBUG_*` | `LIA_TRACE=1` |
| Test hooks | `LIA_TEST_*` | Every test hook uses it, and the shape check rejects a test hook without it or another variable with it |
| Unix standards | As defined | `NO_COLOR`, `TERM`, `HOME` |

- A setting gets a named env override only when CI jobs or wrapper scripts need it for a whole process tree. For one `lia ask` request, `--config key=value` overrides any key `lia config set` takes, with the same checks. Like `git -c`, it's the top settings layer: it beats every settings file, while dedicated flags such as `--fast` and `LIA_*` variables still beat it. It repeats, the last value for a key wins, and it never saves. Interactive sessions don't take it, because they re-read settings during the session; they change settings with `/settings` and slash commands.
- An override uses the setting's name: `max_agent_steps` becomes `LIA_MAX_AGENT_STEPS`, never an invented short name.
- No unprefixed names except Unix standards and third-party integrations' own variables, which are listed under `external_env` in `scripts/cli_shape_registry.json`.
- Every `LIA_*` name in `src/` is registered in `scripts/cli_shape_registry.json` with its job and stability. CI's `python3 -m scripts.check_cli_shape` fails on an unregistered or stale name, and on an override that `lia config list` reports, from `env_settings.collect`, that isn't `stable`.
- An env var shapes context. It never changes what a command does.
- `LIA_HOME` is lia's folder itself, an absolute path that replaces `~/.lia` for everything lia keeps there; the OS keychain stays shared. `main` checks it once at startup through `profile_paths.useFxHome`. It can't be the home folder itself, because lia keeps its folder private to the user. With `HOME` unset, its parent serves as the home folder, and `main` creates its missing parent folders at startup, before I/O is set up. Code reaches the folder only through `src/core/shared/profile_paths.zig`: `rootPath` and the named helpers build paths, and code that opens the folder without following symlinks opens `rootParent(home)` and then `rootName()`. Never join `HOME` with `.lia`. A message that names a file there writes `~/.lia/...` through `displayText`, or formats `displayRoot()`, so it says `$LIA_HOME/...` when the variable is set. Help text documents the default and keeps `~/.lia`.
- Respect `NO_COLOR` and `TERM=dumb` on every output path, through `src/core/shared/terminal_env.zig` (`NO_COLOR` counts only when non-empty). Help and `lia ask` drop color for either. The interactive session drops color for `NO_COLOR` by turning off `engine.colors_enabled` before startup, so cells never take a color while bold, dim, and reverse stay; it refuses `TERM=dumb` with a message that points to `lia ask`. New output that styles text should go through the terminal engine, or check `terminal_env.colorDisabled()` itself.

## Slash commands

- A slash command that performs an action uses the CLI command's name and verbs: `/workspace add` matches `lia workspace add`.
- A slash command that changes a setting uses the setting's name and values: `/fast on` writes `fast_mode`. This follows vim, where `:set number` matches `set number` in `.vimrc`. `/model` is a picker for model and effort, which is an action.
- A toggle accepts explicit values as well as no argument: `/fast [on|off]`, like `/ultrafast [on|off|status]`.

## Output, errors, and exit codes

- Results go to stdout; progress and diagnostics go to stderr.
- Every command that prints data accepts `--json`. Failures share one shape: `{"kind": ..., "error": ..., "code": ...}`, as `lia session last --json` already does. That includes usage errors: when `--json` is anywhere in the arguments, a bad flag or extra argument prints that shape on stdout with exit 2 and nothing on stderr, and its `error` is the same text the plain error names. `writeUsageOrJsonError` in `cli_surface.zig` does this, from `flagProblem`.
- JSON fields are only added. If a shape must change, the new shape is opt-in behind a versioned flag such as `--json=v2`, following git's `--porcelain=v2`. Don't add a `schema_version` field. Commands such as `lia status`, `lia sessions`, and `lia session` already name their JSON shape with `kind`.
- Exit codes: 0 for success, 1 when the work fails, 2 when the command line is wrong. `output_contracts.usage_exit_code` is the 2.
- An error says what happened, which input caused it, and what to do, and suggests the closest match for a typo. A flag error names the flag and the closest documented flag, such as `lia status: unknown flag --jsno (did you mean --json?)`. A mistyped command, subcommand, or global flag gets the same: `lia stauts` suggests `status`, `lia mcp lsit` suggests `list`, and `lia --modle` suggests `--model`. A number outside the range its placeholder names, such as `--limit <1-100>`, says the range. A command that reads words, such as `lia config set`, says which word is missing or wrong.
- lia never prompts without a terminal. It fails with a message naming the flag that avoids the prompt.

## Experiments

- Each experiment is a setting under `experimental`, off by default. lia has none today.
- Users change it like any setting: `lia config set experimental.<name> true`, `lia ask --config experimental.<name>=true` for one run, the settings file, or an Experimental section in `/settings` (planned). The first one adds an `experimental` group to `settings_keys.zig` with the key as its child, the key to the `lia config` writable list and `resolved_keys`, and a profile-only parser for the group in `config_runtime.zig`.
- No experiment gets its own flag or env var. Messages that need the experiment name the setting.
- Experiments are profile-only. A project's `.lia.json` can't turn one on.

## Stability and deprecation

- Every public control carries one label: stable, experimental, deprecated, or internal.
- During the cleanup, stable means `lia ask --json` fields, ACP behavior, and stable env vars. Everything else may change with a changelog entry. From 1.0, everything documented in `--help` is stable.
- A renamed or removed stable control keeps working with a warning that names its replacement for at least two releases and at least 30 days, whichever is later.
- The warning also names the release that drops the old spelling: `old_spelling_removal` in `src/core/slash_commands/command_specs.zig`, 0.0.18 for the current set. Pick a release after the first one that ships the warning, so every user sees it at least once: the current set first ships in 0.0.17. Build the text from `deprecated_until`. The shape check fails once lia's version in `src/main.zig` reaches that release, so the old spellings come out on time.

## One source of truth

- The command specs in `src/builtins/commands.zig` drive help, parsing, and `lia completion`: each command's `OptionDoc` list is what `cli_flags.Parser` reads, and `src/core/cli/completion.zig` builds the bash, zsh, and fish scripts from the same lists. A command's words, such as `config set` or `login vercel`, go in its spec's `subcommands`, which help prints under "Commands:"; a `<key>` right after the word makes completion offer setting keys, and `settable_key` narrows them to the ones `lia config set` changes. A word offers only its own `options` and `--help`, never its parent's, so declare the flags it takes on it. A flag with fixed values writes them in its placeholder (`--period <today|7d|month>`) or lists them in `values` (`--permission-mode <mode>`). Never list a subcommand as an `OptionDoc`, and never add completion data anywhere else.
- The settings list, `src/core/config/settings_keys.zig`, holds each key's placement, kind, values, and description, and `lia completion <shell>` and `lia config schema` read it.
- Each option a run can set, such as the model or Fast mode, has one row in `run_options` in `scripts/cli_shape_registry.json` naming its agent-run flag, setting, `LIA_*` variable, and ACP config option. Names may differ by surface, as ACP's `mode` does for `--permission-mode`, but each is written there. The shape check fails when ACP offers or accepts a config option that no row names, or when a row names something that doesn't exist. Add the row in the same change as the option.
- The global launch flags live once in `launch_options`, starting with `launch_wide_options`; `lia --help` documents them in `top_level_flags`, and a test checks the two match both ways.
- CI fails when code reads an `LIA_*` env var, compares a flag by hand, or parses a setting that the registries don't list.
- A new top-level command, a new stable env var, or a new project-safe setting needs a maintainer's explicit approval in the PR.
