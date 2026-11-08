---
name: verify
description: Typecheck and lint this repo before a commit. Written by `skills/setup/SKILL.md` from the sheet's `verify` line.
---

Run from the repo root: `zig build`, `zig fmt --check src/`, `zig build test`, then `./zig-out/bin/fx --version` and an `fx acp` `initialize` handshake against `./zig-out/bin/fx`. Red → fix it before the commit; the commit waits.
