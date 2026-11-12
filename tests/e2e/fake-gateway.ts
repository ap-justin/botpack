import { existsSync } from "node:fs";

export const FAKE_GATEWAY_MODEL = "openai/gpt-5";

// The issuer a sign-in reaches when no test named one: a loopback server that
// refuses every request and records its paths, so a test can tell this issuer
// from an unreachable vercel.com. It is unref'd, so it never keeps a process alive.
const guardIssuerPaths: string[] = [];
let guardIssuer: ReturnType<typeof Bun.serve> | undefined;

export function guardIssuerUrl(): string {
  guardIssuer ??= Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      guardIssuerPaths.push(new URL(request.url).pathname);
      return new Response("sign-in issuer not configured for this test", { status: 503 });
    },
  });
  guardIssuer.unref();
  return `http://127.0.0.1:${guardIssuer.port}`;
}

// The paths the guard issuer has been asked for, in order.
export function guardIssuerRequests(): readonly string[] {
  return guardIssuerPaths;
}

// The bare http origin with a port that the product accepts as a test issuer
// (isLoopbackHttpUrl in src/core/auth/oauth_session.zig).
function isLoopbackUrl(value: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(value);
}

// The environment for any test spawn of `lia acp`, so that no test can reach vercel.com.
// A sign-in that no test pointed at a fake issuer fails on the guard issuer's refusal and opens no
// browser. A loopback issuer a test sets stays; a missing, `undefined` or non-loopback one
// becomes the guard issuer. `env` overrides `base` (the process environment).
export function acpSpawnEnv(
  env: Record<string, string | undefined> = {},
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const merged = { ...base, ...env };
  const issuer = merged.LIA_TEST_OAUTH_ISSUER_URL;
  if (!issuer || !isLoopbackUrl(issuer)) merged.LIA_TEST_OAUTH_ISSUER_URL = guardIssuerUrl();
  if (!merged.LIA_NO_OPEN_BROWSER) merged.LIA_NO_OPEN_BROWSER = "1";
  return merged;
}

export function terminalFixtureShell(): string {
  for (const path of ["/bin/zsh", "/bin/bash"]) {
    if (existsSync(path)) return path;
  }
  throw new Error("terminal fixtures require Bash or zsh");
}

export function fakeGatewaySse(events: object[]) {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function fakeGatewayToolCall(
  id: string,
  name: string,
  input: object,
) {
  return fakeGatewaySse([
    {
      type: "tool-call",
      toolCallId: id,
      toolName: name,
      input,
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
    },
  ]);
}

export function fakeShellRun(
  id: string,
  command: string,
  options: Record<string, unknown> = {},
) {
  return fakeGatewayToolCall(id, "shell", {
    request: {
      yield_time_ms: 30_000,
      ...options,
      action: "run",
      command,
    },
  });
}

// Marks a fake review decision that lia will hold, without reading its stream.
const HELD_REVIEW_HEADER = "x-fake-review-held";

// A caution without `evidence` reaches lia as an unproven caution, which lia
// clears. Use fakeGatewayHeldDecision for a review that must hold the action.
export function fakeGatewayPermissionDecision(
  decision: "clear" | "caution" = "clear",
  toolCallId = "permission_decision_1",
  rationale = "test fixture",
  evidence?: string,
  category: "prompt_injection" | "system_harm" = "system_harm",
) {
  const response = fakeGatewayToolCall(toolCallId, "permission_decision", {
    risk: decision === "clear" ? "low" : "high",
    decision,
    rationale,
    ...(evidence === undefined ? {} : { category, evidence }),
  });
  if (decision === "caution" && evidence !== undefined) response.headers.set(HELD_REVIEW_HEADER, "1");
  return response;
}

// lia holds an action only when the review names a harm and quotes evidence
// found in the pending action, so this answers with a system-harm caution
// that quotes the action line of the review request it receives.
export function fakeGatewayHeldDecision(
  toolCallId = "permission_decision_1",
  rationale = "test fixture",
) {
  return (body: string) =>
    fakeGatewayPermissionDecision("caution", toolCallId, rationale, reviewedActionEvidence(body));
}

// lia confirms a held decision with a second, identical review request. A fake
// reviewer answers that confirmation the way it answered the first request,
// and only that one request, so format and transport retries still take the
// next queued answer.
export function confirmationReplay() {
  let held: { body: string; response: Response } | undefined;
  return {
    replay(body: string): Response | undefined {
      if (held?.body !== body) return undefined;
      const { response } = held;
      held = undefined;
      return response;
    },
    record(body: string, response: Response): Response {
      held = response.headers.has(HELD_REVIEW_HEADER) ? { body, response: response.clone() } : undefined;
      return response;
    },
  };
}

export function reviewedActionEvidence(body: string): string {
  const texts: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(JSON.parse(body));
  const instruction = texts.find((text) => text.includes("<permission_review>"));
  if (!instruction) throw new Error("review request has no permission_review instruction");
  const action = instruction.slice(instruction.lastIndexOf("\naction: "));
  const line = action.split("\n").find((entry) => /^(command|arguments_json|path): /.test(entry));
  if (!line) throw new Error("review request has no reviewed action line");
  return line
    .slice(line.indexOf(": ") + 2)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .slice(0, 160);
}

export function fakeGatewaySerializedToolCall(
  id: string,
  name: string,
  input: string,
  assistantText?: string,
) {
  return fakeGatewaySse([
    ...(assistantText
      ? [{ type: "text-delta", id: "answer_1", delta: assistantText }]
      : []),
    {
      type: "tool-call",
      toolCallId: id,
      toolName: name,
      input,
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
    },
  ]);
}

export function fakeGatewayFinalText(text: string) {
  return fakeGatewaySse([
    { type: "text-delta", id: "answer_1", delta: text },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 3 },
        outputTokens: { total: 5 },
      },
    },
  ]);
}

export function heldFakeGatewayFinalText() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let response: Response | undefined;
  let pendingText: string | undefined;

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stopTimer();
    controller?.close();
  };
  const finish = (text: string) => {
    if (closed) return;
    if (!controller) {
      pendingText = text;
      return;
    }
    stopTimer();
    controller.enqueue(encoder.encode(
      `data: ${JSON.stringify({ type: "text-delta", id: "answer_1", delta: text })}\n\n` +
        `data: ${JSON.stringify({
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 3 },
            outputTokens: { total: 5 },
          },
        })}\n\ndata: [DONE]\n\n`,
    ));
    close();
  };
  const createResponse = () => new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        if (closed) {
          value.close();
          return;
        }
        const keepAlive = () => {
          if (!closed) value.enqueue(encoder.encode(": hold-response\n\n"));
        };
        keepAlive();
        timer = setInterval(keepAlive, 50);
        if (pendingText !== undefined) finish(pendingText);
      },
      cancel() {
        closed = true;
        stopTimer();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  return {
    get response() {
      response ??= createResponse();
      return response;
    },
    release: finish,
    dispose: close,
  };
}

export type FakeGatewayResponse =
  | Response
  | ((body: string) => Response | Promise<Response>);

export type FakeGatewayModel = {
  id: string;
  type?: string;
  owned_by?: string;
  released?: number;
  tags?: string[];
  context_window?: number;
  max_tokens?: number;
  pricing?: Record<string, unknown>;
  reasoning_options?: Array<{
    type: string;
    values?: string[];
    [key: string]: unknown;
  }>;
  fast_options?: Array<{
    type: string;
    [key: string]: unknown;
  }>;
};

export type FakeGatewayModelRequest = {
  headers: Headers;
  url: string;
};

export type FakeGatewayOptions = {
  models?:
    | FakeGatewayModel[]
    | ((request: Request) =>
      | FakeGatewayModel[]
      | Response
      | Promise<FakeGatewayModel[] | Response>);
  classifierDecision?: "clear" | "caution";
  classifierResponses?: FakeGatewayResponse[];
  titleResponses?: FakeGatewayResponse[];
  // Answers usage GETs (`/v1/report`, `/ai-gateway/usage-report`); see
  // usage-fakes.ts. Null falls through to the routes below.
  usage?: (url: URL, request: Request) => Response | null;
  // Response for the /v4/ai/evaluation-model endpoint (TypeSafe Jev through
  // the gateway). Defaults to a clear Jev decision.
  evaluationResponse?: FakeGatewayResponse;
};

// Session title generation calls carry this instruction regardless of the
// provider protocol. Fake servers route them to their own channel so they
// never consume queued completion responses; the default is a finish-only
// stream so the call completes without text deltas (which would pollute
// SSE trace assertions) and without a usable title, leaving the locally
// derived title in place for tests that do not opt in.
export const TITLE_GENERATION_MARKER = "Generate a short title";

export function fakeGatewayTitleDefault() {
  return fakeGatewaySse([{
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 2 }, outputTokens: { total: 0 } },
  }]);
}

function serveFakeGateway(
  nextCompletion: (body: string) => Response | Promise<Response>,
  options: FakeGatewayOptions,
) {
  const requests: Array<{ body: string; headers: Headers }> = [];
  const classifierRequests: Array<{ body: string; headers: Headers }> = [];
  // lia's second, identical review of a held action, kept apart so
  // classifierRequests counts one entry per review.
  const confirmationRequests: Array<{ body: string; headers: Headers }> = [];
  const evaluationRequests: Array<{ body: string; headers: Headers }> = [];
  const classifierResponses = [...(options.classifierResponses ?? [])];
  const confirmations = confirmationReplay();
  const titleRequests: Array<{ body: string; headers: Headers }> = [];
  const titleResponses = [...(options.titleResponses ?? [])];
  const modelRequests: FakeGatewayModelRequest[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/coding-agent/v1/models") {
        modelRequests.push({ headers: new Headers(req.headers), url: req.url });
        const models = typeof options.models === "function"
          ? await options.models(req)
          : options.models;
        if (models instanceof Response) return models;
        return Response.json({
          data: models ?? [{
            id: FAKE_GATEWAY_MODEL,
            type: "language",
            tags: ["tool-use"],
          }],
        });
      }
      if (req.method === "GET" && options.usage) {
        const answer = options.usage(new URL(req.url), req);
        if (answer) return answer;
      }
      if (
        req.method === "POST" &&
        new URL(req.url).pathname === "/v4/ai/evaluation-model"
      ) {
        evaluationRequests.push({
          body: await req.text(),
          headers: new Headers(req.headers),
        });
        // Mirrors the real AI Gateway evaluation-model envelope: camelCase
        // usage and confidence under providerMetadata.typesafe.
        const evaluationResponse = options.evaluationResponse ??
          Response.json({
            answers: {
              decision: {
                type: "choice",
                choice: "clear",
                probabilities: { clear: 0.99, caution: 0.01 },
              },
            },
            rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
            usage: { inputTokens: 100, outputTokens: 10 },
            warnings: [],
            providerMetadata: {
              typesafe: { confidence: { decision: 0.97 } },
            },
          });
        return typeof evaluationResponse === "function"
          ? await evaluationResponse(evaluationRequests[evaluationRequests.length - 1].body)
          : evaluationResponse;
      }
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      const body = await req.text();
      const headers = new Headers(req.headers);
      if (body.includes("\"permission_decision\"")) {
        const confirmation = confirmations.replay(body);
        if (confirmation) {
          confirmationRequests.push({ body, headers });
          return confirmation;
        }
        classifierRequests.push({ body, headers });
        const next = classifierResponses.shift();
        const response = next
          ? typeof next === "function" ? await next(body) : next
          : options.classifierDecision === "caution"
            ? fakeGatewayHeldDecision()(body)
            : fakeGatewayPermissionDecision("clear");
        return confirmations.record(body, response);
      }
      if (body.includes(TITLE_GENERATION_MARKER)) {
        titleRequests.push({ body, headers });
        const next = titleResponses.shift();
        if (next) return typeof next === "function" ? await next(body) : next;
        return fakeGatewayTitleDefault();
      }
      requests.push({ body, headers });
      return nextCompletion(body);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    chatUrl: `http://127.0.0.1:${server.port}/v4/ai/language-model`,
    requests,
    classifierRequests,
    confirmationRequests,
    evaluationRequests,
    titleRequests,
    modelRequests,
    requestCount() {
      return requests.length;
    },
    stop() {
      server.stop(true);
    },
  };
}

export function startFakeGateway(
  responses: FakeGatewayResponse[],
  options: FakeGatewayOptions = {},
) {
  return serveFakeGateway(async (body) => {
    const next = responses.shift();
    if (!next) {
      return new Response("unexpected request", { status: 500 });
    }
    return typeof next === "function" ? await next(body) : next;
  }, options);
}

// Same server and classifier handling as startFakeGateway, but every
// completion request is answered by the supplied callback instead of a
// finite queue. For suites that replay one response indefinitely or switch
// on their own state.
export function startDynamicFakeGateway(
  response: (body: string) => Response | Promise<Response>,
  options: FakeGatewayOptions = {},
) {
  return serveFakeGateway(response, options);
}
