// Run context for the Bun drivers written as `bun test` files: which lia
// checkout and binary they drive, where their output goes, and the E2E helpers
// they borrow from tests/e2e/.
//
//   LIA_WORKTREE    checkout under test (default: this one)
//   LIA_BIN         binary under test (default: <checkout>/zig-out/bin/lia)
//   LIA_TLA_OUT     output root (default: a folder under the system temp dir)
//   LIA_TLA_REPEAT  how many times a repeatable check runs (default: 1)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, outDir } from "./tlc";

export const worktree = resolve(process.env.LIA_WORKTREE ?? REPO_ROOT);
export const binary = process.env.LIA_BIN ?? join(worktree, "zig-out", "bin", "lia");
export const artifacts = outDir(process.env.LIA_TLA_CASE ?? "driver");
export const repetitions = Number(process.env.LIA_TLA_REPEAT ?? "1");

/// The checkout's tests/e2e/fake-gateway.ts: the fake gateways and their response builders.
export async function targetHelpers() {
  return await targetModule("fake-gateway.ts");
}

/// A helper module from the checkout's tests/e2e/, such as shell-sessions.ts.
export async function targetModule(name: string) {
  const path = join(worktree, "tests", "e2e", name);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return await import(pathToFileURL(path).href);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/// A minimal environment for an lia process under test: no inherited
/// credentials, sound, keychain, upgrade check, or dotenv.
export function testEnvironment(values: Record<string, string>, inherited = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "TERM", "COLORTERM", "LANG", "LC_ALL", "TMPDIR"]) {
    if (inherited[key]) result[key] = inherited[key]!;
  }
  return {
    ...result,
    LIA_SOUND: "0",
    LIA_DISABLE_KEYCHAIN: "1",
    LIA_AUTO_UPGRADE: "0",
    LIA_E2E_DISABLE_DOTENV: "1",
    ...values,
  };
}
