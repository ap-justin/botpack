import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLia } from "../evals/eval-helpers";
import {
  FAKE_GATEWAY_MODEL,
  fakeGatewayFinalText,
  fakeGatewayPermissionDecision,
  fakeShellRun,
  startFakeGateway,
} from "./fake-gateway";

const TIMEOUT = 120_000;

type LiaJson = {
  output: string;
  exit_code: number;
  tool_calls: Array<{ name: string; status: string }>;
};

type PermissionEcho = {
  type: string;
  tool_name: string;
  message: string;
  reason: string;
  denied: boolean;
};

function createIsolatedRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, ".lia"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { root, home, workspace };
}

function parseLiaJson(result: { stdout: string; stderr: string; code: number | null }): LiaJson {
  if (result.code !== 0) {
    throw new Error(`lia exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()) as LiaJson;
}

function executionDeniedReason(body: string, toolCallId: string): string {
  const request = JSON.parse(body) as {
    prompt?: Array<{ content?: Array<Record<string, unknown>> }>;
  };
  const result = (request.prompt ?? [])
    .flatMap((message) => message.content ?? [])
    .find((part) => part.type === "tool-result" && part.toolCallId === toolCallId);
  expect(result).toBeDefined();
  const output = result!.output as Record<string, unknown>;
  expect(output.type).toBe("execution-denied");
  expect(typeof output.reason).toBe("string");
  expect(output.value).toBeUndefined();
  return output.reason as string;
}

function permissionEnv(
  home: string,
  gateway: ReturnType<typeof startFakeGateway>,
) {
  return {
    HOME: home,
    AI_GATEWAY_API_KEY: "permission-error-fake-key",
    VERCEL_OIDC_TOKEN: undefined,
    LIA_GATEWAY_BASE_URL: gateway.baseUrl,
    LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
    LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
    LIA_MODEL: FAKE_GATEWAY_MODEL,
    LIA_AUTO_UPGRADE: "0",
    NO_COLOR: "1",
  };
}

describe("generic permission typed errors", () => {
  test(
    "returns typed JSON for denied terminal",
    async () => {
      const root = createIsolatedRoot("lia-permission-error-");
      const marker = join(root.workspace, "denied-marker.txt");
      const toolCallId = "permission_denied_call";
      const gateway = startFakeGateway([
        fakeShellRun(toolCallId, `touch ${JSON.stringify(marker)}`, {
          timeout_ms: 600_000,
        }),
        fakeGatewayFinalText("permission error observed"),
      ]);
      try {
        writeFileSync(
          join(root.home, ".lia", "settings.json"),
          JSON.stringify({
            workspaces: {
              [root.workspace]: {
                permission: {
                  bash: {
                    "touch *denied-marker.txt*": "deny",
                  },
                },
              },
            },
          }),
        );

        const result = await runLia(["ask", "--json", "--no-save", "--auto", "Run the denied command."], {
          cwd: root.workspace,
          env: {
            HOME: root.home,
            AI_GATEWAY_API_KEY: "permission-error-fake-key",
            VERCEL_OIDC_TOKEN: undefined,
            LIA_GATEWAY_BASE_URL: gateway.baseUrl,
            LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
            LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
            LIA_MODEL: FAKE_GATEWAY_MODEL,
            LIA_AUTO_UPGRADE: "0",
          },
          timeoutMs: TIMEOUT,
        });
        const json = parseLiaJson(result);
        expect(result.stderr).toBe('Running touch "./denied-marker.txt"\n');
        expect(json.tool_calls).toContainEqual({
          name: "shell",
          status: "error",
          action: "run",
          error: {
            category: "rejected",
            code: "rejected",
          },
        });
        expect(existsSync(marker)).toBe(false);
        expect(gateway.requests).toHaveLength(2);

        const toolResult = JSON.parse(
          executionDeniedReason(gateway.requests[1]!.body, toolCallId),
        ) as { error: PermissionEcho };
        const echo = toolResult.error;
        expect(echo.type).toBe("tool_permission_denied");
        expect(echo.tool_name).toBe("shell");
        expect(echo.message).toBe("Tool access was denied by configured policy");
        expect(echo.reason).toBe("policy_denied");
        expect(echo.denied).toBe(true);
      } finally {
        gateway.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "JSON and quiet permission prompting remain fail-closed without a TTY or explicit opt in",
    async () => {
      const cases = [
        { mode: "json", args: ["--json"], optIn: false },
        { mode: "json", args: ["--json", "--prompt-permissions"], optIn: true },
        { mode: "quiet", args: ["--quiet"], optIn: false },
        { mode: "quiet", args: ["--quiet", "--prompt-permissions"], optIn: true },
      ] as const;

      for (const testCase of cases) {
        const root = createIsolatedRoot(
          `lia-${testCase.mode}-${testCase.optIn ? "opt-in" : "default"}-non-tty-`,
        );
        const marker = join(root.workspace, "must-not-run.txt");
        writeFileSync(
          join(root.home, ".lia", "settings.json"),
          JSON.stringify({ permission_mode: "ask", sandbox: "none" }),
        );
        const gateway = startFakeGateway([
          fakeShellRun("non_tty_call", `touch ${JSON.stringify(marker)}`, {
            timeout_ms: 600_000,
          }),
        ]);
        try {
          const result = await runLia(
            [
              "ask",
              ...testCase.args,
              "--no-save",
              "Run the non-TTY fixture.",
            ],
            {
              cwd: root.workspace,
              env: permissionEnv(root.home, gateway),
              timeoutMs: TIMEOUT,
            },
          );

          expect(result.timedOut).toBe(false);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("noninteractive_permission_prompt_unavailable");
          expect(result.stderr).not.toContain("Approve? [y/N]");
          if (testCase.mode === "json") {
            const json = JSON.parse(result.stdout) as LiaJson & {
              error: string;
            };
            expect(json.error).toBe("NonInteractivePermissionRequired");
          } else {
            expect(result.stdout).toBe("");
          }
          expect(gateway.requests).toHaveLength(1);
          expect(existsSync(marker)).toBe(false);
        } finally {
          gateway.stop();
          rmSync(root.root, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );
});
