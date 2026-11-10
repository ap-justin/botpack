---
name: verify
description: Typecheck and lint this repo before a commit. Written by `skills/setup/SKILL.md` from the sheet's `verify` line.
---

Run from the repo root: `zig build`, `zig fmt --check src/`, the narrowest tests for the changed path (CI runs the full `zig build test`), then `./zig-out/bin/lia --version` and an `lia acp` `initialize` handshake against `./zig-out/bin/lia`. Red → fix it before the commit; the commit waits.
