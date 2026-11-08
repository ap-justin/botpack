import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFx } from "../evals/eval-helpers";

const serialTest = test.serial;

describe("config persistence", () => {
  serialTest("config diagnostics preserve invalid, oversized, and unsafe primaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "fx-config-diagnostics-"));
    try {
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(join(home, ".fx"), { recursive: true, mode: 0o700 });
      mkdirSync(workspace);
      const workspaceRoot = realpathSync(workspace);
      const settingsPath = join(home, ".fx", "settings.json");

      const malformed = "{bad\n";
      writeFileSync(settingsPath, malformed, { mode: 0o600 });
      const malformedStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(malformedStatus.code).toBe(0);
      expect(malformedStatus.stderr).toContain("malformed_settings");
      expect(readFileSync(settingsPath, "utf8")).toBe(malformed);

      // statusLine is retired, so a value of any type loads without a warning.
      const retiredStatusLine = "{\"statusLine\":{\"context\":1}}\n";
      writeFileSync(settingsPath, retiredStatusLine, { mode: 0o600 });
      const retiredStatusLineStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(retiredStatusLineStatus.code).toBe(0);
      expect(retiredStatusLineStatus.stderr).not.toContain("malformed_settings");
      expect(readFileSync(settingsPath, "utf8")).toBe(retiredStatusLine);

      const inertOutputSettings =
        JSON.stringify({
          output_level: { legacy: true },
          workspaces: {
            [workspaceRoot]: {
              output_level: ["quiet", 7],
            },
          },
        }) + "\n";
      writeFileSync(settingsPath, inertOutputSettings, { mode: 0o600 });
      const inertStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(inertStatus.code).toBe(0);
      expect(inertStatus.stderr).not.toContain("legacy_workspace_preferences");
      const inertDoctor = await runFx(["doctor", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(inertDoctor.code).toBe(0);
      expect(inertDoctor.stdout).not.toContain("legacy_workspace_preferences");

      expect(readFileSync(settingsPath, "utf8")).toBe(inertOutputSettings);

      const oversized = JSON.stringify({ padding: "x".repeat(65 * 1024) }) + "\n";
      writeFileSync(settingsPath, oversized, { mode: 0o600 });
      const oversizedDoctor = await runFx(["doctor", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(oversizedDoctor.code).toBe(0);
      expect(oversizedDoctor.stdout).toContain("settings_too_large");
      expect(readFileSync(settingsPath, "utf8")).toBe(oversized);

      const external = join(root, "external-settings.json");
      writeFileSync(external, "{\"model\":\"external\"}\n", { mode: 0o600 });
      rmSync(settingsPath);
      symlinkSync(external, settingsPath);
      const unsafeStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(unsafeStatus.code).toBe(0);
      expect(unsafeStatus.stderr).toContain("durable_path_unsafe");
      expect(readFileSync(external, "utf8")).toBe("{\"model\":\"external\"}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
