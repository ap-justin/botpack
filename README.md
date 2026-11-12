# lia

lia is a native coding agent that runs headless behind an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) client. It's one binary written in Zig, with no runtime to install.

## Install

lia ships Linux builds for x86_64 and arm64 on [GitHub Releases](https://github.com/ap-justin/lia/releases), each with a SHA-256 checksum file. Until the first release is out, build it from source (see [Contributing](#contributing)).

## Quick start

Sign in to Vercel AI Gateway:

```bash
lia login                    # Vercel AI Gateway
lia login vercel --api-key   # AI Gateway API key
```

Then run it the way you need:

| Command | Use it for |
| --- | --- |
| <code>lia&nbsp;acp</code> | ACP clients, over stdio. This is how lia is meant to run. |
| <code>lia&nbsp;ask</code> | One request from a script or CI job. `--json` returns structured output, and `--resume` continues a saved session. |
| <code>lia&nbsp;mcp</code> | Managing MCP servers. A server's tool schemas load when the model looks for them. |

If something doesn't work, run `lia doctor` to check your setup, or `lia status --json` to see the configuration a run uses.

lia loads skills from `.lia/skills` and `~/.lia/skills`, and from the folders other agents use, such as `.claude/skills` and `.agents/skills`. It follows your project's `AGENTS.md`, and `~/.lia/AGENTS.md` for your own instructions. Settings live in `~/.lia/settings.json`.

## Contributing

You need [Zig 0.17.0](https://ziglang.org/download/) to build lia:

```bash
git clone https://github.com/ap-justin/lia.git
cd lia
zig build
./zig-out/bin/lia --version
```

Test your changes with the freshly built `./zig-out/bin/lia`, because a bare `lia` may be another copy on your `PATH`.

`zig build test` runs the unit tests, which sit next to the code they cover. The end-to-end tests in [`tests/e2e/`](tests/e2e) drive the built binary and need [Bun](https://bun.sh).

The source is laid out like this:

```text
lia/
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

Coding agents should read [AGENTS.md](AGENTS.md) before changing lia. [CONTRIBUTING.md](CONTRIBUTING.md) covers verification and CI.

Report problems in [lia's issues](https://github.com/ap-justin/lia/issues).

## License

[Apache-2.0](LICENSE). lia is based on [fx](https://github.com/vercel-labs/fx) by Vercel Labs. Third-party licenses and attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
