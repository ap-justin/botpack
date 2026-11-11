Code style, architecture boundaries and the rest of the conventions live in `AGENTS.md`; this file adds only the team's routing.

<!-- kru v0.176.0 · derived 2026-11-08 · `skills/setup/SKILL.md` to re-derive -->
Load **`skills/lead/SKILL.md`** before building, reviewing, or dispatching a seat — it carries how the team works.

- **zig** → `kru:zig-developer` owns `src/` — `build.zig`, `build.zig.zon` (Zig 0.17.0, no package dependencies)
- **tests** → `kru:test-writer` owns `tests/` — Bun suites in `tests/e2e`, `tests/evals` and the TLA+ models and drivers in `tests/tla`
- **skills** → `kru:zig` for all of `src/`; `kru:acp` for `src/acp` (hand-written `session/*` handling); `kru:mcp` for `src/mcp` and `src/core/mcp_host`; `claude-api` for prompt caching in `src/gateway`
- **screens** — none to review: the product is headless (`lia acp`), so the lead skips the screen passes. The `src/ui` terminal code is upstream's and stays under `kru:zig-developer`.
- **project seats** — `.lia/skills/lia-cli-shape` (any flag, command, setting or exit code), `.lia/skills/technical-writer` (prose); prefer these over a plugin seat where they overlap
- **verify** — `zig build`, `zig fmt --check src/`, the narrowest tests for the changed path ← `AGENTS.md` build and testing sections; then `./zig-out/bin/lia --version` and a `lia acp` `initialize` handshake (`tests/e2e/acp.test.ts` sends `protocolVersion: 1`). Always the checkout's `./zig-out/bin/lia`, never one on `PATH`.
- **test** — `zig build test` is the full ReleaseSafe suite that `AGENTS.md` leaves to CI; run the narrowest test while developing. Bun: `cd tests/e2e && LIA_SOUND=0 bun test <file>`. Cost unmeasured.
- **mcp** — `context7` only (user scope, `claude mcp list`); `doop` is registered and failing auth, and no seat here needs it.

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would need — never a nearby seat pressed into the gap.
