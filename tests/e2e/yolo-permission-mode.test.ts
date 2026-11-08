import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFx } from "../evals/eval-helpers";
import {
  FAKE_GATEWAY_MODEL,
  fakeGatewayFinalText,
  fakeShellRun,
  startFakeGateway,
} from "./fake-gateway";
import { expectPermissionModeContext } from "./permission-mode-context";

const WARNING = "Full access enabled: fx permission checks disabled";
const TIMEOUT = 30_000;
const CONFIGURED_SANDBOX = process.platform === "darwin" ? "os" : "none";

let gateway: { stop(): void } | null = null;
const tempRoots: string[] = [];

afterEach(async () => {
  gateway?.stop();
  gateway = null;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".fx"), { recursive: true });
  mkdirSync(workspace);
  tempRoots.push(root);
  return {
    root,
    home,
    workspace: realpathSync(workspace),
    settingsPath: join(home, ".fx", "settings.json"),
  };
}

describe("yolo permission mode", () => {
  test.each(["--full-access", "--yolo"])(
    "%s warns once, bypasses configured denial, and keeps stdout clean",
    async (flag) => {
      const fixture = createFixture("fx-yolo-headless-");
      const markerPath = join(fixture.workspace, "yolo-command.txt");
      const tracePath = join(fixture.root, "permission-trace.log");
      writeFileSync(
        fixture.settingsPath,
        JSON.stringify({
          permission_mode: "ask",
          sandbox: CONFIGURED_SANDBOX,
          permission: { bash: "deny" },
          future_setting: { preserved: true },
        }) + "\n",
      );

      const fake = startFakeGateway([
        fakeShellRun(
          "yolo_command",
          `printf 'YOLO_COMMAND_OK\\n' > ${JSON.stringify(markerPath)}`,
          { timeout_ms: 600_000 },
        ),
        fakeGatewayFinalText("YOLO_HEADLESS_DONE"),
      ]);
      gateway = fake;

      const result = await runFx(
        ["ask", flag, "--json", "--no-save", "Run the fixture command exactly once."],
        {
          cwd: fixture.workspace,
          env: {
            HOME: fixture.home,
            AI_GATEWAY_API_KEY: "fake-yolo-key",
            VERCEL_OIDC_TOKEN: undefined,
            FX_AUTO_UPGRADE: "0",
            FX_GATEWAY_BASE_URL: fake.baseUrl,
            FX_GATEWAY_CHAT_URL: fake.chatUrl,
            FX_MODEL: FAKE_GATEWAY_MODEL,
            FX_TRACE_LOG: tracePath,
            FX_TRACE_SCOPES: "permission",
          },
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(result.stderr.startsWith(`${WARNING}\n`)).toBe(true);
      expect(result.stderr.match(new RegExp(WARNING, "g"))).toHaveLength(1);
      expect(result.stdout).not.toContain(WARNING);
      const output = JSON.parse(result.stdout.trim()) as {
        output: string;
        tool_calls: Array<{ name: string; status: string }>;
      };
      expect(output.output).toContain("YOLO_HEADLESS_DONE");
      expect(
        output.tool_calls.some(
          (call) => call.name === "shell" && call.status === "success",
        ),
      ).toBe(true);
      expect(readFileSync(markerPath, "utf8")).toBe("YOLO_COMMAND_OK\n");
      expect(fake.classifierRequests).toHaveLength(0);
      expectPermissionModeContext(fake.requests[0]!.body, "yolo");
      expect(existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "")
        .not.toContain("event=auto_review_start");

      const stored = JSON.parse(readFileSync(fixture.settingsPath, "utf8"));
      expect(stored).toMatchObject({
        permission_mode: "ask",
        sandbox: CONFIGURED_SANDBOX,
        yolo_acknowledged: true,
        future_setting: { preserved: true },
      });
    },
    TIMEOUT,
  );

  test.each(["full-access", "full access", "yolo"])(
    "status accepts %s in settings and environment without changing JSON",
    async (mode) => {
      const fixture = createFixture("fx-full-access-status-");
      writeFileSync(fixture.settingsPath, JSON.stringify({ permission_mode: mode }));
      const env = {
        HOME: fixture.home,
        FX_PERMISSION_MODE: undefined,
        FX_AUTO_UPGRADE: "0",
      };
      const configured = await runFx(["status", "--json"], { cwd: fixture.workspace, env });
      expect(configured.code).toBe(0);
      expect(configured.stderr).toBe("");
      expect(JSON.parse(configured.stdout).permission_mode).toBe("full-access");
      const fake = startFakeGateway([fakeGatewayFinalText("ALIAS_WRITE_DONE")]);
      gateway = fake;
      const request = await runFx(["ask", "--no-save", "--json", "Reply once."], {
        cwd: fixture.workspace,
        env: {
          ...env,
          AI_GATEWAY_API_KEY: "fake-alias-key",
          FX_GATEWAY_BASE_URL: fake.baseUrl,
          FX_GATEWAY_CHAT_URL: fake.chatUrl,
          FX_MODEL: FAKE_GATEWAY_MODEL,
        },
        timeoutMs: TIMEOUT,
      });
      expect(request.code).toBe(0);
      expect(request.stderr).toBe(`${WARNING}\n`);
      expect(JSON.parse(request.stdout).output).toContain("ALIAS_WRITE_DONE");
      expect(JSON.parse(readFileSync(fixture.settingsPath, "utf8"))).toMatchObject({
        permission_mode: mode,
        yolo_acknowledged: true,
      });
      writeFileSync(fixture.settingsPath, JSON.stringify({ permission_mode: "ask" }));
      const overridden = await runFx(["status", "--json"], {
        cwd: fixture.workspace,
        env: { ...env, FX_PERMISSION_MODE: mode },
      });
      expect(overridden.code).toBe(0);
      expect(JSON.parse(overridden.stdout).permission_mode).toBe("full-access");
      const text = await runFx(["permissions"], {
        cwd: fixture.workspace,
        env: { ...env, FX_PERMISSION_MODE: mode },
      });
      expect(text.code).toBe(0);
      expect(text.stdout).toContain("mode=full access");
      expect(JSON.parse(readFileSync(fixture.settingsPath, "utf8")).permission_mode).toBe("ask");
    },
    TIMEOUT,
  );

  test(
    "status omits sandbox while preserving the legacy configured value",
    async () => {
      const fixture = createFixture("fx-yolo-status-");
      writeFileSync(
        fixture.settingsPath,
        JSON.stringify({
          permission_mode: "yolo",
          sandbox: CONFIGURED_SANDBOX,
          yolo_acknowledged: true,
        }) + "\n",
      );

      const result = await runFx(["status", "--json"], {
        cwd: fixture.workspace,
        env: {
          HOME: fixture.home,
          AI_GATEWAY_API_KEY: undefined,
          VERCEL_OIDC_TOKEN: undefined,
          FX_PERMISSION_MODE: undefined,
        },
      });

      expect(result.code).toBe(0);
      const status = JSON.parse(result.stdout.trim());
      expect(status).toMatchObject({ permission_mode: "full-access" });
      expect(status).not.toHaveProperty("sandbox");
      expect(JSON.parse(readFileSync(fixture.settingsPath, "utf8")).sandbox).toBe(
        CONFIGURED_SANDBOX,
      );
    },
    TIMEOUT,
  );

  test(
    "legacy sandbox config is inert and ps executes once",
    async () => {
      const fixture = createFixture("fx-legacy-sandbox-ps-");
      const psPath = join(fixture.workspace, "ps.txt");
      const attemptsPath = join(fixture.workspace, "attempts.txt");
      writeFileSync(
        fixture.settingsPath,
        JSON.stringify({
          permission_mode: "yolo",
          sandbox: "os",
          yolo_acknowledged: true,
        }) + "\n",
      );

      const fake = startFakeGateway([
        fakeShellRun(
          "legacy_ps",
          `ps -p $$ -o pid= > ${JSON.stringify(psPath)}; printf x >> ${JSON.stringify(attemptsPath)}`,
          { timeout_ms: 600_000 },
        ),
        fakeGatewayFinalText("LEGACY_PS_DONE"),
      ]);
      gateway = fake;

      const result = await runFx(
        ["ask", "--yolo", "--json", "--no-save", "Run the ps fixture once."],
        {
          cwd: fixture.workspace,
          env: {
            HOME: fixture.home,
            AI_GATEWAY_API_KEY: "fake-yolo-key",
            VERCEL_OIDC_TOKEN: undefined,
            FX_AUTO_UPGRADE: "0",
            FX_GATEWAY_BASE_URL: fake.baseUrl,
            FX_GATEWAY_CHAT_URL: fake.chatUrl,
            FX_MODEL: FAKE_GATEWAY_MODEL,
          },
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(readFileSync(psPath, "utf8").trim()).toMatch(/^\d+$/);
      expect(readFileSync(attemptsPath, "utf8")).toBe("x");
      expect(fake.classifierRequests).toHaveLength(0);
      expect(fake.requests).toHaveLength(2);
    },
    TIMEOUT,
  );
});
