import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  fakeGatewayToolCall,
  startFakeGateway,
} from "./fake-gateway";
import { copyV1Fixture, savedSession, savedSessionIds, savedText, savedToolResults, sessionDir, storeRoot, withoutConversionNotice } from "./saved-sessions";

const TIMEOUT = 30_000;

function savedFileHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  function visit(directory: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "session.lock") continue;
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) visit(join(directory, entry.name), relative);
      else hashes[relative] = createHash("sha256")
        .update(readFileSync(join(directory, entry.name)))
        .digest("hex");
    }
  }
  visit(root);
  return hashes;
}

function createFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  return {
    root,
    home: realpathSync(home),
    workspace: realpathSync(workspace),
  };
}

function gatewayEnv(
  fixture: ReturnType<typeof createFixture>,
  gateway: ReturnType<typeof startFakeGateway>,
) {
  return {
    HOME: fixture.home,
    AI_GATEWAY_API_KEY: "session-recovery-test-key",
    VERCEL_OIDC_TOKEN: undefined,
    LIA_GATEWAY_BASE_URL: gateway.baseUrl,
    LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
    LIA_TEST_GATEWAY_CHAT_URL: gateway.chatUrl,
    LIA_MODEL: FAKE_GATEWAY_MODEL,
  };
}

async function continueSession(
  fixture: ReturnType<typeof createFixture>,
  gateway: ReturnType<typeof startFakeGateway>,
  sessionId: string,
  latest = false,
) {
  return runLia(
    [
      "ask",
      "--json",
      "--auto",
      ...(latest ? ["--resume", "last"] : ["--resume", sessionId]),
      "Continue after recovery.",
    ],
    {
      cwd: fixture.workspace,
      env: gatewayEnv(fixture, gateway),
      timeoutMs: TIMEOUT,
    },
  );
}

const LEGACY_TITLE = "Synthetic legacy recovery conversation";

test("a session converts the same whatever its old replay cache holds", async () => {
  // v0.0.14 kept a replay cache beside its log. The converter reads the log,
  // so a damaged, missing or outdated cache changes nothing.
  const versionOffset = Buffer.byteLength("lia-history-cache\x1a\n");
  const faults: Record<string, (cache: string) => void> = {
    intact: () => {},
    corrupt: (cache) => {
      const bytes = readFileSync(cache);
      bytes[bytes.byteLength - 4] = bytes[bytes.byteLength - 4]! ^ 0xff;
      writeFileSync(cache, bytes, { mode: 0o600 });
    },
    missing: (cache) => rmSync(cache),
    outdated: (cache) => {
      const bytes = readFileSync(cache);
      bytes.writeBigUInt64LE(2n, versionOffset);
      writeFileSync(cache, bytes, { mode: 0o600 });
    },
  };
  const histories = new Set<string>();
  for (const [name, fault] of Object.entries(faults)) {
    const fixture = createFixture(`lia-history-cache-${name}-`);
    const gateway = startFakeGateway([fakeGatewayFinalText("CACHE_CONTINUED_TURN")]);
    try {
      const [id] = copyV1Fixture(fixture.home, "cancelled");
      fault(join(fixture.home, ".lia", "sessions", id!, "history-cache.bin"));
      const continued = await continueSession(fixture, gateway, id!);
      expect(continued.code).toBe(0);
      expect(withoutConversionNotice(continued.stderr)).toBe("");
      expect(JSON.parse(continued.stdout).output).toBe("CACHE_CONTINUED_TURN");
      expect(gateway.requests[0]!.body).toContain("CONV_FIRST_ANSWER");
      const history = (await savedSession(fixture.home, id!)).history;
      histories.add(JSON.stringify(history.slice(0, -1)));
    } finally {
      gateway.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  expect(histories.size).toBe(1);
}, TIMEOUT);

test("latest resume converts the newest session and leaves an unrelated pending authority directory", async () => {
  const fixture = createFixture("lia-latest-pending-");
  const gateway = startFakeGateway([fakeGatewayFinalText("CONTINUED_PARENT_CONTEXT")]);
  try {
    const ids = copyV1Fixture(fixture.home, "plain", 3, fixture.workspace);
    const orphan = join(fixture.home, ".lia", "sessions", "pending-authority");
    mkdirSync(orphan, { mode: 0o700 });
    writeFileSync(join(orphan, "authority.pending.json"), "pending", { mode: 0o600 });
    writeFileSync(join(orphan, "events.jsonl"), "unidentified saved data\n", { mode: 0o600 });
    const resumed = await continueSession(fixture, gateway, "", true);
    expect(resumed.code).toBe(0);
    expect(withoutConversionNotice(resumed.stderr)).toBe("");
    // The newest of the three, as v0.0.14 would have picked.
    expect(JSON.parse(resumed.stdout).session_id).toBe(ids[2]!);
    expect(gateway.requests.at(-1)?.body).toContain("CONV_FIRST 3");
    expect(readFileSync(join(orphan, "events.jsonl"), "utf8")).toBe("unidentified saved data\n");
    expect(readFileSync(join(orphan, "authority.pending.json"), "utf8")).toBe("pending");
  } finally {
    gateway.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, TIMEOUT);

test("a session converts past a damaged usage file left by an older lia", async () => {
  const fixture = createFixture("lia-accounting-resume-");
  const gateway = startFakeGateway([fakeGatewayFinalText("ACCOUNTING_RESUME_COMPLETED")]);
  try {
    const [id] = copyV1Fixture(fixture.home, "plain");
    writeFileSync(join(fixture.home, ".lia", "sessions", id!, "usage-v2.json"), "{broken accounting", { mode: 0o600 });
    const resumed = await continueSession(fixture, gateway, id!);
    expect(resumed.code).toBe(0);
    expect(withoutConversionNotice(resumed.stderr)).toBe("");
    expect(JSON.parse(resumed.stdout).session_id).toBe(id!);
    expect(gateway.requests.at(-1)?.body).toContain("CONV_FIRST_ANSWER");
    expect((await savedSession(fixture.home, id!)).history_len).toBe(2);
  } finally {
    gateway.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, TIMEOUT);

test("conversation language survives an ordinary saved turn and resume", async () => {
  const fixture = createFixture("lia-language-resume-");
  const gateway = startFakeGateway([
    fakeGatewayFinalText("こんにちは。"),
    fakeGatewayFinalText("完了しました。"),
  ]);
  try {
    const seeded = await runLia(["ask", "--json", "こんにちは。日本語で返答してください。"], {
      cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
    });
    expect(seeded.code).toBe(0);
    const id = JSON.parse(seeded.stdout).session_id;
    expect((await savedSession(fixture.home, id)).conversation_language).toBe("ja");
    const resumed = await runLia(["ask", "--json", "--resume", id, "👍"], {
      cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
    });
    expect(resumed.code).toBe(0);
    expect(resumed.stderr).toBe("");
    expect((await savedSession(fixture.home, id)).conversation_language).toBe("ja");
  } finally {
    gateway.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, TIMEOUT);
const LEGACY_ANSWER = "LEGACY_COMMITTED_ANSWER";
const LEGACY_PARTIAL = "LEGACY_PARTIAL_EVIDENCE";
const LEGACY_TOOL_CALL_ID = "legacy-recorded-read";
const LEGACY_TOOL_EVIDENCE = "LEGACY_TOOL_EVIDENCE";
const LEGACY_GATEWAY_OPTIONS = {
  models: [{
    id: FAKE_GATEWAY_MODEL,
    type: "language",
    tags: ["reasoning", "tool-use"],
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    fast_options: [{ type: "toggle" }],
  }],
};

// Entirely synthetic schema-v3 data: no copied sessions, credentials, or child markers.
function createLegacySession(fixture: ReturnType<typeof createFixture>, version: 2 | 3 | 4) {
  const id = `synthetic-legacy-v${version}`;
  const source = join(fixture.home, ".lia", "sessions", id);
  mkdirSync(source, { recursive: true, mode: 0o700 });
  const generation = "01".repeat(16);
  const authority = "03".repeat(16);
  const preferences = {
    connection_id: "vercel", model_id: FAKE_GATEWAY_MODEL, effort: "high", fast_mode: true,
  };
  const execution = { schema_version: 4, tool_steps: [], files: [] };
  const checkpointExecution = {
    ...execution,
    tool_steps: [{
      assistant: null,
      tool_calls: [{
        id: LEGACY_TOOL_CALL_ID, name: "read_file",
        arguments_json: JSON.stringify({ path: "synthetic-recorded-read.txt" }), provider_result: null,
      }],
      tool_results: [{
        tool_call_id: LEGACY_TOOL_CALL_ID, tool_name: "read_file", status: "success",
        output: LEGACY_TOOL_EVIDENCE, output_handle: null, preview: null,
        output_bytes: Buffer.byteLength(LEGACY_TOOL_EVIDENCE),
        stored_output_bytes: Buffer.byteLength(LEGACY_TOOL_EVIDENCE),
        truncated: false, provider_native: false, created_at_ms: 25, permission_feedback: [],
        committed_file_presentation: null, command_output_replay: null,
        command_process_presentation: null, terminal_action_presentation: null,
      }],
    }],
  };
  const route = {
    connection_id: "vercel", adapter_kind: "vercel_ai_gateway", permission_review_model_id: "",
    ...(version >= 3 ? { vision_model_id: "", subagent_model_id: "" } : {}),
    ...(version === 4 ? {
      version: 1, endpoint: "https://legacy-route.invalid", protocol: "vercel_ai_gateway",
      credential_ref: "synthetic-unusable-credential",
    } : {}),
  };
  const records = [
    { kind: "session_started", payload: {
      id, created_at_ms: 10, origin_workspace_root: fixture.workspace,
      workspace_root: fixture.workspace, conversation_language: "en", preferences,
    } },
    { kind: "history_turn_committed", payload: {
      conversation_language: "en", total_input_tokens: 0, total_output_tokens: 0,
      turn: { kind: "assistant", user: { text: LEGACY_TITLE, images: [] }, assistant: LEGACY_ANSWER, execution },
    } },
    { kind: "recovery_checkpoint_set", payload: { checkpoint: {
      version, route_identity: route, delivery: "possibly_sent", turn_id: 2,
      user: { text: "An interrupted synthetic request", images: [] },
      assistant_source: LEGACY_PARTIAL, execution: checkpointExecution, cause: "response_interrupted",
      action: "continuing_response", tool_state: "confirmed", route_model: FAKE_GATEWAY_MODEL,
      requested_fast_mode: true, fast_mode: true, max_provider_attempts: 3,
      consumed_provider_attempts: 1, outstanding_reservation: false,
    } } },
  ].map((record, index) => ({
    schema_version: 1, log_generation: generation, seq: index + 1,
    event_id: (index + 1).toString(16).padStart(2, "0").repeat(16),
    timestamp_ms: (index + 1) * 10, ...record,
  }));
  const lines = records.map((record) => JSON.stringify(record) + "\n");
  const events = lines.join("");
  const writeJson = (name: string, value: object) => writeFileSync(
    join(source, name), JSON.stringify(value) + "\n", { mode: 0o600 },
  );
  writeFileSync(join(source, "events.jsonl"), events, { mode: 0o600 });
  writeJson("authority.json", {
    schema_version: 1, storage_format: "event_log_v1", session_id: id,
    authority_id: authority, source: "native_create",
  });
  writeJson("session.json", {
    schema_version: 3, storage_format: "event_log_v1", id, authority_id: authority,
    log_generation: generation, created_at_ms: 10, updated_at_ms: 30,
    origin_workspace_root: fixture.workspace, workspace_root: fixture.workspace,
    conversation_language: "en", history_len: 1, total_input_tokens: 0, total_output_tokens: 0,
    last_event_seq: records.length, event_log_bytes: Buffer.byteLength(events),
    event_log_stat_fingerprint: "00".repeat(32), generation_base_seq: 1,
    generation_base_bytes: Buffer.byteLength(lines[0]!), checkpoint_seq: null,
    checkpoint_sha256: null, preferences,
  });
  const watermarkPath = join(source, `commit.${generation}.json`);
  writeJson(`commit.${generation}.json`, {
    schema_version: 1, session_id: id, log_generation: generation,
    through_seq: records.length, through_event_id: records.at(-1)!.event_id,
    through_event_log_bytes: Buffer.byteLength(events),
  });
  writeJson("display.json", {
    schema_version: 1, title: LEGACY_TITLE, preview: null, origin_workspace_root: fixture.workspace,
  });
  writeFileSync(join(fixture.home, ".lia", "settings.json"), JSON.stringify({
    model: "workspace/default", effort: "low", fast_mode: false, auto_upgrade: false,
  }), { mode: 0o600 });
  return { id, source, watermarkPath };
}

function legacyGatewayEnv(
  fixture: ReturnType<typeof createFixture>,
  gateway: ReturnType<typeof startFakeGateway>,
) {
  return {
    ...gatewayEnv(fixture, gateway), LIA_MODEL: undefined, LIA_EFFORT: undefined,
    LIA_FAST_MODE: undefined, LIA_TEST_GATEWAY_MODELS_URL: `${gateway.baseUrl}/coding-agent/v1/models`,
    LIA_TRACE_LOG: join(fixture.root, "legacy.trace.log"), LIA_TRACE_SCOPES: "tool,session,agent",
  };
}

// What the converter saved for the synthetic legacy session: the committed
// answer, the interrupted reply once with the tool call it recorded, and
// nothing of the old route.
async function expectLegacyConverted(home: string, id: string) {
  const history = (await savedSession(home, id)).history;
  expect(history[0]).toMatchObject({ kind: "assistant", assistant: LEGACY_ANSWER });
  const interrupted = history.filter((turn: any) => turn.kind === "interrupted" && turn.assistant === LEGACY_PARTIAL);
  expect(interrupted).toHaveLength(1);
  const steps = interrupted[0].execution.tool_steps;
  expect(steps).toHaveLength(1);
  expect(steps[0].tool_calls).toEqual([{
    id: LEGACY_TOOL_CALL_ID, name: "read_file",
    arguments_json: JSON.stringify({ path: "synthetic-recorded-read.txt" }), provider_result: null,
  }]);
  // The exact retained bytes come back, but legacy completeness is not trusted.
  expect(steps[0].tool_results).toHaveLength(1);
  expect(steps[0].tool_results[0]).toMatchObject({
    tool_call_id: LEGACY_TOOL_CALL_ID, tool_name: "read_file", status: "success", truncated: true,
    output_bytes: Buffer.byteLength(LEGACY_TOOL_EVIDENCE),
    stored_output_bytes: Buffer.byteLength(LEGACY_TOOL_EVIDENCE), preview: LEGACY_TOOL_EVIDENCE,
  });
  const blobs = join(sessionDir(home, id), "blobs");
  expect(readdirSync(blobs).some((hash) => readFileSync(join(blobs, hash), "utf8") === LEGACY_TOOL_EVIDENCE)).toBe(true);
  const text = savedText(home, id);
  expect(text.split(LEGACY_PARTIAL)).toHaveLength(2);
  expect(text).not.toContain("route_identity");
  expect(text).not.toContain("synthetic-unusable-credential");
  expect(text).not.toContain("legacy-route.invalid");
}

function expectLegacyRequest(request: { body: string; headers: Headers }) {
  expect(request.headers.get("ai-language-model-id")).toBe(FAKE_GATEWAY_MODEL);
  expect(JSON.parse(request.body)).toMatchObject({
    reasoning: "high", providerOptions: { gateway: { speed: "fast" } },
  });
  expect(request.body).toContain(LEGACY_ANSWER);
  expect(request.body).toContain(LEGACY_TOOL_EVIDENCE);
  expect(request.body.split(LEGACY_PARTIAL)).toHaveLength(2);
  expect(request.body).not.toContain("synthetic-unusable-credential");
  expect(request.body).not.toContain("legacy-route.invalid");
}

describe("session recovery", () => {

  test("recover leaves a whole session alone and copies one whose saved rules can't be read without them", async () => {
    const fixture = createFixture("lia-session-current-healthy-");
    const gateway = startFakeGateway([]);
    try {
      const [id] = copyV1Fixture(fixture.home, "rules");
      const source = join(fixture.home, ".lia", "sessions", id!);
      const before = savedFileHashes(source);
      const result = await runLia(["session", "recover", id!, "--json"], {
        cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).code).toBe("SessionRecoveryNotNeeded");
      expect(savedFileHashes(source)).toEqual(before);
      expect(readdirSync(join(fixture.home, ".lia", "sessions"))).toEqual([id!]);
      expect(gateway.requests).toHaveLength(0);
      // A conversation that only its saved rules keep from converting is
      // copied without them (D72), and v1's folder stays as it was.
      async function expectCopiedWithoutRules() {
        const damaged = savedFileHashes(source);
        const copied = await runLia(["session", "recover", id!, "--json"], {
          cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        expect(copied.code).toBe(0);
        expect(copied.stderr).toBe("");
        const result = JSON.parse(copied.stdout);
        expect(result).toMatchObject({
          kind: "session_recovery", source_id: id, status: "recovered", history_turns: 1, permission_rules_dropped: true,
        });
        expect(result.recovered_id).not.toBe(id);
        expect(savedFileHashes(source)).toEqual(damaged);
        expect((await savedSession(fixture.home, result.recovered_id)).history_len).toBe(1);
        expect(gateway.requests).toHaveLength(0);
      }
      const permissionPath = join(source, "permissions.json");
      writeFileSync(permissionPath, "{broken", { mode: 0o600 });
      await expectCopiedWithoutRules();
      writeFileSync(permissionPath, "", { mode: 0o600 });
      await expectCopiedWithoutRules();
    } finally {
      gateway.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  for (const { checkpointedTurn, fullCoverage } of [
    { checkpointedTurn: false, fullCoverage: false },
    { checkpointedTurn: true, fullCoverage: false },
    { checkpointedTurn: false, fullCoverage: true },
  ]) {
    test(`current conversation recovery preserves exact checkpoints and artifacts with open=${checkpointedTurn} full coverage=${fullCoverage}`, async () => {
      const fixture = createFixture("lia-session-current-copy-");
      const responses: Response[] = [];
      const gateway = startFakeGateway(responses);
      try {
        // One saved command result, under tool-results/ and logs/commands/.
        const [id] = copyV1Fixture(fixture.home, "side");
        const source = join(fixture.home, ".lia", "sessions", id!);
        const eventPath = join(source, "events.jsonl");
        const metadataPath = join(source, "session.json");
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        metadata.title = "Recovered work keeps its chosen title";
        writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
        const records = readFileSync(eventPath, "utf8").trimEnd().split("\n").map(JSON.parse);
        if (fullCoverage) records[0].event.user.work_id = "covered-recovery-work";
        const stored = records.find((record) => record.event.tool_result).event.tool_result;
        const coverage = fullCoverage ? records[records.length - 1].seq : 1;
        const append = (event: object) => records.push({
          schema_version: 1, seq: records.length + 1, timestamp_ms: Date.now(), event,
        });
        append({ context_checkpoint: { covers_through_seq: coverage, summary: "<context_handoff>Saved command completed.</context_handoff>" } });
        append({ context_checkpoint: { covers_through_seq: coverage, summary: "<context_handoff>Retain the completed command and its result.</context_handoff>" } });
        if (checkpointedTurn) {
          append({ user: { text: "Keep the already completed stored read.", work_id: "checkpointed-recovery-work" } });
          append({ tool_call: { call_id: "checkpointed-read", tool_name: "read_tool_result", arguments_json: JSON.stringify({ handle: stored.artifact_ref }) } });
          append({ tool_result: { ...stored, call_id: "checkpointed-read", tool_name: "read_tool_result" } });
          append({ context_checkpoint: { covers_through_seq: 1, summary: "<context_handoff>Checkpointed read is already complete.</context_handoff>" } });
        }
        const prefix = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
        writeFileSync(eventPath, prefix + "invalid CORRUPT_TAIL_MUST_NOT_REPLAY\n", { mode: 0o600 });
        const before = savedFileHashes(source);
        const recovered = await runLia(["session", "recover", id!, "--json"], {
          cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        expect(recovered.code).toBe(0);
        expect(recovered.stderr).toBe("");
        const result = JSON.parse(recovered.stdout);
        expect(result).toMatchObject({ kind: "session_recovery", source_id: id, status: "recovered", permission_rules_dropped: false });
        expect(result.recovered_id).not.toBe(id);
        expect(gateway.requests).toHaveLength(0);
        expect(savedFileHashes(source)).toEqual(before);
        // The copy keeps the title, the good turns and the newest summary, but
        // not the damaged tail; an open turn the checkpoint saw ends
        // interrupted.
        const text = savedText(fixture.home, result.recovered_id);
        expect(text).toContain(metadata.title);
        expect(text).toContain("Retain the completed command and its result.");
        expect(text).not.toContain("CORRUPT_TAIL_MUST_NOT_REPLAY");
        const history = (await savedSession(fixture.home, result.recovered_id)).history;
        expect(history.at(-1).kind === "interrupted").toBe(checkpointedTurn);
        // Every side file comes along byte for byte.
        const blobs = join(sessionDir(fixture.home, result.recovered_id), "blobs");
        const copied = new Set(readdirSync(blobs).map((hash) => createHash("sha256").update(readFileSync(join(blobs, hash))).digest("hex")));
        for (const [path, digest] of Object.entries(before)) {
          if (path.startsWith("tool-results/") || path.startsWith("logs/commands/")) expect(copied.has(digest)).toBe(true);
        }

        responses.push(
          fakeGatewayToolCall("read-recovered", "read_tool_result", { request: { handle: stored.artifact_ref, query: "12760" } }),
          fakeGatewayFinalText("RECOVERED_CONTINUATION_SAVED"),
        );
        const tracePath = join(fixture.root, "continue.trace.log");
        const continued = await runLia(["ask", "--json", "--full-access", "--resume", result.recovered_id, "Read the retained result. Do not repeat completed commands."], {
          cwd: fixture.workspace,
          env: { ...gatewayEnv(fixture, gateway), LIA_TRACE_LOG: tracePath, LIA_TRACE_SCOPES: "tool,session,agent" },
          timeoutMs: TIMEOUT,
        });
        expect(continued.code).toBe(0);
        expect(JSON.parse(continued.stdout)).toMatchObject({ output: "RECOVERED_CONTINUATION_SAVED", tool_calls: [{ name: "read_tool_result", status: "success" }] });
        expect(gateway.requests).toHaveLength(2);
        // Only the read ran; the saved command did not run again.
        const executionStarts = readFileSync(tracePath, "utf8").split("\n")
          .filter((line) => line.includes("[tool] event=execution_start "));
        expect(executionStarts).toHaveLength(1);
        expect(executionStarts[0]).toContain("call_id=read-recovered name=read_tool_result");
        const read = savedToolResults((await savedSession(fixture.home, result.recovered_id)).history)
          .find((entry) => entry.tool_call_id === "read-recovered");
        expect(read?.status).toBe("success");
        expect(read?.output).toContain("12760");
        expect(savedFileHashes(source)).toEqual(before);
        const inspected = await runLia(["session", "--id", result.recovered_id, "--json"], {
          cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        expect(inspected.code).toBe(0);
        expect(inspected.stderr).toBe("");
        expect(inspected.stdout).toContain("RECOVERED_CONTINUATION_SAVED");
      } finally {
        gateway.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  for (const tail of ["", "invalid tail\n"]) {
    test(`current recovery excludes checkpoint splitting a call/result pair with tail=${tail.length > 0}`, async () => {
      const fixture = createFixture("lia-session-current-cut-");
      const responses: Response[] = [];
      const gateway = startFakeGateway(responses);
      try {
        const [id] = copyV1Fixture(fixture.home, "side");
        const source = join(fixture.home, ".lia", "sessions", id!);
        const eventPath = join(source, "events.jsonl");
        const prefix = readFileSync(eventPath, "utf8");
        const records = prefix.trimEnd().split("\n").map(JSON.parse);
        const callSeq = records.find((record) => record.event.tool_call).seq;
        appendFileSync(eventPath, JSON.stringify({ schema_version: 1, seq: records.at(-1).seq + 1, timestamp_ms: Date.now(), event: {
          context_checkpoint: { covers_through_seq: callSeq, summary: "INVALID_SPLIT_CHECKPOINT" },
        } }) + "\n" + tail);
        const before = savedFileHashes(source);
        const recovered = await runLia(["session", "recover", id!, "--json"], {
          cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        if (!tail) {
          // Nothing else is damaged, so the session converts as it is (D75):
          // the summary covers the whole first turn, call and result alike.
          expect(recovered.code).toBe(1);
          expect(JSON.parse(recovered.stdout).code).toBe("SessionRecoveryNotNeeded");
          expect(savedFileHashes(source)).toEqual(before);
          responses.push(fakeGatewayFinalText("CUT_CONTINUED"));
          const converted = await continueSession(fixture, gateway, id!);
          expect(converted.code).toBe(0);
          expect(JSON.parse(converted.stdout).output).toBe("CUT_CONTINUED");
          // The model gets the summary, then the whole first turn: its call
          // always with its result.
          const prompt = JSON.parse(gateway.requests[0]!.body).prompt.filter((message: any) => message.role !== "system");
          expect(JSON.stringify(prompt[0].content)).toContain("INVALID_SPLIT_CHECKPOINT");
          expect(prompt.slice(1).map((message: any) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
          return;
        }
        expect(recovered.code).toBe(0);
        expect(recovered.stderr).toBe("");
        const result = JSON.parse(recovered.stdout);
        expect(result.status).toBe("recovered");
        // The copy is the turn before the checkpoint, which it leaves out.
        expect((await savedSession(fixture.home, result.recovered_id)).history_len).toBe(1);
        expect(savedText(fixture.home, result.recovered_id)).not.toContain("INVALID_SPLIT_CHECKPOINT");
        expect(savedFileHashes(source)).toEqual(before);
        const inspected = await runLia(["session", "--id", result.recovered_id, "--json"], {
          cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        expect(inspected.code).toBe(0);
        expect(inspected.stderr).toBe("");
        expect(inspected.stdout).toContain("CONV_CALLS_DONE");
        responses.push(fakeGatewayFinalText("CUT_CONTINUED"));
        const continued = await continueSession(fixture, gateway, result.recovered_id);
        expect(continued.code).toBe(0);
        expect(JSON.parse(continued.stdout).output).toBe("CUT_CONTINUED");
        expect(gateway.requests).toHaveLength(1);
        expect(savedFileHashes(source)).toEqual(before);
      } finally {
        gateway.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  for (const damage of ["missing-result", "changed-result"] as const) {
    test(`current conversation recovery copies past a ${damage} and says it could not verify it`, async () => {
      const fixture = createFixture("lia-session-current-unverified-");
      const gateway = startFakeGateway([fakeGatewayFinalText("UNVERIFIED_CONTINUED")]);
      try {
        const [id] = copyV1Fixture(fixture.home, "side");
        const source = join(fixture.home, ".lia", "sessions", id!);
        appendFileSync(join(source, "events.jsonl"), "invalid tail\n");
        const [artifact] = readdirSync(join(source, "tool-results"));
        const artifactPath = join(source, "tool-results", artifact!);
        if (damage === "missing-result") rmSync(artifactPath);
        else {
          const bytes = readFileSync(artifactPath);
          bytes[0] ^= 1;
          writeFileSync(artifactPath, bytes);
        }
        const before = savedFileHashes(source);
        const recovered = await runLia(["session", "recover", id!, "--json"], {
          cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        // The conversation is copied without that file, and recover says so
        // with its partial-recovery exit (D74); v1 refused the whole recovery.
        expect(recovered.code).toBe(1);
        expect(recovered.stderr).toBe("");
        const result = JSON.parse(recovered.stdout);
        expect(result).toMatchObject({ kind: "session_recovery", source_id: id, status: "recovered_with_unverified_artifacts" });
        expect(savedFileHashes(source)).toEqual(before);
        const continued = await runLia(["ask", "--json", "--resume", result.recovered_id, "What did the command print?"], {
          cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        expect(continued.code).toBe(0);
        expect(gateway.requests[0]!.body).toContain("Saved tool-result content is unavailable.");
        expect(gateway.requests).toHaveLength(1);
      } finally {
        gateway.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  for (const damage of ["metadata", "private-child", "private-marker", "first-record"] as const) {
    test(`current conversation recovery refuses ${damage} without publishing a copy`, async () => {
      const fixture = createFixture("lia-session-current-refusal-");
      const gateway = startFakeGateway([]);
      try {
        const [id] = copyV1Fixture(fixture.home, "side");
        const source = join(fixture.home, ".lia", "sessions", id!);
        const eventPath = join(source, "events.jsonl");
        const committed = readFileSync(eventPath, "utf8");
        if (damage === "metadata" || damage === "private-child") {
          const metadataPath = join(source, "session.json");
          const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
          if (damage === "metadata") metadata.id = "different-session";
          else metadata.subagent_child = true;
          writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
        } else if (damage === "private-marker") {
          mkdirSync(join(source, "subagent"), { recursive: true, mode: 0o700 });
          writeFileSync(join(source, "subagent", "owner.json"), "{}", { mode: 0o600 });
          appendFileSync(eventPath, "invalid tail\n");
        } else if (damage === "first-record") {
          writeFileSync(eventPath, "[" + committed.slice(1), { mode: 0o600 });
        } else {
          appendFileSync(eventPath, "invalid tail\n");
          const record = committed.trimEnd().split("\n").map(JSON.parse)
            .find((frame) => frame.event.tool_result).event.tool_result;
          const artifactPath = join(source, "tool-results", record.artifact_ref);
          if (damage === "missing-result") rmSync(artifactPath);
          else {
            const bytes = readFileSync(artifactPath);
            bytes[0] ^= 1;
            writeFileSync(artifactPath, bytes);
          }
        }
        const before = savedFileHashes(source);
        const result = await runLia(["session", "recover", id!, "--json"], {
          cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout).code).toBe(damage === "private-child" || damage === "private-marker" ? "SessionNotFound" : "SessionRecoveryBoundaryInvalid");
        expect(savedFileHashes(source)).toEqual(before);
        const sessionRoot = join(fixture.home, ".lia", "sessions");
        expect(readdirSync(sessionRoot).filter((name) => existsSync(join(sessionRoot, name, "session.json")))).toEqual([id!]);
        // No copy was published.
        expect(existsSync(storeRoot(fixture.home)) ? savedSessionIds(fixture.home) : []).toEqual([]);
        expect(gateway.requests).toHaveLength(0);
      } finally {
        gateway.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }


  for (const { version, entry } of [
    { version: 2, entry: "-r" },
    { version: 3, entry: "/resume" },
    { version: 4, entry: "--resume id" },
  ] as const) {
  }

  test("legacy ask resume fails closed at a bad watermark then preserves archived evidence on retry", async () => {
    const fixture = createFixture("lia-legacy-ask-recovery-");
    const legacy = createLegacySession(fixture, 4);
    const gateway = startFakeGateway([
      fakeGatewayFinalText("LEGACY_ASK_SAVED"),
      fakeGatewayFinalText("LEGACY_ASK_REOPEN_SAVED"),
    ], LEGACY_GATEWAY_OPTIONS);
    try {
      const watermark = readFileSync(legacy.watermarkPath, "utf8");
      writeFileSync(legacy.watermarkPath, JSON.stringify({
        ...JSON.parse(watermark), through_event_log_bytes: Buffer.byteLength(readFileSync(join(legacy.source, "events.jsonl"))) - 1,
      }));
      const before = savedFileHashes(legacy.source);
      const failed = await runLia(["ask", "--json", "--auto", "--resume", legacy.id, "Do not run with invalid history."], {
        cwd: fixture.workspace, env: legacyGatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
      });
      expect(failed.timedOut).toBe(false);
      expect(failed.code).toBe(1);
      expect(gateway.requests).toHaveLength(0);
      expect(gateway.classifierRequests).toHaveLength(0);
      expect(savedFileHashes(legacy.source)).toEqual(before);
      expect(readdirSync(join(fixture.home, ".lia", "sessions"))).toEqual([legacy.id]);
      writeFileSync(legacy.watermarkPath, watermark);

      for (const [index, args] of [["--resume", legacy.id], ["--resume", "last"]].entries()) {
        const result = await runLia(["ask", "--json", "--auto", ...args, "Continue the synthetic saved conversation."], {
          cwd: fixture.workspace, env: legacyGatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        expect(result.code).toBe(0);
        expect(withoutConversionNotice(result.stderr)).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          session_id: legacy.id, model: FAKE_GATEWAY_MODEL, tool_calls: [],
          output: index === 0 ? "LEGACY_ASK_SAVED" : "LEGACY_ASK_REOPEN_SAVED",
        });
        expect(gateway.requests).toHaveLength(index + 1);
        expectLegacyRequest(gateway.requests[index]!);
        await expectLegacyConverted(fixture.home, legacy.id);
      }
      expect(gateway.requests[1]!.body).toContain("LEGACY_ASK_SAVED");
      expect(readFileSync(join(fixture.root, "legacy.trace.log"), "utf8"))
        .not.toContain("[tool] event=execution_start ");
    } finally {
      gateway.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT * 2);

  for (const kind of ["recovery_checkpoint_cleared", "history_turn_committed"] as const) {
    test(`legacy ask resume does not resurrect a checkpoint superseded by ${kind}`, async () => {
      const fixture = createFixture("lia-legacy-checkpoint-superseded-");
      const legacy = createLegacySession(fixture, 4);
      const gateway = startFakeGateway([fakeGatewayFinalText("SUPERSESSION_ASK_SAVED")], LEGACY_GATEWAY_OPTIONS);
      try {
        const eventsPath = join(legacy.source, "events.jsonl");
        const events = readFileSync(eventsPath, "utf8");
        const records = events.trimEnd().split("\n").map(JSON.parse);
        const watermark = JSON.parse(readFileSync(legacy.watermarkPath, "utf8"));
        const supersedingAnswer = "LEGACY_SUPERSEDING_ANSWER";
        const event = {
          schema_version: 1, log_generation: watermark.log_generation,
          seq: watermark.through_seq + 1, event_id: "04".repeat(16), timestamp_ms: 40, kind,
          payload: kind === "recovery_checkpoint_cleared" ? {} : {
            ...records[1].payload,
            turn: {
              ...records[1].payload.turn,
              user: records[2].payload.checkpoint.user,
              assistant: supersedingAnswer,
            },
          },
        };
        const appended = JSON.stringify(event) + "\n";
        appendFileSync(eventsPath, appended);
        // Leave the derived manifest stale; the committed watermark owns the replay boundary.
        writeFileSync(legacy.watermarkPath, JSON.stringify({
          ...watermark, through_seq: event.seq, through_event_id: event.event_id,
          through_event_log_bytes: Buffer.byteLength(events + appended),
        }) + "\n");

        expect(gateway.requests).toHaveLength(0);
        const prompt = "Continue after the superseding legacy event.";
        const result = await runLia(["ask", "--json", "--auto", "--resume", legacy.id, prompt], {
          cwd: fixture.workspace, env: legacyGatewayEnv(fixture, gateway), timeoutMs: TIMEOUT,
        });
        expect(result.code).toBe(0);
        expect(withoutConversionNotice(result.stderr)).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          session_id: legacy.id, output: "SUPERSESSION_ASK_SAVED", tool_calls: [],
        });
        expect(gateway.requests).toHaveLength(1);
        expect(gateway.classifierRequests).toHaveLength(0);
        const request = gateway.requests[0]!.body;
        expect(request).toContain(prompt);
        expect(request).toContain(LEGACY_ANSWER);
        expect(request).not.toContain(LEGACY_PARTIAL);
        expect(request).not.toContain(LEGACY_TOOL_EVIDENCE);
        const migrated = savedText(fixture.home, legacy.id);
        expect(migrated).toContain(LEGACY_ANSWER);
        expect(migrated).toContain("SUPERSESSION_ASK_SAVED");
        expect(migrated).not.toContain(LEGACY_PARTIAL);
        expect(migrated).not.toContain(LEGACY_TOOL_CALL_ID);
        expect(migrated).not.toContain(LEGACY_TOOL_EVIDENCE);
        expect((await savedSession(fixture.home, legacy.id)).history.filter((turn: any) => turn.kind === "interrupted"))
          .toHaveLength(0);
        if (kind === "history_turn_committed") {
          expect(request).toContain(supersedingAnswer);
          expect(migrated).toContain(supersedingAnswer);
        }
        expect(readFileSync(join(fixture.root, "legacy.trace.log"), "utf8"))
          .not.toContain("[tool] event=execution_start ");
      } finally {
        gateway.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  for (const { target, fileName, fenced } of [
    { target: "event log", fileName: "events.jsonl", fenced: false },
    { target: "fenced legacy snapshot", fileName: "session.legacy.json", fenced: true },
  ]) {
    test.skipIf(process.platform === "win32")(`ask resume last rejects a FIFO ${target} promptly without writes`, async () => {
      const fixture = createFixture("lia-session-fifo-");
      const gateway = startFakeGateway([]);
      try {
        const id = fenced ? "fenced-legacy-fifo" : copyV1Fixture(fixture.home, "plain", 1, fixture.workspace)[0]!;
        const source = join(fixture.home, ".lia", "sessions", id);
        if (fenced) {
          mkdirSync(source, { recursive: true, mode: 0o700 });
          const snapshot = JSON.stringify({
            schema_version: 1, id, created_at_ms: 1, updated_at_ms: Date.now(),
            workspace_root: fixture.workspace, conversation_language: "en", history_len: 0, history: [],
          });
          writeFileSync(join(source, "session.json"), snapshot, { mode: 0o600 });
          writeFileSync(join(source, "session.legacy.json"), snapshot, { mode: 0o600 });
          writeFileSync(join(source, "authority.pending.json"), "pending", { mode: 0o600 });
        }
        const fifoPath = join(source, fileName);
        const before = savedFileHashes(source);
        delete before[fileName];
        rmSync(fifoPath);
        execFileSync("mkfifo", ["-m", "600", fifoPath]);
        const fifoBefore = lstatSync(fifoPath);
        expect(fifoBefore.isFIFO()).toBe(true);
        const namesBefore = readdirSync(source, { recursive: true }).sort();
        const result = await runLia(["ask", "--json", "--auto", "--resume", "last", "Never open the FIFO."], {
          cwd: fixture.workspace, env: gatewayEnv(fixture, gateway), timeoutMs: 5_000,
        });
        expect(result.timedOut).toBe(false);
        expect(result.killSent).toBe(false);
        expect(result.code).toBe(1);
        expect(result.elapsedMs).toBeLessThan(5_000);
        // The unreadable session is skipped exactly as every listing skips it,
        // and the error says unreadable sessions exist, as `lia session last` does.
        expect(result.stdout + result.stderr).toContain("NoReadableSessions");
        expect(gateway.requests).toHaveLength(0);
        expect(gateway.classifierRequests).toHaveLength(0);
        expect(readdirSync(source, { recursive: true }).sort()).toEqual(namesBefore);
        const fifoAfter = lstatSync(fifoPath);
        expect(fifoAfter.isFIFO()).toBe(true);
        expect([fifoAfter.ino, fifoAfter.size, fifoAfter.mtimeMs, fifoAfter.ctimeMs])
          .toEqual([fifoBefore.ino, fifoBefore.size, fifoBefore.mtimeMs, fifoBefore.ctimeMs]);
        // Never hash/read the FIFO: retain the regular-file and directory evidence separately.
        for (const [path, digest] of Object.entries(before)) {
          expect(createHash("sha256").update(readFileSync(join(source, path))).digest("hex")).toBe(digest);
        }
        // Only the new store's folder may appear beside the untouched session,
        // and it holds no session.
        expect(readdirSync(join(fixture.home, ".lia", "sessions")).filter((name) => name !== "v2"))
          .toEqual([id]);
        expect(existsSync(storeRoot(fixture.home)) ? savedSessionIds(fixture.home) : []).toEqual([]);
      } finally {
        gateway.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  test("latest resume discovers and repairs a partial final JSONL record", async () => {
    const fixture = createFixture("lia-session-partial-record-");
    const gateway = startFakeGateway([fakeGatewayFinalText("PARTIAL_RECORD_RECOVERED")]);
    try {
      const [sessionId] = copyV1Fixture(fixture.home, "plain", 1, fixture.workspace) as [string];
      const eventsPath = join(fixture.home, ".lia", "sessions", sessionId, "events.jsonl");
      const committed = readFileSync(eventsPath, "utf8");
      appendFileSync(eventsPath, '{"schema_version":1,"partial-tail"');

      const listed = await runLia(["sessions", "--json"], {
        cwd: fixture.workspace,
        env: gatewayEnv(fixture, gateway),
        timeoutMs: TIMEOUT,
      });
      expect(listed.code).toBe(0);
      expect(listed.stderr).toBe("");
      expect(JSON.parse(listed.stdout).sessions.map((entry: { id: string }) => entry.id))
        .toContain(sessionId);
      expect(readFileSync(eventsPath, "utf8")).toBe(committed + '{"schema_version":1,"partial-tail"');

      const resumed = await continueSession(fixture, gateway, sessionId, true);
      expect(resumed.code).toBe(0);
      expect(withoutConversionNotice(resumed.stderr)).toBe("");
      expect(JSON.parse(resumed.stdout).session_id).toBe(sessionId);
      expect(JSON.parse(resumed.stdout).output).toBe("PARTIAL_RECORD_RECOVERED");
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]!.body).toContain("CONV_FIRST_ANSWER");
      expect(gateway.requests[0]!.body).not.toContain("partial-tail");
      // The torn line goes as v1's repair dropped it; the turn before stays.
      expect(savedText(fixture.home, sessionId)).not.toContain("partial-tail");
      expect((await savedSession(fixture.home, sessionId)).history_len).toBe(2);
    } finally {
      gateway.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  for (const partialNextRecord of [false, true]) {
    test(`an unfinished last turn converts as interrupted with partial next record=${partialNextRecord}`, async () => {
      const fixture = createFixture("lia-session-unfinished-turn-");
      const gateway = startFakeGateway([fakeGatewayFinalText("UNFINISHED_TURN_RECOVERED")]);
      try {
        const [sessionId] = copyV1Fixture(fixture.home, "plain") as [string];
        const eventsPath = join(
          fixture.home,
          ".lia",
          "sessions",
          sessionId,
          "events.jsonl",
        );
        const committed = readFileSync(eventsPath, "utf8");
        const lines = committed.trimEnd().split("\n");
        const last = JSON.parse(lines[lines.length - 1]!);
        appendFileSync(eventsPath, JSON.stringify({
          schema_version: 1,
          seq: last.seq + 1,
          timestamp_ms: Date.now(),
          event: {
            user: {
              text: "DANGLING_USER_MUST_NOT_REPLAY",
              images: [],
              work_id: null,
            },
          },
        }) + "\n");
        if (partialNextRecord) appendFileSync(eventsPath, '{"schema_version":1,"event":');

        const resumed = await continueSession(fixture, gateway, sessionId);
        expect(resumed.code).toBe(0);
        expect(withoutConversionNotice(resumed.stderr)).toBe("");
        expect(JSON.parse(resumed.stdout).output).toBe("UNFINISHED_TURN_RECOVERED");
        expect(gateway.requests).toHaveLength(1);
        // The unanswered prompt stays, as an interrupted turn (D1, D77);
        // v1 discarded it. A torn record after it goes.
        const history = (await savedSession(fixture.home, sessionId)).history;
        expect(history.map((turn: any) => turn.kind)).toEqual(["assistant", "interrupted", "assistant"]);
        expect(history[1].user.text).toBe("DANGLING_USER_MUST_NOT_REPLAY");
        expect(gateway.requests[0]!.body).toContain("DANGLING_USER_MUST_NOT_REPLAY");
        expect(savedText(fixture.home, sessionId)).not.toContain('{"schema_version":1,"event":');
      } finally {
        gateway.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  test.each(["malformed", "oversized", "unreadable"])("committed-history corruption (%s) fails closed without rewriting JSONL and points at doctor", async (fault) => {
    const fixture = createFixture("lia-session-middle-corruption-");
    const gateway = startFakeGateway([]);
    try {
      const [sessionId] = copyV1Fixture(fixture.home, "plain") as [string];
      const eventsPath = join(
        fixture.home,
        ".lia",
        "sessions",
        sessionId,
        "events.jsonl",
      );
      const committed = readFileSync(eventsPath, "utf8");
      const corrupted = fault === "malformed"
        ? `[${committed.slice(1)}`
        : fault === "oversized" ? "x".repeat(64 * 1024 * 1024 + 1) + "\n" : committed;
      writeFileSync(eventsPath, corrupted, { mode: 0o600 });
      if (fault === "unreadable") chmodSync(eventsPath, 0);

      const detail = await runLia(
        ["session", "--id", sessionId, "--json"],
        {
          cwd: fixture.workspace,
          env: { HOME: fixture.home },
          timeoutMs: TIMEOUT,
        },
      );
      expect(detail.code).toBe(1);
      expect(detail.stderr).toBe("");
      // The damage is named, and doctor says what can be done (D78).
      const failure = JSON.parse(detail.stdout);
      expect(failure.code).toBe("InvalidSessionFormat");
      expect(failure.error).toContain(`session ${sessionId} can't be read: `);
      expect(failure.error).toContain("run `lia doctor`");
      if (fault === "unreadable") chmodSync(eventsPath, 0o600);
      expect(readFileSync(eventsPath, "utf8")).toBe(corrupted);
      expect(gateway.requests).toHaveLength(0);
    } finally {
      gateway.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
