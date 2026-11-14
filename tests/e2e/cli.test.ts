import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  cleanupIsolatedTestHome,
  createIsolatedTestHome,
  LIA_BIN,
  HAS_API_KEY,
  REPO_ROOT,
  runLia,
} from "../evals/eval-helpers";
import {
  FAKE_GATEWAY_MODEL,
  acpSpawnEnv,
  fakeGatewayFinalText,
  fakeGatewaySse,
  startFakeGateway,
} from "./fake-gateway";
import { onlySessionId, savedSession, savedText, sessionDir } from "./saved-sessions";
import {
  DAY_MS,
  type ReportRow,
  USAGE_NOW_MS,
  usageEnv,
  usageFake,
  utcDate,
  writeUsageClock,
} from "./usage-fakes";

const TIMEOUT = 15_000;
const NO_GATEWAY_AUTH = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
};
// `lia config` shows these when they're set, so its tests clear them.
const NO_SETTING_ENV = Object.fromEntries(
  [
    "LIA_PROVIDER", "LIA_MODEL", "LIA_ULTRAFAST", "LIA_REVIEW_MODEL", "LIA_PROVIDER_ORDER", "LIA_PROVIDER_STRICT",
    "LIA_PERMISSION_MODE", "LIA_MAX_AGENT_STEPS", "LIA_AUTO_COMPACT_PERCENT", "LIA_THEME", "LIA_SOUND", "LIA_AUTO_UPGRADE",
  ].map((name) => [name, undefined]),
);
const MISSING_AUTH_MESSAGE =
  "lia needs access to Vercel AI Gateway. Run lia login to sign in, lia login vercel --api-key to use an API key, or set AI_GATEWAY_API_KEY.";
const MODERN_MCP_FIXTURE = join(
  import.meta.dirname,
  "fixtures",
  "mcp-modern-stdio.mjs",
);

const KEYCHAIN_SERVICE = "LIA_AI_GATEWAY_API_KEY";

function maxLineWidth(text: string): number {
  return Math.max(...text.split(/\r?\n/).map((line) => Bun.stringWidth(line)));
}

function sourceVersion(): string {
  const source = readFileSync(join(REPO_ROOT, "src/main.zig"), "utf8");
  const match = source.match(/pub const version = "([^"]+)";/);
  if (!match) throw new Error("src/main.zig version declaration not found");
  return match[1];
}

function doctorSessionDiagnosticsLimit(): number {
  const source = readFileSync(
    join(REPO_ROOT, "src/core/cli/doctor_runtime.zig"),
    "utf8",
  );
  const match = source.match(/const default_session_diagnostics_limit: usize = (\d+);/);
  if (!match) throw new Error("doctor session diagnostics limit not found");
  return Number(match[1]);
}

const SEEDED_GATEWAY_TOKEN = "seeded-access-token";

function writeSeededLiaAuth(
  home: string,
  teamId?: string,
  issuer = "https://vercel.com",
  expiresAtMs = Date.now() + 60 * 60 * 1000,
): void {
  const liaDir = join(home, ".lia");
  mkdirSync(liaDir, { recursive: true, mode: 0o700 });
  chmodSync(liaDir, 0o700);
  const authPath = join(liaDir, "auth.json");
  const auth: Record<string, string | number> = {
    version: 1,
    issuer,
    client_id: "test-client",
    access_token: SEEDED_GATEWAY_TOKEN,
    refresh_token: "seeded-refresh-token",
    expires_at_ms: expiresAtMs,
    scope: "openid",
    token_type: "Bearer",
  };
  if (teamId) {
    auth.team_id = teamId;
    auth.team_slug = "vercel-labs";
  }
  writeFileSync(authPath, JSON.stringify(auth) + "\n", { mode: 0o600 });
  chmodSync(authPath, 0o600);
}

function startRequestCatcher() {
  const requests: Array<{ method: string; path: string }> = [];
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      return Response.json({ revoked: true });
    },
  });
  return {
    issuerUrl: `http://127.0.0.1:${server.port}`,
    endpoint: `http://localhost.:${server.port}/oauth/revoke`,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

function startLogoutIssuer(
  revokeStatuses: number[],
  authPath?: string,
  revocationEndpoint?: string | null,
) {
  const providerDetail = `provider rejected ${SEEDED_GATEWAY_TOKEN} and seeded-refresh-token`;
  const requests: Array<{
    method: string;
    path: string;
    tokenTypeHint?: string;
    validForm?: boolean;
    localSessionPresent?: boolean;
  }> = [];
  let revokeAttempt = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const issuerUrl = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/.well-known/openid-configuration") {
        requests.push({ method: request.method, path: url.pathname });
        return Response.json({
          issuer: issuerUrl,
          device_authorization_endpoint: `${issuerUrl}/oauth/device`,
          token_endpoint: `${issuerUrl}/oauth/token`,
          ...(revocationEndpoint === null
            ? {}
            : {
                revocation_endpoint:
                  revocationEndpoint ?? `${issuerUrl}/oauth/revoke`,
              }),
        });
      }
      if (url.pathname === "/oauth/revoke") {
        const form = await request.formData();
        const tokenTypeHint = form.get("token_type_hint");
        const expectedToken =
          tokenTypeHint === "refresh_token"
            ? "seeded-refresh-token"
            : tokenTypeHint === "access_token"
              ? SEEDED_GATEWAY_TOKEN
              : null;
        const validForm =
          form.get("client_id") === "test-client" &&
          expectedToken !== null &&
          form.get("token") === expectedToken;
        requests.push({
          method: request.method,
          path: url.pathname,
          tokenTypeHint:
            typeof tokenTypeHint === "string" ? tokenTypeHint : "missing",
          validForm,
          ...(authPath
            ? { localSessionPresent: existsSync(authPath) }
            : {}),
        });
        const configuredStatus = revokeStatuses[revokeAttempt] ?? 200;
        revokeAttempt += 1;
        const revokeStatus = validForm ? configuredStatus : 400;
        return Response.json(
          revokeStatus >= 400 ? { error: providerDetail } : { revoked: true },
          { status: revokeStatus },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    issuerUrl: `http://127.0.0.1:${server.port}`,
    providerDetail,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

function snapshotTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (path: string, relative: string): void => {
    const info = lstatSync(path);
    entries.push(
      `${relative}|${info.isDirectory() ? "dir" : "file"}|${info.mode & 0o777}|${info.size}`,
    );
    if (!info.isDirectory()) return;
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relative ? join(relative, name) : name);
    }
  };
  visit(root, "");
  return entries;
}

function writeLegacySession(
  home: string,
  workspaceRoot: string,
  sessionId: string,
  opts: {
    createdAtMs?: number;
    updatedAtMs?: number;
    historyLen?: number;
  } = {},
): void {
  const sessionDir = join(home, ".lia", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".lia"), 0o700);
  chmodSync(join(home, ".lia", "sessions"), 0o700);
  chmodSync(sessionDir, 0o700);
  const historyLen = opts.historyLen ?? 0;
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 2,
      id: sessionId,
      created_at_ms: opts.createdAtMs ?? 1,
      updated_at_ms: opts.updatedAtMs ?? 2,
      workspace_root: workspaceRoot,
      conversation_language: "en",
      history_len: historyLen,
      history: historyLen > 0 ? [{ role: "user", content: "saved" }] : [],
      total_input_tokens: 0,
      total_output_tokens: 0,
    }) + "\n",
    { mode: 0o600 },
  );
}

function writeConversationSession(
  home: string,
  workspaceRoot: string,
  sessionId: string,
  opts: {
    createdAtMs?: number;
    updatedAtMs?: number;
    title?: string | null;
    conversationLanguage?: string;
    turns?: string[];
  } = {},
): void {
  const sessionDir = join(home, ".lia", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".lia"), 0o700);
  chmodSync(join(home, ".lia", "sessions"), 0o700);
  chmodSync(sessionDir, 0o700);
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 4,
      id: sessionId,
      origin_workspace_root: workspaceRoot,
      workspace_root: workspaceRoot,
      created_at_ms: opts.createdAtMs ?? 1,
      updated_at_ms: opts.updatedAtMs ?? 2,
      conversation_language: opts.conversationLanguage ?? "en",
      provider: "gateway",
      model: FAKE_GATEWAY_MODEL,
      effort: "auto",
      fast_mode: false,
      title: opts.title ?? null,
      subagent_child: false,
    }) + "\n",
    { mode: 0o600 },
  );

  let seq = 0;
  const frames: string[] = [];
  for (const text of opts.turns ?? []) {
    const append = (event: object): void => {
      seq += 1;
      frames.push(JSON.stringify({
        schema_version: 1,
        seq,
        timestamp_ms: opts.updatedAtMs ?? 2,
        event,
      }));
    };
    append({ user: { text, images: [], work_id: null } });
    append({ assistant: { text: "done" } });
    append({ turn_completed: {} });
  }
  const eventsPath = join(sessionDir, "events.jsonl");
  writeFileSync(
    eventsPath,
    frames.length > 0 ? `${frames.join("\n")}\n` : "",
    { mode: 0o600 },
  );
  const updatedSeconds = (opts.updatedAtMs ?? 2) / 1000;
  utimesSync(eventsPath, updatedSeconds, updatedSeconds);
  writeFileSync(join(sessionDir, "session.lock"), "", { mode: 0o600 });
}

describe("cli: help", () => {
  test(
    "top-level help aliases render the same accurate navigation page",
    async () => {
      const outputs: string[] = [];
      for (const args of [["help"], ["--help"], ["-h"]]) {
        const result = await runLia(args);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        outputs.push(result.stdout);
      }

      expect(outputs[1]).toBe(outputs[0]);
      expect(outputs[2]).toBe(outputs[0]);
      const stdout = outputs[0]!;
      expect(stdout).not.toContain("\x1b[");
      expect(stdout).not.toContain("\x1b]2;");
      expect(stdout).toStartWith(
        `𝒇x v${sourceVersion()}\nFast, native coding agent for the terminal.\n`,
      );
      expect(stdout.match(/𝒇x/g) ?? []).toHaveLength(1);
      expect(stdout).toContain("lia is a command-line coding agent.");
      expect(stdout).toContain("Commands:\n");
      expect(stdout).toContain("Run one noninteractive request");
      expect(stdout).toContain("Sign in to Vercel AI Gateway");
      expect(stdout).toContain("Sign out of Vercel AI Gateway");
      // runLia inherits COLUMNS, and at the 80-column default the summary wraps
      // "connection" onto the next line, so accept it on either line.
      const providerRow = stdout.indexOf("  provider <name>");
      expect(providerRow).toBeGreaterThanOrEqual(0);
      const providerLine = stdout.slice(providerRow, stdout.indexOf("\n", providerRow));
      const summaryStart = providerLine.indexOf("Choose AI Gateway or a configured");
      expect(summaryStart).toBeGreaterThanOrEqual(0);
      expect(stdout.indexOf("connection", providerRow)).toBeGreaterThan(providerRow + summaryStart);
      // `lia setup` is deprecated and hidden; `lia login --api-key` replaces it.
      expect(stdout).not.toContain("Configure a Vercel AI Gateway API key");
      expect(stdout).toContain("login [vercel] [--api-key]");
      expect(stdout).toContain("Choose a Vercel AI Gateway team");
      expect(stdout).toContain("Show Vercel AI Gateway credits");
      expect(stdout).not.toContain("Sign in to a model provider");
      expect(stdout).not.toContain("Sign out of a model provider");
      expect(stdout).not.toContain("Choose the active model provider");
      expect(stdout).toContain("credits|balance");
      expect(stdout).toContain("Flags:\n");
      expect(stdout).toContain("--context-limit <spec>");
      expect(stdout).toContain("Set name=bytes|off; repeatable");
      expect(stdout).toContain("--add-dir <path>");
      expect(stdout).not.toContain("--continue");
      expect(stdout).not.toContain("--resume-last");
      expect(stdout).not.toContain("--resume-<id>");
      expect(stdout).not.toContain("session resume");
      expect(stdout).toContain("-v, --version");
      expect(stdout).toContain("Print the lia version and exit");
      expect(stdout).not.toContain("Must appear before the command");
      expect(stdout).toContain("Examples:\n");
      expect(stdout).not.toContain("fx.sh");
      expect(stdout).toContain(
        "Run `lia <command> --help` for command-specific usage and options.",
      );
      expect(stdout).not.toContain("command-specific options and examples");
      expect(stdout).not.toContain("  Work      ");
      expect(stdout).not.toContain("\n\n\nRun `lia <command> --help`");
    },
    TIMEOUT,
  );

  test(
    "lia ask help renders documented options through both aliases",
    async () => {
      const env = {
        ...NO_GATEWAY_AUTH,
        LIA_DISABLE_KEYCHAIN: "1",
      };
      const expected = `lia ask

Run one noninteractive request

Usage:
  lia ask [--permission-mode <mode>|--ask|--auto|--full-access] [--provider <name>] [--model <id>] [--effort <level>] [--fast|--no-fast] [--ultrafast|--no-ultrafast] [--provider-order <a,b,...>] [--provider-strict|--no-provider-strict] [--image PATH] [--system TEXT] [--json] [--quiet] [--prompt-permissions] [--timeout <seconds>] [--config <key=value>] [--no-save] [--no-color] [--resume <last|<id>>] [--] <prompt>

Options:
  --permission-mode <mode>    Set the permission mode for this request: ask, auto, or full-access
  --ask                       Ask before each action that needs permission
  --auto                      Automatically review unresolved permission requests
  --full-access               Disable lia permission checks
  --yolo                      Alias for --full-access
  --provider <name>           Override the model provider for this request (gateway or a configured name)
  --model <id>                Override the model for this request
  --effort <level>            Override the reasoning effort for this request
  --fast                      Enable Fast mode for this request when the model supports it
  --no-fast                   Disable Fast mode for this request
  --ultrafast                 Request Ultrafast mode for this request when the model supports it
  --no-ultrafast              Disable Ultrafast mode for this request
  --provider-order <a,b,...>  Prefer these gateway providers in order for this request
  --provider-strict           Restrict this request to only the providers in --provider-order
  --no-provider-strict        Clear the provider restriction for this request
  --image PATH                Attach an image file; repeat for multiple images
  --system TEXT               Replace the built-in system prompt for this request
  --json                      Emit machine-readable JSON instead of text
  --quiet                     Suppress assistant output
  --prompt-permissions        Prompt for Y/N permission approval when stdin is a TTY
  --timeout <seconds>         Time limit for each shell command the agent runs
  --config <key=value>        Override a setting for this request, with the keys lia config set takes; repeatable
  --no-save                   Do not save the session; incompatible with --resume
  --no-color                  Print the full-access warning on stderr without color; NO_COLOR or TERM=dumb also turns color off
  --resume <last|<id>>        Continue the last session or a session by id
  --                          Treat every following argument as prompt text

The prompt may be passed as arguments or piped on stdin when no prompt args are given.
Assistant output is raw Markdown on stdout.
Operational progress and diagnostics are written to stderr. JSON \`output\` keeps accumulated assistant Markdown; \`final_output\` contains only the completed final response, or an empty string when absent.
JSON usage sums reported main-agent input_tokens and output_tokens, including with --no-save; unreported counts are null. cache_read_tokens and cache_write_tokens appear only when the provider reports them. Nested usage and dollar spend are excluded.
--system replaces only the built-in base prompt for this request; tool, skill, project, and runtime context still apply.
With --prompt-permissions, JSON and quiet requests may prompt on stderr only when stdin is a TTY.
`;

      for (const alias of ["--help", "-h"]) {
        const result = await runLia(["ask", alias], { env });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(expected);
      }
    },
    TIMEOUT,
  );

  test(
    "lia session help documents inspect and recover",
    async () => {
      for (const args of [["session", "--help"]]) {
        const r = await runLia(args);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Inspect or recover saved sessions");
        expect(r.stdout).toContain("session <last|id>|--id <id>");
        expect(r.stdout).not.toContain("session resume");
        expect(r.stdout).toContain("session recover <id>|--id <id>");
        // Sessions convert on open; there is nothing to migrate by hand.
        expect(r.stdout).not.toContain("migrate");
        expect(r.stdout).not.toContain("--allow-large");
      }
    },
    TIMEOUT,
  );

  test(
    "lia acp help documents accepted options",
    async () => {
      for (const alias of ["--help", "-h"]) {
        const r = await runLia(["acp", alias], { env: acpSpawnEnv() });
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain(
          "Usage:\n  lia acp [--permission-mode <mode>|--ask|--auto|--full-access] [--provider <name>] [--model <id>] [--effort <level>] [--fast|--no-fast] [--ultrafast|--no-ultrafast] [--log-file <path>]",
        );
        expect(r.stdout).toContain("--model <id>");
        expect(r.stdout).toContain("--ultrafast");
        expect(r.stdout).toContain("--no-ultrafast");
        expect(r.stdout).toContain("--log-file <path>");
      }
    },
    TIMEOUT,
  );

  test(
    "lia acp rejects unknown options and missing option values",
    async () => {
      const cases: [string[], string][] = [
        [["--bogus"], "lia acp: unknown flag --bogus\n"],
        [["--model"], "lia acp: --model needs a value\n"],
        [["--log-file"], "lia acp: --log-file needs a value\n"],
        [["--effort", "high effort"], "lia acp: invalid value for --effort: high effort\n"],
        [["--permission-mode", "never"], "lia acp: invalid value for --permission-mode: never\n"],
        // ACP sessions don't apply gateway provider routing.
        [["--provider-order", "a"], "lia acp: unknown flag --provider-order\n"],
        [["--add-dir", "/tmp"], "lia acp: unknown flag --add-dir; it goes before the command: lia --add-dir <path> acp\n"],
      ];
      for (const [args, problem] of cases) {
        const result = await runLia(["acp", ...args], { env: acpSpawnEnv() });
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          problem +
            "usage: lia acp [--permission-mode <mode>|--ask|--auto|--full-access] [--provider <name>] [--model <id>] [--effort <level>] [--fast|--no-fast] [--ultrafast|--no-ultrafast] [--log-file <path>]\n",
        );
      }
    },
    TIMEOUT,
  );

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `lia ${alias} respects COLUMNS=60`,
      async () => {
        const r = await runLia([alias], { env: { COLUMNS: "60" } });
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Commands:");
        expect(r.stdout).toContain("ask");
        expect(r.stdout).toContain("login");
        expect(r.stdout).toContain("status");
        expect(r.stdout).toContain("doctor");
        expect(maxLineWidth(r.stdout)).toBeLessThanOrEqual(60);
      },
      TIMEOUT,
    );
  }

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `lia ${alias} hides developer recording surfaces`,
      async () => {
        const r = await runLia([alias]);
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain("--record");
        expect(r.stdout).not.toContain("replay <tape>");
        expect(r.stderr).toBe("");
      },
      TIMEOUT,
    );
  }

  test(
    "lia rejects the removed record flag as unknown input",
    async () => {
      const r = await runLia(["--record"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("lia: unknown flag --record");
      expect(r.stderr).not.toContain("visual terminal capture:");
    },
    TIMEOUT,
  );
});

describe("cli: version", () => {
  for (const alias of ["--version", "-v"]) {
    test(
      `lia ${alias} prints the source version`,
      async () => {
        const r = await runLia([alias]);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe(`${sourceVersion()}\n`);
        expect(r.stderr).toBe("");
      },
      TIMEOUT,
    );
  }
});

describe("cli: output errors", () => {
  test(
    "a command that can't write its output says so instead of naming a dropped connection",
    () => {
      const home = createIsolatedTestHome();
      const tracePath = join(home, "trace.log");
      try {
        for (const args of [["--version"], ["status"]]) {
          // `>&-` closes stdout, so every write to it fails.
          const result = spawnSync("sh", ["-c", 'exec "$0" "$@" >&-', LIA_BIN, ...args], {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              HOME: home,
              LIA_SOUND: "0",
              LIA_AUTO_UPGRADE: "0",
              LIA_DISABLE_KEYCHAIN: "1",
              LIA_TRACE_LOG: tracePath,
              LIA_TRACE_SCOPES: "core",
            },
          });
          expect(result.status, args.join(" ")).toBe(1);
          expect(result.stderr).toBe("lia: couldn't write the output\n");
        }
        // The raw name stays in the trace.
        const trace = readFileSync(tracePath, "utf8");
        expect(trace).toContain("command output write failed err=WriteFailed");
        expect(trace).toContain("command error err=OutputWriteFailed");
      } finally {
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  for (const [label, flags] of [["text", []], ["--json", ["--json"]]] as const) {
    test(
      `lia ask ${label} that can't write its answer fails and keeps the answer in the session`,
      async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-ask-closed-stdout-")));
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const tracePath = join(root, "trace.log");
        mkdirSync(home);
        mkdirSync(workspace);
        const gateway = startFakeGateway([fakeGatewayFinalText("ANSWER_KEPT_IN_SESSION")]);
        try {
          // `>&-` closes stdout, so the answer can't be written. The fake
          // gateway answers from this process, so lia runs asynchronously.
          const proc = Bun.spawn(["sh", "-c", 'exec "$0" "$@" >&-', LIA_BIN, "ask", ...flags, "--auto", "Say the answer."], {
            cwd: workspace,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
            env: {
              PATH: process.env.PATH,
              HOME: home,
              AI_GATEWAY_API_KEY: "closed-stdout-key",
              LIA_MODEL: FAKE_GATEWAY_MODEL,
              LIA_DISABLE_KEYCHAIN: "1",
              LIA_AUTO_UPGRADE: "0",
              LIA_SOUND: "0",
              LIA_GATEWAY_BASE_URL: gateway.baseUrl,
              LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_TEST_GATEWAY_MODELS_URL: `${gateway.baseUrl}/coding-agent/v1/models`,
              LIA_TRACE_LOG: tracePath,
              LIA_TRACE_SCOPES: "core",
            },
          });
          const stderr = await new Response(proc.stderr).text();
          expect(await proc.exited, stderr).toBe(1);
          expect(stderr).toBe("lia: couldn't write the output\n");
          const trace = readFileSync(tracePath, "utf8");
          expect(trace).toContain("ask output write failed err=");
          expect(trace).toContain("command error err=OutputWriteFailed");

          // No file lia opened took stdout's place, such as the store's lock.
          const lock = join(home, ".lia", "sessions", "v2", "index.lock");
          if (existsSync(lock)) expect(readFileSync(lock, "utf8")).not.toContain("ANSWER_KEPT_IN_SESSION");

          // The turn is saved, so the answer can still be read.
          const sessionId = onlySessionId(home);
          expect(savedText(home, sessionId)).toContain("ANSWER_KEPT_IN_SESSION");
          const detail = await runLia(["session", "--id", sessionId, "--json"], { cwd: workspace, env: { HOME: home } });
          expect(detail.code, detail.stderr).toBe(0);
          expect(JSON.parse(detail.stdout).history_len).toBe(1);
        } finally {
          gateway.stop();
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});

describe("cli: closed output pipe", () => {
  // The reader exits at once, and the short sleep lets it go before lia
  // writes, as `| head` leaves a pipe once it has read enough.
  async function runWithReaderGone(args: string[], env: Record<string, string | undefined>, cwd?: string) {
    const statusPath = join(env.HOME!, "lia.status");
    const proc = Bun.spawn(["sh", "-c", '(sleep 0.2; "$0" "$@"; echo $? > "$LIA_STATUS_PATH") | true', LIA_BIN, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...env, LIA_STATUS_PATH: statusPath },
    });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    return { status: Number(readFileSync(statusPath, "utf8").trim()), stderr };
  }

  test(
    "a command whose output reader went away ends quietly with SIGPIPE's status",
    async () => {
      const home = createIsolatedTestHome();
      try {
        const env = { PATH: process.env.PATH, HOME: home, LIA_SOUND: "0", LIA_AUTO_UPGRADE: "0", LIA_DISABLE_KEYCHAIN: "1" };
        // `lia --version` ends before lia's I/O starts, so SIGPIPE ends it;
        // `lia status` gets the closed pipe as a failed write.
        for (const args of [["--version"], ["status"]]) {
          const result = await runWithReaderGone(args, env);
          expect(result.status, args.join(" ")).toBe(141);
          expect(result.stderr, args.join(" ")).toBe("");
        }
      } finally {
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  for (const [label, flags] of [["text", []], ["--json", ["--json"]]] as const) {
    test(
      `lia ask ${label} whose reader went away ends quietly and still saves the answer`,
      async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-ask-reader-gone-")));
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const gateway = startFakeGateway([fakeGatewayFinalText("ANSWER_SAVED_AFTER_READER_LEFT")]);
        try {
          const result = await runWithReaderGone(["ask", ...flags, "--auto", "Say the answer."], {
            PATH: process.env.PATH,
            HOME: home,
            AI_GATEWAY_API_KEY: "reader-gone-key",
            LIA_MODEL: FAKE_GATEWAY_MODEL,
            LIA_DISABLE_KEYCHAIN: "1",
            LIA_AUTO_UPGRADE: "0",
            LIA_SOUND: "0",
            LIA_GATEWAY_BASE_URL: gateway.baseUrl,
            LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
            LIA_TEST_GATEWAY_MODELS_URL: `${gateway.baseUrl}/coding-agent/v1/models`,
          }, workspace);
          expect(result.status, result.stderr).toBe(141);
          expect(result.stderr).toBe("");
          // The turn finished and was saved, so a resume sees it whole.
          const sessionId = onlySessionId(home);
          expect(savedText(home, sessionId)).toContain("ANSWER_SAVED_AFTER_READER_LEFT");
          const detail = await runLia(["session", "--id", sessionId, "--json"], { cwd: workspace, env: { HOME: home } });
          expect(detail.code, detail.stderr).toBe(0);
          expect(JSON.parse(detail.stdout).history_len).toBe(1);
        } finally {
          gateway.stop();
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});

describe("cli: status", () => {
  test(
    "status and doctor expose the MCP profile error that blocks ask startup",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-mcp-config-diagnostic-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const liaDir = join(home, ".lia");
      mkdirSync(liaDir, { recursive: true, mode: 0o700 });
      mkdirSync(workspace);
      writeFileSync(join(liaDir, "mcp.json"), "{invalid json", { mode: 0o600 });
      const gateway = startFakeGateway([]);

      try {
        const env = {
          HOME: realpathSync(home),
          AI_GATEWAY_API_KEY: "mcp-config-diagnostic-key",
          VERCEL_OIDC_TOKEN: undefined,
          LIA_DISABLE_KEYCHAIN: "1",
          LIA_AUTO_UPGRADE: "0",
          LIA_MODEL: FAKE_GATEWAY_MODEL,
          LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
        };
        const cwd = realpathSync(workspace);
        const before = snapshotTree(home);

        const statusText = await runLia(["status"], { cwd, env });
        const statusJsonResult = await runLia(["status", "--json"], { cwd, env });
        const doctorText = await runLia(["doctor"], { cwd, env });
        const doctorJsonResult = await runLia(["doctor", "--json"], { cwd, env });
        const ask = await runLia(
          ["ask", "--json", "--no-save", "Do nothing."],
          { cwd, env },
        );

        for (const result of [statusText, statusJsonResult, doctorText, doctorJsonResult]) {
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
        }
        expect(statusText.stdout).toContain(
          "[status] mcp_config_error=McpConfigInvalidJson\n",
        );
        expect(JSON.parse(statusJsonResult.stdout)).toMatchObject({
          kind: "status",
          mcp_config_error: "McpConfigInvalidJson",
        });
        expect(doctorText.stdout).toContain(
          "[fail] mcp_config: failed to load ~/.lia/mcp.json: McpConfigInvalidJson\n",
        );
        const doctorJson = JSON.parse(doctorJsonResult.stdout);
        expect(doctorJson.fail_count).toBe(1);
        expect(
          doctorJson.checks.filter(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toEqual([
          {
            name: "mcp_config",
            status: "fail",
            detail: "failed to load ~/.lia/mcp.json: McpConfigInvalidJson",
          },
        ]);
        expect(ask.code).toBe(1);
        expect(ask.stderr).toBe("");
        expect(JSON.parse(ask.stdout)).toMatchObject({
          exit_code: 1,
          error: "McpConfigInvalidJson",
        });
        expect(gateway.requestCount()).toBe(0);
        expect(snapshotTree(home)).toEqual(before);

        writeFileSync(
          join(liaDir, "mcp.json"),
          JSON.stringify({
            "MCP-Servers": { fixture: { command: "node" } },
          }) + "\n",
          { mode: 0o600 },
        );
        const warningStatus = await runLia(["status", "--json"], { cwd, env });
        const warningDoctor = await runLia(["doctor", "--json"], { cwd, env });
        expect(JSON.parse(warningStatus.stdout)).toMatchObject({
          mcp_config_warning: {
            cause: "suspicious_server_key",
            key: "MCP-Servers",
            additional_matches: 0,
          },
        });
        expect(
          JSON.parse(warningDoctor.stdout).checks.find(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toMatchObject({ status: "warn" });

        writeFileSync(join(liaDir, "mcp.json"), '{"mcp":{}}\n', { mode: 0o600 });
        const validBefore = snapshotTree(home);
        const validStatus = await runLia(["status", "--json"], { cwd, env });
        const validDoctor = await runLia(["doctor", "--json"], { cwd, env });
        expect(validStatus.code).toBe(0);
        expect(validDoctor.code).toBe(0);
        expect(JSON.parse(validStatus.stdout)).not.toHaveProperty("mcp_config_error");
        expect(
          JSON.parse(validDoctor.stdout).checks.some(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toBe(false);
        expect(gateway.requestCount()).toBe(0);
        expect(snapshotTree(home)).toEqual(validBefore);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "doctor names unknown settings keys while status stays quiet",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-e2e-unknown-settings-")));
      try {
        const home = join(root, "home");
        const cwd = join(root, "workspace");
        mkdirSync(join(home, ".lia"), { recursive: true });
        mkdirSync(cwd);
        writeFileSync(
          join(home, ".lia", "settings.json"),
          JSON.stringify({
            $schema: "https://fx.sh/schemas/settings.json",
            fast_mdoe: true,
            statusLine: { contxt: true },
            status_line: { context: true },
            maxxing_mode: 1,
            workspaces: { [cwd]: { efort: "low" } },
          }) + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(cwd, ".lia.json"), JSON.stringify({ $schema: "https://fx.sh/schemas/fx.json", max_agent_step: 5 }) + "\n");
        const env = { ...NO_GATEWAY_AUTH, HOME: home, LIA_DISABLE_KEYCHAIN: "1" };

        const doctor = await runLia(["doctor", "--json"], { cwd, env });
        expect(doctor.code).toBe(0);
        const warnings = JSON.parse(doctor.stdout)
          .checks.filter((check: { name: string; status: string }) => check.name === "config" && check.status === "warn")
          .map((check: { detail: string }) => check.detail);
        expect(warnings).toEqual([
          "unknown setting fast_mdoe in ~/.lia/settings.json (did you mean fast_mode?)",
          `unknown setting efort in ~/.lia/settings.json for workspace ${cwd} (did you mean effort?)`,
          "unknown setting max_agent_step in .lia.json (did you mean max_agent_steps?)",
        ]);
        // statusLine and status_line are retired: loaded and ignored, never diagnosed.
        expect(doctor.stdout).not.toContain("statusLine");
        expect(doctor.stdout).not.toContain("status_line");

        const status = await runLia(["status"], { cwd, env });
        expect(status.code).toBe(0);
        expect(status.stderr).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia config schema prints the settings.json and .lia.json schemas",
    async () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "lia-e2e-config-schema-")));
      try {
        const env = { ...NO_GATEWAY_AUTH, HOME: home };
        const profile = await runLia(["config", "schema"], { env });
        expect(profile.code).toBe(0);
        expect(profile.stderr).toBe("");
        const schema = JSON.parse(profile.stdout);
        expect(schema.$id).toBeUndefined();
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties.fast_mode).toEqual({ description: "Use faster inference when the model supports it", type: "boolean" });
        expect(schema.properties.permission_mode.enum).toEqual(["ask", "auto", "full-access", "yolo"]);
        expect(schema.properties.auto_compact_percent).toMatchObject({ type: "integer", minimum: 10, maximum: 80 });
        expect(schema.properties.statusLine.deprecated).toBe(true);
        expect(schema.properties.workspaces.additionalProperties).toEqual({ $ref: "#/$defs/workspace" });
        expect(schema.properties.additional_directories).toBeUndefined();
        expect(schema.$defs.workspace.properties.additional_directories.type).toBe("array");
        expect(schema.$defs.workspace.properties.providers).toBeUndefined();

        const project = await runLia(["config", "schema", "--project"], { env });
        expect(project.code).toBe(0);
        const projectSchema = JSON.parse(project.stdout);
        expect(projectSchema.$id).toBeUndefined();
        expect(Object.keys(projectSchema.properties)).toEqual([
          "$schema",
          "context",
          "max_agent_steps",
          "max_tool_result_bytes",
          "provider_order",
          "provider_strict",
        ]);

        const misplaced = await runLia(["config", "list", "--project"], { env });
        expect(misplaced.code).toBe(2);
        expect(misplaced.stdout).toBe("");
        expect(misplaced.stderr).toContain("usage: lia config [list|get <key>|set <key> <value>|unset <key>|schema [--project]]");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia config lists settings in precedence order and gets the value lia uses",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-e2e-config-")));
      try {
        const home = join(root, "home");
        const cwd = join(root, "workspace");
        mkdirSync(join(home, ".lia"), { recursive: true });
        mkdirSync(cwd);
        const settingsPath = join(home, ".lia", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            fast_mode: true,
            fast_mdoe: 1,
            statusLine: { context: true },
            models: { gateway: "openai/gpt-5.5" },
            provider_order: ["a", "b"],
            workspaces: { [cwd]: { fast_mode: false } },
          }) + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(cwd, ".lia.json"), JSON.stringify({ max_agent_steps: 7, model: "ignored/here" }) + "\n");
        const env = { ...NO_GATEWAY_AUTH, ...NO_SETTING_ENV, HOME: home, LIA_DISABLE_KEYCHAIN: "1" };
        const before = readFileSync(settingsPath, "utf8");

        const list = await runLia(["config", "list", "--show-origin"], { cwd, env });
        expect(list.code).toBe(0);
        expect(list.stdout).toBe(
          [
            "file:.lia.json\tmax_agent_steps=7",
            "file:~/.lia/settings.json\tfast_mode=true",
            "file:~/.lia/settings.json\tmodels.gateway=openai/gpt-5.5",
            'file:~/.lia/settings.json\tprovider_order=["a","b"]',
            `workspace:${cwd}\tfast_mode=false`,
            "",
          ].join("\n"),
        );
        expect(list.stderr).toBe("lia config: unknown setting fast_mdoe in ~/.lia/settings.json (did you mean fast_mode?)\n");

        // The retired statusLine in the file is ignored, and lia config refuses it as unknown.
        for (const key of ["statusLine.context", "status_line.context"]) {
          const retired = await runLia(["config", "get", key], { cwd, env });
          expect([retired.code, retired.stdout]).toEqual([2, ""]);
          expect(retired.stderr).toStartWith(`lia config: unknown setting ${key.split(".")[0]}\nusage: lia config`);
        }

        // get reads the settings the runtime resolves, so it gives the same
        // warnings a run does: this .lia.json sets a profile-only key.
        const projectWarning = "lia: config project: ignored_project_user_only_setting; key=model\n";
        const get = await runLia(["config", "get", "fast_mode"], { cwd, env });
        expect([get.code, get.stdout, get.stderr]).toEqual([0, "false\n", projectWarning]);
        const global = await runLia(["config", "get", "fast_mode", "--global"], { cwd, env });
        expect([global.code, global.stdout]).toEqual([0, "true\n"]);
        const unset = await runLia(["config", "get", "theme"], { cwd, env });
        expect([unset.code, unset.stdout, unset.stderr]).toEqual([1, "", projectWarning]);
        // A key nothing sets gives the value lia uses, labeled default.
        const fallback = await runLia(["config", "get", "--show-origin", "permission_mode"], { cwd, env });
        expect([fallback.code, fallback.stdout]).toEqual([0, "default\tauto\n"]);

        const typo = await runLia(["config", "get", "fast_mdoe"], { cwd, env });
        expect(typo.code).toBe(2);
        expect(typo.stderr).toStartWith("lia config: unknown setting fast_mdoe (did you mean fast_mode?)\nusage: lia config");

        // Documented LIA_* overrides come last, as lia applies them; an ignored value doesn't show.
        const withEnv = { ...env, LIA_MAX_AGENT_STEPS: "20", LIA_SOUND: "off" };
        const fromEnv = await runLia(["config", "list", "--show-origin"], { cwd, env: withEnv });
        expect(fromEnv.stdout.trimEnd().split("\n").slice(-4)).toEqual([
          "env:LIA_MAX_AGENT_STEPS\tmax_agent_steps=20",
          "env:LIA_SOUND\tsound.turn_end=false",
          "env:LIA_SOUND\tsound.attention_required=false",
          "env:LIA_SOUND\tsound.max=false",
        ]);
        const envGet = await runLia(["config", "get", "max_agent_steps"], { cwd, env: withEnv });
        expect([envGet.code, envGet.stdout]).toEqual([0, "20\n"]);
        const ignored = await runLia(["config", "get", "max_agent_steps"], { cwd, env: { ...env, LIA_MAX_AGENT_STEPS: "many" } });
        expect([ignored.code, ignored.stdout]).toEqual([0, "7\n"]);
        const scoped = await runLia(["config", "list", "--global", "--show-origin"], { cwd, env: withEnv });
        expect(scoped.stdout).not.toContain("env:");

        const json = await runLia(["config", "--workspace", "--json"], { cwd, env });
        expect(json.code).toBe(0);
        expect(JSON.parse(json.stdout)).toEqual({
          kind: "config",
          entries: [{ key: "fast_mode", value: false, origin: "workspace", file: "~/.lia/settings.json", workspace: cwd }],
          unknown: [],
        });

        expect(readFileSync(settingsPath, "utf8")).toBe(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia config set and unset change plain preferences and refuse the rest",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-e2e-config-set-")));
      try {
        const home = join(root, "home");
        const cwd = join(root, "workspace");
        mkdirSync(join(home, ".lia"), { recursive: true });
        mkdirSync(cwd);
        const settingsPath = join(home, ".lia", "settings.json");
        writeFileSync(settingsPath, JSON.stringify({ statusLine: { session: true } }) + "\n", { mode: 0o600 });
        const env = { ...NO_GATEWAY_AUTH, ...NO_SETTING_ENV, HOME: home, LIA_DISABLE_KEYCHAIN: "1" };
        const settings = () => JSON.parse(readFileSync(settingsPath, "utf8"));

        const set = await runLia(["config", "set", "fast_mode", "on"], { cwd, env });
        expect([set.code, set.stdout, set.stderr]).toEqual([0, "fast_mode set to true in ~/.lia/settings.json.\n", ""]);
        const again = await runLia(["config", "set", "fast_mode", "true"], { cwd, env });
        expect([again.code, again.stdout]).toEqual([0, "fast_mode is already true.\n"]);
        const steps = await runLia(["config", "set", "max_agent_steps", "40", "--json"], { cwd, env });
        expect(steps.code).toBe(0);
        expect(JSON.parse(steps.stdout)).toEqual({
          kind: "config",
          action: "set",
          key: "max_agent_steps",
          value: 40,
          changed: true,
          file: "~/.lia/settings.json",
        });
        // Saving drops the retired statusLine the file started with.
        expect(settings()).toEqual({ fast_mode: true, max_agent_steps: 40 });
        for (const [verb, key] of [["unset", "statusLine.session"], ["set", "status_line.context"], ["set", "startup_scrollback"]]) {
          const retired = await runLia(["config", verb!, key!, ...(verb === "set" ? ["false"] : [])], { cwd, env });
          expect([retired.code, retired.stdout]).toEqual([2, ""]);
          expect(retired.stderr).toStartWith(`lia config: unknown setting ${key!.split(".")[0]}\nusage: lia config`);
        }
        const get = await runLia(["config", "get", "max_agent_steps"], { cwd, env });
        expect([get.code, get.stdout]).toEqual([0, "40\n"]);

        const before = readFileSync(settingsPath, "utf8");
        const refusals: Array<[string[], string]> = [
          [
            ["config", "set", "permission_mode", "full-access"],
            "lia config: can't change permission_mode with lia config; use --permission-mode for one run, or edit ~/.lia/settings.json\n",
          ],
          [["config", "set", "fast_mode", "maybe"], "lia config: invalid value for fast_mode: maybe (use true or false)\n"],
          [["config", "set", "models.gateway", "openai/gpt-5.5"], "lia config: can't change models.gateway with lia config; use --model for one run, or edit ~/.lia/settings.json\n"],
        ];
        for (const [args, stderr] of refusals) {
          const result = await runLia(args, { cwd, env });
          expect([result.code, result.stdout, result.stderr]).toEqual([2, "", stderr]);
        }
        const workspace = await runLia(["config", "set", "--workspace", "fast_mode", "off"], { cwd, env });
        expect(workspace.code).toBe(2);
        expect(workspace.stderr).toStartWith(
          "lia config: preferences apply to every workspace, so set and unset don't take --workspace\nusage: lia config",
        );
        expect(readFileSync(settingsPath, "utf8")).toBe(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor share the missing auth snapshot",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-status-noauth-"));
      try {
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(root),
          LIA_DISABLE_KEYCHAIN: "1",
        };
        const status = await runLia(["status", "--json"], { env });
        const doctor = await runLia(["doctor", "--json"], { env });

        expect(status.code).toBe(0);
        expect(doctor.code).toBe(0);
        const statusJson = JSON.parse(status.stdout.trim());
        const doctorJson = JSON.parse(doctor.stdout.trim());
        expect(statusJson).toMatchObject({
          auth: "missing",
          auth_refreshable: false,
          auth_help: MISSING_AUTH_MESSAGE,
        });
        expect(statusJson).not.toHaveProperty("sandbox");
        expect(doctorJson).toMatchObject({
          auth: "missing",
          auth_refreshable: false,
        });
        expect(doctorJson.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  for (const scenario of [
    { name: "automatic Gateway", provider: "gateway", source: undefined, help: MISSING_AUTH_MESSAGE },
    { name: "an exact Gateway login", provider: "gateway", source: "fx_login", help: "lia login is selected but unavailable. Run lia login to reconnect; no other credential was selected." },
    { name: "an exact OIDC token", provider: "gateway", source: "vercel_oidc_token", help: "VERCEL_OIDC_TOKEN is selected but unavailable. Set VERCEL_OIDC_TOKEN before starting lia; no other credential was selected." },
    { name: "an exact environment key", provider: "gateway", source: "ai_gateway_api_key", help: "AI_GATEWAY_API_KEY is selected but unavailable. Set AI_GATEWAY_API_KEY before starting lia; no other credential was selected." },
    { name: "an exact stored key", provider: "gateway", source: "stored_key", help: "A stored API key is selected but unavailable. Run lia login vercel --api-key to save a key again, or lia login to sign in instead; no other credential was selected." },
  ]) {
    test(
      `status and doctor respect ${scenario.name} when credentials are missing`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "lia-e2e-provider-diagnostics-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(join(home, ".lia"), { recursive: true });
          mkdirSync(workspace);
          const settingsPath = join(home, ".lia", "settings.json");
          const settings = JSON.stringify({
            provider: scenario.provider,
            models: { [scenario.provider]: "test-model" },
            credential_source: scenario.source,
          });
          writeFileSync(settingsPath, settings);
          const options = {
            cwd: realpathSync(workspace),
            env: { ...NO_GATEWAY_AUTH, HOME: realpathSync(home), LIA_DISABLE_KEYCHAIN: "1" },
          };

          for (const command of ["status", "doctor"]) {
            const text = await runLia([command], options);
            const json = await runLia([command, "--json"], options);
            expect(text.code).toBe(0);
            expect(json.code).toBe(0);
            expect(text.stderr).toBe("");
            expect(json.stderr).toBe("");
            expect(text.stdout).toContain(scenario.help);
            const value = JSON.parse(json.stdout);
            expect(value.auth).toBe("missing");
            expect(value.auth_refreshable).toBe(false);
            if (command === "status") {
              expect(value.auth_help).toBe(scenario.help);
            } else {
              expect(value.checks).toContainEqual({
                name: "auth", status: "fail", detail: scenario.help,
              });
            }
          }

          const ask = await runLia(["ask", "--json", "--no-save", "Say hello."], options);
          expect(ask.code).toBe(1);
          expect(JSON.parse(ask.stdout).error).toBe("MissingCredentials");
          expect(ask.stderr).toContain(scenario.help);
          expect(readFileSync(settingsPath, "utf8")).toBe(settings);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }

  test("LIA_HOME holds settings and sessions in place of ~/.lia", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-home-")));
    const gateway = startFakeGateway([fakeGatewayFinalText("SAVED_UNDER_FX_HOME")]);
    try {
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const liaHome = join(root, "profile");
      mkdirSync(home);
      mkdirSync(workspace);
      const options = {
        cwd: workspace,
        env: {
          HOME: home,
          LIA_HOME: liaHome,
          AI_GATEWAY_API_KEY: "lia-home-key",
          VERCEL_OIDC_TOKEN: undefined,
          LIA_MODEL: FAKE_GATEWAY_MODEL,
          LIA_DISABLE_KEYCHAIN: "1",
          LIA_GATEWAY_BASE_URL: gateway.baseUrl,
          LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
          LIA_TEST_GATEWAY_MODELS_URL: `${gateway.baseUrl}/coding-agent/v1/models`,
        },
      };

      const set = await runLia(["config", "set", "theme", "light"], options);
      expect(set.code).toBe(0);
      expect(set.stdout).toBe("theme set to light in $LIA_HOME/settings.json.\n");
      expect(JSON.parse(readFileSync(join(liaHome, "settings.json"), "utf8")).theme).toBe("light");

      const status = await runLia(["status", "--json"], options);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout).lia_home).toBe(liaHome);

      const asked = await runLia(["ask", "--json", "Say something."], options);
      expect(asked.code).toBe(0);
      const sessionId = JSON.parse(asked.stdout).session_id;
      expect(existsSync(join(liaHome, "sessions"))).toBe(true);
      const sessions = await runLia(["sessions", "--json"], options);
      expect(sessions.stdout).toContain(sessionId);

      expect(existsSync(join(home, ".lia"))).toBe(false);

      const relative = await runLia(["status"], { ...options, env: { ...options.env, LIA_HOME: "profile" } });
      expect(relative.code).toBe(1);
      expect(relative.stderr).toBe("lia: LIA_HOME must be an absolute path\n");

      // A relative HOME counts as unset, so with LIA_HOME unset lia has no
      // folder of its own, and status names none.
      const relativeHome = await runLia(["status", "--json"], {
        ...options,
        env: { ...options.env, HOME: "relative/home", LIA_HOME: undefined },
      });
      expect(relativeHome.code).toBe(0);
      expect(JSON.parse(relativeHome.stdout).lia_home).toBeUndefined();

      // With LIA_HOME set, a relative HOME counts as unset the same way, so
      // LIA_HOME still holds lia's files.
      const relativeWithLiaHome = { ...options, env: { ...options.env, HOME: "relative/home" } };
      const statusWithLiaHome = await runLia(["status", "--json"], relativeWithLiaHome);
      expect(statusWithLiaHome.code).toBe(0);
      expect(JSON.parse(statusWithLiaHome.stdout).lia_home).toBe(liaHome);
      const added = await runLia(["mcp", "add", "probe", "--", "/bin/echo", "hi"], relativeWithLiaHome);
      expect(added.code).toBe(0);
      expect(added.stdout).toBe("Added probe to $LIA_HOME/mcp.json.\n");
      expect(existsSync(join(workspace, "relative"))).toBe(false);
    } finally {
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("fresh and resumed asks retain an unavailable exact login with an environment key", async () => {
    const root = mkdtempSync(join(tmpdir(), "lia-ask-exact-source-"));
    const gateway = startFakeGateway([
      fakeGatewayFinalText("SESSION_SEEDED"),
      fakeGatewayFinalText("AUTOMATIC_KEY_WORKS"),
    ]);
    try {
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(join(home, ".lia"), { recursive: true });
      mkdirSync(workspace);
      const settingsPath = join(home, ".lia", "settings.json");
      const settings = { provider: "gateway", models: { gateway: FAKE_GATEWAY_MODEL } };
      writeFileSync(settingsPath, JSON.stringify(settings));
      const options = {
        cwd: realpathSync(workspace),
        env: {
          HOME: realpathSync(home),
          AI_GATEWAY_API_KEY: "exact-source-control-key",
          VERCEL_OIDC_TOKEN: undefined,
          LIA_MODEL: undefined,
          LIA_DISABLE_KEYCHAIN: "1",
          LIA_GATEWAY_BASE_URL: gateway.baseUrl,
          LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
          LIA_TEST_GATEWAY_MODELS_URL: `${gateway.baseUrl}/coding-agent/v1/models`,
        },
      };
      const seeded = await runLia(["ask", "--json", "Create a short greeting."], options);
      expect(seeded.code).toBe(0);
      const sessionId = JSON.parse(seeded.stdout).session_id;
      expect(sessionId.length).toBeGreaterThan(0);
      expect(gateway.requests).toHaveLength(1);

      const pinned = JSON.stringify({ ...settings, credential_source: "fx_login" });
      writeFileSync(settingsPath, pinned);
      const status = await runLia(["status", "--json"], options);
      const help = JSON.parse(status.stdout).auth_help;
      expect(help).toContain("lia login is selected but unavailable");
      for (const resumed of [false, true]) {
        for (const json of [false, true]) {
          const result = await runLia([
            "ask", ...(json ? ["--json"] : []),
            ...(resumed ? ["--resume", sessionId] : ["--no-save"]),
            "Continue with a greeting.",
          ], options);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain(help);
          expect(result.stderr).not.toContain("set AI_GATEWAY_API_KEY");
          if (json) expect(JSON.parse(result.stdout).error).toBe("MissingCredentials");
          expect(readFileSync(settingsPath, "utf8")).toBe(pinned);
          expect(gateway.requests).toHaveLength(1);
        }
      }

      writeFileSync(settingsPath, JSON.stringify(settings));
      const automatic = await runLia(["ask", "--json", "--no-save", "Give a greeting."], options);
      expect(automatic.code).toBe(0);
      expect(JSON.parse(automatic.stdout).output).toContain("AUTOMATIC_KEY_WORKS");
      expect(gateway.requests).toHaveLength(2);
    } finally {
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test(
    "status and doctor share lia login source, team, and refreshability",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-status-auth-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        writeSeededLiaAuth(home, "team_123");
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          LIA_DISABLE_KEYCHAIN: "1",
        };
        const cwd = realpathSync(workspace);

        const statusText = await runLia(["status"], { cwd, env });
        const statusJsonResult = await runLia(["status", "--json"], { cwd, env });
        const doctorText = await runLia(["doctor"], { cwd, env });
        const doctorJsonResult = await runLia(["doctor", "--json"], { cwd, env });

        expect(statusText.code).toBe(0);
        expect(statusJsonResult.code).toBe(0);
        expect(doctorText.code).toBe(0);
        expect(doctorJsonResult.code).toBe(0);
        const expectedAuth = {
          auth: "lia login",
          auth_refreshable: true,
          team: "vercel-labs",
        };
        expect(JSON.parse(statusJsonResult.stdout.trim())).toMatchObject(expectedAuth);
        expect(JSON.parse(doctorJsonResult.stdout.trim())).toMatchObject(expectedAuth);
        for (const output of [statusText.stdout, doctorText.stdout]) {
          expect(output).toContain("auth=lia login");
          expect(output).toContain("auth_refreshable=true");
          expect(output).toContain("team=vercel-labs");
        }
        for (const output of [
          statusText.stdout,
          statusJsonResult.stdout,
          doctorText.stdout,
          doctorJsonResult.stdout,
        ]) {
          expect(output).not.toContain(SEEDED_GATEWAY_TOKEN);
          expect(output).not.toContain("seeded-refresh-token");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor inspect an expired login without refreshing it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-status-expired-auth-"));
      const requestCatcher = startRequestCatcher();
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        writeSeededLiaAuth(
          home,
          "team_123",
          requestCatcher.issuerUrl,
          Date.now() - 60_000,
        );
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          LIA_DISABLE_KEYCHAIN: "1",
          LIA_TEST_OAUTH_ISSUER_URL: requestCatcher.issuerUrl,
        };
        const cwd = realpathSync(workspace);

        const status = await runLia(["status", "--json"], { cwd, env });
        const doctor = await runLia(["doctor", "--json"], { cwd, env });

        expect(status.code).toBe(0);
        expect(doctor.code).toBe(0);
        const expectedAuth = {
          auth: "lia login",
          auth_refreshable: true,
          team: "vercel-labs",
        };
        expect(JSON.parse(status.stdout.trim())).toMatchObject(expectedAuth);
        expect(JSON.parse(doctor.stdout.trim())).toMatchObject(expectedAuth);
        expect(requestCatcher.requests).toEqual([]);
      } finally {
        requestCatcher.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "a new status process keeps normal credential precedence",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-status-precedence-"));
      try {
        writeSeededLiaAuth(root, "team_123");
        const envToken = "preferred-environment-token";
        const env = {
          HOME: realpathSync(root),
          VERCEL_OIDC_TOKEN: undefined,
          AI_GATEWAY_API_KEY: envToken,
          LIA_DISABLE_KEYCHAIN: "1",
        };

        const status = await runLia(["status", "--json"], { env });
        const doctor = await runLia(["doctor", "--json"], { env });

        const expectedAuth = {
          auth: "AI_GATEWAY_API_KEY",
          auth_refreshable: false,
        };
        expect(JSON.parse(status.stdout.trim())).toMatchObject(expectedAuth);
        expect(JSON.parse(doctor.stdout.trim())).toMatchObject(expectedAuth);
        expect(status.stdout).not.toContain(envToken);
        expect(doctor.stdout).not.toContain(envToken);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia status --json returns valid status JSON",
    async () => {
      const r = await runLia(["status", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("status");
      expect(json).toHaveProperty("model");
      expect(json).toHaveProperty("workspace");
      expect(json).toHaveProperty("permission_mode");
      expect(json).toHaveProperty("history_turns");
      expect(json).toHaveProperty("agent_step_limit");
      expect(json.build_revision).toMatch(/^[0-9a-f]{12}$/);
      expect(typeof json.update_channel).toBe("string");
      expect(typeof json.build_channel).toBe("string");
      const keys = Object.keys(json);
      expect(keys.indexOf("update_channel")).toBeGreaterThan(-1);
      expect(keys.indexOf("build_channel")).toBe(keys.indexOf("update_channel") + 1);
      expect(keys.indexOf("build_revision")).toBe(keys.indexOf("build_channel") + 1);
    },
    TIMEOUT,
  );

  test(
    "lia status reports the effort a new session starts with, workspace override first",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-status-effort-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const elsewhere = join(root, "elsewhere");
        mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(elsewhere);
        const env = { ...NO_GATEWAY_AUTH, HOME: home };

        const unset = await runLia(["status", "--json"], { cwd: realpathSync(elsewhere), env });
        expect(unset.code).toBe(0);
        expect(JSON.parse(unset.stdout.trim()).effort).toBe("auto");

        writeFileSync(
          join(home, ".lia", "settings.json"),
          JSON.stringify({ effort: "xhigh", workspaces: { [realpathSync(workspace)]: { effort: "low" } } }) + "\n",
          { mode: 0o600 },
        );
        const inWorkspace = await runLia(["status", "--json"], { cwd: realpathSync(workspace), env });
        const global = await runLia(["status", "--json"], { cwd: realpathSync(elsewhere), env });
        const text = await runLia(["status"], { cwd: realpathSync(elsewhere), env });
        for (const result of [inWorkspace, global, text]) {
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
        }
        expect(JSON.parse(inWorkspace.stdout.trim()).effort).toBe("low");
        expect(JSON.parse(global.stdout.trim()).effort).toBe("xhigh");
        expect(text.stdout).toContain("[status] effort=xhigh\n");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia status loads settings left by the retired auto_upgrade and update_channel keys without a warning",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-status-retired-update-keys-"));
      try {
        const home = join(root, "home");
        mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
        writeFileSync(
          join(home, ".lia", "settings.json"),
          JSON.stringify({ auto_upgrade: false, update_channel: "dev", effort: "low" }) + "\n",
          { mode: 0o600 },
        );

        const result = await runLia(["status", "--json"], { env: { ...NO_GATEWAY_AUTH, HOME: home } });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        // The same file's live key still applies, so the file was read, not skipped.
        expect(JSON.parse(result.stdout.trim()).effort).toBe("low");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia mcp list reports bad arguments as JSON when --json is given",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-mcp-list-json-"));
      try {
        for (const [args, error] of [
          [["mcp", "list", "--bogus", "--json"], "unknown flag --bogus"],
          [["mcp", "list", "--json", "--bogus"], "unknown flag --bogus"],
          [["mcp", "list", "extra", "--json"], "lia mcp list takes no server name."],
        ] as const) {
          const result = await runLia([...args], { env: { HOME: home } });
          expect(result.code).toBe(2);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toEqual({
            kind: "mcp_list",
            error,
            code: "InvalidLocalSurfaceArgs",
          });
        }
        const text = await runLia(["mcp", "list", "--bogus"], { env: { HOME: home } });
        expect(text.code).toBe(2);
        expect(text.stdout).toBe("");
        expect(text.stderr).toStartWith("lia mcp list: unknown flag --bogus\nusage: lia mcp list");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia status --json defaults permission mode to auto",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-permission-default-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runLia(["status", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            LIA_PERMISSION_MODE: undefined,
          },
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.permission_mode).toBe("auto");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor apply an exact LIA_MAX_AGENT_STEPS override",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-agent-step-limit-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          LIA_MAX_AGENT_STEPS: "3",
        };

        const status = await runLia(["status", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout.trim()).agent_step_limit).toBe(3);

        const doctor = await runLia(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        const startup = JSON.parse(doctor.stdout.trim()).checks.find(
          (check: { name: string }) => check.name === "startup",
        );
        expect(startup.detail).toContain("agent_step_limit=3");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "project profile-only settings are ignored before parsing and profile overrides win",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-profile-config-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".lia"), { recursive: true });
        mkdirSync(workspace);
        const homeRoot = realpathSync(home);
        const workspaceRoot = realpathSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: homeRoot,
          LIA_MODEL: undefined,
          LIA_PERMISSION_MODE: undefined,
          LIA_MAX_AGENT_STEPS: undefined,
        };

        writeFileSync(
          join(home, ".lia", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
          }) + "\n",
        );
        writeFileSync(
          join(workspace, ".lia.json"),
          JSON.stringify({
            model: 123,
            permission_mode: "danger",
            permission: { bash: true },
            statusLine: 7,
            max_agent_steps: 7,
          }) + "\n",
        );

        const status = await runLia(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        const first = JSON.parse(status.stdout.trim());
        expect(first.model).toBe("anthropic/claude-sonnet-4.6");
        expect(first.permission_mode).toBe("auto");
        expect(first.agent_step_limit).toBe(7);
        expect(status.stderr).toContain(
          "lia: config project: ignored_project_user_only_setting; key=model",
        );
        expect(status.stderr).toContain(
          "lia: config project: ignored_project_user_only_setting; key=permission_mode",
        );
        expect(status.stderr).toContain(
          "lia: config project: ignored_project_user_only_setting; key=permission",
        );
        // statusLine is retired, so a project file's copy is ignored without a warning.
        expect(status.stderr).not.toContain("key=statusLine");
        expect(status.stderr).not.toContain("danger");

        writeFileSync(
          join(home, ".lia", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
            workspaces: {
              [workspaceRoot]: {
                max_agent_steps: 4,
              },
            },
          }) + "\n",
        );

        const overridden = await runLia(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(overridden.code).toBe(0);
        const second = JSON.parse(overridden.stdout.trim());
        expect(second.model).toBe("anthropic/claude-sonnet-4.6");
        expect(second.permission_mode).toBe("auto");
        expect(second.agent_step_limit).toBe(4);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "special settings files fail closed without blocking CLI startup",
    async () => {
      if (platform() === "win32") return;
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-config-special-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const liaDir = join(home, ".lia");
        mkdirSync(liaDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(liaDir, 0o700);

        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: home,
          LIA_DISABLE_KEYCHAIN: "1",
          LIA_TEST_SKIP_ONBOARDING: "1",
          LIA_SOUND: "0",
        };

        expect(spawnSync("mkfifo", [join(liaDir, "settings.json")]).status).toBe(0);
        const userStartedAt = Date.now();
        const user = await runLia(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 3_000,
        });
        expect(Date.now() - userStartedAt).toBeLessThan(3_000);
        expect(user.code).toBe(0);
        expect(JSON.parse(user.stdout)).toMatchObject({ kind: "status" });
        expect(user.stderr).toContain("lia: config user: durable_path_unsafe");

        rmSync(join(liaDir, "settings.json"));
        expect(spawnSync("mkfifo", [join(workspace, ".lia.json")]).status).toBe(0);
        const projectStartedAt = Date.now();
        const project = await runLia(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 3_000,
        });
        expect(Date.now() - projectStartedAt).toBeLessThan(3_000);
        expect(project.code).toBe(0);
        expect(JSON.parse(project.stdout)).toMatchObject({ kind: "status" });
        expect(project.stderr).toContain("lia: config project: durable_path_unsafe");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: usage", () => {
  const today = utcDate(USAGE_NOW_MS);
  const reportRow = (start: string, end: string): ReportRow[] => {
    if (start === today) {
      return [{ model: "provider/a", request_count: 2, input_tokens: 10, output_tokens: 5, total_cost: 0.5 }];
    }
    if (end !== utcDate(USAGE_NOW_MS - DAY_MS)) return [];
    // The month's finished days add a second model on top of the week's.
    return start === "2026-10-01"
      ? [
        { model: "provider/b", request_count: 4, input_tokens: 40, output_tokens: 8, total_cost: 2 },
        { model: "provider/a", request_count: 1, input_tokens: 4, output_tokens: 1, total_cost: 0.25 },
      ]
      : [{ model: "provider/a", request_count: 1, input_tokens: 4, output_tokens: 1, total_cost: 0.25 }];
  };

  function usageFixture(prefix: string, options: Parameters<typeof usageFake>[0] = {}) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const home = join(root, "home");
    mkdirSync(home);
    const clock = join(root, "clock");
    writeUsageClock(clock, USAGE_NOW_MS);
    const fake = usageFake({ report: reportRow, ...options });
    const gateway = startFakeGateway([], { usage: fake.handler });
    const env = {
      ...NO_GATEWAY_AUTH,
      ...usageEnv(gateway.baseUrl, clock),
      HOME: realpathSync(home),
    };
    return {
      root,
      home,
      clock,
      fake,
      gateway,
      env,
      stop() {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  test(
    "lia usage without a sign-in says so, reads nothing, and leaves the profile alone",
    async () => {
      const fixture = usageFixture("lia-e2e-usage-none-");
      try {
        const text = await runLia(["usage"], { env: fixture.env });
        expect(text.code).toBe(1);
        expect(text.stdout).toContain("Usage needs an AI Gateway sign-in: run lia login or set an API key.");
        const json = await runLia(["usage", "--json"], { env: fixture.env });
        expect(json.code).toBe(1);
        expect(JSON.parse(json.stdout)).toMatchObject({
          kind: "usage",
          schema_version: 2,
          source: "ai_gateway",
          status: "unavailable",
          reason: "no_gateway_sign_in",
        });
        expect(fixture.fake.requests).toEqual([]);
        expect(readdirSync(fixture.home)).toEqual([]);
      } finally {
        fixture.stop();
      }
    },
    TIMEOUT,
  );

  test(
    "lia usage reads an API key's spend from AI Gateway and fetches finished days once a day",
    async () => {
      const fixture = usageFixture("lia-e2e-usage-key-");
      const env = { ...fixture.env, AI_GATEWAY_API_KEY: "e2e-usage-key" };
      try {
        const month = await runLia(["usage", "--json"], { env });
        expect(month.code).toBe(0);
        expect(month.stderr).toBe("");
        const report = JSON.parse(month.stdout);
        expect(report).toMatchObject({
          source: "ai_gateway",
          period: "month",
          status: "ready",
          reason: null,
          budget: null,
          totals: { request_count: 7, input_tokens: 54, output_tokens: 14 },
        });
        expect(report.totals.spend).toBeCloseTo(2.75, 6);
        expect(report.models.map((row: { model: string }) => row.model)).toEqual(["provider/b", "provider/a"]);
        expect(fixture.fake.reportRanges()).toEqual([
          `${today}..${today}`,
          "2026-10-06..2026-10-11",
          "2026-10-01..2026-10-11",
        ]);
        for (const request of fixture.fake.requests) {
          expect(request.authorization).toBe("Bearer e2e-usage-key");
          expect(request.query.get("api_key_id")).toBe("self");
          expect(request.query.get("group_by")).toBe("model");
        }

        // Later the same day only today is read again; the cache answers the rest.
        const week = await runLia(["usage", "--period", "7d"], { env });
        expect(week.code).toBe(0);
        expect(week.stderr).toBe("");
        expect(week.stdout).toContain("Usage (7d, UTC) from AI Gateway");
        expect(week.stdout).toContain("Requests      3");
        expect(week.stdout).toContain("- provider/a  $0.7500  3 requests  20 tokens");
        expect(fixture.fake.reportRanges().slice(3)).toEqual([`${today}..${today}`]);

        // A new UTC day reads its finished days again.
        writeUsageClock(fixture.clock, USAGE_NOW_MS + DAY_MS);
        const next = await runLia(["usage", "--json", "--period", "today"], { env });
        expect(next.code).toBe(0);
        expect(fixture.fake.reportRanges().slice(4)).toEqual([
          "2026-10-13..2026-10-13",
          "2026-10-07..2026-10-12",
          "2026-10-01..2026-10-12",
        ]);
        const output = month.stdout + week.stdout + next.stdout;
        expect(output).not.toContain("e2e-usage-key");
      } finally {
        fixture.stop();
      }
    },
    TIMEOUT,
  );

  test(
    "lia usage with lia login reads the member's team spend and budget",
    async () => {
      const fixture = usageFixture("lia-e2e-usage-member-", {
        budget: {
          users: [{ budget: { limitAmount: 50, currentSpend: 12, refreshPeriod: "monthly" } }],
        },
      });
      writeSeededLiaAuth(fixture.home, "team_e2e", fixture.gateway.baseUrl);
      const env = { ...fixture.env, LIA_TEST_OAUTH_ISSUER_URL: fixture.gateway.baseUrl };
      try {
        const json = await runLia(["usage", "--json"], { env });
        expect(json.code).toBe(0);
        expect(json.stderr).toBe("");
        expect(JSON.parse(json.stdout)).toMatchObject({
          status: "ready",
          budget: { limit: 50, spent: 12, period: "monthly" },
        });
        const reports = fixture.fake.requests.filter((request) => request.path === "/v1/report");
        expect(reports).toHaveLength(3);
        for (const request of reports) {
          expect(request.authorization).toBe(`Bearer ${SEEDED_GATEWAY_TOKEN}`);
          expect(request.team).toBe("team_e2e");
          expect(request.query.get("metered_scope")).toBe("user");
        }
        const budget = fixture.fake.requests.find((request) => request.path === "/ai-gateway/usage-report");
        expect(budget?.query.get("teamId")).toBe("team_e2e");
        expect(budget?.query.get("scope")).toBe("user");

        const text = await runLia(["usage"], { env });
        expect(text.code).toBe(0);
        expect(text.stdout).toContain("Budget        $12.00 of $50.00 this month");
        expect(text.stdout).not.toContain(SEEDED_GATEWAY_TOKEN);
      } finally {
        fixture.stop();
      }
    },
    TIMEOUT,
  );

  test(
    "lia usage keeps its cache in LIA_HOME",
    async () => {
      const fixture = usageFixture("lia-e2e-usage-lia-home-");
      const liaHome = join(realpathSync(fixture.root), "profile");
      const env = { ...fixture.env, AI_GATEWAY_API_KEY: "e2e-usage-key", LIA_HOME: liaHome };
      try {
        const json = await runLia(["usage", "--json"], { env });
        expect(json.code).toBe(0);
        expect(readdirSync(join(liaHome, "usage-cache")).length).toBeGreaterThan(0);
        expect(existsSync(join(fixture.home, ".lia"))).toBe(false);
      } finally {
        fixture.stop();
      }
    },
    TIMEOUT,
  );

  test(
    "lia usage keeps the last numbers when AI Gateway refuses the sign-in",
    async () => {
      let refuse = false;
      const fixture = usageFixture("lia-e2e-usage-refused-", {
        report: (start, end) =>
          refuse ? new Response("unauthorized", { status: 401 }) : reportRow(start, end),
      });
      const env = { ...fixture.env, AI_GATEWAY_API_KEY: "e2e-usage-key" };
      try {
        expect((await runLia(["usage", "--json"], { env })).code).toBe(0);
        refuse = true;
        // Past the one-minute floor, so the second process fetches again.
        writeUsageClock(fixture.clock, USAGE_NOW_MS + 2 * 60 * 1000);
        const json = await runLia(["usage", "--json"], { env });
        expect(json.code).toBe(1);
        const report = JSON.parse(json.stdout);
        expect(report).toMatchObject({ status: "failed", reason: "refused" });
        expect(report.totals.request_count).toBe(7);
        const text = await runLia(["usage"], { env });
        expect(text.stdout).toContain("Refresh failed: AI Gateway refused this sign-in.");
        expect(text.stdout).toContain("Requests      7");
      } finally {
        fixture.stop();
      }
    },
    TIMEOUT,
  );
});

describe("cli: permissions", () => {
  test(
    "lia permissions --json returns valid permissions JSON",
    async () => {
      const r = await runLia(["permissions", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("permissions");
      expect(json).toHaveProperty("mode");
      expect(json).toHaveProperty("grant_count");
      expect(json.grant_scope).toBe("session");
      expect(json.runtime_grants_available).toBe(false);
      expect(json.rules_scope).toBe("persistent_config");
      expect(Array.isArray(json.rules)).toBe(true);
      expect(Array.isArray(json.grants)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("cli: doctor", () => {
  test(
    "lia doctor --json returns valid doctor JSON",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-doctor-json-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runLia(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(Array.isArray(json.checks)).toBe(true);
        expect(json).toHaveProperty("ok_count");
        expect(json).toHaveProperty("warn_count");
        expect(json).toHaveProperty("fail_count");
        expect(json.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
        for (const check of json.checks) {
          expect(check).toHaveProperty("name");
          expect(check).toHaveProperty("status");
          expect(check).toHaveProperty("detail");
          expect(["ok", "warn", "fail"]).toContain(check.status);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia doctor --json leaves an empty home unchanged",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-doctor-no-create-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runLia(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout.trim()).kind).toBe("doctor");
        expect(existsSync(join(home, ".lia"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia doctor --json bounds diagnostics while reporting the cache-free session count",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-doctor-bounded-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const limit = doctorSessionDiagnosticsLimit();
        const sessionCount = limit + 32;
        for (let i = 0; i < sessionCount; i += 1) {
          writeLegacySession(
            home,
            workspaceRoot,
            `doctor-bounded-${String(i).padStart(3, "0")}`,
            { updatedAtMs: i + 1 },
          );
        }

        expect(existsSync(join(home, ".lia", "sessions", "summary.json"))).toBe(false);

        const r = await runLia(["doctor", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: home,
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout.length).toBeLessThan(64 * 1024);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(json.checks.length).toBeLessThan(sessionCount);
        expect(json.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "session",
              status: "warn",
              detail: expect.stringContaining(
                `truncated after ${limit} session director`,
              ),
            }),
            expect.objectContaining({
              name: "sessions",
              status: "ok",
              // Sessions an older lia saved, each converted when first
              // opened (D73).
              detail: expect.stringContaining(
                `${sessionCount} session(s) saved by an older lia`,
              ),
            }),
          ]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: logout", () => {
  test(
    "lia logout revokes refresh and access tokens after local deletion",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-logout-revocation-"));
      const authPath = join(home, ".lia", "auth.json");
      const issuer = startLogoutIssuer([200, 200], authPath);
      try {
        writeSeededLiaAuth(home, undefined, issuer.issuerUrl);

        const logout = await runLia(["logout"], {
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            LIA_DISABLE_KEYCHAIN: "1",
          },
        });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("Signed out of lia.\n");
        expect(logout.stderr).toBe("");
        expect(existsSync(authPath)).toBe(false);
        expect(issuer.requests).toEqual([
          { method: "GET", path: "/.well-known/openid-configuration" },
          {
            method: "POST",
            path: "/oauth/revoke",
            tokenTypeHint: "refresh_token",
            validForm: true,
            localSessionPresent: false,
          },
          {
            method: "POST",
            path: "/oauth/revoke",
            tokenTypeHint: "access_token",
            validForm: true,
            localSessionPresent: false,
          },
        ]);
        for (const secret of [
          SEEDED_GATEWAY_TOKEN,
          "seeded-refresh-token",
          issuer.providerDetail,
        ]) {
          expect(logout.stdout).not.toContain(secret);
          expect(logout.stderr).not.toContain(secret);
        }
      } finally {
        issuer.stop();
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia logout warns once and sends no tokens without a revocation endpoint",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-logout-no-revocation-"));
      const authPath = join(home, ".lia", "auth.json");
      const issuer = startLogoutIssuer([], authPath, null);
      try {
        writeSeededLiaAuth(home, undefined, issuer.issuerUrl);

        const logout = await runLia(["logout"], {
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            LIA_DISABLE_KEYCHAIN: "1",
          },
        });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("Signed out of lia.\n");
        expect(logout.stderr).toBe(
          "Warning: signed out locally, but the remote session could not be revoked.\n",
        );
        expect(existsSync(authPath)).toBe(false);
        expect(issuer.requests).toEqual([
          { method: "GET", path: "/.well-known/openid-configuration" },
        ]);
      } finally {
        issuer.stop();
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia logout warns once and sends no tokens to an invalid revocation endpoint",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-logout-invalid-revocation-"));
      const authPath = join(home, ".lia", "auth.json");
      const catcher = startRequestCatcher();
      const issuer = startLogoutIssuer([], authPath, catcher.endpoint);
      try {
        writeSeededLiaAuth(home, undefined, issuer.issuerUrl);

        const logout = await runLia(["logout"], {
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            LIA_DISABLE_KEYCHAIN: "1",
          },
        });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("Signed out of lia.\n");
        expect(catcher.requests).toEqual([]);
        expect(logout.stderr).toBe(
          "Warning: signed out locally, but the remote session could not be revoked.\n",
        );
        expect(existsSync(authPath)).toBe(false);
        expect(issuer.requests).toEqual([
          { method: "GET", path: "/.well-known/openid-configuration" },
        ]);
      } finally {
        issuer.stop();
        catcher.stop();
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia logout removes an unsafe saved login and warns that it could not revoke it",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-logout-rejected-login-"));
      const issuer = startLogoutIssuer([200, 200]);
      const authPath = join(home, ".lia", "auth.json");
      try {
        writeSeededLiaAuth(home, undefined, issuer.issuerUrl);
        chmodSync(authPath, 0o644);

        const logout = await runLia(["logout"], {
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            LIA_DISABLE_KEYCHAIN: "1",
          },
        });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("Signed out of lia.\n");
        expect(logout.stderr).toBe(
          "Warning: signed out locally, but the remote session could not be revoked.\n",
        );
        expect(existsSync(authPath)).toBe(false);
        expect(issuer.requests).toEqual([]);
        for (const secret of [
          SEEDED_GATEWAY_TOKEN,
          "seeded-refresh-token",
          issuer.providerDetail,
        ]) {
          expect(logout.stdout).not.toContain(secret);
          expect(logout.stderr).not.toContain(secret);
        }
      } finally {
        issuer.stop();
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia logout fails when the saved login cannot be deleted",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-logout-delete-failure-"));
      const issuer = startLogoutIssuer([200, 200]);
      const liaDir = join(home, ".lia");
      const authPath = join(liaDir, "auth.json");
      try {
        writeSeededLiaAuth(home, undefined, issuer.issuerUrl);
        chmodSync(liaDir, 0o500);

        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          LIA_DISABLE_KEYCHAIN: "1",
        };
        const logout = await runLia(["logout"], { env });
        const status = await runLia(["status", "--json"], { env });

        expect(logout.code).toBe(1);
        expect(logout.stdout).toBe("");
        expect(logout.stderr).toBe(
          "lia logout: failed to durably remove saved lia login\n",
        );
        expect(existsSync(authPath)).toBe(true);
        expect(JSON.parse(status.stdout).auth).toBe("lia login");
        expect(issuer.requests).toEqual([]);
      } finally {
        chmodSync(liaDir, 0o700);
        issuer.stop();
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia logout deletes only the saved login and keeps environment credentials available",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-logout-env-"));
      const authPath = join(home, ".lia", "auth.json");
      const issuer = startLogoutIssuer([500, 200], authPath);
      const oidcToken = "logout-oidc-token";
      const apiToken = "logout-api-key-token";
      try {
        writeSeededLiaAuth(home, undefined, issuer.issuerUrl);
        const env = {
          HOME: realpathSync(home),
          VERCEL_OIDC_TOKEN: oidcToken,
          AI_GATEWAY_API_KEY: apiToken,
          LIA_DISABLE_KEYCHAIN: "1",
        };

        const logout = await runLia(["logout"], { env });
        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("Signed out of lia.\n");
        expect(logout.stderr).toBe(
          "Warning: signed out locally, but the remote session could not be revoked.\n",
        );
        expect(existsSync(join(home, ".lia", "auth.json"))).toBe(false);
        expect(issuer.requests).toEqual([
          { method: "GET", path: "/.well-known/openid-configuration" },
          {
            method: "POST",
            path: "/oauth/revoke",
            tokenTypeHint: "refresh_token",
            validForm: true,
            localSessionPresent: false,
          },
          {
            method: "POST",
            path: "/oauth/revoke",
            tokenTypeHint: "access_token",
            validForm: true,
            localSessionPresent: false,
          },
        ]);

        const oidcStatus = await runLia(["status", "--json"], { env });
        const apiEnv = { ...env, VERCEL_OIDC_TOKEN: undefined };
        const apiStatus = await runLia(["status", "--json"], { env: apiEnv });
        const doctor = await runLia(["doctor", "--json"], { env: apiEnv });
        expect(JSON.parse(oidcStatus.stdout)).toMatchObject({
          auth: "VERCEL_OIDC_TOKEN",
          auth_refreshable: false,
        });
        expect(JSON.parse(apiStatus.stdout)).toMatchObject({
          auth: "AI_GATEWAY_API_KEY",
          auth_refreshable: false,
        });
        expect(JSON.parse(doctor.stdout)).toMatchObject({
          auth: "AI_GATEWAY_API_KEY",
          auth_refreshable: false,
        });

        for (const output of [
          logout.stdout,
          logout.stderr,
          oidcStatus.stdout,
          apiStatus.stdout,
          doctor.stdout,
        ]) {
          for (const secret of [
            SEEDED_GATEWAY_TOKEN,
            "seeded-refresh-token",
            oidcToken,
            apiToken,
            issuer.providerDetail,
          ]) {
            expect(output).not.toContain(secret);
          }
        }
      } finally {
        issuer.stop();
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia logout deletes ChatGPT and Grok sign-in tokens left by an older install",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-logout-legacy-"));
      try {
        const root = join(realpathSync(home), ".lia");
        mkdirSync(root, { recursive: true });
        for (const name of ["chatgpt-auth.json", "chatgpt-auth.lock", "grok-auth.json", "grok-auth.lock"]) {
          writeFileSync(join(root, name), "{}");
        }
        const env = { HOME: realpathSync(home), LIA_DISABLE_KEYCHAIN: "1" };
        const logout = await runLia(["logout"], { env });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("Removed saved ChatGPT and Grok sign-in tokens left by an older install.\n");
        expect(logout.stderr).toBe("");
        for (const name of ["chatgpt-auth.json", "chatgpt-auth.lock", "grok-auth.json", "grok-auth.lock"]) {
          expect(existsSync(join(root, name))).toBe(false);
        }
        const again = await runLia(["logout"], { env });
        expect(again.stdout).toBe("No lia login session found.\n");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia logout leaves an active API key unchanged when no login exists",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-logout-no-login-"));
      const apiToken = "logout-existing-api-key";
      try {
        const env = {
          HOME: realpathSync(home),
          VERCEL_OIDC_TOKEN: undefined,
          AI_GATEWAY_API_KEY: apiToken,
          LIA_DISABLE_KEYCHAIN: "1",
        };
        const logout = await runLia(["logout"], { env });
        const status = await runLia(["status", "--json"], { env });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("No lia login session found.\n");
        expect(logout.stderr).toBe("");
        expect(JSON.parse(status.stdout)).toMatchObject({
          auth: "AI_GATEWAY_API_KEY",
          auth_refreshable: false,
        });
        expect(logout.stdout).not.toContain(apiToken);
        expect(status.stdout).not.toContain(apiToken);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(platform() !== "darwin")(
    "lia logout leaves the macOS Keychain API key untouched",
    async () => {
      const runId = `${process.pid}-${Date.now()}`;
      const account = `lia-e2e-logout-${runId}`;
      const keychainToken = `vca_fake_logout_key_${runId}`;
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-logout-keychain-"));
      const home = join(root, "home");
      mkdirSync(join(home, "Library"), { recursive: true });
      symlinkSync(
        join(homedir(), "Library", "Keychains"),
        join(home, "Library", "Keychains"),
        "dir",
      );
      const issuer = startLogoutIssuer([200, 200]);

      try {
        const store = spawnSync(
          "/usr/bin/security",
          ["add-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-U", "-w", keychainToken],
          { encoding: "utf8" },
        );
        expect(store.status, store.stderr).toBe(0);
        writeSeededLiaAuth(home, undefined, issuer.issuerUrl);

        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          USER: account,
        };
        const logout = await runLia(["logout"], { env });
        const status = await runLia(["status", "--json"], { env });
        const stored = spawnSync(
          "/usr/bin/security",
          ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
          { encoding: "utf8", env: { ...process.env, ...env } },
        );

        expect(logout.code).toBe(0);
        expect(logout.stderr).toBe("");
        expect(existsSync(join(home, ".lia", "auth.json"))).toBe(false);
        expect(stored.status).toBe(0);
        expect(stored.stdout.trim()).toBe(keychainToken);
        expect(JSON.parse(status.stdout).auth).not.toBe("lia login");
        expect(logout.stdout).not.toContain(keychainToken);
        expect(status.stdout).not.toContain(keychainToken);
      } finally {
        issuer.stop();
        spawnSync(
          "/usr/bin/security",
          ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE],
          { encoding: "utf8" },
        );
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: setup", () => {
  test(
    "lia setup is a top-level command and fails cleanly when Keychain is disabled",
    async () => {
      const r = await runLia(["setup"], {
        env: { ...NO_GATEWAY_AUTH, LIA_DISABLE_KEYCHAIN: "1" },
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(
        "lia setup is deprecated and stops working in lia 0.2.0; use lia login vercel --api-key\n" +
          "lia setup: stored API keys are disabled by LIA_DISABLE_KEYCHAIN\n",
      );
    },
    TIMEOUT,
  );

  test(
    "lia login --api-key replaces lia setup and is only for vercel",
    async () => {
      for (const args of [["login", "--api-key"], ["login", "vercel", "--api-key"]]) {
        const disabled = await runLia(args, { env: { ...NO_GATEWAY_AUTH, LIA_DISABLE_KEYCHAIN: "1" } });
        expect(disabled.code).toBe(1);
        expect(disabled.stdout).toBe("");
        expect(disabled.stderr).toBe("lia login: stored API keys are disabled by LIA_DISABLE_KEYCHAIN\n");
      }

      const noTerminal = await runLia(["login", "--api-key"], { env: { ...NO_GATEWAY_AUTH } });
      expect(noTerminal.code).toBe(1);
      expect(noTerminal.stderr).toBe("lia login: an interactive terminal is required to paste an API key\n");

      const usage = "usage: lia login [vercel] [--api-key]\n";
      const cases: [string[], string][] = [
        [["login", "--bogus"], "lia login: unknown flag --bogus\n" + usage],
        [["login", "vercel", "extra"], usage],
      ];
      for (const [args, stderr] of cases) {
        const r = await runLia(args, { env: { ...NO_GATEWAY_AUTH } });
        expect(r.code).toBe(2);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe(stderr);
      }
    },
    TIMEOUT,
  );

  test(
    "lia setup never invokes the configured Vercel CLI",
    async () => {
      const runId = `${process.pid}-${Date.now()}`;
      const fakeDir = mkdtempSync(join(tmpdir(), "lia-e2e-vercel-cli-"));
      const fakeCli = join(fakeDir, "vc");
      const invocationLog = join(fakeDir, "invoked");

      writeFileSync(
        fakeCli,
        `#!/bin/sh
set -eu
printf '%s\\n' invoked > '${invocationLog}'
exit 99
`,
        { mode: 0o700 },
      );

      try {
        const r = await runLia(["setup"], {
          env: {
            ...NO_GATEWAY_AUTH,
            USER: `lia-e2e-setup-${runId}`,
            LIA_VERCEL_CLI_PATH: fakeCli,
          },
          timeoutMs: TIMEOUT,
        });
        expect(r.code).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("lia setup is deprecated and stops working in lia 0.2.0; use lia login vercel --api-key\n");
        expect(r.stderr).toContain("interactive terminal is required");
        expect(existsSync(invocationLog)).toBe(false);
      } finally {
        rmSync(fakeDir, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

// The file backend is only selected off macOS, so these run on Linux CI.
describe("cli: stored key file backend", () => {
  test.skipIf(platform() === "darwin")(
    "a 0600 key file resolves, and a loosened one is refused rather than reported absent",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-stored-key-file-"));
      const liaDir = join(home, ".lia");
      mkdirSync(liaDir, { recursive: true, mode: 0o700 });
      chmodSync(liaDir, 0o700);
      const keyPath = join(liaDir, "api-key");
      writeFileSync(keyPath, "vca_file_backend_key", { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      const env = { ...NO_GATEWAY_AUTH, HOME: realpathSync(home) };

      try {
        const readable = await runLia(["status", "--json"], { env });
        expect(readable.code).toBe(0);
        const readableJson = JSON.parse(readable.stdout);
        expect(readableJson.auth).toBe("stored API key (profile file)");
        expect(readableJson.auth_help).toBeUndefined();
        expect(readable.stdout).not.toContain("vca_file_backend_key");

        chmodSync(keyPath, 0o644);
        const refused = await runLia(["status", "--json"], { env });
        expect(refused.code).toBe(0);
        const refusedJson = JSON.parse(refused.stdout);
        expect(refusedJson.auth).toBe("missing");
        // Refusal must not read as absence.
        expect(refusedJson.auth_help).toContain("could not read the stored API key");
        expect(refusedJson.auth_help).not.toBe(MISSING_AUTH_MESSAGE);

        rmSync(keyPath);
        const absent = await runLia(["status", "--json"], { env });
        const absentJson = JSON.parse(absent.stdout);
        expect(absentJson.auth).toBe("missing");
        expect(absentJson.auth_help).toBe(MISSING_AUTH_MESSAGE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: Keychain authentication", () => {
  test.skipIf(platform() !== "darwin")(
    "lia ask reads an existing Keychain credential without onboarding",
    async () => {
      const runId = `${process.pid}-${Date.now()}`;
      const account = `lia-e2e-ask-${runId}`;
      const fakeKey = `vca_fake_ask_key_${runId}`;
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-keychain-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(join(home, "Library"), { recursive: true });
      symlinkSync(
        join(homedir(), "Library", "Keychains"),
        join(home, "Library", "Keychains"),
        "dir",
      );
      mkdirSync(workspace);
      const gateway = startFakeGateway([
        fakeGatewayFinalText("Keychain ask complete"),
      ]);

      try {
        const store = spawnSync(
          "/usr/bin/security",
          [
            "add-generic-password",
            "-a",
            account,
            "-s",
            KEYCHAIN_SERVICE,
            "-U",
            "-w",
            fakeKey,
          ],
          { encoding: "utf8" },
        );
        expect(store.status, store.stderr).toBe(0);

        const lookup = spawnSync(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-a",
            account,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: realpathSync(home),
              USER: account,
            },
          },
        );
        expect(lookup.status, lookup.stderr).toBe(0);
        expect(lookup.stdout.trim()).toBe(fakeKey);

        const result = await runLia(
          [
            "ask",
            "--json",
            "--auto",
            "--no-save",
            "Say exactly: Keychain ask complete",
          ],
          {
            cwd: realpathSync(workspace),
            env: {
              ...NO_GATEWAY_AUTH,
              HOME: realpathSync(home),
              USER: account,
              LIA_GATEWAY_BASE_URL: gateway.baseUrl,
              LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_MODEL: FAKE_GATEWAY_MODEL,
              LIA_AUTO_UPGRADE: "0",
            },
            timeoutMs: TIMEOUT,
          },
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout).output.trim()).toBe(
          "Keychain ask complete",
        );
        expect(result.stdout).not.toContain(fakeKey);
        expect(existsSync(join(home, ".lia"))).toBe(false);
        expect(gateway.requests).toHaveLength(1);
        expect(gateway.requests[0]!.headers.get("authorization")).toBe(
          `Bearer ${fakeKey}`,
        );
      } finally {
        gateway.stop();
        spawnSync(
          "/usr/bin/security",
          [
            "delete-generic-password",
            "-a",
            account,
            "-s",
            KEYCHAIN_SERVICE,
          ],
          { encoding: "utf8" },
        );
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: read-only no-create matrix", () => {
  const probes = [
    { args: ["status", "--json"], code: 0, kind: "status" },
    { args: ["sessions", "--json"], code: 0, kind: "sessions", count: 0 },
    { args: ["session", "last", "--json"], code: 1, error: "no saved sessions" },
    { args: ["session", "--id", "missing.valid-id", "--json"], code: 1, error: "record not found" },
    { args: ["doctor", "--json"], code: 0, kind: "doctor" },
  ] as const;

  for (const probe of probes) {
    test(
      `${probe.args.join(" ")} leaves an empty home unchanged`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "lia-e2e-no-create-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(home);
          mkdirSync(workspace);
          const before = snapshotTree(home);

          const result = await runLia([...probe.args], {
            cwd: realpathSync(workspace),
            env: {
              ...NO_GATEWAY_AUTH,
              HOME: realpathSync(home),
              LIA_TEST_FAIL_ON_DURABLE_MUTATION: "1",
            },
            timeoutMs: TIMEOUT,
          });

          expect(result.code).toBe(probe.code);
          if ("kind" in probe) {
            const output = JSON.parse(result.stdout);
            expect(output.kind).toBe(probe.kind);
            if ("count" in probe) expect(output.count).toBe(probe.count);
          } else {
            const output = JSON.parse(result.stdout);
            expect(output.error).toContain(probe.error);
            expect(result.stderr).toBe("");
          }
          expect(snapshotTree(home)).toEqual(before);
          expect(existsSync(join(home, ".lia"))).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});

describe("cli: missing durable home", () => {
  test(
    "read-only commands tolerate a nonexistent HOME and saved ask bootstraps it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-missing-home-path-"));
      const home = join(root, "missing-home");
      const workspace = join(root, "workspace");
      const gateway = startFakeGateway([
        fakeGatewayFinalText("missing home persisted"),
      ]);
      try {
        mkdirSync(workspace);
        const cwd = realpathSync(workspace);
        const baseEnv = {
          HOME: home,
          VERCEL_OIDC_TOKEN: undefined,
          LIA_AUTO_UPGRADE: "0",
          LIA_DISABLE_KEYCHAIN: "1",
        };

        const status = await runLia(["status", "--json"], {
          cwd,
          env: { ...baseEnv, AI_GATEWAY_API_KEY: undefined },
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        expect(status.stderr).toBe("");
        expect(JSON.parse(status.stdout).kind).toBe("status");
        expect(existsSync(home)).toBe(false);

        const listed = await runLia(["sessions", "--json"], {
          cwd,
          env: { ...baseEnv, AI_GATEWAY_API_KEY: undefined },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual({
          kind: "sessions",
          count: 0,
          sessions: [],
        });
        expect(existsSync(home)).toBe(false);

        const asked = await runLia(
          ["ask", "--json", "--auto", "Persist under the new home."],
          {
            cwd,
            env: {
              ...baseEnv,
              AI_GATEWAY_API_KEY: "missing-home-key",
              LIA_GATEWAY_BASE_URL: gateway.baseUrl,
              LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_MODEL: FAKE_GATEWAY_MODEL,
            },
            timeoutMs: TIMEOUT,
          },
        );
        expect(asked.code).toBe(0);
        expect(JSON.parse(asked.stdout).output.trim()).toBe(
          "missing home persisted",
        );
        expect(existsSync(join(home, ".lia", "sessions"))).toBe(true);
        expect(gateway.requests).toHaveLength(1);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session commands fail precisely while doctor remains available without HOME",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-no-home-"));
      try {
        const workspace = join(root, "workspace");
        mkdirSync(workspace);
        const cwd = realpathSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: undefined,
        };

        for (const args of [
          ["sessions", "--json"],
          ["session", "last", "--json"],
          ["session", "--id", "missing.valid-id", "--json"],
        ]) {
          const result = await runLia(args, { cwd, env, timeoutMs: TIMEOUT });
          expect(result.code).toBe(1);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toEqual(
            expect.objectContaining({
              code: "HomeNotSet",
            }),
          );
        }

        const doctor = await runLia(["doctor", "--json"], {
          cwd,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        expect(JSON.parse(doctor.stdout).checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "state",
              detail: expect.stringContaining("HomeNotSet"),
            }),
          ]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: sessions", () => {
  test(
    "lia sessions --json returns valid sessions JSON",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-sessions-empty-"));
      try {
        const r = await runLia(["sessions", "--json"], { env: { HOME: home } });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("sessions");
        expect(json).toHaveProperty("count");
        expect(Array.isArray(json.sessions)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia sessions text shows named, unnamed, and renamed sessions",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-session-names-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".lia", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".lia"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        writeConversationSession(home, workspaceRoot, "named-session", {
          title: "Investigate cache misses",
          updatedAtMs: 3,
          turns: ["first named turn", "second named turn"],
        });
        writeConversationSession(home, workspaceRoot, "unnamed-session", {
          updatedAtMs: 2,
        });
        writeConversationSession(home, workspaceRoot, "script-only-session", {
          title: "Review landing page",
          updatedAtMs: 1_700_000_000_123,
          conversationLanguage: "und-Latn",
          turns: ["review the landing page"],
        });

        // Updated times show in the local zone, fixed here at five and a half hours east of UTC.
        const first = await runLia(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH, TZ: "IST-5:30" },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        expect(first.stdout).toContain(
          " - Investigate cache misses\n   id=named-session | 2 turns | English | updated 1970-01-01 05:30:00.003 IST",
        );
        expect(first.stdout).toContain(
          " - Untitled session\n   id=unnamed-session | 0 turns | English | updated 1970-01-01 05:30:00.002 IST",
        );
        expect(first.stdout).toContain(
          " - Review landing page\n   id=script-only-session | 1 turn | Latin script | updated 2023-11-15 03:43:20.123 IST",
        );
        expect(first.stdout).not.toContain("updated_at_ms");
        expect(first.stdout).not.toContain("language=");

        const structured = await runLia(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(structured.code).toBe(0);
        expect(structured.stderr).toBe("");
        expect(JSON.parse(structured.stdout).sessions[0]).toMatchObject({
          id: "script-only-session",
          updated_at_ms: 1_700_000_000_123,
          conversation_language: "und-Latn",
        });

        const namedPath = join(sessionsDir, "named-session", "session.json");
        const renamedMetadata = JSON.parse(readFileSync(namedPath, "utf8"));
        renamedMetadata.title = "Investigate cache hits";
        writeFileSync(namedPath, JSON.stringify(renamedMetadata) + "\n", {
          mode: 0o600,
        });
        const renamed = await runLia(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(renamed.code).toBe(0);
        expect(renamed.stderr).toBe("");
        expect(renamed.stdout).toContain(
          " - Investigate cache hits\n   id=named-session | 2 turns | English",
        );
        expect(renamed.stdout).not.toContain("Investigate cache misses");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia sessions text applies daylight saving time for each session's own date",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-session-dst-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        // 2023-07-10 14:40:00 UTC, during daylight saving time.
        writeConversationSession(home, workspaceRoot, "summer-session", {
          title: "Summer session",
          updatedAtMs: 1_689_000_000_000,
        });
        // 2023-11-14 22:13:20.123 UTC, after daylight saving time ends.
        writeConversationSession(home, workspaceRoot, "winter-session", {
          title: "Winter session",
          updatedAtMs: 1_700_000_000_123,
        });

        const listed = await runLia(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH, TZ: "EST5EDT,M3.2.0,M11.1.0" },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(listed.stderr).toBe("");
        expect(listed.stdout).toContain(
          " - Summer session\n   id=summer-session | 0 turns | English | updated 2023-07-10 10:40:00.000 EDT",
        );
        expect(listed.stdout).toContain(
          " - Winter session\n   id=winter-session | 0 turns | English | updated 2023-11-14 17:13:20.123 EST",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session listing pages direct metadata without an index",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-session-pages-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".lia", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".lia"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        for (let index = 0; index < 201; index += 1) {
          const id = `direct-session-${index.toString().padStart(5, "0")}`;
          writeConversationSession(home, workspaceRoot, id, {
            title: id,
            createdAtMs: 20_000 - index,
            updatedAtMs: 20_000 - index,
          });
        }
        expect(existsSync(join(sessionsDir, "index.json"))).toBe(false);

        const first = await runLia(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(Buffer.byteLength(first.stdout)).toBeLessThan(100_000);
        const firstJson = JSON.parse(first.stdout) as {
          count: number;
          has_more: boolean;
          next_cursor: string;
          sessions: Array<{ id: string; history_len: number }>;
        };
        expect(firstJson.count).toBe(100);
        expect(firstJson.has_more).toBe(true);
        expect(firstJson.sessions).toHaveLength(100);
        expect(firstJson.sessions[0]).toMatchObject({
          id: "direct-session-00000",
          history_len: 0,
        });
        expect(firstJson.sessions[99].id).toBe("direct-session-00099");

        const second = await runLia(
          ["sessions", "--json", "--cursor", firstJson.next_cursor],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(second.code).toBe(0);
        const secondJson = JSON.parse(second.stdout) as {
          count: number;
          has_more: boolean;
          sessions: Array<{ id: string }>;
        };
        expect(secondJson.count).toBe(100);
        expect(secondJson.has_more).toBe(true);
        expect(secondJson.sessions[0].id).toBe("direct-session-00100");
        expect(secondJson.sessions[99].id).toBe("direct-session-00199");

        const one = await runLia(["sessions", "--json", "--limit", "1"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(one.code).toBe(0);
        expect(JSON.parse(one.stdout)).toMatchObject({
          count: 1,
          has_more: true,
          sessions: [{ id: "direct-session-00000" }],
        });

        const invalid = await runLia(["sessions", "--limit", "0"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(invalid.code).not.toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session lists use projections when event logs are unreadable",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-session-projections-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const fixture = spawnSync(
          "python3",
          [
            join(REPO_ROOT, "benchmarks", "session_list_fixture.py"),
            "--home",
            home,
            "--workspace",
            workspaceRoot,
            "--sessions",
            "2",
            "--log-size",
            "4096",
            "--deny-event-read",
          ],
          { encoding: "utf8" },
        );
        expect(fixture.status).toBe(0);

        const before = snapshotTree(join(home, ".lia"));
        const listed = await runLia(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual({
          kind: "sessions",
          count: 2,
          sessions: [
            {
              id: "benchmark-session-01",
              title: "Benchmark session 01",
              preview: "Benchmark session 01 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1001,
              updated_at_ms: 2001,
              history_len: 1,
              conversation_language: "en",
            },
            {
              id: "benchmark-session-00",
              title: "Benchmark session 00",
              preview: "Benchmark session 00 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1000,
              updated_at_ms: 2000,
              history_len: 0,
              conversation_language: "en",
            },
          ],
        });
        expect(snapshotTree(join(home, ".lia"))).toEqual(before);

        const latest = await runLia(["session", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(0);
        expect(JSON.parse(latest.stdout)).toEqual({
          kind: "session_summary",
          id: "benchmark-session-01",
          title: "Benchmark session 01",
          preview: "Benchmark session 01 preview",
          workspace_root: workspaceRoot,
          origin_workspace_root: workspaceRoot,
          created_at_ms: 1001,
          updated_at_ms: 2001,
          history_len: 1,
          conversation_language: "en",
        });
        expect(snapshotTree(join(home, ".lia"))).toEqual(before);

        const detail = await runLia(
          ["session", "--id", "benchmark-session-00", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          },
        );
        expect(detail.code).not.toBe(0);
        expect(detail.stderr).toBe("");
        // The damage is named, and doctor says what can be done (D78).
        const failure = JSON.parse(detail.stdout);
        expect(failure.code).toBe("InvalidSessionFormat");
        expect(failure.error).toContain("AccessDenied");
        expect(failure.error).toContain("run `lia doctor`");
        expect(snapshotTree(join(home, ".lia"))).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "workspace-scoped session discovery filters list and last by cwd",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-workspace-sessions-"));
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        mkdirSync(home);
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        const workspaceARoot = realpathSync(workspaceA);
        const workspaceBRoot = realpathSync(workspaceB);

        writeLegacySession(home, workspaceARoot, "workspace-a-older", {
          updatedAtMs: 20,
        });
        writeLegacySession(home, workspaceARoot, "workspace-a-latest", {
          updatedAtMs: 40,
        });
        writeLegacySession(home, workspaceBRoot, "workspace-b-newest", {
          updatedAtMs: 80,
        });

        const listA = await runLia(["sessions", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listA.code).toBe(0);
        const jsonA = JSON.parse(listA.stdout);
        expect(jsonA.kind).toBe("sessions");
        expect(jsonA.count).toBe(2);
        expect(jsonA.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-a-latest", "workspace-a-older"]);

        const lastA = await runLia(["session", "last", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(lastA.code).toBe(0);
        expect(JSON.parse(lastA.stdout).id).toBe("workspace-a-latest");

        const listB = await runLia(["sessions", "--json"], {
          cwd: workspaceBRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listB.code).toBe(0);
        const jsonB = JSON.parse(listB.stdout);
        expect(jsonB.count).toBe(1);
        expect(jsonB.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-b-newest"]);

        const exactForeign = await runLia(
          ["session", "--id", "workspace-b-newest", "--json"],
          {
            cwd: workspaceARoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(exactForeign.code).toBe(0);
        expect(JSON.parse(exactForeign.stdout).id).toBe("workspace-b-newest");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session discovery reports corrupt records and distinguishes an unreadable latest session",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-corrupt-sessions-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "readable-session", {
          updatedAtMs: 30,
        });
        for (const [id, contents] of [
          ["invalid-json", "{"],
          ["truncated", '{"schema_version":2,"id":"truncated"}'],
        ] as const) {
          const directory = join(home, ".lia", "sessions", id);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          writeFileSync(join(directory, "session.json"), contents, {
            mode: 0o600,
          });
        }

        const listed = await runLia(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toMatchObject({
          kind: "sessions",
          count: 1,
          skipped_invalid: 2,
          sessions: [{ id: "readable-session" }],
        });

        rmSync(join(home, ".lia", "sessions", "readable-session"), {
          recursive: true,
          force: true,
        });
        const latest = await runLia(["session", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(1);
        expect(latest.stderr).toBe("");
        expect(JSON.parse(latest.stdout)).toMatchObject({
          error: expect.stringContaining("saved sessions are unreadable"),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "profile-wide session discovery recovers sessions after a workspace rename",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-renamed-workspace-"));
      try {
        const home = join(root, "home");
        const original = join(root, "workspace-before");
        const renamed = join(root, "workspace-after");
        mkdirSync(home);
        mkdirSync(original);
        const originalRoot = realpathSync(original);
        writeLegacySession(home, originalRoot, "renamed-workspace-session", {
          updatedAtMs: 40,
        });
        renameSync(original, renamed);
        const renamedRoot = realpathSync(renamed);

        const scoped = await runLia(["sessions", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(JSON.parse(scoped.stdout)).toMatchObject({ count: 0, sessions: [] });

        const recovered = await runLia(["sessions", "--all", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(recovered.code).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({
          count: 1,
          sessions: [
            {
              id: "renamed-workspace-session",
              workspace_root: originalRoot,
            },
          ],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia sessions --json ignores malformed and oversized list caches",
    async () => {
      for (const cached of ["{", "x".repeat(4 * 1024 * 1024 + 1)]) {
        const root = mkdtempSync(join(tmpdir(), "lia-e2e-sessions-cache-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(join(home, ".lia", "sessions"), { recursive: true });
          mkdirSync(workspace, { recursive: true });
          writeFileSync(join(home, ".lia", "sessions", "list.json"), cached);

          const r = await runLia(["sessions", "--json"], {
            cwd: realpathSync(workspace),
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          });
          expect(r.code).toBe(0);
          expect(JSON.parse(r.stdout.trim())).toEqual({
            kind: "sessions",
            count: 0,
            sessions: [],
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );

  test(
    "exact session flags address special-token and 255-byte IDs literally",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-session-exact-ids-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const ids = [
          "last",
          "migrate",
          "--json",
          "--allow-large",
          "x".repeat(255),
        ];
        for (const id of ids) writeLegacySession(home, workspaceRoot, id);

        for (const id of ids) {
          const result = await runLia(
            ["session", "--id", id, "--json"],
            {
              cwd: workspaceRoot,
              env: { HOME: home },
              timeoutMs: TIMEOUT,
            },
          );
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout).id).toBe(id);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "expected json failures emit machine-readable stdout",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-json-errors-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const cases: Array<{
          args: string[];
          kind: string;
          code: number;
          expectedError?: string;
        }> = [
          { args: ["session", "last", "--json"], kind: "session", code: 1 },
          {
            args: ["ask", "--json"],
            kind: "ask",
            code: 2,
            expectedError: "MissingPrompt",
          },
          {
            args: ["ask", "--json", "--no-save", "--resume", "last", "hello"],
            kind: "ask",
            code: 2,
            expectedError: "InvalidAskArgs",
          },
          {
            args: ["ask", "--json", "--bogus", "hello"],
            kind: "ask",
            code: 2,
            expectedError: "InvalidAskArgs",
          },
        ];

        for (const item of cases) {
          const result = await runLia(item.args, {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          });
          expect(result.code).toBe(item.code);
          expect(result.stdout.trim().length).toBeGreaterThan(0);
          const parsed = JSON.parse(result.stdout.trim());
          expect(parsed.kind ?? item.kind).toBe(item.kind);
          expect(typeof parsed.error).toBe("string");
          if (item.expectedError) expect(parsed.error).toBe(item.expectedError);
          // The JSON field reports the status the process exits with.
          if (item.kind === "ask") expect(parsed.exit_code).toBe(item.code);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: removed task and background commands", () => {
  test(
    "lia task, lia tasks, and lia background are not commands",
    async () => {
      for (const command of ["task", "tasks"]) {
        const result = await runLia([command], { env: NO_GATEWAY_AUTH });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(`lia: unknown command: ${command} (did you mean ask?)`);
      }
      const background = await runLia(["background"], { env: NO_GATEWAY_AUTH });
      expect(background.code).toBe(2);
      expect(background.stderr).toBe("lia: unknown command: background\n");
    },
    TIMEOUT,
  );

  test(
    "legacy tasks files are ignored by ordinary session loading",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-legacy-tasks-ignored-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "legacy-tasks-session");
        const tasksDir = join(home, ".lia", "sessions", "legacy-tasks-session", "tasks");
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, "unreadable-legacy-shape.json"), "not json\n");

        const result = await runLia(
          ["session", "--id", "legacy-tasks-session", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).id).toBe("legacy-tasks-session");
        expect(existsSync(join(tasksDir, "unreadable-legacy-shape.json"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

function modelsGatewayEnv(home: string, modelsUrl: string) {
  return {
    AI_GATEWAY_API_KEY: SEEDED_GATEWAY_TOKEN,
    VERCEL_OIDC_TOKEN: undefined,
    HOME: home,
    LIA_DISABLE_KEYCHAIN: "1",
    LIA_AUTO_UPGRADE: "0",
    LIA_TEST_GATEWAY_MODELS_URL: modelsUrl,
  };
}

function catalogTraceEvents(trace: string): string[] {
  return trace.split("\n").filter((line) =>
    line.includes("[catalog] event=model_catalog_load ")
  );
}

describe("cli: models", () => {
  for (const scenario of [
    {
      name: "an ordinary public empty catalog",
      authenticated: false,
      expected:
        "[models] no models returned by gateway\n[models] Using the public model catalog; sign in with Vercel or use an AI Gateway API key for team-private models.\n",
    },
    {
      name: "a rejected credential empty fallback catalog",
      authenticated: true,
      expected:
        "[models] no models returned by gateway\n[models] Your Gateway credential was rejected; using the public model catalog.\n",
    },
  ]) {
    test(
      `lia models renders exact text for ${scenario.name}`,
      async () => {
        const home = createIsolatedTestHome();
        const gateway = startFakeGateway([], {
          models(request) {
            if (scenario.authenticated && request.headers.get("authorization")) {
              return new Response("rejected", { status: 401 });
            }
            return [];
          },
        });

        try {
          const result = await runLia(["models"], {
            env: {
              ...modelsGatewayEnv(home, `${gateway.baseUrl}/coding-agent/v1/models`),
              ...(scenario.authenticated ? {} : NO_GATEWAY_AUTH),
            },
          });

          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout).toBe(scenario.expected);
          expect(gateway.modelRequests).toHaveLength(scenario.authenticated ? 2 : 1);
          if (scenario.authenticated) {
            expect(gateway.modelRequests[0]!.headers.get("authorization")).toBe(`Bearer ${SEEDED_GATEWAY_TOKEN}`);
          }
          const publicRequest = gateway.modelRequests.at(-1)!;
          expect(publicRequest.headers.get("authorization")).toBeNull();
          expect(publicRequest.headers.get("x-vercel-ai-gateway-team")).toBeNull();
        } finally {
          gateway.stop();
          cleanupIsolatedTestHome(home);
        }
      },
      TIMEOUT,
    );
  }

  test(
    "lia models retries a rejected API key exactly once without authentication",
    async () => {
      for (const rejectedStatus of [401, 403]) {
        const home = createIsolatedTestHome();
        const tracePath = join(home, "catalog-trace.log");
        const gateway = startFakeGateway([], {
          models(request) {
            if (request.headers.get("authorization")) {
              return Response.json({ error: "rejected" }, { status: rejectedStatus });
            }
            return [{ id: "public/fallback", type: "language", tags: ["tool-use"] }];
          },
        });

        try {
          const result = await runLia(["models", "--json"], {
            env: {
              ...modelsGatewayEnv(home, `${gateway.baseUrl}/coding-agent/v1/models`),
              LIA_TRACE_LOG: tracePath,
              LIA_TRACE_SCOPES: "catalog",
            },
          });

          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout.trim())).toEqual({
            kind: "models",
            count: 1,
            shown_count: 1,
            more_count: 0,
            private_models_hidden: true,
            ids: ["public/fallback"],
            models: [{ id: "public/fallback", efforts: [], fast: false, ultrafast: false }],
          });

          expect(gateway.modelRequests).toHaveLength(2);
          expect(gateway.modelRequests[0]!.headers.get("authorization")).toBe(`Bearer ${SEEDED_GATEWAY_TOKEN}`);
          expect(gateway.modelRequests[1]!.headers.get("authorization")).toBeNull();
          expect(gateway.modelRequests[1]!.headers.get("x-vercel-ai-gateway-team")).toBeNull();

          const trace = readFileSync(tracePath, "utf8");
          const events = catalogTraceEvents(trace);
          expect(events).toHaveLength(1);
          expect(events[0]).toContain(
            `requested_access=authenticated credential_source=ai_gateway_api_key effective_access=public_only public_only_reason=authenticated_credential_rejected anonymous_fallback=true outcome=loaded failure_category=authentication http_status=${rejectedStatus} retryable=false`,
          );
          for (const secret of [SEEDED_GATEWAY_TOKEN, "team_123", "vercel-labs"]) {
            expect(trace).not.toContain(secret);
          }
        } finally {
          gateway.stop();
          cleanupIsolatedTestHome(home);
        }
      }
    },
    TIMEOUT,
  );

  test(
    "lia models --json describes each Gateway model's name, efforts, and speed lanes",
    async () => {
      const home = createIsolatedTestHome();
      const gateway = startFakeGateway([], {
        models: () => [
          {
            id: "openai/astra",
            name: "Astra ",
            type: "language",
            owned_by: "openai",
            tags: ["tool-use"],
            reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            pricing: {
              service_tiers: {
                priority: { input: "1", output: "2" },
                ultrafast: { input: "3", output: "4" },
              },
            },
          },
          { id: "provider/plain", type: "language", tags: ["tool-use"] },
        ],
      });

      try {
        const result = await runLia(["models", "--json"], {
          env: modelsGatewayEnv(home, `${gateway.baseUrl}/coding-agent/v1/models`),
        });

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        const json = JSON.parse(result.stdout.trim());
        expect(json.models).toHaveLength(2);
        expect(json.models).toEqual(
          expect.arrayContaining([
            { id: "openai/astra", name: "Astra", efforts: ["low", "high"], fast: true, ultrafast: true },
            { id: "provider/plain", efforts: [], fast: false, ultrafast: false },
          ]),
        );
      } finally {
        gateway.stop();
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  test(
    "lia models preserves network and 5xx failures without anonymous retry",
    async () => {
      const unavailableHome = createIsolatedTestHome();
      const gateway = startFakeGateway([], {
        models: () => Response.json({ error: "unavailable" }, { status: 500 }),
      });
      try {
        const result = await runLia(["models", "--json"], {
          env: modelsGatewayEnv(unavailableHome, `${gateway.baseUrl}/coding-agent/v1/models`),
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout.trim()).code).toBe("GatewayUnavailable");
        // The catalog answered, so the message does not blame the connection.
        expect(JSON.parse(result.stdout.trim()).error).toBe("could not list models: Unavailable");
        expect(gateway.modelRequests).toHaveLength(1);
      } finally {
        gateway.stop();
        cleanupIsolatedTestHome(unavailableHome);
      }

      const home = createIsolatedTestHome();
      let connections = 0;
      const server = createServer((socket) => {
        connections += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("missing server address");
        const env = modelsGatewayEnv(home, `http://127.0.0.1:${address.port}/v1/models`);
        const result = await runLia(["models", "--json"], { env });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout.trim()).code).toBe("TransportFailure");
        expect(JSON.parse(result.stdout.trim()).error).toBe(
          "could not list models: couldn't connect to AI Gateway; check your network connection or firewall",
        );
        expect(connections).toBe(1);

        const text = await runLia(["models"], { env });
        expect(text.code).not.toBe(0);
        expect(text.stderr).toBe(
          "lia models: could not list models: couldn't connect to AI Gateway; check your network connection or firewall\n",
        );

        // Switching to the Gateway from another provider loads its catalog
        // the same way, and a failed switch keeps the saved provider.
        const settingsPath = join(home, ".lia", "settings.json");
        mkdirSync(join(home, ".lia"), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({
          provider: "local",
          providers: { local: { protocol: "openai-chat-completions", base_url: "http://127.0.0.1:1/v1", auth: { type: "none" } } },
        }));
        const selection = await runLia(["provider", "gateway"], { env });
        expect(selection.code).not.toBe(0);
        expect(selection.stderr).toBe(
          "lia provider: couldn't connect to AI Gateway to load the target model catalog; check your network connection or firewall\n",
        );
        expect(JSON.parse(readFileSync(settingsPath, "utf8")).provider).toBe("local");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  for (const scenario of [
    {
      name: "rate limiting",
      response: () => Response.json({ error: "slow down" }, { status: 429 }),
      code: "RateLimited",
    },
    {
      name: "malformed JSON",
      response: () => new Response("{not-json", {
        headers: { "content-type": "application/json" },
      }),
      code: "MalformedResponse",
    },
    {
      name: "a malformed top-level catalog array",
      response: () => Response.json([]),
      code: "MalformedResponse",
    },
    {
      name: "a catalog without data",
      response: () => Response.json({}),
      code: "MalformedResponse",
    },
    {
      name: "a catalog with non-array data",
      response: () => Response.json({ data: {} }),
      code: "MalformedResponse",
    },
  ]) {
    test(
      `lia models preserves ${scenario.name} without anonymous retry`,
      async () => {
        const home = createIsolatedTestHome();
        const gateway = startFakeGateway([], { models: scenario.response });
        try {
          const result = await runLia(["models", "--json"], {
            env: modelsGatewayEnv(home, `${gateway.baseUrl}/coding-agent/v1/models`),
          });

          expect(result.code).not.toBe(0);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout.trim()).code).toBe(scenario.code);
          expect(gateway.modelRequests).toHaveLength(1);
          expect(gateway.modelRequests[0]!.headers.get("authorization")).toBe(`Bearer ${SEEDED_GATEWAY_TOKEN}`);
        } finally {
          gateway.stop();
          cleanupIsolatedTestHome(home);
        }
      },
      TIMEOUT,
    );
  }

  test(
    "cancelling lia models does not retry anonymously",
    async () => {
      const home = createIsolatedTestHome();
      const gateway = startFakeGateway([], {
        models: () => new Promise<Response>(() => {}),
      });
      const proc = Bun.spawn([LIA_BIN, "models", "--json"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...modelsGatewayEnv(home, `${gateway.baseUrl}/coding-agent/v1/models`),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        const started = Date.now();
        while (gateway.modelRequests.length === 0) {
          if (Date.now() - started >= TIMEOUT) {
            throw new Error("timed out waiting for the cancellable model request");
          }
          await Bun.sleep(25);
        }
        expect(gateway.modelRequests).toHaveLength(1);
        expect(gateway.modelRequests[0]!.headers.get("authorization")).toBe(`Bearer ${SEEDED_GATEWAY_TOKEN}`);

        proc.kill("SIGTERM");
        await proc.exited;
        expect(gateway.modelRequests).toHaveLength(1);
      } finally {
        proc.kill("SIGKILL");
        gateway.stop();
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  test(
    "lia models rejects E2E gateway redirects without contacting the target",
    async () => {
      const home = createIsolatedTestHome();
      const captureRequests: string[] = [];
      const captureServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          captureRequests.push(
            `${request.method} ${new URL(request.url).pathname} authorization=${request.headers.get("authorization") ?? ""}`,
          );
          return Response.json({ data: [] });
        },
      });
      const redirectServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return Response.redirect(`http://127.0.0.1:${captureServer.port}/capture`, 302);
        },
      });

      try {
        const r = await runLia(["models", "--json"], {
          env: {
            HOME: home,
            LIA_DISABLE_KEYCHAIN: "1",
            AI_GATEWAY_API_KEY: "redirect-proof-key",
            VERCEL_OIDC_TOKEN: undefined,
            LIA_TEST_GATEWAY_MODELS_URL: `http://127.0.0.1:${redirectServer.port}/v1/models`,
          },
        });

        expect(captureRequests).toEqual([]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toBe("");
        expect(JSON.parse(r.stdout.trim())).toMatchObject({
          kind: "models",
          error: expect.stringContaining("could not list models:"),
          code: expect.any(String),
        });
      } finally {
        redirectServer.stop(true);
        captureServer.stop(true);
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  // Mirror the gateway's credential handling for private model catalogs.
  for (const scenario of [
    {
      name: "uses the anonymous public catalog without a credential",
      seedLiaLogin: false,
      expiredLiaLogin: false,
      authEnv: {},
      expectAuthHeader: false,
      expectPrivate: false,
      expectedTrace:
        "requested_access=public_only credential_source=none effective_access=public_only public_only_reason=no_credential anonymous_fallback=false outcome=loaded failure_category=none http_status=none retryable=none",
    },
    {
      name: "uses the selected lia login team catalog",
      seedLiaLogin: true,
      expiredLiaLogin: false,
      authEnv: {},
      expectAuthHeader: true,
      expectPrivate: true,
      expectedTeamQuery: "team_123",
      expectedTrace:
        "requested_access=authenticated credential_source=fx_login effective_access=authenticated public_only_reason=none anonymous_fallback=false outcome=loaded failure_category=none http_status=none retryable=none",
    },
    {
      name: "refreshes an expired lia login before loading the selected team catalog",
      seedLiaLogin: true,
      expiredLiaLogin: true,
      authEnv: {},
      expectAuthHeader: true,
      expectPrivate: true,
      expectedTeamQuery: "team_123",
      expectedTrace:
        "requested_access=authenticated credential_source=fx_login effective_access=authenticated public_only_reason=none anonymous_fallback=false outcome=loaded failure_category=none http_status=none retryable=none",
    },
    {
      name: "sends an API key so the catalog includes team-private models",
      seedLiaLogin: false,
      expiredLiaLogin: false,
      authEnv: { AI_GATEWAY_API_KEY: SEEDED_GATEWAY_TOKEN },
      expectAuthHeader: true,
      expectPrivate: true,
      expectedTrace:
        "requested_access=authenticated credential_source=ai_gateway_api_key effective_access=authenticated public_only_reason=none anonymous_fallback=false outcome=loaded failure_category=none http_status=none retryable=none",
    },
    {
      name: "sends deployment OIDC so the catalog includes team-private models",
      seedLiaLogin: false,
      expiredLiaLogin: false,
      authEnv: { VERCEL_OIDC_TOKEN: SEEDED_GATEWAY_TOKEN },
      expectAuthHeader: true,
      expectPrivate: true,
      expectedTrace:
        "requested_access=authenticated credential_source=vercel_oidc_token effective_access=authenticated public_only_reason=none anonymous_fallback=false outcome=loaded failure_category=none http_status=none retryable=none",
    },
  ]) {
    test(
      `lia models --json ${scenario.name}`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "lia-e2e-team-models-"));
        const requests: Array<{ headers: Headers; teamId: string | null }> = [];
        const oauthRequests: string[] = [];
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const headers = new Headers(request.headers);
            const url = new URL(request.url);
            if (url.pathname === "/.well-known/openid-configuration") {
              oauthRequests.push(url.pathname);
              return Response.json({
                issuer: `http://127.0.0.1:${server.port}`,
                device_authorization_endpoint: `http://127.0.0.1:${server.port}/oauth/device`,
                token_endpoint: `http://127.0.0.1:${server.port}/oauth/token`,
                revocation_endpoint: `http://127.0.0.1:${server.port}/oauth/revoke`,
              });
            }
            if (url.pathname === "/oauth/token") {
              oauthRequests.push(url.pathname);
              await request.text();
              return Response.json({
                access_token: SEEDED_GATEWAY_TOKEN,
                refresh_token: "rotated-refresh-token",
                expires_in: 3600,
                scope: "openid",
                token_type: "Bearer",
              });
            }
            requests.push({ headers, teamId: url.searchParams.get("teamId") });
            const seededAuth =
              headers.get("authorization") === `Bearer ${SEEDED_GATEWAY_TOKEN}` &&
              (!scenario.seedLiaLogin || url.searchParams.get("teamId") === "team_123");
            return Response.json({
              data: [
                { id: "public/sentinel", type: "language", tags: ["tool-use"] },
                ...(seededAuth
                  ? [{ id: "private/blue-hornbill", type: "language", tags: ["tool-use"] }]
                  : []),
              ],
            });
          },
        });

        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          const tracePath = join(root, "catalog-trace.log");
          mkdirSync(home);
          mkdirSync(workspace);
          if (scenario.seedLiaLogin) {
            writeSeededLiaAuth(
              home,
              "team_123",
              `http://127.0.0.1:${server.port}`,
              scenario.expiredLiaLogin
                ? Date.now() - 60_000
                : Date.now() + 60 * 60 * 1000,
            );
          }

          const r = await runLia(["models", "--json"], {
            cwd: realpathSync(workspace),
            env: {
              ...NO_GATEWAY_AUTH,
              ...scenario.authEnv,
              HOME: realpathSync(home),
              LIA_DISABLE_KEYCHAIN: "1",
              LIA_AUTO_UPGRADE: "0",
              LIA_GATEWAY_BASE_URL: `http://127.0.0.1:${server.port}`,
              LIA_TEST_GATEWAY_MODELS_URL: undefined,
              LIA_TRACE_LOG: tracePath,
              LIA_TRACE_SCOPES: "catalog",
            },
            timeoutMs: TIMEOUT,
          });

          expect(r.code).toBe(0);
          expect(r.stderr).toBe("");
          const json = JSON.parse(r.stdout.trim());
          expect(json.kind).toBe("models");
          expect(requests).toHaveLength(1);
          if (scenario.expectAuthHeader) {
            expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${SEEDED_GATEWAY_TOKEN}`);
          } else {
            expect(requests[0]!.headers.get("authorization")).toBeNull();
            expect(requests[0]!.headers.get("x-vercel-ai-gateway-team")).toBeNull();
          }
          expect(requests[0]!.teamId).toBe(scenario.expectedTeamQuery ?? null);
          expect(oauthRequests).toEqual(
            scenario.expiredLiaLogin
              ? ["/.well-known/openid-configuration", "/oauth/token"]
              : [],
          );
          expect(json.ids).toContain("public/sentinel");
          if (scenario.expectPrivate) {
            expect(json.ids).toContain("private/blue-hornbill");
          } else {
            expect(json.ids).not.toContain("private/blue-hornbill");
          }
          expect(json.private_models_hidden).toBe(!scenario.expectPrivate);
          if (scenario.seedLiaLogin && !scenario.expiredLiaLogin) {
            expect(requests[0]!.headers.get("x-vercel-ai-gateway-team")).toBeNull();
          }

          const trace = readFileSync(tracePath, "utf8");
          const events = catalogTraceEvents(trace);
          expect(events).toHaveLength(1);
          expect(events[0]).toContain(scenario.expectedTrace);
          for (const secret of [
            SEEDED_GATEWAY_TOKEN,
            "seeded-refresh-token",
            "team_123",
            "vercel-labs",
          ]) {
            expect(trace).not.toContain(secret);
          }
        } finally {
          server.stop(true);
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }

  test.skipIf(!HAS_API_KEY)(
    "lia models --json returns valid models JSON",
    async () => {
      const r = await runLia(["models", "--json"], { timeoutMs: 30_000 });
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("models");
      expect(json).toHaveProperty("count");
      expect(Array.isArray(json.ids)).toBe(true);
      expect(json.ids.length).toBeGreaterThan(0);
    },
    30_000,
  );
});

describe("cli: credits", () => {
  test(
    "lia credits --json preserves Gateway HTTP denial details",
    async () => {
      const home = createIsolatedTestHome();
      const requests: Array<{
        method: string;
        path: string;
        authorizationMatchesExpected: boolean;
      }> = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push({
            method: request.method,
            path: new URL(request.url).pathname,
            authorizationMatchesExpected:
              request.headers.get("authorization") ===
              "Bearer credits-fake-key",
          });
          return Response.json(
            { error: { code: "credit_card_required", message: "Buy credits to use AI Gateway." } },
            { status: 403 },
          );
        },
      });

      try {
        const r = await runLia(["credits", "--json"], {
          env: {
            AI_GATEWAY_API_KEY: "credits-fake-key",
            VERCEL_OIDC_TOKEN: undefined,
            HOME: realpathSync(home),
            LIA_DISABLE_KEYCHAIN: "1",
            LIA_TEST_GATEWAY_CREDITS_URL: `http://127.0.0.1:${server.port}/v1/credits`,
            HOME: home,
          },
        });

        expect(requests).toEqual([{
          method: "GET",
          path: "/v1/credits",
          authorizationMatchesExpected: true,
        }]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toBe("");
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("credits");
        expect(json.error).toContain("API access denied");
        expect(json.error).toContain("HTTP 403");
        expect(json.error).toContain("Buy credits to use AI Gateway.");
      } finally {
        server.stop(true);
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  test.skipIf(!HAS_API_KEY)(
    "lia credits --json returns credits JSON or exits non-zero",
    async () => {
      const r = await runLia(["credits", "--json"], { timeoutMs: 30_000 });
      if (r.code === 0 && r.stdout.trim()) {
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("credits");
      } else {
        expect(r.code).not.toBe(0);
      }
    },
    30_000,
  );
});

describe("cli: ask input validation", () => {
  test(
    "lia ask rejects invalid UTF-8 stdin before Gateway or session effects",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-invalid-utf8-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(home);
      mkdirSync(workspace);
      const requests: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(new URL(request.url).pathname);
          return Response.json({ error: "request should not arrive" }, { status: 400 });
        },
      });

      try {
        const result = await runLia(["ask", "--json", "--no-save"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            AI_GATEWAY_API_KEY: "invalid-utf8-proof-key",
            LIA_DISABLE_KEYCHAIN: "1",
            LIA_TEST_GATEWAY_CHAT_URL: `http://127.0.0.1:${server.port}/ai/v1/chat/completions`,
          },
          stdin: Uint8Array.from([0xff, 0xfe, 0x80, 0x68, 0x69]),
          timeoutMs: TIMEOUT,
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          exit_code: 1,
          error: "InvalidPromptText",
        });
        expect(requests).toEqual([]);
        expect(existsSync(join(home, ".lia"))).toBe(false);
      } finally {
        server.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: session", () => {
  test(
    "lia session with no id exits non-zero or shows usage",
    async () => {
      const r = await runLia(["session"]);
      expect(r.code).not.toBe(0);
    },
    TIMEOUT,
  );

  test(
    "lia session exact id hides managed child detail",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-private-child-detail-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".lia", "sessions"), {
          recursive: true,
          mode: 0o700,
        });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const parentId = "visible-parent";
        const childId = "private-child";

        writeLegacySession(home, workspaceRoot, parentId);
        writeLegacySession(home, workspaceRoot, childId);
        const childControl = join(
          home,
          ".lia",
          "sessions",
          childId,
          "subagent",
        );
        mkdirSync(childControl, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(childControl, "owner.json"),
          JSON.stringify({ schema_version: 1, parent_id: parentId }),
          { mode: 0o600 },
        );

        const parent = await runLia(
          ["session", "--id", parentId, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, LIA_DISABLE_KEYCHAIN: "1" },
          },
        );
        expect(parent).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(parent.stdout)).toMatchObject({
          kind: "session_detail",
          id: parentId,
        });

        const child = await runLia(
          ["session", "--id", childId, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, LIA_DISABLE_KEYCHAIN: "1" },
          },
        );
        expect(child.code).toBe(1);
        expect(child.stderr).toBe("");
        expect(JSON.parse(child.stdout)).toEqual({
          kind: "session",
          error: "record not found",
          code: "SessionNotFound",
        });
        expect(child.stdout).not.toContain(childId);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: interactive startup", () => {
  test(
    "lia explains a first argument it can't take as a command",
    async () => {
      const cases: Array<[string[], string]> = [
        [["fix", "the", "login", "bug"], "lia: unknown command: fix\n"],
        [["fix the login bug"], "lia: unknown command: fix the login bug\n"],
        [["stauts"], "lia: unknown command: stauts (did you mean status?)\n"],
        [["upgrade"], "lia: upgrade was removed; lia no longer updates itself\n"],
        [["-p", "fix the bug"], 'lia: -p isn\'t a lia flag; to run one request and exit, use lia ask "fix the bug"\n'],
        [["--print"], 'lia: --print isn\'t a lia flag; to run one request and exit, use lia ask "<prompt>"\n'],
        [[""], "lia: unknown command: \n"],
      ];
      for (const [args, stderr] of cases) {
        const r = await runLia(args, { env: NO_GATEWAY_AUTH });
        expect(r.code, args.join(" ")).toBe(2);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe(stderr);
      }
      for (const args of [["--modle", "x"], ["--model", "a", "--modle=x"]]) {
        const r = await runLia(args, { env: NO_GATEWAY_AUTH });
        expect(r.code, args.join(" ")).toBe(2);
        expect(r.stderr.split("\n")[0]).toBe("lia: unknown flag --modle (did you mean --model?)");
      }
    },
    TIMEOUT,
  );

  test(
    "bare lia prints the help and exits zero",
    async () => {
      for (const args of [[], ["--model", "x"]]) {
        const home = realpathSync(mkdtempSync(join(tmpdir(), "lia-e2e-bare-")));
        try {
          const r = await runLia(args, { env: { HOME: home } });
          expect(r.code).toBe(0);
          expect(r.stdout).toContain("lia ask");
          expect(r.stderr).toBe("");
          expect(readdirSync(home)).toEqual([]);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );

  test(
    "command flag errors name the flag and the last repeated flag wins",
    async () => {
      const failures: [string[], string][] = [
        [["status", "--jsno"], "lia status: unknown flag --jsno (did you mean --json?)\nusage: lia status [--json]\n"],
        [["sessions", "--limit"], "lia sessions: --limit needs a value\n"],
        [["usage", "--perod", "7d"], "lia usage: unknown flag --perod (did you mean --period?)\n"],
        [["workspace", "--json=1"], "lia workspace: --json doesn't take a value\n"],
      ];
      for (const [args, stderr] of failures) {
        const home = realpathSync(mkdtempSync(join(tmpdir(), "lia-e2e-flag-errors-")));
        try {
          const r = await runLia(args, { env: { HOME: home } });
          expect(r.code).toBe(2);
          expect(r.stdout).toBe("");
          expect(r.stderr.startsWith(stderr)).toBe(true);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }

      const home = realpathSync(mkdtempSync(join(tmpdir(), "lia-e2e-flag-last-")));
      try {
        const r = await runLia(["sessions", "--limit=5", "--limit", "2", "--json", "--json"], { env: { HOME: home } });
        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout).kind).toBe("sessions");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

});

describe("cli: pr", () => {
  test(
    "lia pr without gateway auth exits non-zero",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-noauth-"));
      try {
        const r = await runLia(["pr"], {
          env: { ...NO_GATEWAY_AUTH, HOME: home, LIA_DISABLE_KEYCHAIN: "1" },
        });
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain(MISSING_AUTH_MESSAGE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: issue", () => {
  test(
    "lia issue without gateway auth exits non-zero",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "lia-e2e-noauth-"));
      try {
        const r = await runLia(["issue"], {
          env: { ...NO_GATEWAY_AUTH, HOME: home, LIA_DISABLE_KEYCHAIN: "1" },
        });
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain(MISSING_AUTH_MESSAGE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: ask success", () => {
  test(
    "lia ask binds an explicitly invoked skill into the prompt",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-explicit-skill-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const skillDirectory = join(home, ".lia", "skills", "cli-explicit");
      const skillBody = "CLI_EXPLICIT_SKILL_BODY";
      const gateway = startFakeGateway([
        fakeGatewayFinalText("explicit skill ask complete"),
      ]);
      try {
        mkdirSync(skillDirectory, { recursive: true });
        mkdirSync(workspace);
        writeFileSync(
          join(skillDirectory, "SKILL.md"),
          `---\nname: cli-explicit\ndescription: explicit CLI fixture\n---\n\n${skillBody}\n`,
        );

        const result = await runLia(
          [
            "ask",
            "--json",
            "--auto",
            "--no-save",
            "$cli-explicit apply the selected skill.",
          ],
          {
            cwd: realpathSync(workspace),
            env: {
              HOME: realpathSync(home),
              AI_GATEWAY_API_KEY: "fake-explicit-skill-key",
              VERCEL_OIDC_TOKEN: undefined,
              LIA_GATEWAY_BASE_URL: gateway.baseUrl,
              LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_MODEL: FAKE_GATEWAY_MODEL,
              LIA_AUTO_UPGRADE: "0",
            },
            timeoutMs: TIMEOUT,
          },
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout).output.trim()).toBe(
          "explicit skill ask complete",
        );
        expect(gateway.requests).toHaveLength(1);
        expect(gateway.modelRequests).toHaveLength(1);
        expect(gateway.requests[0]!.body).toContain(
          "Explicitly invoked skill content for this query:",
        );
        expect(gateway.requests[0]!.body).toContain(
          '<skill_content name=\\"cli-explicit\\"',
        );
        expect(gateway.requests[0]!.body).toContain('resource=\\"SKILL.md\\"');
        expect(gateway.requests[0]!.body).toContain('complete=\\"true\\"');
        expect(gateway.requests[0]!.body).toContain(skillBody);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia ask stdin prompts above the old 1 MiB limit reach Gateway byte-for-byte",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-large-stdin-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const sizes = [1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024];
      const gateway = startFakeGateway(
        sizes.map((_, index) => fakeGatewayFinalText(`large stdin ${index}`)),
        { models: [{
          id: FAKE_GATEWAY_MODEL,
          type: "language",
          tags: ["tool-use"],
          // Keep the stdin transport cases below the separate compaction threshold.
          context_window: 2_000_000,
          max_tokens: 16_384,
        }] },
      );
      try {
        mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeFileSync(join(home, ".lia", "settings.json"), "{}\n");

        for (const [index, size] of sizes.entries()) {
          const prompt = `B${"x".repeat(size - 2)}E`;
          const result = await runLia(
            ["ask", "--json", "--auto", "--no-save"],
            {
              cwd: realpathSync(workspace),
              env: {
                HOME: home,
                AI_GATEWAY_API_KEY: "fake-large-stdin-key",
                VERCEL_OIDC_TOKEN: undefined,
                LIA_GATEWAY_BASE_URL: gateway.baseUrl,
                LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
                LIA_MODEL: FAKE_GATEWAY_MODEL,
                LIA_AUTO_UPGRADE: "0",
              },
              stdin: prompt,
              timeoutMs: 60_000,
            },
          );

          expect(result.code, JSON.stringify({ size, stdout: result.stdout, stderr: result.stderr })).toBe(0);
          expect(JSON.parse(result.stdout).output.trim()).toBe(`large stdin ${index}`);
          const request = JSON.parse(gateway.requests[index]!.body) as {
            prompt: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
          };
          const user = request.prompt.findLast((message) => message.role === "user");
          expect(user?.content.find((part) => part.type === "text")?.text).toBe(prompt);
        }

        expect(gateway.requests).toHaveLength(sizes.length);
        expect(gateway.modelRequests).toHaveLength(sizes.length);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "lia ask stdin resource overflow has distinct text and JSON errors",
    async () => {
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x78);

      const textResult = await runLia(["ask", "--auto", "--no-save"], {
        env: { ...NO_GATEWAY_AUTH, LIA_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(textResult.code).toBe(1);
      expect(textResult.stdout).toBe("");
      expect(textResult.stderr).toBe(
        "lia ask: prompt exceeds the local input safety limit\n",
      );

      const jsonResult = await runLia(["ask", "--json", "--auto", "--no-save"], {
        env: { ...NO_GATEWAY_AUTH, LIA_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(jsonResult.code).toBe(1);
      expect(jsonResult.stderr).toBe("");
      expect(jsonResult.stdout).toBe(
        '{"output":"","final_output":"","exit_code":1,"model":"","resolved_provider":null,"session_id":"","steps":0,"tool_calls":[],"usage":{"input_tokens":null,"output_tokens":null},"error":"PromptResourceLimitExceeded"}\n',
      );
    },
    120_000,
  );

  test(
    "lia ask sends catalog-backed portable reasoning",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-portable-reasoning-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const model = "provider/new-reasoning-model";
      const gateway = startFakeGateway(
        [fakeGatewayFinalText("portable ask complete")],
        {
          models: [{
            id: model,
            type: "language",
            tags: ["reasoning", "tool-use"],
            context_window: 750_000,
            max_tokens: 64_000,
            reasoning_options: [{ type: "effort", values: ["high"] }],
          }],
        },
      );
      try {
        mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeFileSync(
          join(home, ".lia", "settings.json"),
          `${JSON.stringify({ model, effort: "high" })}\n`,
        );

        const result = await runLia(
          ["ask", "--json", "--auto", "--no-save", "Use portable reasoning."],
          {
            cwd: realpathSync(workspace),
            env: {
              HOME: home,
              AI_GATEWAY_API_KEY: "fake-portable-ask-key",
              VERCEL_OIDC_TOKEN: undefined,
              LIA_GATEWAY_BASE_URL: gateway.baseUrl,
              LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_TEST_GATEWAY_MODELS_URL: `${gateway.baseUrl}/coding-agent/v1/models`,
            },
            timeoutMs: 60_000,
          },
        );

        expect(result.code).toBe(0);
        expect(
          result.stderr
            .replace(
              /lia ask: warning: skipped \d+ invalid or unreadable skill candidates?; relaunch with LIA_TRACE=1 to write a trace log\n/g,
              "",
            )
            .replace(
              /\[notice\] skill discovery warning: [^\n]*; relaunch with LIA_TRACE=1 to write a trace log\n/g,
              "",
            ),
        ).toBe("");
        expect(JSON.parse(result.stdout).output.trim()).toBe("portable ask complete");
        expect(gateway.requests).toHaveLength(1);
        const request = JSON.parse(gateway.requests[0]!.body);
        expect(request).toMatchObject({
          reasoning: "high",
          maxOutputTokens: 64_000,
        });
        expect(gateway.modelRequests).toHaveLength(1);
        expect(request.providerOptions).toEqual({ gateway: { caching: "auto" } });
        expect(
          gateway.requests[0]!.headers.get(
            "ai-language-model-specification-version",
          ),
        ).toBe("4");
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test.skipIf(!HAS_API_KEY)(
    "live Gateway accepts catalog-backed portable reasoning",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-live-portable-reasoning-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      try {
        mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeFileSync(
          join(home, ".lia", "settings.json"),
          `${JSON.stringify({
            model: "openai/gpt-5.6-sol",
            effort: "high",
          })}\n`,
        );

        const result = await runLia(
          [
            "ask",
            "--json",
            "--auto",
            "--no-save",
            "Reply with exactly: LIA_PORTABLE_REASONING_LIVE_OK",
          ],
          {
            cwd: realpathSync(workspace),
            env: {
              HOME: home,
              LIA_MODEL: undefined,
              LIA_TRACE: "1",
              LIA_TRACE_LOG: tracePath,
              LIA_GATEWAY_BASE_URL: undefined,
              LIA_GATEWAY_CHAT_URL: undefined,
              LIA_TEST_GATEWAY_MODELS_URL: undefined,
              VERCEL_OIDC_TOKEN: undefined,
            },
            timeoutMs: 120_000,
          },
        );

        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).output).toContain(
          "LIA_PORTABLE_REASONING_LIVE_OK",
        );
        expect(readFileSync(tracePath, "utf8")).toContain(
          "reasoning=selected",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test.each([
    {
      name: "reports exact provider totals",
      reportedUsage: { inputTokens: { total: 17 }, outputTokens: { total: 23 } },
      expectedUsage: { input_tokens: 17, output_tokens: 23 },
      toolLoop: false,
      json: true,
    },
    {
      name: "reports null when provider totals are missing",
      reportedUsage: undefined,
      expectedUsage: { input_tokens: null, output_tokens: null },
      toolLoop: false,
      json: true,
    },
    {
      name: "sums main-agent completions across a read_file tool loop",
      reportedUsage: { inputTokens: { total: 17 }, outputTokens: { total: 23 } },
      expectedUsage: { input_tokens: 20, output_tokens: 28 },
      toolLoop: true,
      json: true,
    },
    {
      name: "leaves plain output unchanged",
      reportedUsage: { inputTokens: { total: 17 }, outputTokens: { total: 23 } },
      expectedUsage: undefined,
      toolLoop: false,
      json: false,
    },
  ])(
    "lia ask usage $name",
    async ({ reportedUsage, expectedUsage, toolLoop, json }) => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-usage-"));
      const answer = "Usage fixture complete.\n";
      const gateway = startFakeGateway([
        fakeGatewaySse([
          toolLoop
            ? {
                type: "tool-call",
                toolCallId: "read_usage_fixture",
                toolName: "read_file",
                input: JSON.stringify({ path: "fixture.txt" }),
              }
            : { type: "text-delta", id: "answer_1", delta: answer },
          {
            type: "finish",
            finishReason: toolLoop
              ? { unified: "tool-calls", raw: "tool-calls" }
              : { unified: "stop", raw: "stop" },
            usage: reportedUsage,
          },
        ]),
        ...(toolLoop ? [fakeGatewayFinalText(answer)] : []),
      ]);
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        writeFileSync(join(workspace, "fixture.txt"), "usage fixture contents\n");

        const result = await runLia(
          [
            "ask",
            ...(json ? ["--json"] : []),
            "--auto",
            "--no-save",
            toolLoop ? "Read fixture.txt and reply." : "Reply with the fixture answer.",
          ],
          {
            cwd: realpathSync(workspace),
            env: {
              HOME: realpathSync(home),
              AI_GATEWAY_API_KEY: "fake-ask-usage-key",
              VERCEL_OIDC_TOKEN: undefined,
              LIA_DISABLE_KEYCHAIN: "1",
              LIA_GATEWAY_BASE_URL: gateway.baseUrl,
              LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_TEST_GATEWAY_MODELS_URL: `${gateway.baseUrl}/coding-agent/v1/models`,
              LIA_MODEL: FAKE_GATEWAY_MODEL,
              LIA_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );

        expect(result.code).toBe(0);
        if (json) {
          const output = JSON.parse(result.stdout);
          expect(output.output).toBe(answer);
          expect(output.final_output).toBe(answer.trimEnd());
          expect(output.exit_code).toBe(0);
          expect(output.session_id).toBe("");
          expect(output.usage).toEqual(expectedUsage);
          expect(output.tool_calls).toEqual(
            toolLoop ? [{ name: "read_file", status: "success" }] : [],
          );
        } else {
          expect(result.stdout).toBe(answer);
        }
        if (toolLoop) {
          expect(result.stderr).toContain("Reading fixture.txt");
          expect(gateway.requests[1]!.body).toContain("usage fixture contents");
        } else {
          expect(result.stderr).toBe("");
        }
        expect(gateway.requests).toHaveLength(toolLoop ? 2 : 1);
        expect(gateway.classifierRequests).toHaveLength(0);
        expect(existsSync(join(home, ".lia"))).toBe(false);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "saved ask resumes the exact session while no-save creates no durable state",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-persistence-"));
      const gateway = startFakeGateway([
        fakeGatewayFinalText("orange triangle"),
        fakeGatewayFinalText("blue circle"),
        fakeGatewayFinalText("green square"),
      ]);
      try {
        const savedHome = join(root, "saved-home");
        const noSaveHome = join(root, "no-save-home");
        const workspace = join(root, "workspace");
        mkdirSync(savedHome);
        mkdirSync(noSaveHome);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);

        const first = await runLia(
          ["ask", "--json", "--auto", "Reply with exactly: orange triangle"],
          {
            cwd: workspaceRoot,
            env: {
              HOME: realpathSync(savedHome),
              AI_GATEWAY_API_KEY: "fake-ask-persistence-key",
              VERCEL_OIDC_TOKEN: undefined,
              LIA_GATEWAY_BASE_URL: gateway.baseUrl,
              LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_MODEL: FAKE_GATEWAY_MODEL,
              LIA_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        const firstJson = JSON.parse(first.stdout.trim());
        expect(firstJson.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
        expect(typeof firstJson.session_id).toBe("string");
        expect(firstJson.session_id.length).toBeGreaterThan(0);
        expect(gateway.requests[0]?.headers.get("x-session-id")).toBe(
          firstJson.session_id,
        );
        expect(gateway.requests[0]?.headers.get("x-session-affinity")).toBe(
          firstJson.session_id,
        );
        expect(
          gateway.requests[0]?.headers.get("x-vercel-gateway-extended-time"),
        ).toBe("true");
        expect(existsSync(sessionDir(savedHome, firstJson.session_id))).toBe(true);

        const resumed = await runLia(
          [
            "ask",
            "--json",
            "--auto",
            "--resume",
            "last",
            "Reply with exactly: blue circle",
          ],
          {
            cwd: workspaceRoot,
            env: {
              HOME: realpathSync(savedHome),
              AI_GATEWAY_API_KEY: "fake-ask-persistence-key",
              VERCEL_OIDC_TOKEN: undefined,
              LIA_GATEWAY_BASE_URL: gateway.baseUrl,
              LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_MODEL: FAKE_GATEWAY_MODEL,
              LIA_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toBe("");
        const resumedJson = JSON.parse(resumed.stdout.trim());
        expect(resumedJson.session_id).toBe(firstJson.session_id);
        expect(resumedJson.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
        expect(gateway.requests[1]?.headers.get("x-session-id")).toBe(
          firstJson.session_id,
        );
        expect(gateway.requests[1]?.headers.get("x-session-affinity")).toBe(
          firstJson.session_id,
        );
        const detail = await runLia(
          ["session", "--id", firstJson.session_id, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: realpathSync(savedHome) },
            timeoutMs: 60_000,
          },
        );
        expect(detail.code).toBe(0);
        expect(JSON.parse(detail.stdout).history_len).toBe(2);

        const noSave = await runLia(
          ["ask", "--json", "--auto", "--no-save", "Reply with exactly: green square"],
          {
            cwd: workspaceRoot,
            env: {
              HOME: realpathSync(noSaveHome),
              AI_GATEWAY_API_KEY: "fake-ask-persistence-key",
              VERCEL_OIDC_TOKEN: undefined,
              LIA_GATEWAY_BASE_URL: gateway.baseUrl,
              LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
              LIA_MODEL: FAKE_GATEWAY_MODEL,
              LIA_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );
        expect(noSave.code).toBe(0);
        expect(noSave.stderr).toBe("");
        const noSaveJson = JSON.parse(noSave.stdout.trim());
        expect(noSaveJson.session_id).toBe("");
        expect(noSaveJson.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
        expect(gateway.requests[2]?.headers.get("x-session-id")).toBeNull();
        expect(gateway.requests[2]?.headers.get("x-session-affinity")).toBeNull();
        expect(existsSync(join(noSaveHome, ".lia"))).toBe(false);
        expect(gateway.requests).toHaveLength(3);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  test(
    "saved ask converts a legacy session once and continues after restart",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-legacy-convert-"));
      const gateway = startFakeGateway([
        fakeGatewayFinalText("LEGACY_CONVERTED_OK"),
        fakeGatewayFinalText("LEGACY_RESTART_OK"),
      ]);
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const sessionId = "legacy-ask-convert";
        writeLegacySession(home, workspaceRoot, sessionId);
        const legacyDir = join(home, ".lia", "sessions", sessionId);
        const legacyPath = join(legacyDir, "session.json");
        const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
        const legacyOutput = "LEGACY_AVAILABLE_RESULT_BYTES";
        const legacySummary = "LEGACY_ONLY_EARLIER_CONTEXT: deploy to eu-west-1.";
        legacy.history_len = 2;
        legacy.history = [{
          kind: "compacted_summary",
          summary: legacySummary,
          removed_turn_count: 12,
          compaction_count: 1,
        }, {
          kind: "assistant",
          user: { text: "LEGACY_ORIGINAL_REQUEST", images: [] },
          assistant: "LEGACY_ORIGINAL_ANSWER",
          execution: {
            schema_version: 2,
            tool_steps: [{
              assistant: null,
              tool_calls: [{ id: "legacy-read", name: "read_file", arguments_json: '{"path":"past.txt"}', provider_result: null }],
              tool_results: [{
                tool_call_id: "legacy-read", tool_name: "read_file", status: "success",
                output: legacyOutput, output_handle: null, preview: null,
                output_bytes: legacyOutput.length, stored_output_bytes: legacyOutput.length,
                truncated: false, provider_native: false, created_at_ms: 2, permission_feedback: [],
              }],
            }],
            files: [
              { path: "", new_path: null, tool_call_id: "legacy-read", tool_name: "read_file", action: "unknown", status: "success", model_view_covers_full_file: false, stale: false },
              { path: "past.txt", new_path: null, tool_call_id: "legacy-read", tool_name: "read_file", action: "unknown", status: "success", model_view_covers_full_file: false, stale: false },
            ], steering: [],
          },
        }];
        writeFileSync(legacyPath, JSON.stringify(legacy) + "\n", { mode: 0o600 });
        const env = {
          HOME: home,
          AI_GATEWAY_API_KEY: "fake-legacy-convert-key",
          VERCEL_OIDC_TOKEN: undefined,
          LIA_GATEWAY_BASE_URL: gateway.baseUrl,
          LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
          LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
          LIA_MODEL: FAKE_GATEWAY_MODEL,
          LIA_AUTO_UPGRADE: "0",
        };

        const first = await runLia(
          ["ask", "--json", "--auto", "--resume", sessionId, "Convert and continue."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(first.code, first.stderr + first.stdout).toBe(0);
        expect(first.stderr).toBe("");
        expect(JSON.parse(first.stdout)).toMatchObject({
          session_id: sessionId,
          final_output: "LEGACY_CONVERTED_OK",
        });

        // Converted once: the new store holds it, and v1's folder is gone.
        expect(existsSync(sessionDir(home, sessionId))).toBe(true);
        expect(existsSync(legacyDir)).toBe(false);

        const second = await runLia(
          ["ask", "--json", "--auto", "--resume", sessionId, "Continue after restart."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(second.code).toBe(0);
        expect(second.stderr).toBe("");
        expect(JSON.parse(second.stdout)).toMatchObject({
          session_id: sessionId,
          final_output: "LEGACY_RESTART_OK",
        });
        const history = (await savedSession(home, sessionId)).history;
        expect(history.map((turn: { kind: string }) => turn.kind)).toEqual([
          "compacted_summary",
          "assistant",
          "assistant",
          "assistant",
        ]);
        expect(gateway.requests).toHaveLength(2);
        for (const request of gateway.requests) {
          expect(request.body).toContain(legacySummary);
          expect(request.body).toContain("LEGACY_ORIGINAL_REQUEST");
          expect(request.body).toContain("LEGACY_ORIGINAL_ANSWER");
          expect(request.body).toContain(legacyOutput);
        }
        // The old inline result keeps its bytes, but not the claim that it is
        // complete.
        const preserved = history[1].execution.tool_steps[0].tool_results[0];
        expect(preserved.tool_call_id).toBe("legacy-read");
        expect(preserved.truncated).toBe(true);
        expect(preserved.stored_output_bytes).toBe(legacyOutput.length);
        const blobs = join(sessionDir(home, sessionId), "blobs");
        expect(readdirSync(blobs).some((hash) => readFileSync(join(blobs, hash), "utf8") === legacyOutput)).toBe(true);
        expect(history[1].execution.files.map((file: { path: string }) => file.path)).toEqual(["past.txt"]);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "saved asks remain discoverable and resumable without session caches",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-session-cache-free-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const unrelatedReply = `unrelated saved turn ${"x".repeat(64 * 1024)}`;
      const gateway = startFakeGateway([
        fakeGatewayFinalText(unrelatedReply),
        fakeGatewayFinalText("first saved turn"),
        fakeGatewayFinalText("second saved turn"),
        fakeGatewayFinalText("exact resumed turn"),
        fakeGatewayFinalText("latest resumed turn"),
        fakeGatewayFinalText("continued target turn"),
        fakeGatewayFinalText("continued second turn"),
      ]);
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const env = {
          HOME: realpathSync(home),
          AI_GATEWAY_API_KEY: "fake-session-cache-free-key",
          VERCEL_OIDC_TOKEN: undefined,
          LIA_GATEWAY_BASE_URL: gateway.baseUrl,
          LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
          LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
          LIA_MODEL: FAKE_GATEWAY_MODEL,
          LIA_AUTO_UPGRADE: "0",
        };

        const unrelated = await runLia(
          ["ask", "--json", "--auto", "Save an unrelated long turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(unrelated.code).toBe(0);
        expect(unrelated.stderr).toBe("");
        const unrelatedJson = JSON.parse(unrelated.stdout);
        const unrelatedSessionId = unrelatedJson.session_id as string;
        expect(unrelatedJson.output).toBe(unrelatedReply);

        const first = await runLia(
          ["ask", "--json", "--auto", "Reply with the first saved turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        const sessionId = JSON.parse(first.stdout).session_id as string;
        const sessionsDir = join(home, ".lia", "sessions");
        expect(existsSync(join(sessionsDir, "index.json"))).toBe(false);
        expect(existsSync(join(sessionsDir, "latest"))).toBe(false);
        expect(existsSync(join(sessionsDir, "latest.lock"))).toBe(false);

        const createdNext = await runLia(
          ["ask", "--json", "--auto", "Create another saved turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(createdNext.code).toBe(0);
        expect(createdNext.stderr).toBe("");
        const createdNextJson = JSON.parse(createdNext.stdout);
        const createdNextId = createdNextJson.session_id as string;
        expect(createdNextJson.output.trim()).toBe("second saved turn");

        const exact = await runLia(
          [
            "ask",
            "--json",
            "--auto",
            "--resume",
            sessionId,
            "Reply with the exact resumed turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(exact.code).toBe(0);
        expect(exact.stderr).toBe("");
        expect(JSON.parse(exact.stdout).output.trim()).toBe("exact resumed turn");

        const listed = await runLia(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: 60_000,
        });
        expect(listed.code).toBe(0);
        expect(listed.stderr).toBe("");
        const listedSessions = JSON.parse(listed.stdout).sessions;
        expect(listedSessions[0]).toMatchObject({
          id: sessionId,
          history_len: 2,
        });
        expect(listedSessions[1]).toMatchObject({
          id: createdNextId,
          history_len: 1,
        });
        expect(listedSessions[2]).toMatchObject({
          id: unrelatedSessionId,
          history_len: 1,
        });
        expect(existsSync(join(sessionsDir, "latest"))).toBe(false);

        const latest = await runLia(
          [
            "ask",
            "--json",
            "--auto",
            "--resume",
            "last",
            "Reply with the latest resumed turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(latest.code).toBe(0);
        expect(latest.stderr).toBe("");
        expect(JSON.parse(latest.stdout).session_id).toBe(sessionId);
        expect(JSON.parse(latest.stdout).output.trim()).toBe("latest resumed turn");

        const repaired = await runLia(
          [
            "ask",
            "--json",
            "--auto",
            "--resume",
            sessionId,
            "Reply with the continued target turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(repaired.code).toBe(0);
        expect(repaired.stderr).toBe("");
        expect(JSON.parse(repaired.stdout).output.trim()).toBe("continued target turn");
        const createdNextDetail = await runLia(
          ["session", "--id", createdNextId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(createdNextDetail.code).toBe(0);
        expect(createdNextDetail.stderr).toBe("");
        expect(JSON.parse(createdNextDetail.stdout).history_len).toBe(1);
        const continuedNext = await runLia(
          [
            "ask",
            "--json",
            "--auto",
            "--resume",
            createdNextId,
            "Continue the second saved session.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(continuedNext.code).toBe(0);
        expect(continuedNext.stderr).toBe("");
        expect(JSON.parse(continuedNext.stdout).output.trim()).toBe("continued second turn");
        const targetDetail = await runLia(
          ["session", "--id", sessionId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(targetDetail.code).toBe(0);
        expect(targetDetail.stderr).toBe("");
        expect(JSON.parse(targetDetail.stdout).history_len).toBe(4);
        const unrelatedDetail = await runLia(
          ["session", "--id", unrelatedSessionId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(unrelatedDetail.code).toBe(0);
        expect(unrelatedDetail.stderr).toBe("");
        expect(JSON.parse(unrelatedDetail.stdout).history_len).toBe(1);
        expect(gateway.requests).toHaveLength(7);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );

  test.skipIf(!HAS_API_KEY)(
    "lia ask --json --no-save --auto returns valid JSON with output",
    async () => {
      const r = await runLia(
        ["ask", "--json", "--no-save", "--auto", "Say exactly: hello world"],
        { timeoutMs: 60_000 },
      );
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(typeof json.output).toBe("string");
      expect(json.output.length).toBeGreaterThan(0);
      expect(typeof json.final_output).toBe("string");
      expect(json.final_output.length).toBeGreaterThan(0);
      expect(typeof json.model).toBe("string");
      expect(Array.isArray(json.tool_calls)).toBe(true);
      expect(typeof json.steps).toBe("number");
    },
    60_000,
  );
});

describe("cli: error handling", () => {
  test(
    "lia ask rejects unknown options before a model turn and -- preserves literal prompt text",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-options-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const gateway = startFakeGateway([
        fakeGatewayFinalText("literal option prompt complete"),
      ]);
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          HOME: realpathSync(home),
          AI_GATEWAY_API_KEY: "ask-options-key",
          VERCEL_OIDC_TOKEN: undefined,
          LIA_GATEWAY_BASE_URL: gateway.baseUrl,
          LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
          LIA_MODEL: FAKE_GATEWAY_MODEL,
          LIA_AUTO_UPGRADE: "0",
        };

        const rejected = await runLia(["ask", "--definitely-unknown"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(rejected.code).toBe(2);
        expect(rejected.stderr).toContain("usage: lia ask");
        expect(gateway.requests).toHaveLength(0);

        const literal = await runLia(
          [
            "ask",
            "--json",
            "--auto",
            "--no-save",
            "--",
            "--definitely-prompt-text",
          ],
          {
            cwd: realpathSync(workspace),
            env,
            timeoutMs: TIMEOUT,
          },
        );
        expect(literal.code).toBe(0);
        const literalJson = JSON.parse(literal.stdout);
        expect(literalJson.output.trim()).toBe(
          "literal option prompt complete",
        );
        expect(literalJson.final_output).toBe("literal option prompt complete");
        expect(gateway.requests).toHaveLength(1);
        expect(gateway.requests[0]!.body).toContain("--definitely-prompt-text");
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "lia ask with no prompt exits 2",
    async () => {
      const r = await runLia(["ask"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("missing prompt");
    },
    TIMEOUT,
  );

  test(
    "lia with a mistyped command exits 2",
    async () => {
      const r = await runLia(["statsu"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toBe("lia: unknown command: statsu (did you mean status?)\n");
    },
    TIMEOUT,
  );

  test(
    "lia ask explains no-save resume conflicts before a model turn",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-resume-no-save-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const gateway = startFakeGateway([]);
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          HOME: realpathSync(home),
          AI_GATEWAY_API_KEY: "ask-conflict-key",
          VERCEL_OIDC_TOKEN: undefined,
          LIA_GATEWAY_BASE_URL: gateway.baseUrl,
          LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
          LIA_MODEL: FAKE_GATEWAY_MODEL,
          LIA_AUTO_UPGRADE: "0",
        };

        for (const args of [
          ["ask", "--no-save", "--resume", "last", "hello"],
          ["ask", "--resume", "session.v3", "--no-save", "hello"],
        ]) {
          const rejected = await runLia(args, {
            cwd: realpathSync(workspace),
            env,
            timeoutMs: TIMEOUT,
          });
          expect(rejected.code).toBe(2);
          expect(rejected.stdout).toBe("");
          expect(rejected.stderr).toContain(
            "lia ask: --no-save cannot be used with --resume",
          );
          expect(rejected.stderr).toContain(
            "usage: lia ask [--permission-mode <mode>|--ask|--auto|--full-access] [--provider <name>] [--model <id>] [--effort <level>] [--fast|--no-fast] [--ultrafast|--no-ultrafast] [--provider-order <a,b,...>] [--provider-strict|--no-provider-strict] [--image PATH] [--system TEXT] [--json] [--quiet] [--prompt-permissions] [--timeout <seconds>] [--config <key=value>] [--no-save]",
          );
        }
        expect(gateway.requests).toHaveLength(0);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: workspace access", () => {
  test(
    "workspace launch modifiers preserve ask help and report friendly option errors",
    async () => {
      const enabled = {
        ...NO_GATEWAY_AUTH,
      };

      const help = await runLia(
        ["--add-dir", "/tmp/shared", "ask", "--help"],
        { env: enabled },
      );
      expect(help.code).toBe(0);
      expect(help.stdout.startsWith("lia ask\n\n")).toBe(true);
      expect(help.stderr).toBe("");

      const missing = await runLia(["--add-dir"], { env: enabled });
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("lia: --add-dir needs a value\n");
      expect(missing.stderr).not.toContain("InvalidFlag");

      // A repeated flag is not an error: the launch gets past parsing and
      // prints the help.
      const duplicate = await runLia(
        ["--no-additional-dirs", "--no-additional-dirs"],
        { env: enabled },
      );
      expect(duplicate.code).toBe(0);
      expect(duplicate.stderr).toBe("");

      const badMode = await runLia(["--permission-mode", "never"], { env: enabled });
      expect(badMode.code).toBe(2);
      expect(badMode.stderr).toContain("lia: --permission-mode accepts ask, auto, or full-access\n");

      const beforeCommand = await runLia(["--auto", "status"], { env: enabled });
      expect(beforeCommand.code).toBe(2);
      expect(beforeCommand.stderr).toBe("lia: agent-run flags such as --permission-mode apply to a session and to lia ask, lia pr, lia issue, and lia acp\n");
    },
    TIMEOUT,
  );

  test(
    "workspace commands persist per-primary roots and track availability",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-workspace-access-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const unknown = join(root, "unknown");
        const missing = join(root, "missing");
        mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".lia"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(unknown);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const unknownRoot = realpathSync(unknown);
        const baseEnv = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
        };

        const added = await runLia(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(added.code).toBe(0);
        const addedJson = JSON.parse(added.stdout.trim());
        expect(addedJson).toMatchObject({
          kind: "workspace",
          action: "add",
          changed: true,
          limit: 16,
          path: sharedRoot,
        });
        expect(addedJson.additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: true,
            active: true,
          },
        ]);

        const stored = JSON.parse(
          readFileSync(join(home, ".lia", "settings.json"), "utf8"),
        );
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          sharedRoot,
        ]);

        for (const path of [unknownRoot, missing]) {
          const unknownRemoval = await runLia(
            ["workspace", "remove", path, "--json"],
            { cwd: workspaceRoot, env: baseEnv },
          );
          expect(unknownRemoval.code).toBe(1);
          expect(JSON.parse(unknownRemoval.stdout.trim())).toEqual({
            kind: "workspace",
            error: "directory is not configured as an additional workspace",
            code: "UnknownAdditionalDirectory",
          });
        }

        const removed = await runLia(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removed.code).toBe(0);
        expect(JSON.parse(removed.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          launch_flag_can_restore: false,
          additional_directories: [],
        });

        const readded = await runLia(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(readded.code).toBe(0);

        const active = await runLia(["workspace", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(active.code).toBe(0);
        expect(JSON.parse(active.stdout.trim())).toMatchObject({
          action: "list",
          changed: false,
          additional_directories: [{ path: sharedRoot, active: true }],
        });

        rmSync(sharedRoot, { recursive: true, force: true });
        const unavailable = await runLia(["workspace", "list", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(unavailable.code).toBe(0);
        expect(JSON.parse(unavailable.stdout.trim()).additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: false,
            active: false,
          },
        ]);

        const unavailableRemoved = await runLia(
          ["workspace", "remove", `${sharedRoot}${sep}`, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unavailableRemoved.code).toBe(0);
        expect(JSON.parse(unavailableRemoved.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        const removedSettings = JSON.parse(
          readFileSync(join(home, ".lia", "settings.json"), "utf8"),
        );
        expect(
          removedSettings.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        mkdirSync(sharedRoot);
        const restored = await runLia(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(restored.code).toBe(0);

        const cleared = await runLia(["workspace", "clear", "--json"], {
          cwd: workspaceRoot,
          env: baseEnv,
        });
        expect(cleared.code).toBe(0);
        expect(JSON.parse(cleared.stdout.trim())).toMatchObject({
          action: "clear",
          changed: true,
          additional_directories: [],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "workspace commands mutate persisted aliases by workspace identity",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lia-workspace-alias-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const sharedLink = join(root, "shared-link");
        const missing = join(root, "missing");
        const realParent = join(root, "real-parent");
        const parentLink = join(root, "parent-link");
        mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".lia"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(realParent);
        symlinkSync(shared, sharedLink, "dir");
        symlinkSync(realParent, parentLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const settingsPath = join(home, ".lia", "settings.json");
        const baseEnv = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
        };

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${sharedRoot}${sep}.`,
                  sharedLink,
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        const unchanged = await runLia(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unchanged.code).toBe(0);
        expect(JSON.parse(unchanged.stdout.trim())).toMatchObject({
          action: "add",
          changed: true,
          saved_changed: true,
          runtime_changed: false,
        });

        const removedAvailable = await runLia(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedAvailable.code).toBe(0);
        expect(JSON.parse(removedAvailable.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        let stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${missing}${sep}.`,
                  join(missing, "child", ".."),
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedUnavailable = await runLia(
          ["workspace", "remove", missing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedUnavailable.code).toBe(0);
        expect(JSON.parse(removedUnavailable.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        const realMissing = join(realParent, "missing");
        const linkedMissing = join(parentLink, "missing");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [realMissing, linkedMissing],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedLinkedPrefix = await runLia(
          ["workspace", "remove", linkedMissing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedLinkedPrefix.code).toBe(0);
        expect(JSON.parse(removedLinkedPrefix.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("cli: MCP profile", () => {
  test("status, doctor, and list start no MCP server, and show connects one", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-cli-mcp-inspect-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const pidPath = join(root, "mcp.pid");
    mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
    mkdirSync(workspace);
    writeFileSync(join(home, ".lia", "settings.json"), "{}\n", { mode: 0o600 });
    writeFileSync(
      join(home, ".lia", "mcp.json"),
      JSON.stringify({
        mcp: {
          fixture: {
            type: "local",
            command: [process.execPath, MODERN_MCP_FIXTURE],
            environment: { LIA_MCP_PID_PATH: pidPath },
          },
        },
      }),
      { mode: 0o600 },
    );
    const env = { HOME: home, ...NO_GATEWAY_AUTH };
    try {
      const status = await runLia(["status", "--json"], { cwd: workspace, env });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout.trim()).mcp).toMatchObject({
        connection_check: "not_checked",
        servers: [{
          name: "fixture",
          source: "profile",
          connection: "not_checked",
          authentication: "not_checked",
        }],
      });
      expect(existsSync(pidPath)).toBe(false);

      const doctor = await runLia(["doctor", "--json"], { cwd: workspace, env });
      expect(doctor.code).toBe(0);
      expect(JSON.parse(doctor.stdout.trim()).mcp.connection_check).toBe(
        "not_checked",
      );
      expect(existsSync(pidPath)).toBe(false);

      const listed = await runLia(["mcp", "list"], { cwd: workspace, env });
      expect(listed.code).toBe(0);
      expect(listed.stdout).toMatch(/fixture +~\/\.lia\/mcp\.json +stdio +not started/);
      expect(existsSync(pidPath)).toBe(false);

      const shown = await runLia(
        ["mcp", "show", "fixture"],
        { cwd: workspace, env, timeoutMs: TIMEOUT },
      );
      expect(shown.code).toBe(0);
      expect(shown.stderr).toBe("");
      expect(shown.stdout).toContain("ready, 1 tool");
      expect(existsSync(pidPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("add refuses a profile with both mcp and mcpServers and leaves it as it was", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-cli-mcp-keys-")));
    const home = join(root, "home");
    const profilePath = join(home, ".lia", "mcp.json");
    mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
    const both = JSON.stringify({
      mcp: { alpha: { command: "alpha-server" } },
      mcpServers: { beta: { command: "beta-server" } },
    });
    writeFileSync(profilePath, both, { mode: 0o600 });
    try {
      const refused = await runLia(
        ["mcp", "add", "gamma", "--", "gamma-server"],
        { env: { HOME: home, ...NO_GATEWAY_AUTH } },
      );
      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe(
          "Couldn't add gamma to ~/.lia/mcp.json: the file has both \"mcp\" and \"mcpServers\"; merge them into one.\n",
      );
      expect(readFileSync(profilePath, "utf8")).toBe(both);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(platform() === "win32")("status, list, and add finish when ~/.lia/mcp.json is a fifo", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-cli-mcp-fifo-")));
    const home = join(root, "home");
    const profilePath = join(home, ".lia", "mcp.json");
    mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
    // Opening a fifo for reading waits for a writer, and nothing writes here.
    expect(spawnSync("mkfifo", [profilePath]).status).toBe(0);
    const env = { HOME: home, ...NO_GATEWAY_AUTH };
    try {
      const status = await runLia(["status", "--json"], { cwd: root, env });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout.trim()).mcp.inspection_error).toBe("DurablePathUnsafe");

      const list = await runLia(["mcp", "list"], { cwd: root, env });
      expect(list.code).toBe(1);
      expect(list.stderr).toBe("lia mcp: ~/.lia/mcp.json isn't a plain file; replace it with one\n");

      const add = await runLia(["mcp", "add", "probe", "--", "/bin/echo", "hi"], { cwd: root, env });
      expect(add.code).toBe(1);
      expect(add.stderr).toBe(
        "Couldn't add probe to ~/.lia/mcp.json: it isn't a plain file; replace it with one.\n",
      );
      expect(lstatSync(profilePath).isFIFO()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(platform() === "win32")("list, add, and ask say what's wrong with a ~/.lia/mcp.json lia can't read", async () => {
    const linkLoop = "~/.lia/mcp.json is a link that loops or passes through too many links; replace it with a plain file";
    const tooLarge = "~/.lia/mcp.json is over 1 MB, the most lia reads; make it smaller";
    const cases = [
      {
        label: "link loop",
        make: (path: string) => symlinkSync("mcp.json", path),
        list: `lia mcp: ${linkLoop}\n`,
        add: "Couldn't add probe to ~/.lia/mcp.json: it is a link that loops or passes through too many links; replace it with a plain file.\n",
        ask: `lia ask: ${linkLoop}\n`,
      },
      {
        label: "over 1 MB",
        make: (path: string) =>
          writeFileSync(path, JSON.stringify({ mcpServers: {}, pad: "x".repeat(1024 * 1024) }), { mode: 0o600 }),
        list: `lia mcp: ${tooLarge}\n`,
        add: "Couldn't add probe to ~/.lia/mcp.json: it is over 1 MB, the most lia reads; make it smaller.\n",
        ask: `lia ask: ${tooLarge}\n`,
      },
      {
        label: "fifo",
        // Opening a fifo for reading waits for a writer, and nothing writes here.
        make: (path: string) => expect(spawnSync("mkfifo", [path]).status).toBe(0),
        ask: "lia ask: ~/.lia/mcp.json isn't a plain file; replace it with one\n",
      },
    ];
    for (const item of cases) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-cli-mcp-unreadable-")));
      const home = join(root, "home");
      const profilePath = join(home, ".lia", "mcp.json");
      mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
      item.make(profilePath);
      const gateway = startFakeGateway([]);
      try {
        const env = { HOME: home, ...NO_GATEWAY_AUTH };
        if (item.list) {
          const list = await runLia(["mcp", "list"], { cwd: root, env });
          expect({ label: item.label, code: list.code, stderr: list.stderr }).toEqual({ label: item.label, code: 1, stderr: item.list });
        }
        if (item.add) {
          const add = await runLia(["mcp", "add", "probe", "--", "/bin/echo", "hi"], { cwd: root, env });
          expect({ label: item.label, code: add.code, stderr: add.stderr }).toEqual({ label: item.label, code: 1, stderr: item.add });
        }
        // lia ask stops in words before it sends any model request.
        const askEnv = {
          HOME: home,
          AI_GATEWAY_API_KEY: "mcp-unreadable-key",
          VERCEL_OIDC_TOKEN: undefined,
          LIA_DISABLE_KEYCHAIN: "1",
          LIA_AUTO_UPGRADE: "0",
          LIA_MODEL: FAKE_GATEWAY_MODEL,
          LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
        };
        const ask = await runLia(["ask", "--no-save", "Do nothing."], { cwd: root, env: askEnv });
        expect({ label: item.label, code: ask.code, stderr: ask.stderr }).toEqual({ label: item.label, code: 1, stderr: item.ask });
        expect(gateway.requestCount()).toBe(0);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("concurrent adds of different names keep both", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-cli-mcp-race-")));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    try {
      const [first, second] = await Promise.all([
        runLia(["mcp", "add", "first", "--", "first-server"], {
          env: { HOME: home, ...NO_GATEWAY_AUTH },
        }),
        runLia(["mcp", "add", "second", "--", "second-server"], {
          env: { HOME: home, ...NO_GATEWAY_AUTH },
        }),
      ]);
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const profile = JSON.parse(
        readFileSync(join(home, ".lia", "mcp.json"), "utf8"),
      );
      expect(Object.keys(profile.mcpServers).sort()).toEqual(["first", "second"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("add fails precisely without HOME and on a flag it doesn't have", async () => {
    const missingHome = await runLia(["mcp", "add", "fixture", "--", "node"], {
      env: { HOME: undefined, ...NO_GATEWAY_AUTH },
    });
    expect(missingHome.code).toBe(1);
    expect(missingHome.stderr).toBe("lia mcp: HOME is not set to an absolute path\n");

    // A relative HOME counts as unset: lia fails the same way and saves
    // nothing under the folder it runs in.
    const cwd = mkdtempSync(join(tmpdir(), "lia-e2e-mcp-relative-home-"));
    try {
      const relativeHome = await runLia(["mcp", "add", "fixture", "--", "node"], {
        cwd,
        env: { HOME: "relative/home", ...NO_GATEWAY_AUTH },
      });
      expect(relativeHome.code).toBe(1);
      expect(relativeHome.stderr).toBe("lia mcp: HOME is not set to an absolute path\n");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    const flagged = await runLia(
      ["mcp", "add", "--transport", "sse", "fixture", "https://example.test"],
      { env: { HOME: tmpdir(), ...NO_GATEWAY_AUTH } },
    );
    expect(flagged.code).toBe(2);
    expect(flagged.stderr).toStartWith("lia mcp add: unknown flag --transport\nusage: lia mcp add");
  });
});

function shellAvailable(shell: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0;
}

describe("cli: completion", () => {
  // The words on the command line, the last one under the cursor, and what
  // Tab offers there.
  const cases: [string[], string][] = [
    [["lia", "con"], "config"],
    [["lia", "config", ""], "list get set unset schema"],
    [["lia", "config", "schema", "--p"], "--project"],
    [["lia", "config", "get", "sound.t"], "sound.turn_end"],
    [["lia", "config", "get", "status_line.c"], ""],
    [["lia", "config", "get", "startup_s"], ""],
    [["lia", "config", "get", "theme", ""], ""],
    [["lia", "ask", "--permission-mode", ""], "ask auto full-access"],
    [["lia", "--model", "gpt-5", "ask", "--permission-m"], "--permission-mode"],
    [["lia", "mcp", ""], "list show add remove login logout approve reject call"],
    [["lia", "mcp", "add", "--g"], "--global"],
    [["lia", "usage", "--period", ""], "today 7d month"],
    [["lia", "login", ""], "vercel"],
    [["lia", "completion", ""], "bash zsh fish"],
  ];

  async function writeScript(shell: string, dir: string): Promise<string> {
    const result = await runLia(["completion", shell], { env: { HOME: dir } });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const path = join(dir, `lia.${shell}`);
    writeFileSync(path, result.stdout);
    return path;
  }

  function quoted(words: string[]): string {
    return words.map((word) => `'${word}'`).join(" ");
  }

  test("lia completion takes one shell name", async () => {
    const home = mkdtempSync(join(tmpdir(), "lia-completion-usage-"));
    try {
      const unknown = await runLia(["completion", "tcsh"], { env: { HOME: home } });
      expect(unknown.code).toBe(2);
      expect(unknown.stdout).toBe("");
      expect(unknown.stderr).toBe("lia completion: unknown shell tcsh; choose bash, zsh, or fish\nusage: lia completion bash|zsh|fish\n");
      const none = await runLia(["completion"], { env: { HOME: home } });
      expect(none.code).toBe(2);
      expect(none.stderr).toBe("usage: lia completion bash|zsh|fish\n");
      const help = await runLia(["completion", "--help"], { env: { HOME: home } });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('Commands:\n  bash  Load it with: eval "$(lia completion bash)"\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("lia completion bash completes words, flags, values, and setting keys", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lia-completion-bash-")));
    try {
      const script = await writeScript("bash", home);
      const harness = join(home, "harness.bash");
      writeFileSync(harness, [
        // The way help says to load it. bash 3.2 loads nothing through
        // source <(...), so eval is the line that works everywhere.
        `eval "$(cat '${script}')"`,
        'comp() { COMP_WORDS=("$@"); COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 )); COMPREPLY=(); _lia; echo "${COMPREPLY[*]}"; }',
        ...cases.map(([words]) => `comp ${quoted(words)}`),
        "",
      ].join("\n"));
      const run = spawnSync("bash", [harness], { cwd: home, encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(run.stdout.split("\n").slice(0, cases.length)).toEqual(cases.map(([, want]) => want));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test.skipIf(!shellAvailable("zsh"))("lia completion zsh offers the same candidates", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lia-completion-zsh-")));
    try {
      const script = await writeScript("zsh", home);
      const harness = join(home, "harness.zsh");
      // compsys filters by the typed prefix itself, so the stubs do too.
      writeFileSync(harness, [
        "compdef() { :; }",
        `source '${script}'`,
        '_lia_test_print() { local prefix=${words[CURRENT]}; local -a out; out=(${(M)@:#${prefix}*}); print -r -- "${out[*]}"; }',
        '_describe() { local -a items; items=("${(@P)4}"); _lia_test_print "${(@)items%%:*}"; }',
        'compadd() { if [[ $1 == -a ]]; then _lia_test_print "${(@P)2}"; else _lia_test_print "$@"; fi; }',
        '_files() { print -r -- ""; }',
        'comp() { words=("$@"); CURRENT=${#words}; _lia; }',
        ...cases.map(([words]) => `comp ${quoted(words)}`),
        "",
      ].join("\n"));
      const run = spawnSync("zsh", ["-f", harness], { cwd: home, encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(run.stdout.split("\n").slice(0, cases.length)).toEqual(cases.map(([, want]) => want));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test.skipIf(!shellAvailable("fish"))("lia completion fish offers the same candidates", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lia-completion-fish-")));
    try {
      const script = await writeScript("fish", home);
      for (const [words, want] of cases) {
        const line = words.join(" ");
        // As in the bash and zsh harnesses, file completion offers nothing,
        // so only the words lia itself offers are compared.
        const stubFiles = "function __fish_complete_path; end";
        const run = spawnSync("fish", ["--no-config", "-c", `source '${script}'; ${stubFiles}; complete -C '${line}'`], {
          cwd: home,
          encoding: "utf8",
        });
        expect(run.stderr).toBe("");
        const got = run.stdout.split("\n").filter(Boolean).map((row) => row.split("\t")[0]).sort();
        expect(got).toEqual(want.split(" ").filter(Boolean).sort());
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
