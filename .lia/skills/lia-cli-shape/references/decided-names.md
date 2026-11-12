# Decided names

Names the maintainers already settled. Reuse them; don't add another spelling. "Planned" means not built yet: design toward it, but don't tell users to run it.

## Resume

| Spelling | Opens | Status |
|---|---|---|
| `lia ask --resume <last\|<id>>` | `last` opens the newest saved session, including ones `lia ask` created, and an ID opens that one | Keep |
| `lia ask --resume-id <id>` | A duplicate of the above | Removed. Fails with exit 2 and names `--resume <id>` |

## Permission mode

| Surface | Name |
|---|---|
| Setting | `permission_mode`: `ask`, `auto`, or `full-access` (legacy `yolo` is read until lia 0.2.0, never written) |
| Flag | `--permission-mode <mode>`, with aliases `--ask`, `--auto`, `--full-access`, `--yolo` |
| Env var | `LIA_PERMISSION_MODE` |
| Read-only view | `lia permissions` |

## Scopes

| Word | Means |
|---|---|
| `--global` | The profile, `~/.lia/settings.json` |
| `--workspace` | This folder's entry in the profile |
| `--project` | A committed file in the repo, only for commands that write one (`lia mcp` and `.mcp.json`) |

`lia mcp --profile` still works as `--global`; it warns and stops working in lia 0.2.0, and lia always shows the new word.

## Settings and their surfaces

| Concept | Name |
|---|---|
| Settings command | `lia config list\|get\|set\|unset\|schema`; `--global`, `--workspace` (list and get), `--show-origin` |
| Generic per-run override | `lia ask --config key=value`, with the keys `lia config set` takes |
| Sound | `sound.turn_end`, `sound.attention_required`, `sound.max` (the older `notifications.*` is read until lia 0.2.0); `LIA_SOUND` is a preset for the group |
| Experiments | `experimental.<name>`; none today |
| Home | `LIA_HOME` (default `~/.lia`) |
| Test hooks | `LIA_TEST_*` |
| Save a default model | Edit `~/.lia/settings.json`; `lia config set` refuses the model keys and points there, and `--model` sets one for a run |
| User aliases | `alias.<name>` (planned) |

## Accounts

| Concept | Name |
|---|---|
| Sign in, including pasting an AI Gateway key | `lia login [vercel]` |
| Paste an AI Gateway API key | `lia login vercel --api-key`. `lia setup` warns, stops working in lia 0.2.0, and is hidden from help |
| Choose the active provider | `lia provider <name>` |

## Other

| Concept | Name |
|---|---|
| Shell completion | `lia completion bash\|zsh\|fish` |
| Settings JSON Schema | `lia config schema [--project]` |
| MCP servers | `lia mcp` (stays the command) |
| Usage and spend | `lia usage` |
| Exit codes | 0 success, 1 failure, 2 usage error |
| Run one request and exit | `lia ask "<prompt>"`; `-p` and `--print` only point to it |
| Versioned JSON | `--json=v2` when a shape must change |
