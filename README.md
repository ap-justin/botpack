```
 ⠀⠀⠀⠀⠀⠀⣠⣾⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⠀⠀⢰⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⣠⣶⣿⣿⣷⣶⡶⣶⣶⣆⠀⠀⠀⣴⣶⣶⠆
 ⠀⠀⠀⠉⢹⣿⣿⠉⠉⠀⠘⢿⣿⣧⣀⣾⣿⡿⠃⠀             Tiny, open, embeddable, native coding agent.
 ⠀⠀⠀⠀⣼⣿⡏⠀⠀⠀⠀⠀⠻⣿⣿⣿⠟⠀⠀⠀
 ⠀⠀⠀⢀⣿⣿⠃⠀⠀⠀⠀⢠⣦⠘⢿⣿⣷⡀⠀⠀             curl -fsSL https://fx.sh/setup.sh | bash
 ⠀⠀⠀⣸⣿⡟⠀⠀⠀⠀⣰⣿⣿⠗⠀⠻⣿⣿⣄⠀
 ⠀⠀⠀⣿⣿⠇⠀⠀⠀⠾⠿⠿⠋⠀⠀⠀⠘⠿⠿⠦             ⚠ Status: Experimental. Use at your own risk.
  ⠀⣸⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⣿⣿⣿⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
```

# fx

fx is a minimal coding agent CLI that still comes with batteries included. It's one native binary written in Zig, so there is no runtime to install, and it runs the same on your laptop, in CI, or inside an agent sandbox.

fx is meant to be embedded and extended. Scripts call it with `fx ask`, and editors connect over the Agent Client Protocol (ACP). Skills, MCP servers, and your project's `AGENTS.md` add to what the agent knows and can do.

<p>
  <a href="https://vercel.com/labs#labs-products"><img alt="Vercel Labs Product" src="https://img.shields.io/badge/LABS-PRODUCT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://github.com/vercel-labs/fx/releases/latest"><img alt="fx CLI release" src="https://img.shields.io/github/v/release/vercel-labs/fx.svg?style=for-the-badge&amp;labelColor=000000&amp;label=release" height="28"></a>
  <a href="https://github.com/vercel-labs/fx/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/vercel-labs/fx.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
</p>

## Features

- **Small and fast**: CI fails a pull request if any benchmarked command, such as `fx help` or `fx status --json`, takes longer than 2 ms on Linux ([benchmarks](benchmarks/)). Stable releases for Apple silicon must also fit under a fixed size limit.
- **Built-in tools**: fx finds, reads, and edits files, runs shell commands, searches the web and reads URLs, and delegates work to subagents. A development server or file watcher can keep running while it works ([tools](https://fx.sh/docs/capabilities/tools)).
- **Model choice**: sign in to Vercel AI Gateway, or connect an OpenAI-compatible Chat Completions endpoint such as Ollama or OpenRouter ([custom model connections](https://fx.sh/docs/configure-fx/custom-model-connections)).
- **Your own shell**: commands run in your login shell, with your aliases, functions, and `PATH`. fx runs your startup files once and reuses the result until one of them changes, so a slow `.zshrc` doesn't slow down every command. Commands also receive `AI_AGENT=fx` in their environment, so development tools can detect fx.
- **Permissions**: the default `auto` mode runs routine work, such as editing project files and running tests, without asking. Anything else goes first to a model that checks the exact action for prompt injection or malicious behavior, and fx holds the action if the check finds a problem. Switch to `ask` to approve each action yourself, or to `full-access` to turn the checks off ([permissions](https://fx.sh/docs/configure-fx/permissions)).
- **Sessions**: fx saves your conversations under `~/.fx/sessions/`, and `fx ask --resume` continues a saved session. When a conversation fills the model's context, fx compacts older turns but keeps their full text on disk, where the agent can look it up ([sessions](https://fx.sh/docs/using-fx/sessions)).

## Install

```bash
curl -fsSL https://fx.sh/setup.sh | bash
```

fx runs on macOS and Linux, on x86_64 and arm64. The installer puts it in `~/.local/bin`. [CHANGELOG.md](CHANGELOG.md) lists what changed in each release. You can also [try fx in your browser](https://fx.sh/try) without installing anything.

## Quick start

Sign in with one of these:

```bash
fx login                    # Vercel AI Gateway
fx login vercel --api-key   # AI Gateway API key
```

Then open a project and send a request with `fx ask`. If something doesn't work, run `fx doctor` to check your setup. Add `--json` when a script needs to read the result:

```bash
fx ask "explain the changes in this repository"
fx ask --json "summarize the failing tests" | jq -r .final_output
```

## Embed and extend

| Surface | Use it for |
| --- | --- |
| <code>fx&nbsp;ask</code> | One request from a script or CI job. `--json` returns structured output, and `--resume` continues a saved session. |
| <code>fx&nbsp;acp</code> | Editors and other [Agent Client Protocol](https://fx.sh/docs/using-fx/acp) clients, over stdio. |


The CLI also picks up these extensions:

- **Skills**: fx loads skills from `.fx/skills` and `~/.fx/skills`, and from the folders other agents use, such as `.claude/skills` and `.agents/skills`. The model sees each skill's name and description and reads the full instructions only when it needs them, so installed skills take little room in the context ([skills](https://fx.sh/docs/capabilities/skills)).
- **MCP servers**: `fx mcp` manages servers from your terminal. A server's tool schemas load when the model looks for them ([MCP](https://fx.sh/docs/capabilities/mcp)).
- **Project instructions**: fx follows the `AGENTS.md` in your project, nested `AGENTS.md` files for the directories they cover, and `~/.fx/AGENTS.md` for your own instructions across projects ([project instructions](https://fx.sh/docs/configure-fx/project-instructions)).

## Documentation

The manual at [fx.sh/docs](https://fx.sh/docs) covers models, permissions, configuration, skills, MCP, sessions, and every CLI command.

## For coding agents

To learn fx, read the manual as Markdown. [fx.sh/llms.txt](https://fx.sh/llms.txt) indexes every page, [fx.sh/llms-full.txt](https://fx.sh/llms-full.txt) puts the whole manual in one file, and adding `.md` to any docs URL returns that page as Markdown. For the flags of the installed version, run `fx <command> --help`.

To run fx from your own tools, use `fx ask`. It takes the prompt as arguments or on stdin, writes its result to stdout and progress and diagnostics to stderr, and exits with a nonzero status when the request fails. With `--json`, the final answer is in `final_output`.

To inspect a user's setup, run `fx status --json` for configuration and runtime information, or `fx doctor --json` for local health checks. Neither changes the setup.

`fx ask` uses the user's saved permission mode, which is `auto` unless they changed it. Pass `--full-access` only when the user asks for it, because it turns off fx's permission checks.

To change fx itself, read [AGENTS.md](AGENTS.md) first, then build and verify the change as described in [Contributing](#contributing).

## Feedback

[Open an issue](https://github.com/vercel-labs/fx/issues/new/choose) to report a problem or share feedback.

## Contributing

You need [Zig 0.17.0](https://ziglang.org/download/) to build fx:

```bash
git clone https://github.com/vercel-labs/fx.git
cd fx
zig build
./zig-out/bin/fx
```

Test your changes with the freshly built `./zig-out/bin/fx`, because a bare `fx` may be an older copy on your `PATH`.

`zig build test` runs the unit tests, which sit next to the code they cover. The end-to-end tests in [`tests/e2e/`](tests/e2e) drive the built binary and need [Bun](https://bun.sh).

The source is laid out like this:

```text
fx/
├── src/
│   ├── main.zig     entry point that wires everything together
│   ├── core/        agent loop, sessions, config, permissions, MCP, skills
│   ├── builtins/    built-in tool specs, providers, and the system prompt
│   ├── tools/       built-in tools: files, shell, web, skills, subagents
│   ├── gateway/     model provider transport
│   ├── mcp/         MCP engine
│   └── acp/         Agent Client Protocol server
├── tests/           end-to-end tests and model evals
└── benchmarks/      startup, memory, and latency benchmarks
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. It covers verification, CI, and PR labels. If a coding agent is helping you, point it at [For coding agents](#for-coding-agents).

## Security

Report vulnerabilities through the [contact page](https://fx.sh/contact) instead of a public issue.

## License

[Apache-2.0](LICENSE). Third-party licenses and attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Credits

Interface sounds by [cuelume](https://github.com/Danilaa1/cuelume).
