# lia

lia is a fork of [fx](https://github.com/vercel-labs/fx), the native coding agent from Vercel Labs, tuned to run as a headless agent behind an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) client. It's one binary written in Zig, with no runtime to install.

Compared with fx, lia:

- connects to MCP servers that sit behind a sign-in proxy, falling back to the older MCP handshake when a proxy drops a header the newer one needs;
- runs an MCP tool called by its server-qualified name, such as `github.create_issue`;
- keeps its own context notices out of the agent's replies over ACP, and sends each MCP server's instructions once instead of once per tool;
- keeps the prompt cache stable across turns and after tools are loaded;
- drops what a headless agent doesn't use: the terminal UI, ChatGPT and Grok sign-in, the Node and WebAssembly SDKs, the Slack install, and auto-upgrade.

The command is still `fx`, and settings still live in `~/.fx`; both will be renamed later.

## Install

lia ships Linux builds for x86_64 and arm64 on [GitHub Releases](https://github.com/ap-justin/lia/releases), each with a SHA-256 checksum file. Until the first release is out, build it from source (see [Contributing](#contributing)).

## Quick start

Sign in to Vercel AI Gateway:

```bash
fx login                    # Vercel AI Gateway
fx login vercel --api-key   # AI Gateway API key
```

Then run it the way you need:

| Command | Use it for |
| --- | --- |
| <code>fx&nbsp;acp</code> | ACP clients, over stdio. This is how lia is meant to run. |
| <code>fx&nbsp;ask</code> | One request from a script or CI job. `--json` returns structured output, and `--resume` continues a saved session. |
| <code>fx&nbsp;mcp</code> | Managing MCP servers. A server's tool schemas load when the model looks for them. |

If something doesn't work, run `fx doctor` to check your setup, or `fx status --json` to see the configuration a run uses.

Skills, MCP servers, and your project's `AGENTS.md` work as they do in fx. fx's manual at [fx.sh/docs](https://fx.sh/docs) covers them; where lia differs, this README wins.

## Contributing

You need [Zig 0.17.0](https://ziglang.org/download/) to build lia:

```bash
git clone https://github.com/ap-justin/lia.git
cd lia
zig build
./zig-out/bin/fx --version
```

Test your changes with the freshly built `./zig-out/bin/fx`, because a bare `fx` may be another copy on your `PATH`.

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

Report problems in [lia's issues](https://github.com/ap-justin/lia/issues). A problem that also happens in fx belongs [upstream](https://github.com/vercel-labs/fx/issues).

## License

[Apache-2.0](LICENSE), like fx. lia keeps fx's license and notices; third-party licenses and attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
