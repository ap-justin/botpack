import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FX_BIN, runFx } from "../evals/eval-helpers";
import { logLines, rootSessionIds, storeRoot } from "./saved-sessions";
import {
  fakeGatewayFinalText,
  startDynamicFakeGateway,
} from "./fake-gateway";

const MAIN_MODEL = "openai/gpt-5.5";
const TITLE_MODEL = "openai/gpt-5.6-luna";
const GENERATED_TITLE = "Renderer Loop Refactor";

type FixtureRoot = {
  root: string;
  home: string;
  workspace: string;
};

function createFixtureRoot(label: string, settings: string = "{}"): FixtureRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `fx-session-title-${label}-`)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".fx"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, ".fx", "settings.json"), settings);
  return { root, home, workspace: realpathSync(workspace) };
}

function startTitleAwareGateway() {
  return startDynamicFakeGateway(_raw => fakeGatewayFinalText("MAIN_ANSWER_OK"), {
    models: [{ id: MAIN_MODEL, type: "language", tags: ["tool-use"] }],
    titleResponses: [fakeGatewayFinalText(GENERATED_TITLE)],
  });
}

function baseEnv(root: FixtureRoot, gateway: { baseUrl: string; chatUrl: string }) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root.home,
    AI_GATEWAY_API_KEY: "synthetic-title",
    FX_DISABLE_KEYCHAIN: "1",
    FX_E2E_DISABLE_DOTENV: "1",
    FX_AUTO_UPGRADE: "0",
    FX_SOUND: "0",
    FX_TEST_SKIP_ONBOARDING: "1",
    FX_MODEL: MAIN_MODEL,
    FX_PERMISSION_MODE: "full-access",
    FX_MAX_AGENT_STEPS: "2",
    FX_GATEWAY_BASE_URL: gateway.baseUrl,
    FX_GATEWAY_CHAT_URL: gateway.chatUrl,
    FX_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
    FX_TEST_GATEWAY_MODELS_URL: `${gateway.baseUrl}/coding-agent/v1/models`,
  };
}

/// Each saved session's title: its log's newest title setting.
function sessionTitles(root: FixtureRoot): string[] {
  if (!existsSync(storeRoot(root.home))) return [];
  return rootSessionIds(root.home).flatMap((id) => {
    const title = (logLines(root.home, id) as any[]).filter((line) => line.kind === "set" && line.key === "title").at(-1)?.value;
    return typeof title === "string" ? [title] : [];
  });
}

function titleRequests(gateway: ReturnType<typeof startTitleAwareGateway>) {
  return gateway.titleRequests;
}

test("fx ask generates a model title for a fresh session", async () => {
  const root = createFixtureRoot("ask");
  const gateway = startTitleAwareGateway();
  try {
    const result = await runFx(["ask", "refactor the renderer loop to fix the crash"], {
      cwd: root.workspace,
      env: baseEnv(root, gateway),
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MAIN_ANSWER_OK");

    const titleCalls = titleRequests(gateway);
    expect(titleCalls.length).toBe(1);
    expect(titleCalls[0].headers.get("ai-language-model-id")).toBe(TITLE_MODEL);
    expect(titleCalls[0].body).toContain("refactor the renderer loop");

    expect(sessionTitles(root)).toContain(GENERATED_TITLE);

    const list = await runFx(["sessions", "--json"], {
      cwd: root.workspace,
      env: baseEnv(root, gateway),
      timeoutMs: 15_000,
    });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(GENERATED_TITLE);
  } finally {
    gateway.stop();
  }
});

test("fx ask keeps the derived title when session_titles is off", async () => {
  const root = createFixtureRoot("disabled", JSON.stringify({ session_titles: false }));
  const gateway = startTitleAwareGateway();
  try {
    const result = await runFx(["ask", "refactor the renderer loop to fix the crash"], {
      cwd: root.workspace,
      env: baseEnv(root, gateway),
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MAIN_ANSWER_OK");
    expect(titleRequests(gateway).length).toBe(0);
    expect(sessionTitles(root)).not.toContain(GENERATED_TITLE);
  } finally {
    gateway.stop();
  }
});

test("fx ask keeps the derived title when the title model output is unusable", async () => {
  const root = createFixtureRoot("unusable");
  const gateway = startDynamicFakeGateway(_raw => fakeGatewayFinalText("MAIN_ANSWER_OK"), {
    models: [{ id: MAIN_MODEL, type: "language", tags: ["tool-use"] }],
    titleResponses: [fakeGatewayFinalText("\n  \n")],
  });
  try {
    const result = await runFx(["ask", "refactor the renderer loop to fix the crash"], {
      cwd: root.workspace,
      env: baseEnv(root, gateway),
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MAIN_ANSWER_OK");
    const titles = sessionTitles(root);
    expect(titles.length).toBe(1);
    expect(titles[0]).not.toBe(GENERATED_TITLE);
    expect(titles[0].length).toBeGreaterThan(0);
  } finally {
    gateway.stop();
  }
});

test("fx ask exits soon after its answer while the title request never answers", async () => {
  const root = createFixtureRoot("title-hang");
  let titleArrived = false;
  const gateway = startDynamicFakeGateway(_raw => fakeGatewayFinalText("MAIN_ANSWER_OK"), {
    models: [{ id: MAIN_MODEL, type: "language", tags: ["tool-use"] }],
    titleResponses: [() => {
      titleArrived = true;
      return new Promise<Response>(() => {});
    }],
  });
  try {
    const started = Date.now();
    const result = await runFx(["ask", "refactor the renderer loop to fix the crash"], {
      cwd: root.workspace,
      env: baseEnv(root, gateway),
      timeoutMs: 30_000,
    });
    const elapsedMs = Date.now() - started;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MAIN_ANSWER_OK");
    expect(titleArrived).toBe(true);
    // The title call's own deadline is 15 s; fx gives it a short grace after
    // the answer and then leaves.
    expect(elapsedMs).toBeLessThan(8_000);

    // The session keeps the title derived from its first prompt.
    const titles = sessionTitles(root);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain("refactor the renderer loop");
    const list = await runFx(["sessions", "--json"], {
      cwd: root.workspace,
      env: baseEnv(root, gateway),
      timeoutMs: 15_000,
    });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(titles[0]);
  } finally {
    gateway.stop();
    rmSync(root.root, { recursive: true, force: true });
  }
}, 45_000);

test("fx ask keeps a generated title that arrives soon after its answer", async () => {
  const root = createFixtureRoot("title-late");
  const gateway = startDynamicFakeGateway(_raw => fakeGatewayFinalText("MAIN_ANSWER_OK"), {
    models: [{ id: MAIN_MODEL, type: "language", tags: ["tool-use"] }],
    titleResponses: [() => Bun.sleep(1_000).then(() => fakeGatewayFinalText(GENERATED_TITLE))],
  });
  try {
    const result = await runFx(["ask", "refactor the renderer loop to fix the crash"], {
      cwd: root.workspace,
      env: baseEnv(root, gateway),
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MAIN_ANSWER_OK");
    expect(sessionTitles(root)).toContain(GENERATED_TITLE);
  } finally {
    gateway.stop();
    rmSync(root.root, { recursive: true, force: true });
  }
}, 45_000);

test("fx ask exits promptly on SIGINT while its title request never answers", async () => {
  const root = createFixtureRoot("interrupt");
  let chatArrived!: () => void;
  let titleArrived!: () => void;
  const chatRequest = new Promise<void>((resolve) => { chatArrived = resolve; });
  const titleRequest = new Promise<void>((resolve) => { titleArrived = resolve; });
  // Neither request ever gets response headers.
  const gateway = startDynamicFakeGateway(() => {
    chatArrived();
    return new Promise<Response>(() => {});
  }, {
    models: [{ id: MAIN_MODEL, type: "language", tags: ["tool-use"] }],
    titleResponses: [() => {
      titleArrived();
      return new Promise<Response>(() => {});
    }],
  });
  const child = Bun.spawn([FX_BIN, "ask", "refactor the renderer loop to fix the crash"], {
    cwd: root.workspace,
    env: baseEnv(root, gateway),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await Promise.all([chatRequest, titleRequest]);
    const signalledAt = Date.now();
    child.kill("SIGINT");
    // The title call's own deadline is 15 s, so an exit that waits for it
    // lands far past this bound.
    const code = await Promise.race([child.exited, Bun.sleep(8_000).then(() => null)]);
    expect(Date.now() - signalledAt).toBeLessThan(2_000);
    expect(code).toBe(130);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    gateway.stop();
    rmSync(root.root, { recursive: true, force: true });
  }
}, 30_000);
