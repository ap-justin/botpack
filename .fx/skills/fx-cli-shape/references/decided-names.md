# Decided names

Names the maintainers already settled. Reuse them; don't add another spelling. "Planned" means not built yet: design toward it, but don't tell users to run it.

## Resume

| Spelling | Opens | Status |
|---|---|---|
| `fx ask --resume <last\|<id>>` | `last` opens the newest saved session, including ones `fx ask` created, and an ID opens that one | Keep |
| `fx ask --resume-id <id>` | A duplicate of the above | Removed. Fails with exit 2 and names `--resume <id>` |

## Permission mode

| Surface | Name |
|---|---|
| Setting | `permission_mode`: `ask`, `auto`, or `full-access` (legacy `yolo` is read until fx 0.0.18, never written) |
| Flag | `--permission-mode <mode>`, with aliases `--ask`, `--auto`, `--full-access`, `--yolo` |
| Env var | `FX_PERMISSION_MODE` |
| Read-only view | `fx permissions` |

## Scopes

| Word | Means |
|---|---|
| `--global` | The profile, `~/.fx/settings.json` |
| `--workspace` | This folder's entry in the profile |
| `--project` | A committed file in the repo, only for commands that write one (`fx mcp` and `.mcp.json`) |

`fx mcp --profile` still works as `--global`; it warns and stops working in fx 0.0.18, and fx always shows the new word.

## Settings and their surfaces

| Concept | Name |
|---|---|
| Settings command | `fx config list\|get\|set\|unset\|schema`; `--global`, `--workspace` (list and get), `--show-origin` |
| Generic per-run override | `fx ask --config key=value`, with the keys `fx config set` takes |
| Sound | `sound.turn_end`, `sound.attention_required`, `sound.max` (the older `notifications.*` is read until fx 0.0.18); `FX_SOUND` is a preset for the group |
| Experiments | `experimental.<name>`; none today |
| Home | `FX_HOME` (default `~/.fx`) |
| Test hooks | `FX_TEST_*` |
| Save a default model | Edit `~/.fx/settings.json`; `fx config set` refuses the model keys and points there, and `--model` sets one for a run |
| User aliases | `alias.<name>` (planned) |

## Accounts

| Concept | Name |
|---|---|
| Sign in, including pasting an AI Gateway key | `fx login [vercel]` |
| Paste an AI Gateway API key | `fx login vercel --api-key`. `fx setup` warns, stops working in fx 0.0.18, and is hidden from help |
| Choose the active provider | `fx provider <name>` |

## Other

| Concept | Name |
|---|---|
| Shell completion | `fx completion bash\|zsh\|fish` |
| Settings JSON Schema | `fx config schema [--project]`, served at `https://fx.sh/schemas/settings.json` and `https://fx.sh/schemas/fx.json` |
| MCP servers | `fx mcp` (stays the command) |
| Usage and spend | `fx usage` |
| Exit codes | 0 success, 1 failure, 2 usage error |
| Run one request and exit | `fx ask "<prompt>"`; `-p` and `--print` only point to it |
| Versioned JSON | `--json=v2` when a shape must change |
