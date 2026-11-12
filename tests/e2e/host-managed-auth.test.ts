import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLia } from "../evals/eval-helpers";
import { fakeGatewayFinalText } from "./fake-gateway";

const TIMEOUT = 30_000;

type CapturedRequest = {
  path: string;
  method: string;
  headers: Headers;
};

describe("host-managed authentication", () => {
  let root = "";
  let home = "";
  let workspace = "";
  let requests: CapturedRequest[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl = "";
  let gatewayUnauthorizedResponses = 0;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lia-host-managed-auth-"));
    home = join(root, "home");
    workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push({
          path,
          method: request.method,
          headers: new Headers(request.headers),
        });
        if (path === "/gateway/models") {
          return Response.json({
            data: [{ id: "test/gateway-model", type: "language", tags: ["tool-use"] }],
          });
        }
        if (path === "/gateway/responses") {
          if (gatewayUnauthorizedResponses > 0) {
            gatewayUnauthorizedResponses -= 1;
            return Response.json({ error: { message: "host rejected request" } }, { status: 401 });
          }
          return fakeGatewayFinalText("GATEWAY_HOST_MANAGED_OK");
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  function env(): Record<string, string | undefined> {
    return {
      HOME: home,
      AI_GATEWAY_API_KEY: undefined,
      VERCEL_OIDC_TOKEN: undefined,
      LIA_AUTH_MODE: "host-managed",
      LIA_AUTO_UPGRADE: "0",
      LIA_DISABLE_KEYCHAIN: "1",
      LIA_TEST_SKIP_ONBOARDING: "1",
      LIA_SOUND: "0",
      LIA_TEST_GATEWAY_MODELS_URL: `${baseUrl}/gateway/models`,
      LIA_TEST_GATEWAY_CHAT_URL: `${baseUrl}/gateway/responses`,
    };
  }

  test("runs Gateway without local authentication headers", async () => {
    const childEnv = env();
    const status = await runLia(["status", "--json"], { cwd: workspace, env: childEnv });
    expect(status.code).toBe(0);
    expect(status.stderr).toBe("");
    expect(JSON.parse(status.stdout).auth).toBe("host managed");

    for (const command of [["login"], ["login", "--api-key"], ["logout"], ["setup"], ["teams"]]) {
      const result = await runLia(command, { cwd: workspace, env: childEnv });
      expect(result.code).toBe(0);
      // `lia setup` is deprecated and says so even when the host manages authentication.
      expect(result.stderr).toBe(command[0] === "setup" ? "lia setup is deprecated and stops working in lia 0.0.18; use lia login vercel --api-key\n" : "");
      expect(result.stdout).toBe("Authentication is managed by the host.\n");
    }
    expect(existsSync(join(home, ".lia", "auth.json"))).toBe(false);

    const selected = await runLia(["provider", "gateway"], {
      cwd: workspace,
      env: childEnv,
      timeoutMs: TIMEOUT,
    });
    expect(selected.code).toBe(0);
    expect(selected.stderr).toBe("");

    const models = await runLia(["models", "--json"], {
      cwd: workspace,
      env: childEnv,
      timeoutMs: TIMEOUT,
    });
    expect(models.code).toBe(0);
    expect(models.stderr).toBe("");

    const asked = await runLia(["ask", "--json", "--no-save", "Reply once."], {
      cwd: workspace,
      env: childEnv,
      timeoutMs: TIMEOUT,
    });
    expect(asked.code).toBe(0);
    expect(asked.stderr).toBe("");
    expect(asked.stdout).toContain("GATEWAY_HOST_MANAGED_OK");

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.headers.get("authorization"), request.path).toBeNull();
      expect(request.headers.get("x-vercel-ai-gateway-team"), request.path).toBeNull();
    }
    expect(existsSync(join(home, ".lia", "auth.json"))).toBe(false);
  }, TIMEOUT);

  test("rejects malformed auth mode before provider I/O", async () => {
    const before = requests.length;
    const result = await runLia(["ask", "--json", "--no-save", "Do nothing."], {
      cwd: workspace,
      env: { ...env(), LIA_AUTH_MODE: "host_managed" },
      timeoutMs: TIMEOUT,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("LIA_AUTH_MODE must be local or host-managed");
    expect(requests.length).toBe(before);
  }, TIMEOUT);

  test("final provider 401 does not enter local refresh or replay", async () => {
    const childEnv = env();
    const selected = await runLia(["provider", "gateway"], {
      cwd: workspace,
      env: childEnv,
      timeoutMs: TIMEOUT,
    });
    expect(selected.code).toBe(0);

    const before = requests.filter((request) => request.path === "/gateway/responses").length;
    gatewayUnauthorizedResponses = 1;
    const asked = await runLia(["ask", "--json", "--no-save", "Reply once."], {
      cwd: workspace,
      env: childEnv,
      timeoutMs: TIMEOUT,
    });
    gatewayUnauthorizedResponses = 0;
    expect(asked.code).toBe(1);
    const after = requests.filter((request) => request.path === "/gateway/responses").length;
    expect(after - before).toBe(1);
    expect(existsSync(join(home, ".lia", "auth.json"))).toBe(false);
  }, TIMEOUT);
});
