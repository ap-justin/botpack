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
import { LIA_BIN, runLia } from "../evals/eval-helpers";
import { contentText } from "./conditional-guidance-oracle";
import { pngPixelSize, solidPng } from "./fixtures/image-encoding";
import {
  fakeGatewayFinalText,
  fakeGatewayToolCall,
  startDynamicFakeGateway,
  startFakeGateway,
} from "./fake-gateway";

const MODEL = "openai/gpt-5";
const TOOL_NAME = "mcp_fixture_echo";
const MODERN_RESULT = "MODERN_MCP_TOOL_RESULT";
const LEGACY_RESULT = "LEGACY_MCP_TOOL_RESULT";
const MODERN_FIXTURE = join(import.meta.dirname, "fixtures", "mcp-modern-stdio.mjs");
const LEGACY_FIXTURE = join(import.meta.dirname, "fixtures", "mcp-legacy-stdio.mjs");
const REPO_ROOT = realpathSync(join(import.meta.dirname, "..", ".."));

type FixtureRoot = {
  root: string;
  home: string;
  workspace: string;
  wireLogPath: string;
  launchLogPath: string;
  traceLogPath: string;
  invalidationReleasePath: string;
  environmentCapturePath: string;
};

type WireEntry = {
  pid: number;
  sequence?: number;
  message: {
    method?: string;
    id?: number | string;
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
    params?: Record<string, unknown>;
  };
};

let gateway: ReturnType<typeof startFakeGateway> | null = null;
let cleanupRoot: string | null = null;

afterEach(async () => {
  const activeGateway = gateway;
  const activeCleanupRoot = cleanupRoot;
  gateway = null;
  cleanupRoot = null;

  activeGateway?.stop();
  if (activeCleanupRoot) {
    rmSync(activeCleanupRoot, { recursive: true, force: true });
  }
});

type RootOptions = {
  /** The 2025 fixture accepts any client the spec allows, not only v1's wire choices. */
  mode?:
    | "normal"
    | "progress"
    | "stall_operation"
    | "stall_startup"
    | "tool_failure"
    | "image_result"
    | "response_missing_jsonrpc"
    | "response_wrong_jsonrpc"
    | "response_missing_payload"
    | "response_ambiguous_payload"
    | "mrtr_input_required"
    | "mrtr_url_required"
    | "mrtr_full_form"
    | "mrtr_collision_form"
    | "mrtr_unsafe_form"
    | "direct_form"
    | "url_required_error"
    | "url_required_multiple"
    | "url_required_malformed_completion"
    | "block_then_stall_recovery"
    | "subscription_cache"
    | "features"
    | "features_no_tools"
    | "feature_protocol_error"
    | "draft7_schema"
    | "list_changed"
    | "crash_once"
    | "crash_always"
    | "startup_exit"
    | "startup_exit_after_delay"
    | "startup_garbage"
    | "exit_after_result";
  startupTimeoutMs?: number;
  protocolErrorMessage?: string;
  operationTimeoutMs?: number;
  restartLimit?: number;
  recoveredToolName?: string;
  expectedElicitation?: "form" | "url" | "both";
  elicitationUrl?: string;
  compactField?: Record<string, unknown>;
  legacyVersion?: "2025-06-18" | "2025-11-25";
  legacyDiscoveryVersions?: readonly ["2024-11-05", "2025-06-18", "2025-11-25"];
  legacyDiscoveryMethodNotFound?: boolean;
  legacyDiscoveryInvalidParams?: boolean;
  legacyRejectNewerInitialize?: boolean;
  draft7Pattern?: string;
  urlRequiredOperation?: "tools" | "resources" | "prompts";
  recordLaunchAttempts?: boolean;
  required?: boolean;
  resourcesSubscribe?: boolean;
  resourceTtlMs?: number;
  captureEnvironment?: boolean;
  image?: Buffer;
};

function createRoot(
  label: string,
  scriptPath: string,
  options: RootOptions = {},
): FixtureRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `lia-mcp-${label}-`)));
  cleanupRoot = root;
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const wireLogPath = join(root, "mcp-wire.jsonl");
  const launchLogPath = join(root, "mcp-launches.txt");
  const invalidationReleasePath = join(root, "mcp-invalidation-release");
  const environmentCapturePath = join(root, "mcp-environment.json");
  const imagePath = join(root, "mcp-image.png");
  if (options.image) writeFileSync(imagePath, options.image);
  const command = options.recordLaunchAttempts
    ? [
      "/bin/sh",
      "-c",
      `printf '%s\\n' "$$" >> "$LIA_MCP_LAUNCH_LOG"; exec "$LIA_MCP_FIXTURE_RUNTIME" "$LIA_MCP_FIXTURE_PATH"`,
    ]
    : [process.execPath, scriptPath];
  mkdirSync(join(home, ".lia"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, ".lia", "settings.json"),
    JSON.stringify({}),
  );
  writeFileSync(
    join(home, ".lia", "mcp.json"),
    JSON.stringify({
      mcp: {
        fixture: {
          type: "local",
          command,
          enabled: true,
          required: options.required,
          environment: {
            LIA_MCP_WIRE_LOG: wireLogPath,
            LIA_MCP_LAUNCH_LOG: options.recordLaunchAttempts
              ? launchLogPath
              : undefined,
            LIA_MCP_FIXTURE_RUNTIME: options.recordLaunchAttempts
              ? process.execPath
              : undefined,
            LIA_MCP_FIXTURE_PATH: options.recordLaunchAttempts
              ? scriptPath
              : undefined,
            LIA_MCP_PID_PATH: join(root, "mcp.pid"),
            LIA_MCP_MODE: options.mode ?? "normal",
            LIA_MCP_IMAGE_PATH: options.image ? imagePath : undefined,
            LIA_MCP_PROTOCOL_ERROR_MESSAGE: options.protocolErrorMessage,
            LIA_MCP_CRASH_MARKER: join(root, "mcp-crashed"),
            LIA_MCP_RECOVERY_READY_PATH: join(root, "mcp-recovery-ready"),
            LIA_MCP_INVALIDATION_RELEASE_PATH: invalidationReleasePath,
            LIA_MCP_RECOVERED_TOOL_NAME: options.recoveredToolName,
            LIA_MCP_EXPECT_ELICITATION: options.expectedElicitation,
            LIA_MCP_ELICITATION_URL: options.elicitationUrl,
            LIA_MCP_COMPACT_FIELD: options.compactField ? JSON.stringify(options.compactField) : undefined,
            LIA_MCP_RESOURCES_SUBSCRIBE: options.resourcesSubscribe === false
              ? "0"
              : undefined,
            LIA_MCP_RESOURCE_TTL_MS: options.resourceTtlMs?.toString(),
            LIA_MCP_LEGACY_VERSION: options.legacyVersion,
            LIA_MCP_LEGACY_DISCOVERY_VERSIONS:
              options.legacyDiscoveryVersions?.join(","),
            LIA_MCP_LEGACY_DISCOVERY_METHOD_NOT_FOUND:
              options.legacyDiscoveryMethodNotFound ? "1" : undefined,
            LIA_MCP_LEGACY_DISCOVERY_INVALID_PARAMS:
              options.legacyDiscoveryInvalidParams ? "1" : undefined,
            LIA_MCP_LEGACY_REJECT_NEWER_INITIALIZE:
              options.legacyRejectNewerInitialize ? "1" : undefined,
            LIA_MCP_DRAFT7_PATTERN: options.draft7Pattern,
            LIA_MCP_URL_REQUIRED_OPERATION: options.urlRequiredOperation,
            LIA_MCP_ENV_CAPTURE: options.captureEnvironment
              ? environmentCapturePath
              : undefined,
            LIA_MCP_ENV_SENTINEL: options.captureEnvironment
              ? "configured"
              : undefined,
          },
          startup_timeout_ms: options.startupTimeoutMs,
          operation_timeout_ms: options.operationTimeoutMs,
          restart_limit: options.restartLimit,
        },
      },
    }),
  );
  return {
    root,
    home,
    workspace,
    wireLogPath,
    launchLogPath,
    traceLogPath: join(root, "lia-trace.log"),
    invalidationReleasePath,
    environmentCapturePath,
  };
}

function moveProfileFixtureToWorkspace(root: FixtureRoot): void {
  const profilePath = join(root.home, ".lia", "mcp.json");
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  const fixture = profile.mcp.fixture;
  if (Array.isArray(fixture.command)) {
    fixture.args = fixture.command.slice(1);
    fixture.command = fixture.command[0];
  }
  writeFileSync(
    join(root.workspace, ".mcp.json"),
    JSON.stringify({ mcpServers: { fixture } }),
  );
  writeFileSync(profilePath, JSON.stringify({ mcp: {} }));
}

/** The text lia sent the model as one tool call's result. */
function toolResultText(body: string, callId: string): string {
  const prompt = (JSON.parse(body) as { prompt: Array<{ content?: unknown }> }).prompt;
  const part = prompt
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []) as Array<Record<string, unknown>>)
    .find((item) => item.type === "tool-result" && item.toolCallId === callId);
  if (!part) throw new Error(`missing the tool result for ${callId}`);
  return contentText(part.output);
}

function fixtureEnv(root: FixtureRoot, activeGateway: ReturnType<typeof startFakeGateway>) {
  return {
    HOME: root.home,
    AI_GATEWAY_API_KEY: "fake-mcp-stdio-key",
    VERCEL_OIDC_TOKEN: undefined,
    LIA_PERMISSION_MODE: "auto",
    LIA_GATEWAY_BASE_URL: activeGateway.baseUrl,
    LIA_GATEWAY_CHAT_URL: activeGateway.chatUrl,
    LIA_TEST_GATEWAY_CHAT_URL: activeGateway.chatUrl,
    LIA_MODEL: MODEL,
    LIA_TRACE_LOG: root.traceLogPath,
    LIA_TRACE_SCOPES: "mcp",
  };
}

function startToolGateway(finalText: string) {
  return startFakeGateway([
    fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
    fakeGatewayToolCall("call_mcp", TOOL_NAME, { text: "hello" }),
    fakeGatewayFinalText(finalText),
  ], {
    models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
  });
}

function readWire(path: string): WireEntry[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WireEntry);
}

function readAttemptedPids(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectFixtureProcessesExited(wire: WireEntry[], timeoutMs = 5_000) {
  return expectProcessesExited(wire.map((entry) => entry.pid), timeoutMs);
}

async function expectProcessesExited(pids: Iterable<number>, timeoutMs = 5_000) {
  const uniquePids = new Set(pids);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ([...uniquePids].every((pid) => !isProcessAlive(pid))) return;
    await Bun.sleep(25);
  }
  const live = [...uniquePids].filter(isProcessAlive);
  throw new Error(`MCP fixture processes did not exit: ${live.join(", ")}`);
}

describe("modern MCP stdio compatibility", () => {

  test("repository-local MCP configuration never launches a process or network request", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-mcp-project-trust-")));
    cleanupRoot = root;
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const marker = join(root, "project-mcp-launched");
    mkdirSync(join(home, ".lia"), { recursive: true });
    mkdirSync(join(workspace, ".lia"), { recursive: true });
    writeFileSync(join(home, ".lia", "settings.json"), JSON.stringify({}));
    writeFileSync(join(home, ".lia", "mcp.json"), JSON.stringify({ mcp: {} }));

    let projectRequestCount = 0;
    const projectEndpoint = Bun.serve({
      port: 0,
      fetch() {
        projectRequestCount += 1;
        return new Response("project MCP must remain unreachable", { status: 500 });
      },
    });
    const hostile = JSON.stringify({
      mcpServers: {
        local: {
          type: "local",
          command: "/bin/sh",
          args: ["-c", `printf launched > ${marker}`],
          enabled: true,
          required: true,
        },
        remote: {
          type: "http",
          url: `http://127.0.0.1:${projectEndpoint.port}/mcp`,
          headers: { Authorization: "Bearer ${PROJECT_MCP_SECRET}" },
          enabled: true,
          required: true,
        },
      },
    });
    writeFileSync(join(workspace, ".mcp.json"), hostile);
    writeFileSync(join(workspace, ".lia", "mcp.json"), hostile);

    gateway = startFakeGateway([fakeGatewayFinalText("Project MCP stayed inert.")], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    try {
      const result = await runLia(
        ["ask", "--json", "--auto", "--no-save", "Confirm the workspace is available."],
        {
          cwd: workspace,
          env: {
            ...fixtureEnv({
              root,
              home,
              workspace,
              wireLogPath: join(root, "wire.jsonl"),
              launchLogPath: join(root, "launches.txt"),
              traceLogPath: join(root, "trace.log"),
              invalidationReleasePath: join(root, "release"),
            }, gateway),
            PROJECT_MCP_SECRET: "must-not-leave-the-process",
          },
          timeoutMs: 15_000,
        },
      );
      expect(result.code).toBe(0);
      expect(gateway.requests).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
      expect(projectRequestCount).toBe(0);
    } finally {
      projectEndpoint.stop(true);
    }
  }, 20_000);

  test("lia ask skips pending workspace MCP and uses it after explicit trust", async () => {
    const root = createRoot("workspace-ask", MODERN_FIXTURE);
    moveProfileFixtureToWorkspace(root);
    const projectPath = join(root.workspace, ".mcp.json");
    const project = JSON.parse(readFileSync(projectPath, "utf8"));
    project.mcpServers.fixture.command = "${WORKSPACE_MCP_COMMAND}";
    project.mcpServers.fixture.args = ["${WORKSPACE_MCP_FIXTURE}"];
    project.mcpServers.fixture.env = {
      LIA_MCP_RESULT_TEXT: "${WORKSPACE_MCP_RESULT:-MODERN_MCP_TOOL_RESULT}",
      LIA_MCP_WIRE_LOG: "${WORKSPACE_MCP_WIRE_LOG}",
      LIA_MCP_PID_PATH: "${WORKSPACE_MCP_PID_PATH}",
      LIA_MCP_MODE: "${WORKSPACE_MCP_MODE:-normal}",
    };
    delete project.mcpServers.fixture.environment;
    writeFileSync(projectPath, JSON.stringify(project));
    gateway = startFakeGateway([
      fakeGatewayFinalText("WORKSPACE_MCP_SKIPPED"),
      fakeGatewayToolCall("workspace_select", "mcp_select_tool", { name: TOOL_NAME }),
      fakeGatewayToolCall("workspace_call", TOOL_NAME, { text: "workspace" }),
      fakeGatewayFinalText("WORKSPACE_MCP_READY"),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });

    const env = {
      ...fixtureEnv(root, gateway),
      WORKSPACE_MCP_COMMAND: process.execPath,
      WORKSPACE_MCP_FIXTURE: MODERN_FIXTURE,
      WORKSPACE_MCP_WIRE_LOG: root.wireLogPath,
      WORKSPACE_MCP_PID_PATH: join(root.root, "mcp.pid"),
    };
    const skipped = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Use the workspace MCP."],
      {
        cwd: root.workspace,
        env,
        timeoutMs: 20_000,
      },
    );
    expect(skipped.code).toBe(0);
    expect(skipped.stdout).toContain("WORKSPACE_MCP_SKIPPED");
    expect(skipped.stderr).toContain(
      "skipped unapproved project MCP servers: fixture",
    );
    expect(existsSync(root.wireLogPath)).toBe(false);
    let settings = readFileSync(join(root.home, ".lia", "settings.json"), "utf8");
    expect(settings).not.toContain("enabledMcpjsonServers");
    expect(settings).not.toContain("enableAllProjectMcpServers");

    const trusted = await runLia(
      ["mcp", "approve", "fixture"],
      { cwd: root.workspace, env },
    );
    expect(trusted.code).toBe(0);
    // It says what the approved server runs, as the file writes it.
    expect(trusted.stdout).toBe("Approved fixture, which runs: '${WORKSPACE_MCP_COMMAND}' '${WORKSPACE_MCP_FIXTURE}'\n");
    settings = readFileSync(join(root.home, ".lia", "settings.json"), "utf8");
    expect(settings).toContain("enabledMcpjsonServers");

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Use the workspace MCP."],
      { cwd: root.workspace, env, timeoutMs: 20_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("WORKSPACE_MCP_READY");
    expect(result.stderr).not.toContain("skipped unapproved project MCP servers");
    expect(readWire(root.wireLogPath).some((entry) =>
      entry.message.method === "tools/call"
    )).toBe(true);
    await expectFixtureProcessesExited(readWire(root.wireLogPath));
  }, 35_000);

  test("lia ask reports rejected workspace MCP entries on stderr", async () => {
    const root = createRoot("workspace-invalid-entry", MODERN_FIXTURE);
    moveProfileFixtureToWorkspace(root);
    const projectPath = join(root.workspace, ".mcp.json");
    const project = JSON.parse(readFileSync(projectPath, "utf8"));
    project.mcpServers.broken = {
      type: "http",
      url: "not a url",
    };
    writeFileSync(projectPath, JSON.stringify(project));
    gateway = startFakeGateway([fakeGatewayFinalText("WORKSPACE_PARSE_CONTINUED")], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Confirm the workspace is available."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 20_000,
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("WORKSPACE_PARSE_CONTINUED");
    expect(result.stdout).not.toContain("broken");
    expect(result.stderr).toContain("skipped unapproved project MCP servers: fixture");
    expect(result.stderr).toContain(
      ".mcp.json server 'broken' was skipped: its \"url\" isn't valid.",
    );
    expect(existsSync(root.wireLogPath)).toBe(false);
  }, 25_000);

  // One text item over 1 MiB used to fail the whole result. Now a
  // saved session keeps the whole result behind a handle, and without one it
  // is cut to the model's limit like any big result.
  describe("big MCP results", () => {
    const bigResultRoot = (label: string) => {
      const root = createRoot(label, MODERN_FIXTURE);
      const profilePath = join(root.home, ".lia", "mcp.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      profile.mcp.fixture.environment.LIA_MCP_RESULT_PAD_BYTES = String(1536 * 1024);
      profile.mcp.fixture.environment.LIA_MCP_RESULT_TEXT = "SBXF2_TAIL";
      writeFileSync(profilePath, JSON.stringify(profile));
      return root;
    };

    // lia reads at most 16 MiB of one stdio message: past that it drops the
    // reply and restarts the server. Before, the model was told the server
    // went away, as if it had crashed.
    test("a stdio reply over lia's message limit tells the model lia restarted the server for it", async () => {
      const root = createRoot("oversized-reply", MODERN_FIXTURE);
      const profilePath = join(root.home, ".lia", "mcp.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      profile.mcp.fixture.environment.LIA_MCP_RESULT_PAD_BYTES = String(17 * 1024 * 1024);
      writeFileSync(profilePath, JSON.stringify(profile));
      let first = "";
      gateway = startFakeGateway([
        fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
        fakeGatewayToolCall("call_mcp", TOOL_NAME, { text: "hello" }),
        (body: string) => {
          first = toolResultText(body, "call_mcp");
          return fakeGatewayFinalText("OVERSIZED_REPLY_DONE");
        },
      ], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });
      const result = await runLia(["ask", "--json", "--auto", "--no-save", "Call the MCP tool."], {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 40_000,
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).output).toContain("OVERSIZED_REPLY_DONE");
      expect(first).toContain("its reply was larger than lia reads in one message, so lia restarted the server");
      expect(first).not.toContain("the server went away");
      const wire = readWire(root.wireLogPath);
      expect(wire.filter((entry) => entry.message.method === "tools/call")).toHaveLength(1);
      await expectFixtureProcessesExited(wire);
    }, 60_000);

    test("lia ask keeps a big MCP result whole behind a handle, and read_tool_result reaches its end", async () => {
      const root = bigResultRoot("big-result-stored");
      let stored = "";
      let read = "";
      gateway = startFakeGateway([
        fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
        fakeGatewayToolCall("call_mcp", TOOL_NAME, { text: "hello" }),
        (body: string) => {
          stored = toolResultText(body, "call_mcp");
          const handle = /<tool_result_handle>([^<]+)<\/tool_result_handle>/.exec(stored)?.[1] ?? "missing";
          // The whole result is one line, so read its last bytes by range.
          const size = Number(/stored_bytes="(\d+)"/.exec(stored)?.[1] ?? 0);
          return fakeGatewayToolCall("read_tail", "read_tool_result", { request: { handle, start_byte: Math.max(size - 255, 1), byte_count: 256 } });
        },
        (body: string) => {
          read = toolResultText(body, "read_tail");
          return fakeGatewayFinalText("BIG_RESULT_READ");
        },
      ], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });
      const result = await runLia(["ask", "--json", "--auto", "Read the big result."], {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 30_000,
      });
      expect(result.code).toBe(0);
      expect(stored).not.toContain("InvalidContent");
      expect(stored).toContain("<tool_result_handle>");
      expect(Number(/stored_bytes="(\d+)"/.exec(stored)?.[1] ?? 0)).toBeGreaterThan(1536 * 1024);
      expect(read).toContain("SBXF2_TAIL:hello");
    }, 45_000);

    test("lia ask --no-save cuts a big MCP result to the model's limit instead of failing it", async () => {
      const root = bigResultRoot("big-result-unsaved");
      let cut = "";
      gateway = startFakeGateway([
        fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
        fakeGatewayToolCall("call_mcp", TOOL_NAME, { text: "hello" }),
        (body: string) => {
          cut = toolResultText(body, "call_mcp");
          return fakeGatewayFinalText("BIG_RESULT_CUT");
        },
      ], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });
      const result = await runLia(["ask", "--json", "--auto", "--no-save", "Read the big result."], {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 30_000,
      });
      expect(result.code).toBe(0);
      expect(cut).not.toContain("InvalidContent");
      expect(cut).not.toContain("<tool_result_handle>");
      expect(cut).toContain("[mcp tool result truncated for fixture/");
      expect(cut.length).toBeLessThanOrEqual(64 * 1024);
    }, 45_000);
  });

  test(
    "top-level mcp list reports a missing workspace variable without exposing config values",
    async () => {
      const root = createRoot("workspace-missing-environment", MODERN_FIXTURE);
      moveProfileFixtureToWorkspace(root);
      const projectPath = join(root.workspace, ".mcp.json");
      const project = JSON.parse(readFileSync(projectPath, "utf8"));
      project.mcpServers.fixture.command = "secret-prefix-${MISSING_WORKSPACE_COMMAND}";
      writeFileSync(projectPath, JSON.stringify(project));
      gateway = startFakeGateway([], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });
      const env = fixtureEnv(root, gateway);
      const trusted = await runLia(
        ["mcp", "approve", "fixture"],
        { cwd: root.workspace, env },
      );
      expect(trusted.code).toBe(0);

      const listed = await runLia(["mcp", "list"], {
        cwd: root.workspace,
        env,
      });
      expect(listed.code).toBe(0);
      // A config problem is a note, said once, naming the variable but no value.
      expect(listed.stderr).toBe(
        "note: .mcp.json server 'fixture' field command requires environment variable 'MISSING_WORKSPACE_COMMAND'; set it or use ${MISSING_WORKSPACE_COMMAND:-default}.\n",
      );
      expect(`${listed.stdout}${listed.stderr}`).not.toContain("secret-prefix");
      expect(`${listed.stdout}${listed.stderr}`).not.toContain(MODERN_FIXTURE);
      expect(existsSync(root.wireLogPath)).toBe(false);
    },
    30_000,
  );

  test("top-level mcp add persists stdio and a later ask calls it", async () => {
    const root = createRoot("top-level-add", MODERN_FIXTURE);
    writeFileSync(
      join(root.home, ".lia", "mcp.json"),
      JSON.stringify({ mcp: {} }),
    );
    gateway = startToolGateway("TOP_LEVEL_STDIO_MCP_READY");
    const env = {
      ...fixtureEnv(root, gateway),
      LIA_MCP_WIRE_LOG: root.wireLogPath,
      LIA_MCP_PID_PATH: join(root.root, "mcp.pid"),
      LIA_MCP_MODE: "normal",
    };
    // A stdio server gets only the default variables and its own, so the
    // fixture's settings go in with --env.
    const added = await runLia(
      [
        "mcp", "add",
        "--env", `LIA_MCP_WIRE_LOG=${env.LIA_MCP_WIRE_LOG}`,
        "--env", `LIA_MCP_PID_PATH=${env.LIA_MCP_PID_PATH}`,
        "--env", `LIA_MCP_MODE=${env.LIA_MCP_MODE}`,
        "fixture", "--", process.execPath, MODERN_FIXTURE,
      ],
      { cwd: root.workspace, env },
    );
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("Added fixture to ~/.lia/mcp.json.");
    expect(existsSync(root.wireLogPath)).toBe(false);

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Use the stdio MCP echo tool."],
      { cwd: root.workspace, env, timeoutMs: 20_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("TOP_LEVEL_STDIO_MCP_READY");
    expect(readWire(root.wireLogPath).filter((entry) =>
      entry.message.method === "tools/call"
    )).toHaveLength(1);
    await expectFixtureProcessesExited(readWire(root.wireLogPath));
  }, 25_000);

  // A server name with control characters never loads, so it can't reach a
  // terminal or a trace raw.
  test("a project server whose name has control characters is skipped, and every message escapes the name", async () => {
    const root = createRoot("workspace-hostile-name", MODERN_FIXTURE);
    moveProfileFixtureToWorkspace(root);
    const hostileName = "bad\n\x1b]0;owned\x07";
    const projectPath = join(root.workspace, ".mcp.json");
    const project = JSON.parse(readFileSync(projectPath, "utf8"));
    project.mcpServers[hostileName] = project.mcpServers.fixture;
    delete project.mcpServers.fixture;
    writeFileSync(projectPath, JSON.stringify(project));
    gateway = startFakeGateway([fakeGatewayFinalText("HOSTILE_NAME_SKIPPED")], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    const env = fixtureEnv(root, gateway);
    const approved = await runLia(["mcp", "approve", hostileName], { cwd: root.workspace, env });
    expect(approved.code).toBe(1);

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Exercise the project MCP."],
      { cwd: root.workspace, env, timeoutMs: 25_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("HOSTILE_NAME_SKIPPED");
    expect(result.stderr).toContain("server 'bad\\x0a\\x1b]0;owned\\x07' was skipped");
    const texts = [approved.stdout, approved.stderr, result.stderr];
    if (existsSync(root.traceLogPath)) texts.push(readFileSync(root.traceLogPath, "utf8"));
    for (const text of texts) {
      expect(text).not.toContain("\x1b");
      expect([...Buffer.from(text)].every((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e))).toBe(true);
    }
    expect(existsSync(root.wireLogPath)).toBe(false);
  }, 30_000);

  test("lia ask skips workspace MCP when profile choices are unreadable", async () => {
    const root = createRoot("workspace-choice-failure", MODERN_FIXTURE, {
      recordLaunchAttempts: true,
    });
    moveProfileFixtureToWorkspace(root);
    writeFileSync(
      join(root.home, ".lia", "settings.json"),
      JSON.stringify({
        workspaces: {
          [root.workspace]: { disabledMcpjsonServers: "fixture" },
        },
      }),
    );
    gateway = startFakeGateway([fakeGatewayFinalText("CHOICES_FAILED_CLOSED")], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Confirm the workspace is available."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 20_000,
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CHOICES_FAILED_CLOSED");
    expect(existsSync(root.launchLogPath)).toBe(false);
    expect(result.stderr).not.toContain("skipped unapproved project MCP servers");
  }, 25_000);

  test("fresh and resumed native sessions reconstruct MCP from the current profile", async () => {
    const root = createRoot("resume-current-profile", MODERN_FIXTURE);
    const initialGateway = startFakeGateway([
      fakeGatewayToolCall("fresh_select", "mcp_select_tool", { name: TOOL_NAME }),
      fakeGatewayToolCall("fresh_call", TOOL_NAME, { text: "fresh" }),
      fakeGatewayFinalText("FRESH_PROFILE_MCP_READY"),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    gateway = initialGateway;
    const initial = await runLia(
      ["ask", "--json", "--auto", "Use the fresh profile MCP."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, initialGateway),
        timeoutMs: 20_000,
      },
    );
    expect(initial.code).toBe(0);
    const sessionId = JSON.parse(initial.stdout).session_id;
    expect(sessionId).toBeTruthy();
    initialGateway.stop();
    gateway = null;

    const profilePath = join(root.home, ".lia", "mcp.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.mcp.fixture.environment.LIA_MCP_INITIAL_TOOL_NAME = "sum";
    profile.mcp.fixture.environment.LIA_MCP_RESULT_TEXT = "RESUMED_PROFILE_TOOL_RESULT";
    writeFileSync(profilePath, JSON.stringify(profile));

    const resumedTool = "mcp_fixture_sum";
    const resumedGateway = startFakeGateway([
      fakeGatewayToolCall("resume_select", "mcp_select_tool", { name: resumedTool }),
      fakeGatewayToolCall("resume_call", resumedTool, { text: "resumed" }),
      fakeGatewayFinalText("RESUMED_PROFILE_MCP_READY"),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    gateway = resumedGateway;
    const resumed = await runLia(
      ["ask", "--json", "--auto", "--resume", sessionId, "Use the current profile MCP."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, resumedGateway),
        timeoutMs: 20_000,
      },
    );
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      session_id: sessionId,
      output: expect.stringContaining("RESUMED_PROFILE_MCP_READY"),
    });
    const wire = readWire(root.wireLogPath);
    const calls = wire.filter((entry) => entry.message.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.message.params?.name).toBe("echo");
    expect(calls[1]?.message.params?.name).toBe("sum");
    expect(new Set(wire.map((entry) => entry.pid)).size).toBe(2);
    await expectFixtureProcessesExited(wire);
  }, 45_000);

  test("a resumed lia ask runs a direct call to an MCP tool an earlier turn loaded", async () => {
    const root = createRoot("ask-later-turn-direct-call", MODERN_FIXTURE);
    const firstGateway = startToolGateway("FIRST_ASK_DONE");
    gateway = firstGateway;
    const first = await runLia(
      ["ask", "--json", "--auto", "Load the fixture echo tool and call it."],
      { cwd: root.workspace, env: fixtureEnv(root, firstGateway), timeoutMs: 20_000 },
    );
    expect(first.code).toBe(0);
    const sessionId = JSON.parse(first.stdout).session_id;
    expect(sessionId).toBeTruthy();
    firstGateway.stop();
    gateway = null;

    const missingTool = "mcp_fixture_missing";
    const laterGateway = startFakeGateway([
      fakeGatewayToolCall("missing_call", missingTool, { text: "nothing" }),
      fakeGatewayToolCall("later_call", TOOL_NAME, { text: "later" }),
      fakeGatewayFinalText("LATER_ASK_DONE"),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    gateway = laterGateway;
    const later = await runLia(
      ["ask", "--json", "--auto", "--resume", sessionId, "Call the echo tool again."],
      { cwd: root.workspace, env: fixtureEnv(root, laterGateway), timeoutMs: 20_000 },
    );
    expect(later.code).toBe(0);
    expect(JSON.parse(later.stdout)).toMatchObject({
      session_id: sessionId,
      output: expect.stringContaining("LATER_ASK_DONE"),
    });
    expect(laterGateway.requests).toHaveLength(3);
    // A name no live server has still fails without reaching any server.
    const missingResult = toolResultText(laterGateway.requests[1]!.body, "missing_call");
    expect(missingResult).toMatch(/not selected for this model step|Unsupported tool/);
    expect(missingResult).toContain(missingTool);
    expect(missingResult).not.toContain(MODERN_RESULT);
    const laterResult = toolResultText(laterGateway.requests[2]!.body, "later_call");
    expect(laterResult).toContain(`${MODERN_RESULT}:later`);
    expect(laterResult).not.toContain("not selected");
    const wire = readWire(root.wireLogPath);
    const calls = wire.filter((entry) => entry.message.method === "tools/call");
    expect(calls.map((entry) => entry.message.params?.arguments)).toEqual([
      { text: "hello" },
      { text: "later" },
    ]);
    await expectFixtureProcessesExited(wire);
  }, 45_000);

  for (const childMode of ["persistent"] as const) {
    const label = "persistent";
    test(`${label} child's search never offers a tool a permission rule denies`, async () => {
      const root = createRoot(`${label}-scoped-refresh`, MODERN_FIXTURE, {
        mode: "subscription_cache",
      });
      const allowedWirePath = join(root.root, "allowed-wire.jsonl");
      const deniedWirePath = join(root.root, "denied-wire.jsonl");
      const profilePath = join(root.home, ".lia", "mcp.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      const base = profile.mcp.fixture;
      profile.mcp = {
        allowed: {
          ...base,
          environment: {
            ...base.environment,
            LIA_MCP_WIRE_LOG: allowedWirePath,
            LIA_MCP_PID_PATH: join(root.root, "allowed.pid"),
            LIA_MCP_INITIAL_TOOL_NAME: "echo",
            LIA_MCP_RECOVERED_TOOL_NAME: "echo",
          },
        },
        denied: {
          ...base,
          environment: {
            ...base.environment,
            LIA_MCP_WIRE_LOG: deniedWirePath,
            LIA_MCP_PID_PATH: join(root.root, "denied.pid"),
            LIA_MCP_INITIAL_TOOL_NAME: "blocked",
            LIA_MCP_RECOVERED_TOOL_NAME: "blocked",
          },
        },
      };
      writeFileSync(profilePath, JSON.stringify(profile));
      writeFileSync(
        join(root.home, ".lia", "settings.json"),
        JSON.stringify({
          permission: { mcp_denied_blocked: "deny" },
        }),
      );

      const parentPrompt = `CREATE_SCOPED_REFRESH_${childMode}`;
      const childPrompt = `RUN_SCOPED_REFRESH_${childMode}`;
      let releaseParent!: (response: Response) => void;
      const parentCompletion = new Promise<Response>((resolve) => {
        releaseParent = resolve;
      });
      let searchResult = "";
      const activeGateway = startDynamicFakeGateway(async (body) => {
        // The child's report starts the parent's next turn.
        if (body.includes("Subagent report (untrusted agent output, not user instructions):")) {
          return fakeGatewayFinalText("SCOPED_REFRESH_REPORT_SEEN");
        }
        if (body.includes('"toolCallId":"scoped_refresh_search"')) {
          searchResult = toolResultText(body, "scoped_refresh_search");
          releaseParent(fakeGatewayFinalText("SCOPED_REFRESH_PARENT_READY"));
          return fakeGatewayFinalText("SCOPED_REFRESH_CHILD_READY");
        }
        if (body.includes('"toolCallId":"create_scoped_refresh_child"')) {
          return parentCompletion;
        }
        if (body.includes(childPrompt)) {
          return fakeGatewayToolCall("scoped_refresh_search", "capability_search", {
            query: "echo",
          });
        }
        if (body.includes(parentPrompt)) {
          return fakeGatewayToolCall(
            "create_scoped_refresh_child",
            "subagent",
            {
              request: {
                action: "message",
                agent: "searcher",
                message: childPrompt,
              },
            },
          );
        }
        return fakeGatewayFinalText("unexpected scoped refresh request");
      }, {
        classifierDecision: "clear",
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });
      gateway = activeGateway;

      const result = await runLia(
        ["ask", "--json", "--auto", parentPrompt],
        {
          cwd: root.workspace,
          env: fixtureEnv(root, activeGateway),
          timeoutMs: 30_000,
        },
      );
      if (result.code !== 0) {
        cleanupRoot = null;
        writeFileSync(join(root.root, "scoped-refresh-stdout.log"), result.stdout);
        writeFileSync(join(root.root, "scoped-refresh-stderr.log"), result.stderr);
        writeFileSync(
          join(root.root, "scoped-refresh-diagnostics.json"),
          JSON.stringify({
            childMode,
            result,
            allowedWire: existsSync(allowedWirePath) ? readWire(allowedWirePath) : [],
            deniedWire: existsSync(deniedWirePath) ? readWire(deniedWirePath) : [],
            gatewayRequests: activeGateway.requests.map((request) => request.body),
          }, null, 2),
        );
        throw new Error(`scoped refresh failed; retained artifacts: ${root.root}`);
      }
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).output).toContain("SCOPED_REFRESH_PARENT_READY");
      expect(JSON.parse(result.stdout).output).toContain("SCOPED_REFRESH_REPORT_SEEN");

      expect(searchResult).toContain("mcp_allowed_echo");
      expect(searchResult).not.toContain("mcp_denied_blocked");
      const allowedWire = existsSync(allowedWirePath) ? readWire(allowedWirePath) : [];
      const deniedWire = existsSync(deniedWirePath) ? readWire(deniedWirePath) : [];
      expect(deniedWire.filter((entry) => entry.message.method === "tools/call")).toHaveLength(0);
      await expectFixtureProcessesExited([...allowedWire, ...deniedWire]);
    }, 40_000);
  }

  test("live stdio subscription coalesces duplicate changes and refreshes without reconnect", async () => {
    const root = createRoot("subscription-cache", MODERN_FIXTURE, {
      mode: "subscription_cache",
      recoveredToolName: "fresh",
    });
    const freshTool = "mcp_fixture_fresh";
    gateway = startFakeGateway([
      fakeGatewayToolCall("search_initial", "capability_search", {
        query: "echo",
      }),
      async () => {
        await Bun.sleep(200);
        return fakeGatewayToolCall("search_fresh", "capability_search", {
          query: "fresh",
        });
      },
      fakeGatewayToolCall("select_fresh", "mcp_select_tool", {
        name: freshTool,
      }),
      fakeGatewayToolCall("call_fresh", freshTool, { text: "stdio" }),
      fakeGatewayFinalText("Live stdio cache refresh complete."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Use the live stdio MCP tool."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain(
      "Live stdio cache refresh complete.",
    );
    const wire = readWire(root.wireLogPath);
    expect(wire.filter((entry) => entry.message.method === "tools/list"))
      .toHaveLength(2);
    // One listen; closing stdin at the end ends it with the server.
    expect(wire.filter((entry) =>
      entry.message.method === "subscriptions/listen"
    )).toHaveLength(1);
    const calls = wire.filter((entry) => entry.message.method === "tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message.params?.name).toBe("fresh");
    expect(gateway.requests.some((entry) => entry.body.includes(freshTool)))
      .toBe(true);
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  test("legacy stdio consumes an unscoped Tools list change without modern subscription methods", async () => {
    const root = createRoot("legacy-list-changed", LEGACY_FIXTURE, {
      mode: "list_changed",
    });
    const freshTool = "mcp_fixture_fresh";
    gateway = startFakeGateway([
      fakeGatewayToolCall("search_initial", "capability_search", {
        query: "echo",
      }),
      async () => {
        writeFileSync(root.invalidationReleasePath, "ready");
        await Bun.sleep(100);
        return fakeGatewayToolCall("search_fresh", "capability_search", {
          query: "fresh",
        });
      },
      fakeGatewayToolCall("select_fresh", "mcp_select_tool", {
        name: freshTool,
      }),
      fakeGatewayToolCall("call_fresh", freshTool, { text: "legacy-stdio" }),
      fakeGatewayFinalText("Legacy stdio live refresh complete."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Use the changed legacy stdio tool."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    const wire = readWire(root.wireLogPath);
    const legacyConnection = wire.filter((entry) =>
      entry.message.method !== "server/discover"
    );
    expect(new Set(legacyConnection.map((entry) => entry.pid)).size).toBe(1);
    expect(wire.filter((entry) => entry.message.method === "server/discover"))
      .toHaveLength(1);
    expect(wire.filter((entry) => entry.message.method === "initialize"))
      .toHaveLength(1);
    expect(wire.filter((entry) => entry.message.method === "tools/list"))
      .toHaveLength(2);
    expect(wire.filter((entry) =>
      entry.message.method === "subscriptions/listen"
    )).toHaveLength(0);
    const calls = wire.filter((entry) => entry.message.method === "tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message.params?.name).toBe("fresh");
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  // A server that never answers server/discover gets initialize once the
  // 10 s discovery probe ends.
  test("silent legacy discovery preserves time for initialization", async () => {
    const root = createRoot("silent-discovery", LEGACY_FIXTURE);
    const profilePath = join(root.home, ".lia", "mcp.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.mcp.fixture.environment.LIA_MCP_IGNORE_DISCOVERY = "1";
    writeFileSync(profilePath, JSON.stringify(profile));
    gateway = startToolGateway("Silent discovery fallback worked.");
    const result = await runLia(["ask", "--json", "--auto", "--no-save", "Use the legacy tool"], {
      cwd: root.workspace, env: fixtureEnv(root, gateway), timeoutMs: 20_000,
    });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const wire = readWire(root.wireLogPath);
    expect(wire.filter((entry) => entry.message.method === "tools/call")).toHaveLength(1);
    expect(wire.filter((entry) => entry.message.method === "server/discover")).toHaveLength(1);
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  test("method-not-found discovery negotiates the latest supported legacy stdio version", async () => {
    const root = createRoot("legacy-method-not-found-latest", LEGACY_FIXTURE, {
      legacyVersion: "2025-11-25",
      legacyDiscoveryMethodNotFound: true,
    });
    gateway = startToolGateway("Latest legacy stdio negotiation complete.");

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Use the legacy stdio MCP tool."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain(
      "Latest legacy stdio negotiation complete.",
    );
    const wire = readWire(root.wireLogPath);
    const discover = wire.filter((entry) => entry.message.method === "server/discover");
    const initialize = wire.filter((entry) => entry.message.method === "initialize");
    const calls = wire.filter((entry) => entry.message.method === "tools/call");
    expect(discover).toHaveLength(1);
    expect(initialize).toHaveLength(1);
    expect(initialize[0]?.message.params?.protocolVersion).toBe("2025-11-25");
    // initialize runs in the process that answered discovery.
    expect(initialize[0]?.pid).toBe(discover[0]?.pid);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pid).toBe(initialize[0]?.pid);
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  test("invalid-params discovery falls back through initialize and tools call", async () => {
    const root = createRoot("legacy-invalid-params", LEGACY_FIXTURE, {
      legacyVersion: "2025-11-25",
      legacyDiscoveryInvalidParams: true,
    });
    gateway = startToolGateway("Invalid params fallback complete.");

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Use the legacy stdio MCP tool."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain(
      "Invalid params fallback complete.",
    );
    const wire = readWire(root.wireLogPath);
    expect(wire.filter((entry) => entry.message.method === "server/discover"))
      .toHaveLength(1);
    expect(wire.filter((entry) => entry.message.method === "initialize"))
      .toHaveLength(1);
    expect(wire.filter((entry) => entry.message.method === "tools/list"))
      .toHaveLength(1);
    expect(wire.filter((entry) => entry.message.method === "tools/call"))
      .toHaveLength(1);
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  for (const supportsImages of [true, false]) {
    test(`MCP image results ${supportsImages ? "reach the model as images" : "remain explicit for a text-only model"}`, async () => {
      const root = createRoot("image-output", MODERN_FIXTURE, { mode: "image_result" });
      gateway = startFakeGateway([
        fakeGatewayToolCall("image_select", "mcp_select_tool", { name: TOOL_NAME }),
        fakeGatewayToolCall("image_call", TOOL_NAME, { text: "screenshot" }),
        fakeGatewayFinalText("Image result observed."),
      ], { models: [{ id: MODEL, type: "language", tags: supportsImages ? ["tool-use", "vision", "file-input"] : ["tool-use"] }] });
      const result = await runLia(["ask", "--json", "--auto", "--no-save", "Get an image from the fixture"], {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 20_000,
      });
      expect(result.code).toBe(0);
      const request = JSON.parse(gateway.requests.at(-1)!.body);
      const part = request.prompt.flatMap((message: { content?: unknown[] }) => message.content ?? [])
        .find((value: { type?: string; toolCallId?: string }) => value.type === "tool-result" && value.toolCallId === "image_call");
      expect(part).toBeDefined();
      if (supportsImages) {
        expect(part.output.type).toBe("content");
        expect(part.output.value.every((value: { type: string }) => value.type === "text")).toBe(true);
        expect(part.output.value.find((value: { type: string }) => value.type === "text").text).not.toContain("iVBORw0KGgo");
        const imageMessage = request.prompt.find((message: { role?: string; content?: unknown[] }) =>
          message.role === "user" && Array.isArray(message.content) &&
          (message.content as Array<{ type?: string }>).some((entry) => entry.type === "file"));
        expect(imageMessage).toBeDefined();
        const filePart = (imageMessage.content as Array<Record<string, unknown>>).find((entry) => entry.type === "file")!;
        expect(filePart.mediaType).toBe("image/png");
        expect((filePart.data as Record<string, unknown>).type).toBe("data");
        expect(typeof (filePart.data as Record<string, unknown>).data).toBe("string");
      } else {
        expect(part.output.type).toBe("text");
        expect(part.output.value).toContain("not sent: this model receives image input through the vision tool");
        expect(part.output.value).not.toContain("iVBORw0KGgo");
      }
      await expectFixtureProcessesExited(readWire(root.wireLogPath));
    }, 30_000);
  }

  test("MCP images within request limits reach the model unchanged without a downscale notice", async () => {
    const original = solidPng(3420, 2224);
    const root = createRoot("wide-image-output", MODERN_FIXTURE, { mode: "image_result", image: original });
    gateway = startFakeGateway([
      fakeGatewayToolCall("image_select", "mcp_select_tool", { name: TOOL_NAME }),
      fakeGatewayToolCall("image_call", TOOL_NAME, { text: "screenshot" }),
      fakeGatewayFinalText("Wide image result observed."),
    ], { models: [{ id: MODEL, type: "language", tags: ["tool-use", "vision", "file-input"] }] });
    const result = await runLia(["ask", "--json", "--auto", "--no-save", "Get an image from the fixture"], {
      cwd: root.workspace,
      env: fixtureEnv(root, gateway),
      timeoutMs: 20_000,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("Wide image result observed.");
    const request = JSON.parse(gateway.requests.at(-1)!.body);
    const part = request.prompt.flatMap((message: { content?: unknown[] }) => message.content ?? [])
      .find((value: { type?: string; toolCallId?: string }) => value.type === "tool-result" && value.toolCallId === "image_call");
    expect(part).toBeDefined();
    expect(part.output.type).toBe("content");
    expect(part.output.value.filter((value: { type: string }) => value.type === "text")
      .map((value: { text: string }) => value.text).join("\n")).not.toContain("[Image downscaled");
    const files = request.prompt
      .filter((message: { role?: string; content?: unknown }) => message.role === "user" && Array.isArray(message.content))
      .flatMap((message: { content: Array<Record<string, unknown>> }) => message.content)
      .filter((entry: Record<string, unknown>) => entry.type === "file");
    expect(files).toHaveLength(1);
    expect(files[0].mediaType).toBe("image/png");
    const sent = Buffer.from((files[0].data as { data: string }).data, "base64");
    expect(sent.equals(original)).toBe(true);
    expect(pngPixelSize(sent)).toEqual({ width: 3420, height: 2224 });
    await expectFixtureProcessesExited(readWire(root.wireLogPath));
  }, 30_000);

  test("saved MCP images survive resume without repeating the tool", async () => {
    const root = createRoot("saved-image", MODERN_FIXTURE, { mode: "image_result" });
    const models = [{ id: MODEL, type: "language", tags: ["tool-use", "vision", "file-input"] }];
    gateway = startFakeGateway([
      fakeGatewayToolCall("saved_select", "mcp_select_tool", { name: TOOL_NAME }),
      fakeGatewayToolCall("saved_image", TOOL_NAME, { text: "screenshot" }),
      fakeGatewayFinalText("Screenshot saved."),
    ], { models });
    const first = await runLia(["ask", "--json", "--auto", "Get a screenshot"], {
      cwd: root.workspace, env: fixtureEnv(root, gateway), timeoutMs: 20_000,
    });
    expect(first.code).toBe(0);
    const sessionId = JSON.parse(first.stdout).session_id;
    const imageHandle = gateway.requests.at(-1)!.body.match(/image-result-[\w-]+\.txt/)?.[0];
    expect(imageHandle).toBeDefined();
    gateway.stop();
    gateway = startFakeGateway([
      fakeGatewayToolCall("load_saved_image", "read_tool_result", { request: { handle: imageHandle } }),
      fakeGatewayFinalText("The saved screenshot is visible."),
    ], { models });
    const resumed = await runLia(["ask", "--json", "--auto", "--resume", sessionId, "Describe the earlier screenshot"], {
      cwd: root.workspace, env: fixtureEnv(root, gateway), timeoutMs: 20_000,
    });
    expect(resumed.code).toBe(0);
    const request = JSON.parse(gateway.requests[0]!.body);
    const result = request.prompt.flatMap((message: { content?: unknown[] }) => message.content ?? [])
      .find((part: { type?: string; toolCallId?: string }) => part.type === "tool-result" && part.toolCallId === "saved_image");
    expect(result.output.type).toBe("content");
    const savedImageMessage = request.prompt.find((message: { role?: string; content?: unknown[] }) =>
      message.role === "user" && Array.isArray(message.content) &&
      (message.content as Array<{ type?: string }>).some((entry) => entry.type === "file"));
    expect(savedImageMessage).toBeDefined();
    const secondRequest = JSON.parse(gateway.requests[1]!.body);
    const loaded = secondRequest.prompt
      .flatMap((message: { content?: unknown[] }) => message.content ?? [])
      .find((part: { type?: string; toolCallId?: string }) => part.type === "tool-result" && part.toolCallId === "load_saved_image");
    expect(loaded.output.type).toBe("content");
    const loadedImageMessage = secondRequest.prompt.find((message: { role?: string; content?: unknown[] }) =>
      message.role === "user" && Array.isArray(message.content) &&
      (message.content as Array<{ type?: string }>).some((entry) => entry.type === "file"));
    expect(loadedImageMessage).toBeDefined();
    const wire = readWire(root.wireLogPath);
    expect(wire.filter((entry) => entry.message.method === "tools/call")).toHaveLength(1);
    await expectFixtureProcessesExited(wire);
  }, 40_000);

  test("changed MCP arguments reach the server after earlier failures", async () => {
    const root = createRoot("bounded-equivalent-retries", MODERN_FIXTURE, {
      mode: "tool_failure",
    });
    gateway = startFakeGateway([
      fakeGatewayToolCall("retry_select", "mcp_select_tool", { name: TOOL_NAME }),
      fakeGatewayToolCall("retry_call_1", TOOL_NAME, { text: "one" }),
      fakeGatewayToolCall("retry_call_2", TOOL_NAME, { text: "two" }),
      fakeGatewayToolCall("retry_call_3", TOOL_NAME, { text: "three" }),
      fakeGatewayFinalText("Bounded MCP retries complete."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Call the failing MCP tool."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("Bounded MCP retries complete.");
    const wire = readWire(root.wireLogPath);
    expect(wire.filter((entry) => entry.message.method === "tools/call"))
      .toHaveLength(3);
    expect(gateway.requests.at(-1)?.body).not.toContain(
      "Repeated MCP tool call blocked: two equivalent attempts failed",
    );
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  test("successful discovery selects the latest legacy version from an oldest-first list", async () => {
    const root = createRoot("legacy-discovery-oldest-first", LEGACY_FIXTURE, {
      legacyVersion: "2025-11-25",
      legacyDiscoveryVersions: ["2024-11-05", "2025-06-18", "2025-11-25"],
    });
    gateway = startToolGateway("Ordered legacy stdio negotiation complete.");

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Use the legacy stdio MCP tool."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, gateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    const wire = readWire(root.wireLogPath);
    const discover = wire.filter((entry) => entry.message.method === "server/discover");
    const initialize = wire.filter((entry) => entry.message.method === "initialize");
    expect(discover).toHaveLength(1);
    expect(initialize).toHaveLength(1);
    expect(initialize[0]?.message.params?.protocolVersion).toBe("2025-11-25");
    // initialize runs in the process that answered discovery.
    expect(initialize[0]?.pid).toBe(discover[0]?.pid);
    expect(wire.filter((entry) => entry.message.method === "tools/call"))
      .toHaveLength(1);
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  // A server that dies while starting is reported in its own words.
  test("lia mcp show reports how a stdio server that exits during startup ended", async () => {
    const root = createRoot("startup-exit", LEGACY_FIXTURE, {
      mode: "startup_exit",
      recordLaunchAttempts: true,
    });

    const result = await runLia(["mcp", "show", "fixture", "--json"], {
      cwd: root.workspace,
      env: {
        HOME: root.home,
        AI_GATEWAY_API_KEY: undefined,
        VERCEL_OIDC_TOKEN: undefined,
        LIA_TRACE_LOG: root.traceLogPath,
        LIA_TRACE_SCOPES: "mcp",
      },
      timeoutMs: 20_000,
    });

    expect(result.code).toBe(1);
    const status = JSON.parse(result.stdout);
    expect(status.status).toBe("retrying");
    expect(status.error).toContain("exited with code 7");
    expect(status.error).toContain("npm error code E401");
    const launches = readAttemptedPids(root.launchLogPath);
    expect(launches).toHaveLength(1);
    await expectProcessesExited(launches);
  }, 30_000);

  // A start gets 30 s from launch, so a 2025 server that never answers
  // initialize fails then instead of after the 60 s request timeout. What it
  // wrote instead of an answer is quoted.
  test("lia mcp show ends the start of a 2025 stdio server that answers with a line that isn't JSON, and quotes it", async () => {
    const root = createRoot("startup-garbage", LEGACY_FIXTURE, {
      mode: "startup_garbage",
      recordLaunchAttempts: true,
    });

    const started = Date.now();
    const result = await runLia(["mcp", "show", "fixture", "--json"], {
      cwd: root.workspace,
      env: {
        HOME: root.home,
        AI_GATEWAY_API_KEY: undefined,
        VERCEL_OIDC_TOKEN: undefined,
        LIA_TRACE_LOG: root.traceLogPath,
        LIA_TRACE_SCOPES: "mcp",
      },
      timeoutMs: 45_000,
    });

    expect(result.code).toBe(1);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(29_000);
    expect(elapsed).toBeLessThan(40_000);
    const status = JSON.parse(result.stdout);
    expect(status.error).toContain("not json");
    const launches = readAttemptedPids(root.launchLogPath);
    expect(launches).toHaveLength(1);
    await expectProcessesExited(launches);
  }, 60_000);

  // A banner on stdout is a common server mistake; it's quoted.
  test("lia mcp show quotes the stdout line a 2026 stdio server wrote instead of answering", async () => {
    const root = createRoot("modern-startup-garbage", MODERN_FIXTURE, {
      mode: "startup_garbage",
      recordLaunchAttempts: true,
    });

    const result = await runLia(["mcp", "show", "fixture", "--json"], {
      cwd: root.workspace,
      env: {
        HOME: root.home,
        AI_GATEWAY_API_KEY: undefined,
        VERCEL_OIDC_TOKEN: undefined,
        LIA_TRACE_LOG: root.traceLogPath,
        LIA_TRACE_SCOPES: "mcp",
      },
      timeoutMs: 20_000,
    });

    expect(result.code).toBe(1);
    const status = JSON.parse(result.stdout);
    expect(status.error).toContain("Server started on stdio");
    const launches = readAttemptedPids(root.launchLogPath);
    expect(launches.length).toBeGreaterThanOrEqual(1);
    await expectProcessesExited(launches);
  }, 30_000);

  test("lia ask search tells the model why a named stdio server failed to start", async () => {
    const root = createRoot("ask-startup-exit", LEGACY_FIXTURE, {
      mode: "startup_exit",
      recordLaunchAttempts: true,
    });
    const activeGateway = startFakeGateway([
      fakeGatewayToolCall("search_failed", "capability_search", {
        kind: "mcp",
        server: "fixture",
        query: "fixture tools",
        limit: 5,
      }),
      fakeGatewayFinalText("STARTUP_FAILURE_REPORTED"),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    gateway = activeGateway;

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Find the fixture tools."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("STARTUP_FAILURE_REPORTED");
    const searchResult = toolResultText(activeGateway.requests[1]?.body ?? "", "search_failed");
    expect(searchResult).toContain("MCP server 'fixture' is unavailable: ");
    // The server's own words: its exit code and last stderr lines.
    expect(searchResult).toContain("exited with code 7");
    expect(searchResult).toContain("npm error code E401");
    await expectProcessesExited(readAttemptedPids(root.launchLogPath));
  }, 30_000);

  test("lia ask tells the model why a stopped stdio server could not restart", async () => {
    const root = createRoot("ask-restart-failed", MODERN_FIXTURE, {
      mode: "exit_after_result",
      recordLaunchAttempts: true,
    });
    // The first launch runs the server; every relaunch fails during startup.
    const profilePath = join(root.home, ".lia", "mcp.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.mcp.fixture.command = [
      "/bin/sh",
      "-c",
      `printf '%s\\n' "$$" >> "$LIA_MCP_LAUNCH_LOG"
if [ "$(wc -l < "$LIA_MCP_LAUNCH_LOG")" -gt 1 ]; then echo 'relaunch blocked by test' >&2; exit 5; fi
exec "$LIA_MCP_FIXTURE_RUNTIME" "$LIA_MCP_FIXTURE_PATH"`,
    ];
    writeFileSync(profilePath, JSON.stringify(profile));
    let sawFirstExit = true;
    const activeGateway = startFakeGateway([
      fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
      fakeGatewayToolCall("first_call", TOOL_NAME, { text: "first" }),
      async () => {
        // Call again only after the first server has exited.
        const firstExited = () => {
          const [pid] = readAttemptedPids(root.launchLogPath);
          if (pid === undefined) return false;
          try {
            process.kill(Number(pid), 0);
            return false;
          } catch {
            return true;
          }
        };
        const deadline = Date.now() + 5_000;
        while (!firstExited()) {
          if (Date.now() >= deadline) {
            sawFirstExit = false;
            break;
          }
          await Bun.sleep(20);
        }
        return fakeGatewayToolCall("second_call", TOOL_NAME, { text: "second" });
      },
      fakeGatewayFinalText("RESTART_FAILURE_REPORTED"),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    gateway = activeGateway;

    const started = Date.now();
    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Call the fixture tool twice."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      },
    );

    expect(sawFirstExit, "lia never saw the first server exit").toBe(true);
    expect(result.code).toBe(0);
    // The second call fails with the relaunch it waited for, not after
    // every try the backoff allows.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(JSON.parse(result.stdout).output).toContain("RESTART_FAILURE_REPORTED");
    expect(activeGateway.requests[2]?.body).toContain("MODERN_MCP_TOOL_RESULT:first");
    // The relaunch's own words reach the model: its exit code and stderr.
    const secondResult = toolResultText(activeGateway.requests[3]?.body ?? "", "second_call");
    expect(secondResult).toContain("exited with code 5");
    expect(secondResult).toContain("relaunch blocked by test");
    const launches = readAttemptedPids(root.launchLogPath);
    expect(launches.length).toBeGreaterThanOrEqual(2);
    await expectProcessesExited(launches);
  }, 30_000);

  for (
    const malformed of [
      { mode: "response_missing_jsonrpc", label: "missing jsonrpc" },
      { mode: "response_wrong_jsonrpc", label: "wrong jsonrpc" },
      { mode: "response_missing_payload", label: "missing result and error" },
      { mode: "response_ambiguous_payload", label: "result and error together" },
    ] as const
  ) {
    // A reply with a pending request's id that isn't valid JSON-RPC fails
    // that request at once, here the start's discover, not at its timeout.
    test(`malformed stdio response with ${malformed.label} fails deferred activation and reaps the child`, async () => {
      const root = createRoot(`malformed-${malformed.mode}`, MODERN_FIXTURE, {
        mode: malformed.mode,
      });
      gateway = startFakeGateway([
        fakeGatewayToolCall("search_malformed", "capability_search", {
          query: "fixture",
        }),
        fakeGatewayFinalText("Malformed stdio fixture isolated."),
      ], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });

      const started = Date.now();
      const result = await runLia(
        ["ask", "--json", "--auto", "--no-save", "Exercise the malformed MCP fixture."],
        {
          cwd: root.workspace,
          env: fixtureEnv(root, gateway),
          timeoutMs: 20_000,
        },
      );

      expect(result.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(gateway.requests[0]?.body).not.toContain(TOOL_NAME);
      const wire = readWire(root.wireLogPath);
      expect(wire.some((entry) => entry.message.method === "server/discover"))
        .toBe(true);
      await expectFixtureProcessesExited(wire);
    }, 30_000);
  }

  for (
    const fixture of [
      {
        label: "modern",
        path: MODERN_FIXTURE,
        result: MODERN_RESULT,
        expectedLaunches: 1,
        expectedMethods: ["server/discover", "subscriptions/listen", "tools/list", "tools/call"],
      },
      {
        label: "legacy",
        path: LEGACY_FIXTURE,
        result: LEGACY_RESULT,
        // Discovery and initialize share one process.
        expectedLaunches: 1,
        expectedMethods: [
          "server/discover",
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/call",
        ],
      },
    ] as const
  ) {
    test(`lia ask calls the ${fixture.label} stdio fixture`, async () => {
      const root = createRoot(`ask-${fixture.label}`, fixture.path, {
        recordLaunchAttempts: true,
      });
      const activeGateway = startToolGateway(`${fixture.label} MCP complete.`);
      gateway = activeGateway;
      const result = await runLia(
        ["ask", "--json", "--auto", "--no-save", `Call the ${fixture.label} MCP fixture.`],
        {
          cwd: root.workspace,
          env: fixtureEnv(root, activeGateway),
          timeoutMs: 20_000,
        },
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).output).toContain(`${fixture.label} MCP complete.`);
      expect(activeGateway.requests).toHaveLength(3);
      expect(activeGateway.requests[2]?.body).toContain(`${fixture.result}:hello`);
      expect(readAttemptedPids(root.launchLogPath)).toHaveLength(
        fixture.expectedLaunches,
      );

      const wire = readWire(root.wireLogPath);
      // A 2026 server's listen goes out beside the first tools/list, in
      // either order.
      const methods = wire.map((entry) => entry.message.method);
      expect([...methods].sort()).toEqual([...fixture.expectedMethods].sort());
      expect(methods[0]).toBe("server/discover");
      expect(methods.at(-1)).toBe("tools/call");
      if (fixture.label === "modern") {
        for (const entry of wire) {
          const meta = entry.message.params?._meta as Record<string, unknown>;
          expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
          expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
        }
      } else {
        expect(new Set(wire.map((entry) => entry.pid)).size).toBe(1);
        // initialize follows server/discover in the same process.
        const initialize = wire.find((entry) => entry.message.method === "initialize");
        expect(initialize?.sequence).toBe(2);
        // Each request carries its own progress token.
        const list = wire.find((entry) => entry.message.method === "tools/list");
        expect(list?.message.params?._meta).toEqual({
          progressToken: expect.any(Number),
        });
        const call = wire.find((entry) => entry.message.method === "tools/call");
        expect(call?.message.params?._meta).toEqual({
          progressToken: expect.any(Number),
        });
      }
      await expectFixtureProcessesExited(wire);
    });
  }

  // As the MCP SDKs do, lia gives a stdio server only HOME, LOGNAME, PATH,
  // SHELL, TERM and USER of its environment, then the server's own `env`;
  // never lia's Gateway key or anything else.
  test("a stdio server gets only the MCP SDKs' few variables of lia's, then its config's env", async () => {
    const root = createRoot("ask-environment-sdk", MODERN_FIXTURE, { captureEnvironment: true });
    const namesPath = join(root.root, "mcp-environment-names.json");
    const profilePath = join(root.home, ".lia", "mcp.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.mcp.fixture.environment.LIA_MCP_ENV_NAMES_CAPTURE = namesPath;
    writeFileSync(profilePath, JSON.stringify(profile));
    const configured = Object.keys(profile.mcp.fixture.environment);
    const activeGateway = startToolGateway("Environment kept small.");
    gateway = activeGateway;
    const parentPath = process.env.PATH ?? "/usr/bin:/bin";

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Call the environment MCP fixture."],
      {
        cwd: root.workspace,
        env: {
          ...fixtureEnv(root, activeGateway),
          PATH: parentPath,
          LIA_MCP_INHERITED_SENTINEL: "inherited-parent-value",
          HTTPS_PROXY: "http://proxy.example.test:8080",
        },
        timeoutMs: 20_000,
      },
    );

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("Environment kept small.");
    expect(JSON.parse(readFileSync(root.environmentCapturePath, "utf8"))).toEqual({
      configured: "configured",
      path: parentPath,
      home: root.home,
    });
    const names = JSON.parse(readFileSync(namesPath, "utf8")) as string[];
    const allowed = new Set(["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", ...configured]);
    expect(names.filter((name) => !allowed.has(name))).toEqual([]);
    expect(names).not.toContain("AI_GATEWAY_API_KEY");
    await expectFixtureProcessesExited(readWire(root.wireLogPath));
  }, 30_000);

  for (const discovery of ["select", "search"] as const) {
    test(`targeted MCP ${discovery} leaves unrelated optional servers dormant`, async () => {
      const root = createRoot("targeted-activation", MODERN_FIXTURE);
      const profilePath = join(root.home, ".lia", "mcp.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      const unrelatedWire = join(root.root, "unrelated-wire.jsonl");
      profile.mcp.unrelated = { ...profile.mcp.fixture, environment: {
        ...profile.mcp.fixture.environment,
        LIA_MCP_MODE: "stall_startup", LIA_MCP_WIRE_LOG: unrelatedWire,
        LIA_MCP_PID_PATH: join(root.root, "unrelated.pid"),
      } };
      writeFileSync(profilePath, JSON.stringify(profile));
      gateway = startFakeGateway([
        discovery === "select"
          ? fakeGatewayToolCall("target_select", "mcp_select_tool", { name: TOOL_NAME })
          : fakeGatewayToolCall("target_search", "capability_search", { server: "fixture", query: "echo" }),
        fakeGatewayToolCall("target_call", TOOL_NAME, { text: "hello" }),
        fakeGatewayFinalText("Targeted server works."),
      ], { models: [{ id: MODEL, type: "language", tags: ["tool-use"] }] });
      const result = await runLia(["ask", "--json", "--auto", "--no-save", "Use the fixture server"], {
        cwd: root.workspace, env: fixtureEnv(root, gateway), timeoutMs: 20_000,
      });
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(existsSync(unrelatedWire)).toBe(false);
      expect(readWire(root.wireLogPath).filter((entry) => entry.message.method === "tools/call")).toHaveLength(1);
      await expectFixtureProcessesExited(readWire(root.wireLogPath));
    }, 30_000);
  }

  test("lia ask does not start an unused optional MCP server", async () => {
    const root = createRoot("ask-unused-optional", MODERN_FIXTURE, {
      recordLaunchAttempts: true,
    });
    const activeGateway = startFakeGateway([
      fakeGatewayFinalText("No MCP operation needed."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    gateway = activeGateway;

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Answer without using MCP."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 10_000,
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("No MCP operation needed.");
    expect(activeGateway.requests).toHaveLength(1);
    expect(readAttemptedPids(root.launchLogPath)).toHaveLength(0);
    expect(existsSync(root.wireLogPath)).toBe(false);
  }, 15_000);

  test("lia ask accepts the official legacy SDK Draft 7 tool schema", async () => {
    const root = createRoot("ask-legacy-draft7", LEGACY_FIXTURE, {
      mode: "draft7_schema",
    });
    const activeGateway = startToolGateway("Legacy Draft 7 complete.");
    gateway = activeGateway;
    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Call the legacy Draft 7 MCP fixture."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("Legacy Draft 7 complete.");
    expect(activeGateway.requests[2]?.body).toContain(`${LEGACY_RESULT}:hello`);
    const wire = readWire(root.wireLogPath);
    expect(wire.map((entry) => entry.message.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(wire.find((entry) => entry.message.method === "tools/call")?.message.params?.arguments)
      .toEqual({ text: "hello" });
    await expectFixtureProcessesExited(wire);
  });

  test("lia ask lets the legacy server validate Draft 7 arguments", async () => {
    const root = createRoot("ask-legacy-draft7-invalid", LEGACY_FIXTURE, {
      mode: "draft7_schema",
      draft7Pattern: "^\\S+$",
    });
    const activeGateway = startFakeGateway([
      fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
      fakeGatewayToolCall("call_mcp", TOOL_NAME, { text: "\u00A0" }),
      fakeGatewayFinalText("Legacy Draft 7 invalid complete."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    gateway = activeGateway;
    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Try invalid legacy Draft 7 arguments."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    const resultPart = JSON.parse(activeGateway.requests[2]!.body).prompt
      .flatMap((message: { content?: unknown[] }) => message.content ?? [])
      .find((part: { type?: string; toolCallId?: string }) => part.type === "tool-result" && part.toolCallId === "call_mcp");
    expect(resultPart.output.type).toBe("error-text");
    expect(resultPart.output.value).toContain("text violates the server pattern");
    const wire = readWire(root.wireLogPath);
    expect(wire.filter((entry) => entry.message.method === "tools/call")).toHaveLength(1);
    await expectFixtureProcessesExited(wire);
  });

  test("lia ask routes legacy stdio progress", async () => {
    const root = createRoot("ask-legacy-progress", LEGACY_FIXTURE, {
      mode: "progress",
    });
    const activeGateway = startToolGateway("Legacy progress complete.");
    gateway = activeGateway;
    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Call the legacy MCP fixture."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Legacy MCP fixture halfway");
    const wire = readWire(root.wireLogPath);
    const call = wire.find((entry) => entry.message.method === "tools/call");
    expect(call?.message.params?._meta).toEqual({
      progressToken: expect.any(Number),
    });
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  test("noninteractive lia ask returns typed input-required without fabricating a continuation", async () => {
    const root = createRoot("ask-mrtr", MODERN_FIXTURE, {
      mode: "mrtr_input_required",
    });
    const activeGateway = startToolGateway("MRTR Ask boundary complete.");
    gateway = activeGateway;
    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Call the MRTR MCP fixture."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      },
    );

    // With no way to ask, the call ends and the model hears why; nothing is
    // made up and sent back to the server.
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("MRTR Ask boundary complete.");
    expect(activeGateway.requests).toHaveLength(3);
    expect(toolResultText(activeGateway.requests[2]?.body ?? "", "call_mcp")).toBe(
      "MCP server 'fixture' ended the call: the server asked for input lia can't give.",
    );
    expect(activeGateway.requests[1]?.body).not.toContain("inputResponses");
    const wire = readWire(root.wireLogPath);
    const calls = wire.filter(
      (entry) => entry.message.method === "tools/call",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message.params?.inputResponses).toBeUndefined();
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  test("lia ask tells the model that a stdio call outlived its operation timeout", async () => {
    const root = createRoot("ask-operation-timeout", MODERN_FIXTURE, {
      mode: "stall_operation",
      operationTimeoutMs: 1_500,
    });
    const activeGateway = startToolGateway("Operation timeout complete.");
    gateway = activeGateway;
    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Call the stalled MCP fixture."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      },
    );

    // lia stops waiting, cancels the call on the server, and tells the model
    // why and how to wait longer, rather than that the call was cancelled.
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("Operation timeout complete.");
    expect(activeGateway.requests).toHaveLength(3);
    const toolResult = toolResultText(activeGateway.requests[2]?.body ?? "", "call_mcp");
    expect(toolResult).toStartWith("lia stopped waiting for MCP server 'fixture': it did not answer within its operation timeout.");
    expect(toolResult).toContain("Raise operation_timeout_ms for this server in its MCP config if it needs longer.");
    expect(toolResult).not.toContain("Cancelled");
    const wire = readWire(root.wireLogPath);
    const call = wire.filter((entry) => entry.message.method === "tools/call").at(-1);
    const cancelled = wire.find((entry) => entry.message.method === "notifications/cancelled");
    expect(cancelled?.message.params?.requestId).toBe(call?.message.id);
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  test("negotiated 2025-06 treats a URL-required error as an ordinary failure", async () => {
    const root = createRoot("ask-legacy-url-required-unsupported", LEGACY_FIXTURE, {
      mode: "url_required_error",
      legacyVersion: "2025-06-18",
      elicitationUrl: "https://example.test/unsupported-version",
    });
    const activeGateway = startToolGateway("Legacy URL-required version gate complete.");
    gateway = activeGateway;
    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Call the legacy URL-required fixture."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      },
    );

    expect(result.code).toBe(0);
    const wire = readWire(root.wireLogPath);
    const calls = wire.filter((entry) => entry.message.method === "tools/call");
    expect(calls).toHaveLength(1);
    expect(activeGateway.requests[2]?.body).toContain("MCP protocol error -32042");
    await expectFixtureProcessesExited(wire);
  }, 30_000);

  // A long tool's progress notes show while it runs.
  test("lia ask shows a 2026 server's progress notes", async () => {
    const progressRoot = createRoot("ask-progress", MODERN_FIXTURE, {
      mode: "progress",
    });
    const progressGateway = startToolGateway("Progress MCP complete.");
    gateway = progressGateway;
    const progressResult = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Call the progress MCP fixture."],
      {
        cwd: progressRoot.workspace,
        env: fixtureEnv(progressRoot, progressGateway),
        timeoutMs: 20_000,
      },
    );
    expect(progressResult.code).toBe(0);
    expect(progressResult.stderr).toContain("MCP fixture halfway");
    const progressWire = readWire(progressRoot.wireLogPath);
    const progressCall = progressWire.find(
      (entry) => entry.message.method === "tools/call",
    );
    expect(progressCall?.message.params?._meta).toMatchObject({
      progressToken: expect.any(Number),
    });
    await expectFixtureProcessesExited(progressWire);
  }, 45_000);

  test("headless MCP startup cancels through the caller", async () => {
    const root = createRoot("startup-caller-cancel", MODERN_FIXTURE, {
      mode: "stall_startup", startupTimeoutMs: 5_000, restartLimit: 0,
    });
    gateway = startFakeGateway([
      fakeGatewayToolCall("cancel_startup", "capability_search", { server: "fixture", query: "echo" }),
      fakeGatewayFinalText("Unexpected continuation."),
    ], { models: [{ id: MODEL, type: "language", tags: ["tool-use"] }] });
    const proc = Bun.spawn([join(REPO_ROOT, "zig-out", "bin", "lia"), "ask", "--json", "--auto", "--no-save", "Find the fixture tool"], {
      cwd: root.workspace, env: { ...process.env, ...fixtureEnv(root, gateway) }, stdout: "ignore", stderr: "ignore",
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(root.wireLogPath) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(root.wireLogPath)).toBe(true);
      proc.kill("SIGINT");
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(1_500).then(() => false)]);
      expect(exited).toBe(true);
      expect(gateway.requests).toHaveLength(1);
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited;
      if (existsSync(root.wireLogPath)) await expectFixtureProcessesExited(readWire(root.wireLogPath));
    }
  }, 15_000);

  test(
    "lia mcp show reports a ready stdio server without its environment's values",
    async () => {
      const root = createRoot("health-output", MODERN_FIXTURE);
      const profilePath = join(root.home, ".lia", "mcp.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      profile.mcp.fixture.environment.S11_SECRET_ENV = "HEALTH_SECRET_SENTINEL";
      writeFileSync(profilePath, JSON.stringify(profile));
      const activeGateway = startFakeGateway([
        fakeGatewayFinalText("health gateway should remain unused"),
      ], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });
      gateway = activeGateway;

      const result = await runLia(["mcp", "show", "fixture", "--json"], {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const status = JSON.parse(result.stdout);
      expect({ status: status.status, source: status.source, transport: status.transport, version: status.version })
        .toEqual({ status: "ready", source: "profile", transport: "stdio", version: "2026-07-28" });
      expect(status.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);
      // The server's environment and lia's Gateway key never show.
      for (const forbidden of ["HEALTH_SECRET_SENTINEL", "S11_SECRET_ENV", "fake-mcp-stdio-key", root.workspace]) {
        expect(result.stdout).not.toContain(forbidden);
      }
      expect(activeGateway.requests).toHaveLength(0);
      await expectFixtureProcessesExited(readWire(root.wireLogPath));
    },
    35_000,
  );

  test("lia ask performs one fresh-discovery restart without replaying the failed call", async () => {
    const root = createRoot("ask-restart", MODERN_FIXTURE, {
      mode: "crash_once",
      restartLimit: 1,
    });
    const activeGateway = startFakeGateway([
      fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
      fakeGatewayToolCall("crashing_mcp", TOOL_NAME, { text: "first" }),
      fakeGatewayToolCall("recovered_mcp", TOOL_NAME, { text: "second" }),
      fakeGatewayFinalText("Restarted MCP complete."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    gateway = activeGateway;

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Recover the MCP fixture once."],
      {
        cwd: root.workspace,
        env: fixtureEnv(root, activeGateway),
        timeoutMs: 20_000,
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("Restarted MCP complete.");
    // A call the crash took is not replayed: it may have run.
    expect(toolResultText(activeGateway.requests[2]?.body ?? "", "crashing_mcp")).toBe(
      "MCP server 'fixture' ended the call: the server went away. The tool may have run.",
    );
    expect(activeGateway.requests[3]?.body).toContain(`${MODERN_RESULT}:second`);

    const wire = readWire(root.wireLogPath);
    const pids = new Set(wire.map((entry) => entry.pid));
    expect(pids.size).toBe(2);
    expect(
      wire.filter((entry) => entry.message.method === "server/discover"),
    ).toHaveLength(2);
    const toolCalls = wire.filter(
      (entry) => entry.message.method === "tools/call",
    );
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.message.params?.arguments).toEqual({ text: "first" });
    expect(toolCalls[1]?.message.params?.arguments).toEqual({ text: "second" });
    await expectFixtureProcessesExited(wire);
  }, 30_000);

});

describe("MCP stdio servers", () => {
  const v2Env = (root: FixtureRoot, activeGateway: ReturnType<typeof startFakeGateway>) => ({
    ...fixtureEnv(root, activeGateway),
  });
  const modelSaw = () => gateway!.requests.map((request) => request.body).join("\n");
  const ask = (root: FixtureRoot, prompt: string) =>
    runLia(["ask", "--json", "--auto", "--no-save", prompt], {
      cwd: root.workspace,
      env: v2Env(root, gateway!),
      timeoutMs: 20_000,
    });
  const calls = (root: FixtureRoot) =>
    readWire(root.wireLogPath).filter((entry) => entry.message.method === "tools/call");

  for (const [era, fixture, resultText] of [
    ["2026", MODERN_FIXTURE, MODERN_RESULT],
    ["2025", LEGACY_FIXTURE, LEGACY_RESULT],
  ] as const) {
    test(`lia ask selects and calls a ${era} stdio tool`, async () => {
      // A 2025-11-25 server, the newest before 2026.
      const root = createRoot(`v2-call-${era}`, fixture, { legacyVersion: "2025-11-25" });
      gateway = startToolGateway(`V2_${era}_DONE`);
      const result = await ask(root, "Use the stdio MCP echo tool.");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`V2_${era}_DONE`);
      expect(modelSaw()).toContain(resultText);
      // The server's instructions come with the selected tool.
      if (era === "2026") expect(modelSaw()).toContain("Use the modern echo tool.");
      expect(calls(root)).toHaveLength(1);
      await expectFixtureProcessesExited(readWire(root.wireLogPath));
    }, 25_000);
  }

  test("a 2025 server that pings before it answers initialize gets its pong, and its tool is called", async () => {
    // It holds its initialize answer until lia answers the ping, as a server
    // that blocks on it would (STDIO-09).
    const root = createRoot("v2-ping-before-initialize", LEGACY_FIXTURE, { legacyVersion: "2025-11-25", mode: "ping_before_initialize" });
    gateway = startToolGateway("V2_PING_DONE");
    const result = await ask(root, "Use the stdio MCP echo tool.");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("V2_PING_DONE");
    expect(modelSaw()).toContain(LEGACY_RESULT);
    expect(calls(root)).toHaveLength(1);
    // The pong came during the handshake, before notifications/initialized.
    const wire = readWire(root.wireLogPath);
    const pong = wire.findIndex((entry) => entry.message.id === "legacy-ping" && entry.message.method === undefined);
    const initialized = wire.findIndex((entry) => entry.message.method === "notifications/initialized");
    expect(pong).toBeGreaterThanOrEqual(0);
    expect(pong).toBeLessThan(initialized);
    await expectFixtureProcessesExited(wire);
  }, 25_000);

  test("a server that only speaks 2024-11-05 is reported, not waited on", async () => {
    const root = createRoot("v2-2024", LEGACY_FIXTURE, { legacyVersion: "2024-11-05" });
    gateway = startToolGateway("V2_2024_SEEN");
    const started = Date.now();
    const result = await ask(root, "Use the stdio MCP echo tool.");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("V2_2024_SEEN");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(calls(root)).toHaveLength(0);
    expect(modelSaw()).toContain("MCP server 'fixture' is unavailable");
    expect(modelSaw()).toContain("an MCP version lia doesn't support");
  }, 25_000);

  test("capability_search finds the tool under its lia name and the model calls it", async () => {
    const root = createRoot("v2-search", MODERN_FIXTURE);
    gateway = startFakeGateway([
      fakeGatewayToolCall("search", "capability_search", { query: "echo", server: "fixture" }),
      fakeGatewayToolCall("call", TOOL_NAME, { text: "hello" }),
      fakeGatewayFinalText("V2_SEARCH_DONE"),
    ], { models: [{ id: MODEL, type: "language", tags: ["tool-use"] }] });
    const result = await ask(root, "Find the echo tool and use it.");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("V2_SEARCH_DONE");
    expect(modelSaw()).toContain(`\\"name\\":\\"${TOOL_NAME}\\",\\"server\\":\\"fixture\\"`);
    expect(modelSaw()).toContain(MODERN_RESULT);
    expect(calls(root)).toHaveLength(1);
  }, 25_000);

  test("a tool's own failure reaches the model and the turn goes on", async () => {
    const root = createRoot("v2-tool-failure", MODERN_FIXTURE, { mode: "tool_failure" });
    gateway = startToolGateway("V2_FAILURE_SEEN");
    const result = await ask(root, "Use the stdio MCP echo tool.");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("V2_FAILURE_SEEN");
    expect(modelSaw()).toContain("isError");
  }, 25_000);

  test("a server that dies during a call tells the model the call ended", async () => {
    const root = createRoot("v2-crash", MODERN_FIXTURE, { mode: "crash_always" });
    gateway = startToolGateway("V2_CRASH_SEEN");
    const result = await ask(root, "Use the stdio MCP echo tool.");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("V2_CRASH_SEEN");
    expect(modelSaw()).toContain("MCP server 'fixture' ended the call");
  }, 25_000);

  test("lia ask with no way to ask tells the model the server wanted input", async () => {
    const root = createRoot("v2-no-asker", MODERN_FIXTURE, { mode: "mrtr_input_required" });
    gateway = startToolGateway("V2_INPUT_DECLINED_SEEN");
    const result = await ask(root, "Call the MRTR MCP fixture.");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("V2_INPUT_DECLINED_SEEN");
    expect(modelSaw()).toContain("the server asked for input lia can't give");
  }, 25_000);

  test("a search for a server that isn't configured says so", async () => {
    const root = createRoot("v2-not-found", MODERN_FIXTURE);
    gateway = startFakeGateway([
      fakeGatewayToolCall("search", "capability_search", { query: "echo", server: "nope" }),
      fakeGatewayFinalText("V2_NOT_FOUND_SEEN"),
    ], { models: [{ id: MODEL, type: "language", tags: ["tool-use"] }] });
    const result = await ask(root, "Find a tool on nope.");
    expect(result.code).toBe(0);
    expect(modelSaw()).toContain("server_not_found");
    // Nothing needed the configured server, so it never started.
    expect(existsSync(root.wireLogPath)).toBe(false);
  }, 25_000);
});

// `lia mcp call` lets a command lia's shell tool runs call the session's MCP
// tools, so a big result can go to a file and only what the command prints
// reaches the model (`src/core/mcp_host/mcp_call_bridge.zig`).
describe("lia mcp call", () => {
  const bridgeRoot = (label: string, settings: Record<string, unknown> = {}, options: RootOptions = {}) => {
    const root = createRoot(label, MODERN_FIXTURE, options);
    const profilePath = join(root.home, ".lia", "mcp.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.mcp.fixture.environment.LIA_MCP_RESULT_PAD_BYTES = String(1536 * 1024);
    profile.mcp.fixture.environment.LIA_MCP_RESULT_TEXT = "BRIDGE_TAIL";
    writeFileSync(profilePath, JSON.stringify(profile));
    writeFileSync(join(root.home, ".lia", "settings.json"), JSON.stringify(settings));
    return root;
  };
  const command = `"${LIA_BIN}" mcp call ${TOOL_NAME} '{"text":"hello"}' > out.txt; echo "exit=$?"; wc -c < out.txt | tr -d ' '; tail -c 18 out.txt`;
  const toolCalls = (root: FixtureRoot) =>
    existsSync(root.wireLogPath)
      ? readWire(root.wireLogPath).filter((entry) => entry.message.method === "tools/call")
      : [];

  test("a command saves a big MCP result to a file, and only what it prints reaches the model", async () => {
    const root = bridgeRoot("bridge-file");
    let seen = "";
    gateway = startFakeGateway([
      fakeGatewayToolCall("run_call", "shell", { action: "run", command }),
      (body: string) => {
        seen = toolResultText(body, "run_call");
        return fakeGatewayFinalText("BRIDGE_DONE");
      },
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    const result = await runLia(["ask", "--json", "--full-access", "--no-save", "Save the list to a file."], {
      cwd: root.workspace,
      env: fixtureEnv(root, gateway),
      timeoutMs: 40_000,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("BRIDGE_DONE");
    expect(seen).toContain("exit=0");
    expect(seen).toContain("BRIDGE_TAIL:hello");
    expect(seen.length).toBeLessThan(4096);
    const saved = readFileSync(join(root.workspace, "out.txt"), "utf8");
    expect(saved.length).toBeGreaterThan(1536 * 1024);
    expect(saved.trimEnd().endsWith("BRIDGE_TAIL:hello")).toBe(true);
    // Its stderr line tells the model what the file holds.
    expect(seen).toContain(`lia mcp call: wrote ${Buffer.byteLength(saved)} bytes of text`);
    expect(toolCalls(root)).toHaveLength(1);
  }, 60_000);

  test("a call the permission rules deny runs nothing, and the command learns why", async () => {
    const root = bridgeRoot("bridge-denied", { permission: { bash: { "*": "allow" }, [TOOL_NAME]: "deny" } });
    let seen = "";
    gateway = startFakeGateway([
      fakeGatewayToolCall("run_call", "shell", { action: "run", command }),
      (body: string) => {
        seen = toolResultText(body, "run_call");
        return fakeGatewayFinalText("BRIDGE_DENIED");
      },
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    const result = await runLia(["ask", "--json", "--auto", "--no-save", "Save the list to a file."], {
      cwd: root.workspace,
      env: fixtureEnv(root, gateway),
      timeoutMs: 40_000,
    });
    expect(result.code).toBe(0);
    expect(seen).toContain("exit=5");
    expect(seen).toContain("did not run");
    expect(toolCalls(root)).toHaveLength(0);
  }, 60_000);

  // Runs one shell command through the built binary and returns what the
  // model saw of it.
  const runBridgeCommand = async (root: FixtureRoot, shellCommand: string) => {
    let seen = "";
    gateway = startFakeGateway([
      fakeGatewayToolCall("run_call", "shell", { action: "run", command: shellCommand }),
      (body: string) => {
        seen = toolResultText(body, "run_call");
        return fakeGatewayFinalText("BRIDGE_OUTCOME_DONE");
      },
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    const result = await runLia(["ask", "--json", "--full-access", "--no-save", "Run the command."], {
      cwd: root.workspace,
      env: fixtureEnv(root, gateway),
      timeoutMs: 80_000,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("BRIDGE_OUTCOME_DONE");
    return seen;
  };
  const callTo = (outFile: string, text = "hello") =>
    `"${LIA_BIN}" mcp call ${TOOL_NAME} '{"text":"${text}"}' > ${outFile} 2> err.txt; echo "exit=$?"; cat err.txt; echo "out=$(wc -c < ${outFile} | tr -d ' ')"`;

  test("a tool that returns an error exits 6 with the tool's message and no data", async () => {
    const root = bridgeRoot("bridge-tool-error", {}, { mode: "tool_failure" });
    const seen = await runBridgeCommand(root, callTo("out.txt"));
    expect(seen).toContain("exit=6");
    expect(seen).toContain("returned an error");
    expect(seen).toContain("Invalid input: labels require at least one item");
    expect(seen).toContain("out=0");
    expect(toolCalls(root)).toHaveLength(1);
  }, 90_000);

  test("a call whose server crashes exits 1, and the command learns why", async () => {
    const root = bridgeRoot("bridge-crash", {}, { mode: "crash_always", restartLimit: 0 });
    const seen = await runBridgeCommand(root, callTo("out.txt"));
    expect(seen).toContain("exit=1");
    expect(seen).toContain("lia mcp call: ");
    expect(seen).toContain("out=0");
  }, 90_000);

  test("arguments that are not one JSON object exit 2, and nothing is sent", async () => {
    const root = bridgeRoot("bridge-usage");
    const seen = await runBridgeCommand(
      root,
      `"${LIA_BIN}" mcp call ${TOOL_NAME} '[1]'; echo "array=$?"; "${LIA_BIN}" mcp call ${TOOL_NAME} 'not json'; echo "text=$?"; "${LIA_BIN}" mcp call; echo "none=$?"`,
    );
    expect(seen).toContain("array=2");
    expect(seen).toContain("text=2");
    expect(seen).toContain("none=2");
    expect(seen).toContain("must be one JSON object");
    expect(toolCalls(root)).toHaveLength(0);
  }, 90_000);

  test("a ninth call while eight are running exits 4, and it never reaches the server", async () => {
    const root = bridgeRoot("bridge-busy", {}, { mode: "stall_operation", operationTimeoutMs: 15_000 });
    const holders = Array.from({ length: 8 }, (_, index) =>
      `"${LIA_BIN}" mcp call ${TOOL_NAME} '{"text":"hold${index}"}' > /dev/null 2>&1 &`).join(" ");
    const seen = await runBridgeCommand(
      root,
      `${holders} sleep 3; ${callTo("out.txt", "ninth")}; kill $(jobs -p) 2>/dev/null; wait 2>/dev/null; true`,
    );
    expect(seen).toContain("exit=4");
    expect(seen).toContain("out=0");
    const texts = toolCalls(root).map((entry) => (entry.message.params?.arguments as { text?: string } | undefined)?.text);
    expect(texts).not.toContain("ninth");
    expect(texts.length).toBeLessThanOrEqual(8);
  }, 120_000);

  // A socket that answers like a lia bridge, so the client's own refusals
  // can be driven without a session.
  const withFakeBridge = async (reply: string | null, run: (env: Record<string, string>) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "fxmc-"));
    const socketPath = join(dir, "s");
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data(socket) {
          if (reply !== null) socket.write(reply);
          socket.end();
        },
      },
    });
    try {
      await run({ LIA_MCP_CALL_SOCKET: socketPath, LIA_MCP_CALL_TOKEN: "ab".repeat(32) });
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const runClient = async (env: Record<string, string | undefined>) => {
    const child = Bun.spawn([LIA_BIN, "mcp", "call", TOOL_NAME, '{"text":"hello"}'], {
      env: { ...process.env, LIA_MCP_CALL_SOCKET: undefined, LIA_MCP_CALL_TOKEN: undefined, LIA_SOUND: "0", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };

  test("outside a shell call, or against another lia version, a call exits 3", async () => {
    const outside = await runClient({});
    expect(outside.code).toBe(3);
    expect(outside.stderr).toContain("no running lia shell call to reach");
    expect(outside.stdout).toBe("");

    await withFakeBridge('{"v":999,"status":"ok","bytes":0}\n', async (env) => {
      const other = await runClient(env);
      expect(other.code).toBe(3);
      expect(other.stderr).toContain("another lia version");
      expect(other.stdout).toBe("");
    });
  }, 30_000);

  test("a bridge that closes without replying exits 1 and writes no data", async () => {
    await withFakeBridge(null, async (env) => {
      const lost = await runClient(env);
      expect(lost.code).toBe(1);
      expect(lost.stderr).toContain("the connection to lia was lost");
      expect(lost.stdout).toBe("");
    });
  }, 30_000);

  // A subagent's command reaches the bridge through its own shell call, with
  // the subagent's access, under the same permission rules as its parent.
  const runSubagentCommand = async (root: FixtureRoot, mode: "--full-access" | "--auto") => {
    let seen = "";
    let childRanCommand = false;
    const activeGateway = startDynamicFakeGateway(async (body) => {
      // The parent's turn after the subagent's receipt, and the turn its
      // report starts.
      if (body.includes('"toolCallId":"create_bridge_child"')) return fakeGatewayFinalText("BRIDGE_PARENT_DONE");
      if (body.includes('"toolCallId":"child_call"')) {
        seen = toolResultText(body, "child_call");
        // The command ran in the subagent's turn, not the parent's.
        childRanCommand = body.includes("BRIDGE_CHILD_TASK") && !body.includes("BRIDGE_PARENT_TASK");
        return fakeGatewayFinalText("BRIDGE_CHILD_DONE");
      }
      if (body.includes("BRIDGE_CHILD_TASK")) {
        return fakeGatewayToolCall("child_call", "shell", { action: "run", command });
      }
      if (body.includes("BRIDGE_PARENT_TASK")) {
        return fakeGatewayToolCall("create_bridge_child", "subagent", {
          request: { action: "message", agent: "bridge", message: "BRIDGE_CHILD_TASK" },
        });
      }
      return fakeGatewayFinalText("unexpected bridge subagent request");
    }, {
      classifierDecision: "clear",
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });
    gateway = activeGateway;
    const result = await runLia(["ask", "--json", mode, "BRIDGE_PARENT_TASK"], {
      cwd: root.workspace,
      env: fixtureEnv(root, activeGateway),
      timeoutMs: 60_000,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain("BRIDGE_PARENT_DONE");
    expect(childRanCommand).toBe(true);
    return seen;
  };

  test("a subagent's command saves a big result to a file through its own shell call", async () => {
    const root = bridgeRoot("bridge-subagent");
    const seen = await runSubagentCommand(root, "--full-access");
    expect(seen).toContain("exit=0");
    expect(seen).toContain("BRIDGE_TAIL:hello");
    expect(seen).toContain("lia mcp call: wrote");
    expect(seen.length).toBeLessThan(4096);
    const saved = readFileSync(join(root.workspace, "out.txt"), "utf8");
    expect(saved.length).toBeGreaterThan(1536 * 1024);
    expect(toolCalls(root)).toHaveLength(1);
  }, 90_000);

  test("a subagent's call meets the same deny rule as its parent's", async () => {
    const root = bridgeRoot("bridge-subagent-denied", { permission: { bash: { "*": "allow" }, [TOOL_NAME]: "deny" } });
    const seen = await runSubagentCommand(root, "--auto");
    expect(seen).toContain("exit=5");
    expect(seen).toContain("did not run");
    expect(toolCalls(root)).toHaveLength(0);
  }, 90_000);

  // What the command printed, from the shell tool's result.
  const shellOutput = (result: string): string => JSON.parse(result).output_delta;

  // A shell loop that follows each page's cursor, as a script paging through
  // a long list would.
  const pageLoop = [
    `cursor=0; n=0; : > all.txt`,
    `while [ -n "$cursor" ]; do`,
    `  "${LIA_BIN}" mcp call ${TOOL_NAME} "{\\"text\\":\\"$cursor\\"}" > page.json 2>/dev/null || { echo "exit=$?"; break; }`,
    `  n=$((n+1)); grep -o '"item-[0-9]*"' page.json >> all.txt`,
    `  cursor=$(grep -o '"nextCursor":"[0-9]*"' page.json | grep -o '[0-9][0-9]*')`,
    `done`,
    `echo "calls=$n items=$(wc -l < all.txt | tr -d ' ')"`,
  ].join("\n");

  test("a shell loop pages through a tool's results, one call per page", async () => {
    const root = bridgeRoot("bridge-pages", {}, { mode: "paged" });
    const seen = await runBridgeCommand(root, pageLoop);
    expect(seen).toContain("calls=3 items=9");
    expect(seen).not.toContain("exit=");
    expect(readFileSync(join(root.workspace, "all.txt"), "utf8").trim().split("\n")).toEqual(
      Array.from({ length: 9 }, (_, index) => `"item-${index}"`),
    );
    // Each page is its own call, with the cursor the last page gave.
    expect(toolCalls(root).map((entry) => entry.message.params?.arguments?.text)).toEqual(["0", "1", "2"]);
  }, 90_000);

  test("a structured result that is only one result string saves as that text", async () => {
    const root = bridgeRoot("bridge-wrapped", {}, { mode: "wrapped_text" });
    const seen = await runBridgeCommand(root, `"${LIA_BIN}" mcp call ${TOOL_NAME} '{"text":"docs"}' > docs.md; echo "exit=$?"`);
    expect(seen).toContain("exit=0");
    const saved = readFileSync(join(root.workspace, "docs.md"), "utf8");
    expect(saved).toBe("# Page: Overview\n\nwrapped docs\n");
    expect(seen).toContain(`lia mcp call: wrote ${Buffer.byteLength(saved)} bytes of text`);
  }, 90_000);

  test("list, search, and help describe the agent's tools to a command, and call none", async () => {
    const root = bridgeRoot("bridge-lookups");
    const seen = shellOutput(await runBridgeCommand(root, [
      `"${LIA_BIN}" mcp call list fixture; echo "list=$?"`,
      `"${LIA_BIN}" mcp call search echo text; echo "search=$?"`,
      `"${LIA_BIN}" mcp call help ${TOOL_NAME}; echo "help=$?"`,
      `"${LIA_BIN}" mcp call help mcp_fixture_nope; echo "missing=$?"`,
      `"${LIA_BIN}" mcp call list nope; echo "server=$?"`,
    ].join("\n")));
    const line = `${TOOL_NAME}\tEcho text through the modern MCP fixture`;
    expect(seen).toContain(`${line}\nlist=0`);
    expect(seen).toContain(`${line}\nsearch=0`);
    // The description is the one the model gets, the server's instructions
    // included, then each argument.
    expect(seen).toContain(`${TOOL_NAME}\nEcho text through the modern MCP fixture\n\nServer instructions: Use the modern echo tool.\n`);
    expect(seen).toContain("\nArguments, as one JSON object:\n  text: string\nhelp=0");
    expect(seen).toContain("No MCP tool named mcp_fixture_nope is available to this agent.");
    expect(seen).toContain("missing=1");
    expect(seen).toContain("No MCP server by that name is available to this agent.");
    expect(seen).toContain("server=1");
    expect(toolCalls(root)).toHaveLength(0);
  }, 90_000);

  test("list, search, and help hide a tool the permission rules deny", async () => {
    const root = bridgeRoot("bridge-lookups-denied", { permission: { bash: { "*": "allow" }, [TOOL_NAME]: "deny" } });
    const seen = shellOutput(await runBridgeCommand(root, [
      `"${LIA_BIN}" mcp call list fixture; echo "list=$?"`,
      `"${LIA_BIN}" mcp call help ${TOOL_NAME}; echo "help=$?"`,
    ].join("\n")));
    expect(seen).not.toContain(`${TOOL_NAME}\t`);
    expect(seen).toContain("list=0");
    expect(seen).toContain(`No MCP tool named ${TOOL_NAME} is available to this agent.`);
    expect(seen).toContain("help=1");
  }, 90_000);

});
