import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { FX_BIN, runFx } from "../evals/eval-helpers";
import { startIdleDropProxy } from "./fixtures/idle-drop-proxy";
import { startLegacyStreamableHttpFixture } from "./fixtures/mcp-legacy-remote";
import { startModernMcpHttpFixture } from "./fixtures/mcp-modern-http";
import {
  fakeGatewayFinalText,
  fakeGatewayToolCall,
  startFakeGateway,
} from "./fake-gateway";
import { zigGlobalCacheDir } from "./zig-build";

const MODEL = "openai/gpt-5";
const TOOL_NAME = "mcp_fixture_echo";
const ACCESS_INITIAL = "mcp-access-initial-secret";
const ACCESS_REFRESHED = "mcp-access-refreshed-secret";
const REFRESH_INITIAL = "mcp-refresh-initial-secret";
const REFRESH_ROTATED = "mcp-refresh-rotated-secret";
const FX_SLACK_CLIENT_ID = "12364000946.12017137861236";
const inheritedKeychainDisable = process.env.FX_DISABLE_KEYCHAIN;

type AuthFixture = ReturnType<typeof startAuthFixture>;

let cleanupRoot: string | null = null;
let upstream: ReturnType<typeof startModernMcpHttpFixture> | null = null;
let legacyStreamable:
  | ReturnType<typeof startLegacyStreamableHttpFixture>
  | null = null;
let auth: AuthFixture | null = null;
let gateway: ReturnType<typeof startFakeGateway> | null = null;
let tokenProxy: Awaited<ReturnType<typeof startIdleDropProxy>> | null = null;

beforeAll(() => {
  process.env.FX_DISABLE_KEYCHAIN = "1";
});

afterAll(() => {
  if (inheritedKeychainDisable === undefined) {
    delete process.env.FX_DISABLE_KEYCHAIN;
  } else {
    process.env.FX_DISABLE_KEYCHAIN = inheritedKeychainDisable;
  }
});

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(10);
  }
  return existsSync(path);
}

async function waitForFileText(
  path: string,
  expected: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(expected)) {
      return true;
    }
    await Bun.sleep(10);
  }
  return existsSync(path) && readFileSync(path, "utf8").includes(expected);
}

function unusedCallbackPort(): number {
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

afterEach(async () => {
  const activeGateway = gateway;
  const activeAuth = auth;
  const activeUpstream = upstream;
  const activeLegacyStreamable = legacyStreamable;
  const activeTokenProxy = tokenProxy;
  const activeCleanupRoot = cleanupRoot;
  gateway = null;
  auth = null;
  upstream = null;
  legacyStreamable = null;
  tokenProxy = null;
  cleanupRoot = null;

  activeGateway?.stop();
  activeTokenProxy?.stop();
  activeAuth?.stop();
  activeUpstream?.stop();
  activeLegacyStreamable?.stop();
  if (activeCleanupRoot) {
    rmSync(activeCleanupRoot, { recursive: true, force: true });
  }
});

function startAuthFixture(
  upstreamUrl: string,
  options: {
    rejectRefresh?: boolean;
    authorizationMetadataContentType?: string;
    stallRefresh?: boolean;
    rotateAuthorizationToken?: boolean;
    /** Appended to the access token a code is exchanged for, such as "\r\n". */
    accessTokenSuffix?: string;
    omitScopes?: boolean;
    /** The metadata's token endpoint, in place of its own. */
    tokenEndpoint?: string;
    slackBridgeClientId?: string;
    /** fx's Slack app signs in with `http://localhost:<port>/callback`, as fx does now, not fx.sh's redirect. */
    slackLocalhostRedirect?: boolean;
    /** Answer every refresh with this status and body, such as Slack's HTTP-200 `ok:false`. */
    refreshAnswer?: { status: number; body: unknown };
    challengeScope?: string;
    rejectCodeExchange?: boolean;
    resourceAtOrigin?: boolean;
    /** Answer revocations this late. */
    revokeDelayMs?: number;
    /** Answer the authorization server's metadata this late, like a slow sign-in. */
    discoveryDelayMs?: number;
    /**
     * Each refresh token works once, as WorkOS and RFC 9700 have it: a refresh
     * returns a new one and retires the one sent. The one just retired still
     * returns the same tokens for `graceMs`; after that it's refused, and with
     * `revokeOnReplay` the newest login of the chain stops working too.
     */
    singleUseRefresh?: { graceMs: number; revokeOnReplay?: boolean };
    /** With `singleUseRefresh`, answer each refresh this late, after retiring the token it sent. */
    refreshDelayMs?: number;
    /** The code exchange waits for this file, after writing the other. */
    codeBarrierStartedPath?: string;
    codeBarrierReleasePath?: string;
    /** Lists a registration endpoint, so a server added without a client ID can sign in. */
    registration?: boolean;
  } = {},
) {
  const resourcePath = "/mcp";
  const metadataResourcePath = (options.resourceAtOrigin ?? Boolean(options.slackBridgeClientId)) ? "" : resourcePath;
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    sessionId: string | null;
    lastEventId: string | null;
    body: string;
  }> = [];
  const validTokens = new Set([ACCESS_INITIAL, ACCESS_REFRESHED]);
  let authorizationRequests = 0;
  let tokenExchanges = 0;
  let refreshes = 0;
  let replays = 0;
  const chain = {
    current: REFRESH_INITIAL,
    issued: 0,
    retired: "",
    retiredAt: 0,
    retiredAnswer: {} as Record<string, unknown>,
  };
  let refreshCancellations = 0;
  let revocations = 0;
  let registrations = 0;
  let protectedToolCalls = 0;
  let expectedChallenge = "";
  let expectedScope = "tools.read offline_access";

  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? "" : await request.text();
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        sessionId: request.headers.get("mcp-session-id"),
        lastEventId: request.headers.get("last-event-id"),
        body,
      });
      const origin = `http://127.0.0.1:${server.port}`;
      const resource = `${origin}${metadataResourcePath}`;
      const protectedRoute = url.pathname === resourcePath;

      if (url.pathname === "/api/slack/install/config" && options.slackBridgeClientId) {
        expect(url.searchParams.get("flow")).toBe("auth");
        return Response.json({
          client_id: options.slackBridgeClientId,
          redirect_uri: "https://fx.sh/api/slack/oauth/callback",
          user_scopes: ["tools.read"],
        });
      }

      if (protectedRoute) {
        const bearer = request.headers.get("authorization");
        const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : "";
        if (!validTokens.has(token)) {
          return new Response("", {
            status: 401,
            headers: {
              "www-authenticate": options.omitScopes
                ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${resourcePath}"`
                : `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${resourcePath}", scope="${options.challengeScope ?? "tools.read"}"`,
            },
          });
        }
        const message = body === "" ? null : JSON.parse(body);
        if (message?.method === "tools/call") protectedToolCalls += 1;
        const upstreamHeaders = new Headers(request.headers);
        upstreamHeaders.set("connection", "close");
        return await fetch(upstreamUrl, {
          method: request.method,
          headers: upstreamHeaders,
          ...(body === "" ? {} : { body }),
        });
      }
      if (
        url.pathname ===
          `/.well-known/oauth-protected-resource${resourcePath}`
      ) {
        return Response.json({
          resource,
          authorization_servers: [
            origin,
          ],
          ...(options.omitScopes
            ? {}
            : { scopes_supported: ["tools.read", "tools.call", "offline_access"] }),
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (options.discoveryDelayMs) await Bun.sleep(options.discoveryDelayMs);
        const metadata = {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: options.tokenEndpoint ?? `${origin}/token`,
          revocation_endpoint: `${origin}/revoke`,
          ...(options.omitScopes
            ? {}
            : { scopes_supported: ["tools.read", "tools.call", "offline_access"] }),
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
          ...(options.registration ? { registration_endpoint: `${origin}/register` } : {}),
        };
        if (options.authorizationMetadataContentType) {
          return new Response(JSON.stringify(metadata), {
            headers: {
              "content-type": options.authorizationMetadataContentType,
            },
          });
        }
        return Response.json(metadata);
      }
      if (url.pathname === "/authorize") {
        authorizationRequests += 1;
        expect(url.searchParams.get("resource")).toBe(new URL(resource).href);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expectedChallenge = url.searchParams.get("code_challenge") ?? "";
        expectedScope = url.searchParams.get("scope") ?? "";
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", "fixture-code");
        redirect.searchParams.set(
          "state",
          url.searchParams.get("state")!,
        );
        redirect.searchParams.set(
          "iss",
          origin,
        );
        return Response.redirect(redirect, 302);
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(body);
        expect(form.get("resource")).toBe(new URL(resource).href);
        if (form.get("grant_type") === "refresh_token") {
          refreshes += 1;
          const rule = options.singleUseRefresh;
          if (rule) {
            const sent = form.get("refresh_token") ?? "";
            if (sent !== "" && sent === chain.current) {
              chain.issued += 1;
              const answer = {
                access_token: `${ACCESS_REFRESHED}-${chain.issued}`,
                refresh_token: `${REFRESH_ROTATED}-${chain.issued}`,
                token_type: "Bearer",
                scope: "tools.read offline_access",
                expires_in: 3600,
              };
              Object.assign(chain, { current: answer.refresh_token, retired: sent, retiredAt: Date.now(), retiredAnswer: answer });
              validTokens.add(answer.access_token);
              if (options.refreshDelayMs) await Bun.sleep(options.refreshDelayMs);
              return Response.json(answer);
            }
            if (sent === chain.retired && Date.now() - chain.retiredAt <= rule.graceMs) return Response.json(chain.retiredAnswer);
            replays += 1;
            if (rule.revokeOnReplay) {
              chain.current = "";
              validTokens.clear();
            }
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          // A refused refresh is refused whichever token it presents.
          if (!options.rejectRefresh) expect(form.get("refresh_token")).toBe(REFRESH_INITIAL);
          if (options.stallRefresh && refreshes === 1) {
            return new Response(
              new ReadableStream({
                cancel() {
                  refreshCancellations += 1;
                },
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
          if (options.rejectRefresh) {
            return Response.json(
              { error: "invalid_grant" },
              { status: 400 },
            );
          }
          if (options.refreshAnswer) return Response.json(options.refreshAnswer.body, { status: options.refreshAnswer.status });
          return Response.json({
            access_token: ACCESS_REFRESHED,
            refresh_token: REFRESH_ROTATED,
            token_type: "Bearer",
            scope: "tools.read offline_access",
            expires_in: 3600,
          });
        }
        tokenExchanges += 1;
        if (options.codeBarrierStartedPath && options.codeBarrierReleasePath) {
          writeFileSync(options.codeBarrierStartedPath, "code-started");
          if (!await waitForFile(options.codeBarrierReleasePath, 10_000)) {
            return Response.json({ error: "code barrier timed out" }, { status: 504 });
          }
        }
        // Only a server playing Slack's bridge gets fx.sh's redirect; another
        // server that names fx's Slack app signs in on its own.
        if (options.slackBridgeClientId && form.get("client_id") === FX_SLACK_CLIENT_ID) {
          if (options.slackLocalhostRedirect) expect(form.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/);
          else expect(form.get("redirect_uri")).toBe("https://fx.sh/api/slack/oauth/callback");
          expect(form.get("client_secret")).toBeNull();
        }
        if (options.rejectCodeExchange) return Response.json({ error: "invalid_grant" }, { status: 400 });
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("fixture-code");
        const verifier = form.get("code_verifier") ?? "";
        const actualChallenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        expect(actualChallenge).toBe(expectedChallenge);
        return Response.json({
          access_token: (options.rotateAuthorizationToken
            ? ACCESS_REFRESHED
            : ACCESS_INITIAL) + (options.accessTokenSuffix ?? ""),
          refresh_token: options.rotateAuthorizationToken
            ? REFRESH_ROTATED
            : REFRESH_INITIAL,
          token_type: "Bearer",
          ...(options.omitScopes ? {} : { scope: expectedScope }),
          expires_in: 3600,
        });
      }
      if (url.pathname === "/revoke") {
        revocations += 1;
        if (options.revokeDelayMs) await Bun.sleep(options.revokeDelayMs);
        return new Response("", { status: 200 });
      }
      if (url.pathname === "/register" && options.registration && request.method === "POST") {
        registrations += 1;
        const asked = JSON.parse(body) as { redirect_uris?: string[] };
        return Response.json({ client_id: "fx-mcp-auth-test", token_endpoint_auth_method: "none", redirect_uris: asked.redirect_uris ?? [] }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    resource: `http://127.0.0.1:${server.port}${metadataResourcePath}`,
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests,
    /** The access tokens the server takes; a test may withdraw them. */
    validTokens,
    get authorizationRequests() {
      return authorizationRequests;
    },
    get tokenExchanges() {
      return tokenExchanges;
    },
    get registrations() {
      return registrations;
    },
    get refreshes() {
      return refreshes;
    },
    /** Refreshes with a retired refresh token, past its grace. */
    get replays() {
      return replays;
    },
    get refreshCancellations() {
      return refreshCancellations;
    },
    get revocations() {
      return revocations;
    },
    get protectedToolCalls() {
      return protectedToolCalls;
    },
    stop() {
      server.stop(true);
    },
  };
}

function createRoot(
  activeAuth: AuthFixture,
  configureOauth = true,
  transport: "http" | "sse" = "http",
  serverUrl = activeAuth.url,
  followAuthorization = true,
  clientId = "fx-mcp-auth-test",
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fx-mcp-auth-")));
  cleanupRoot = root;
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  const trace = join(root, "trace.log");
  const openLog = join(root, "open.log");
  const callbackLog = join(root, "callback.html");
  const stderr = join(root, "stderr.log");
  mkdirSync(join(home, ".fx"), { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(home, ".fx", "settings.json"),
    JSON.stringify({}),
  );
  writeFileSync(
    join(home, ".fx", "mcp.json"),
    JSON.stringify({
      mcp: {
        fixture: {
          type: transport,
          url: serverUrl,
          ...(configureOauth
            ? {
                oauth: {
                  client_id: clientId,
                  scopes: ["tools.read"],
                },
              }
            : {}),
          startup_timeout_ms: 5_000,
        },
      },
    }),
  );
  const follow = followAuthorization
    ? `nohup curl --location --silent --show-error "$1" > '${callbackLog}' 2>/dev/null &\n`
    : "";
  const opener =
    `#!/bin/sh\nprintf '%s\\n' "$1" > '${openLog}'\n${follow}exit 0\n`;
  for (const name of ["open", "xdg-open"]) {
    const path = join(bin, name);
    writeFileSync(path, opener);
    chmodSync(path, 0o700);
  }
  return { root, home, workspace, bin, trace, openLog, callbackLog, stderr };
}

function moveAuthFixtureToWorkspace(root: ReturnType<typeof createRoot>): void {
  const profilePath = join(root.home, ".fx", "mcp.json");
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  writeFileSync(
    join(root.workspace, ".mcp.json"),
    JSON.stringify({ mcpServers: { fixture: profile.mcp.fixture } }),
  );
  writeFileSync(profilePath, JSON.stringify({ mcp: {} }));
}

function baseEnv(root: ReturnType<typeof createRoot>) {
  return {
    HOME: root.home,
    ZIG_GLOBAL_CACHE_DIR: zigGlobalCacheDir(),
    PATH: `${root.bin}${delimiter}${process.env.PATH ?? ""}`,
    AI_GATEWAY_API_KEY: "fake-mcp-auth-key",
    VERCEL_OIDC_TOKEN: undefined,
    FX_AUTO_UPGRADE: "0",
    FX_PERMISSION_MODE: "auto",
    FX_MODEL: MODEL,
    FX_TRACE_LOG: root.trace,
    FX_TRACE_SCOPES: "mcp,core",
  };
}

/** fx exited 0. When it didn't, the failure shows what it printed. */
function expectExit0(result: { code: number; stdout: string; stderr: string }): void {
  expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ code: 0 });
}

function seedExpiredCredentials(
  root: ReturnType<typeof createRoot>,
  activeAuth: AuthFixture,
  expiresAtMs = 0,
) {
  const endpoint = activeAuth.url;
  const origin = new URL(endpoint).origin;
  const directory = join(root.home, ".fx", "mcp-credentials");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "credentials.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      credentials: [{
        server_identity: "fixture",
        endpoint,
        resource: new URL(activeAuth.resource).href,
        issuer: origin,
        client_id: "fx-mcp-auth-test",
        client_secret: null,
        access_token: ACCESS_INITIAL,
        refresh_token: REFRESH_INITIAL,
        scope: "tools.read offline_access",
        token_type: "Bearer",
        token_endpoint_auth_method: "none",
        expires_at_ms: expiresAtMs,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
      }],
    }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

/**
 * Holds fx's MCP credential store lock from another process, as a busy fx would, for
 * `seconds`; resolves once it is held.
 */
async function holdStoreLock(root: ReturnType<typeof createRoot>, seconds: number) {
  const path = join(root.home, ".fx", "mcp-credentials", "credentials-v3.lock");
  const holder = Bun.spawn(["perl", "-e", 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print "held\n"; sleep $ARGV[1];', path, String(seconds)], { stdout: "pipe" });
  const reader = holder.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toBe("held\n");
  return holder;
}

/** A login in fx's MCP credential store (FX_DISABLE_KEYCHAIN), as fx saves it. */
function seedV2Credential(root: ReturnType<typeof createRoot>, activeAuth: AuthFixture, fields: Record<string, unknown> = {}) {
  const origin = new URL(activeAuth.url).origin;
  const directory = join(root.home, ".fx", "mcp-credentials");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const credential = JSON.stringify({
    access: ACCESS_INITIAL, refresh: REFRESH_INITIAL, expires_at_ms: null, skew_ms: 30_000,
    token_endpoint: `${origin}/token`, revocation_endpoint: `${origin}/revoke`,
    resource: new URL(activeAuth.resource).href, client_id: "fx-mcp-auth-test", client_secret: null, method: "none", ...fields,
  });
  const path = join(directory, "credentials-v3.json");
  writeFileSync(path, JSON.stringify({ version: 1, servers: [{ name: "fixture", url: activeAuth.url, credential }] }), { mode: 0o600 });
  return path;
}

/**
 * The MCP credential store's Keychain item for a throwaway account, through
 * the same Security calls fx's osascript helper makes, so no other program
 * needs Keychain access to it. `op` is "load" (the item's text, "" when
 * there is none) or "delete".
 */

/**
 * Pauses the first Keychain read fx makes for `account` from now on, as a
 * slow Keychain does; resolves with its pid, or null if none starts in 15 s.
 */

function startToolGateway() {
  return startFakeGateway([
    fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
    fakeGatewayToolCall("call_mcp", TOOL_NAME, { text: "authenticated" }),
    fakeGatewayFinalText("Authenticated MCP call complete."),
  ], {
    models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
  });
}

/// Holds the call to the protected tool until `callAt`, a wall-clock time in ms.
function startDelayedToolGateway(callAt: number, finalText: string) {
  return startFakeGateway([
    fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
    async () => {
      await Bun.sleep(Math.max(0, callAt - Date.now()));
      return fakeGatewayToolCall("call_mcp", TOOL_NAME, {
        text: "authenticated",
      });
    },
    fakeGatewayFinalText(finalText),
  ], {
    models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
  });
}

function toolResultText(
  body: string,
  toolCallId: string,
  outputType: "text" | "error-text" = "text",
): string {
  const request = JSON.parse(body) as {
    prompt?: Array<{ content?: Array<Record<string, unknown>> }>;
  };
  const result = (request.prompt ?? [])
    .flatMap((message) => message.content ?? [])
    .find((part) =>
      part.type === "tool-result" && part.toolCallId === toolCallId
    );
  if (!result) throw new Error(`Missing tool result for ${toolCallId}`);
  const output = result.output as Record<string, unknown>;
  if (output.type !== outputType || typeof output.value !== "string") {
    throw new Error(`Invalid tool result for ${toolCallId}`);
  }
  return output.value;
}

describe("MCP login", () => {
  test(
    "fx ask isolates failed-server authentication from healthy tool search",
    async () => {
      upstream = startModernMcpHttpFixture("json");
      auth = startAuthFixture(upstream.url);
      const root = createRoot(auth);
      writeFileSync(
        join(root.home, ".fx", "mcp.json"),
        JSON.stringify({
          mcp: {
            linear: {
              type: "http",
              url: upstream.url,
              startup_timeout_ms: 5_000,
              operation_timeout_ms: 5_000,
            },
            slack: {
              type: "http",
              url: auth.url,
              oauth: {
                client_id: "fx-mcp-auth-test",
                scopes: ["tools.read"],
              },
              startup_timeout_ms: 5_000,
              operation_timeout_ms: 5_000,
            },
          },
        }),
      );
      gateway = startFakeGateway([
        fakeGatewayToolCall("search_exact", "capability_search", {
          query: "Please use mcp_linear_echo for this request",
        }),
        fakeGatewayToolCall("search_noisy", "capability_search", {
          query: "linear issue",
        }),
        fakeGatewayToolCall("search_auth_collision", "capability_search", {
          query: "slack data",
        }),
        fakeGatewayToolCall("search_targeted", "capability_search", {
          query: "authenticate slack now",
        }),
        fakeGatewayToolCall("search_healthy", "capability_search", {
          query: "linear echo",
        }),
        fakeGatewayFinalText("MCP search isolation observed."),
      ], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });

      const result = await runFx(
        ["ask", "--json", "--auto", "--no-save", "Exercise mixed MCP search."],
        {
          cwd: root.workspace,
          env: {
            ...baseEnv(root),
            FX_GATEWAY_BASE_URL: gateway.baseUrl,
            FX_GATEWAY_CHAT_URL: gateway.chatUrl,
          },
          timeoutMs: 20_000,
        },
      );

      expect(result.code).toBe(0);
      const finalBody = gateway.requests.at(-1)?.body ?? "";
      const exact = toolResultText(finalBody, "search_exact");
      expect(exact).toContain("mcp_linear_echo");
      expect(exact).not.toContain("authentication_required");
      const noisy = toolResultText(finalBody, "search_noisy");
      expect(noisy).toContain("mcp_linear_echo");
      expect(noisy).not.toContain("authentication_required");
      const collision = toolResultText(finalBody, "search_auth_collision");
      expect(collision).toContain("authentication_required");
      expect(collision).toContain('\"server\":\"slack\"');
      expect(collision).not.toContain("mcp_linear_echo");
      const targeted = toolResultText(finalBody, "search_targeted");
      expect(targeted).toContain("authentication_required");
      expect(targeted).toContain('\"server\":\"slack\"');
      expect(toolResultText(finalBody, "search_healthy")).toContain(
        "mcp_linear_echo",
      );
      expect(auth.authorizationRequests).toBe(0);
    },
    30_000,
  );

  // Without a display (Linux with no DISPLAY, an SSH session, or
  // FX_NO_OPEN_BROWSER) fx offers paste-back instead of opening a browser.
  // These tests drive the fake browser, so they declare one everywhere.
  const v2Env = (root: ReturnType<typeof createRoot>) => ({
    ...baseEnv(root),
    FX_DISABLE_KEYCHAIN: "1",
    DISPLAY: ":0",
    SSH_CONNECTION: undefined,
    FX_NO_OPEN_BROWSER: undefined,
  });
  const statusOf = async (root: ReturnType<typeof createRoot>) => {
    const list = await runFx(["mcp", "list", "--json"], { cwd: root.workspace, env: v2Env(root) });
    expect(list.code).toBe(0);
    return JSON.parse(list.stdout).servers[0].status;
  };
  // What the model is told to ask for depends on where the user is.
  const searchNeedingLogin = () => startFakeGateway([
    fakeGatewayToolCall("search_auth", "capability_search", { query: "fixture", server: "fixture" }),
    fakeGatewayFinalText("Sign in first."),
  ], { models: [{ id: MODEL, type: "language", tags: ["tool-use"] }] });

  test("fx ask tells the model the user signs in with fx mcp login in a terminal", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    gateway = searchNeedingLogin();
    const result = await runFx(["ask", "--json", "--auto", "--no-save", "Find the protected MCP tool."], {
      cwd: root.workspace,
      env: { ...v2Env(root), FX_GATEWAY_BASE_URL: gateway.baseUrl, FX_GATEWAY_CHAT_URL: gateway.chatUrl },
      timeoutMs: 20_000,
    });
    expect(result.code).toBe(0);
    expect(gateway.requests[1]?.body).toContain("Run fx mcp login fixture in a terminal, then search again.");
    expect(auth.authorizationRequests).toBe(0);
  }, 30_000);

  test("an open search that matches nothing names the servers it couldn't look in, and why", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const profile = join(root.home, ".fx", "mcp.json");
    const config = JSON.parse(readFileSync(profile, "utf8"));
    config.mcp.broken = { type: "local", command: ["false"], startup_timeout_ms: 5_000 };
    writeFileSync(profile, JSON.stringify(config));
    gateway = startFakeGateway([
      fakeGatewayToolCall("search_open", "capability_search", { query: "weather forecast" }),
      fakeGatewayFinalText("Nothing found."),
    ], { models: [{ id: MODEL, type: "language", tags: ["tool-use"] }] });
    const result = await runFx(["ask", "--json", "--auto", "--no-save", "What's the weather?"], {
      cwd: root.workspace,
      env: { ...v2Env(root), FX_GATEWAY_BASE_URL: gateway.baseUrl, FX_GATEWAY_CHAT_URL: gateway.chatUrl },
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    const told = toolResultText(gateway.requests[1]?.body ?? "", "search_open");
    expect(told).toContain('"state":"no_match"');
    expect(told).toContain('"mcp_unavailable":[');
    expect(told).toContain("\"MCP server 'fixture' needs a login. Ask the user to run fx mcp login fixture in a terminal, then try again.\"");
    expect(told).toContain("\"MCP server 'broken' is unavailable: ");
    expect(auth.authorizationRequests).toBe(0);
  }, 45_000);

  test("fx mcp login signs in through the browser, and logout signs out", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { revokeDelayMs: 500 });
    const root = createRoot(auth);
    const env = v2Env(root);
    expect(await statusOf(root)).toBe("not_started");

    const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(login.stderr).toBe("");
    expectExit0(login);
    expect(login.stdout).toContain("Approve in your browser.");
    expect(login.stdout).toContain("Signed in to fixture.");
    const opened = new URL(readFileSync(root.openLog, "utf8").trim());
    expect(opened.pathname).toBe("/authorize");
    expect(new URL(opened.searchParams.get("redirect_uri")!).hostname).toBe("127.0.0.1");
    expect(auth.tokenExchanges).toBe(1);
    expect(login.stdout).not.toContain(ACCESS_INITIAL);
    expect(await statusOf(root)).toBe("signed_in");

    const show = await runFx(["mcp", "show", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(show.stderr).toBe("");
    expectExit0(show);
    expect(show.stdout).toMatch(/status +ready/);
    expect(show.stdout).not.toContain(ACCESS_INITIAL);

    const logoutStart = Date.now();
    const logout = await runFx(["mcp", "logout", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    const logoutMs = Date.now() - logoutStart;
    expect(logout.code).toBe(0);
    expect(logout.stdout).toBe("Signed out of fixture.\n");
    // The refresh token is revoked, and fx waits for the answer before it
    // exits: hanging up loses the revocation on a real network.
    expect(auth.revocations).toBe(1);
    expect(logoutMs).toBeGreaterThanOrEqual(500);
    expect(await statusOf(root)).toBe("not_started");
  }, 60_000);

  test("fx mcp login says why the server refused the sign-in, in its words", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { rejectCodeExchange: true });
    const root = createRoot(auth);
    const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env: v2Env(root), timeoutMs: 20_000 });
    expect(login.code).toBe(1);
    // The token endpoint's own error, not the stage's name.
    expect(login.stderr).toBe("Couldn't sign in to fixture: it didn't accept the sign-in (invalid_grant).\n");
    // The one exchange, refused.
    expect(auth.tokenExchanges).toBe(1);
    expect(await statusOf(root)).not.toBe("signed_in");
  }, 30_000);

  test("fx mcp login --no-browser takes the address pasted back", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth, true, "http", auth.url, false);
    const child = Bun.spawn([FX_BIN, "mcp", "login", "--no-browser", "fixture"], {
      cwd: root.workspace,
      env: Object.fromEntries(Object.entries({ ...process.env, ...v2Env(root) }).filter(([, v]) => v !== undefined)) as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    let stdout = "";
    const decoder = new TextDecoder();
    const deadline = Date.now() + 15_000;
    // Wait for the whole line: a long address can arrive in pieces.
    while (!/\/authorize\?[^\n]*\n/.test(stdout) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value);
    }
    const address = stdout.split("\n").map((line) => line.trim()).find((line) => line.includes("/authorize?"));
    expect(address).toBeDefined();
    // The user approves in some other browser, which ends on the loopback address.
    const approved = await fetch(address!, { redirect: "manual" });
    const back = approved.headers.get("location")!;
    expect(new URL(back).hostname).toBe("127.0.0.1");
    child.stdin.write(`${back}\n`);
    child.stdin.flush();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value);
    }
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(stdout).toContain("paste the address");
    expect(stdout).toContain("Signed in to fixture.");
    expect(existsSync(root.openLog)).toBe(false);
    expect(auth.tokenExchanges).toBe(1);
  }, 40_000);

  test("fx mcp login takes only its own return: a stray return and a silent connection don't end or hold up the sign-in", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth, true, "http", auth.url, false);
    const child = Bun.spawn([FX_BIN, "mcp", "login", "--no-browser", "fixture"], {
      cwd: root.workspace,
      env: Object.fromEntries(Object.entries({ ...process.env, ...v2Env(root) }).filter(([, v]) => v !== undefined)) as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let silent: Awaited<ReturnType<typeof Bun.connect>> | undefined;
    try {
      const reader = child.stdout.getReader();
      let stdout = "";
      const decoder = new TextDecoder();
      const deadline = Date.now() + 15_000;
      while (!/\/authorize\?[^\n]*\n/.test(stdout) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value);
      }
      const address = stdout.split("\n").map((line) => line.trim()).find((line) => line.includes("/authorize?"));
      expect(address).toBeDefined();
      const port = Number(new URL(new URL(address!).searchParams.get("redirect_uri")!).port);
      // A return with a state fx never made, from anything that can reach the
      // port: a 404, and the sign-in goes on.
      const stray = await fetch(`http://127.0.0.1:${port}/callback?code=stray&state=not-the-state-fx-made`, { signal: AbortSignal.timeout(5_000) });
      expect(stray.status).toBe(404);
      // A connection that sends nothing, as a browser's spare one does.
      silent = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      const approved = await fetch(address!, { redirect: "manual" });
      const back = approved.headers.get("location")!;
      const page = await fetch(back, { signal: AbortSignal.timeout(5_000) });
      expect(page.status).toBe(200);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value);
      }
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(stdout).toContain("Signed in to fixture.");
      // Only the sign-in's own code was redeemed.
      expect(auth.tokenExchanges).toBe(1);
    } finally {
      silent?.end();
      child.kill();
    }
  }, 40_000);

  test("fx mcp login asks for the oauth.scopes in the config when the server names none", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { omitScopes: true });
    const root = createRoot(auth, true, "http", auth.url, false);
    const profile = join(root.home, ".fx", "mcp.json");
    const config = JSON.parse(readFileSync(profile, "utf8"));
    config.mcp.fixture.oauth.scopes = ["custom.scope", "other.scope"];
    writeFileSync(profile, JSON.stringify(config));
    const child = Bun.spawn([FX_BIN, "mcp", "login", "--no-browser", "fixture"], {
      cwd: root.workspace,
      env: Object.fromEntries(Object.entries({ ...process.env, ...v2Env(root) }).filter(([, v]) => v !== undefined)) as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      let stdout = "";
      const decoder = new TextDecoder();
      const deadline = Date.now() + 15_000;
      // Wait for the whole line: a long address can arrive in pieces.
      while (!/\/authorize\?[^\n]*\n/.test(stdout) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value);
      }
      const address = stdout.split("\n").map((line) => line.trim()).find((line) => line.includes("/authorize?"));
      expect(address).toBeDefined();
      const scopes = (new URL(address!).searchParams.get("scope") ?? "").split(" ");
      expect(scopes).toContain("custom.scope");
      expect(scopes).toContain("other.scope");
    } finally {
      child.kill();
      await child.exited;
    }
  }, 40_000);

  // A listener on this machine that counts connections. 0.0.0.0 reaches it,
  // as a sign-in server's metadata could point fx at it.
  const internalListener = () => {
    const seen = { connections: 0 };
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { seen.connections++; }, data() {}, close() {} } });
    return { seen, url: `https://0.0.0.0:${listener.port}/token`, stop: () => listener.stop(true) };
  };

  test("fx mcp login refuses a sign-in server whose token endpoint is an internal address, and contacts nothing there", async () => {
    const internal = internalListener();
    try {
      upstream = startModernMcpHttpFixture("json");
      auth = startAuthFixture(upstream.url, { tokenEndpoint: internal.url });
      const root = createRoot(auth);
      const result = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env: v2Env(root), timeoutMs: 20_000 });
      // Refused before the browser: nothing at the address, and no sign-in page.
      expect(internal.seen.connections).toBe(0);
      expect(auth.authorizationRequests).toBe(0);
      expect(existsSync(root.openLog)).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Couldn't sign in to fixture: its sign-in server points at an internal address fx won't contact.");
    } finally {
      internal.stop();
    }
  }, 30_000);

  test("an approved .mcp.json server doesn't use a login saved for another server with its name and URL", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const env = v2Env(root);
    // A login for the profile's fixture, which then moves to the workspace.
    expectExit0(await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 }));
    const before = auth.requests.length;
    moveAuthFixtureToWorkspace(root);
    const approved = await runFx(["mcp", "approve", "fixture"], { cwd: root.workspace, env });
    expect(approved.code).toBe(0);
    const shown = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(shown.signal).toBeNull();
    expect(JSON.parse(shown.stdout).status).toBe("needs_login");
    expect(auth.requests.slice(before).some((r) => (r.authorization ?? "").includes(ACCESS_INITIAL))).toBe(false);
  }, 30_000);

  test("an approved .mcp.json server keeps its own login, in its own workspace only", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    moveAuthFixtureToWorkspace(root);
    // A second workspace with the same .mcp.json.
    const other = join(root.root, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, ".mcp.json"), readFileSync(join(root.workspace, ".mcp.json")));
    const env = v2Env(root);
    for (const cwd of [root.workspace, other]) {
      expect((await runFx(["mcp", "approve", "fixture"], { cwd, env })).code).toBe(0);
    }
    const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expectExit0(login);
    expect(login.stdout).toContain("Signed in to fixture.");
    const status = async (cwd: string) =>
      JSON.parse((await runFx(["mcp", "show", "fixture", "--json"], { cwd, env, timeoutMs: 20_000 })).stdout).status;
    expect(await status(root.workspace)).toBe("ready");
    expect(await status(other)).toBe("needs_login");
    expect(auth.tokenExchanges).toBe(1);
    // Removing it from the workspace deletes that workspace's login.
    const removed = await runFx(["mcp", "remove", "fixture", "--project"], { cwd: root.workspace, env });
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("and deleted its login");
  }, 60_000);

  test("a saved sign-in whose token endpoint is an internal address is never refreshed there", async () => {
    const internal = internalListener();
    try {
      upstream = startModernMcpHttpFixture("json");
      auth = startAuthFixture(upstream.url);
      const root = createRoot(auth);
      // Expired, so its next use refreshes it at the saved endpoint.
      seedV2Credential(root, auth, { expires_at_ms: 0, token_endpoint: internal.url });
      const shown = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env: v2Env(root), timeoutMs: 20_000 });
      expect(internal.seen.connections).toBe(0);
      expect(shown.signal).toBeNull();
      expect(JSON.parse(shown.stdout).status).toBe("needs_login");
    } finally {
      internal.stop();
    }
  }, 30_000);

  test("fx mcp login says why the sign-in page refused, in its words", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth, true, "http", auth.url, false);
    const child = Bun.spawn([FX_BIN, "mcp", "login", "--no-browser", "fixture"], {
      cwd: root.workspace,
      env: Object.fromEntries(Object.entries({ ...process.env, ...v2Env(root) }).filter(([, v]) => v !== undefined)) as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    let stdout = "";
    const decoder = new TextDecoder();
    const deadline = Date.now() + 15_000;
    while (!/\/authorize\?[^\n]*\n/.test(stdout) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value);
    }
    const address = stdout.split("\n").map((line) => line.trim()).find((line) => line.includes("/authorize?"));
    expect(address).toBeDefined();
    // The user says no; the browser ends on the loopback address with the refusal.
    const approved = await fetch(address!, { redirect: "manual" });
    const back = new URL(approved.headers.get("location")!);
    back.searchParams.delete("code");
    back.searchParams.set("error", "access_denied");
    child.stdin.write(`${back}\n`);
    child.stdin.flush();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toBe("Couldn't sign in to fixture: the sign-in page returned an error (access_denied).\n");
    expect(auth.tokenExchanges).toBe(0);
  }, 40_000);

  test("fx mcp add signs in to a new server that needs a login, --no-login skips it, and without a browser it names the command", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { registration: true });
    const root = createRoot(auth);
    writeFileSync(join(root.home, ".fx", "mcp.json"), JSON.stringify({ mcp: {} }));
    const env = v2Env(root);

    const added = await runFx(["mcp", "add", "web", auth.url], { cwd: root.workspace, env, timeoutMs: 30_000 });
    expect(added.stderr).toBe("");
    expectExit0(added);
    expect(added.stdout).toStartWith("Added web to ~/.fx/mcp.json.\nweb needs a login.\nApprove in your browser.");
    expect(added.stdout).toEndWith("Signed in to web.\n");
    expect(added.stdout).not.toContain(ACCESS_INITIAL);
    expect(new URL(readFileSync(root.openLog, "utf8").trim()).pathname).toBe("/authorize");
    expect(auth.registrations).toBe(1);
    expect(auth.tokenExchanges).toBe(1);

    const skipped = await runFx(["mcp", "add", "--no-login", "quiet", auth.url], { cwd: root.workspace, env, timeoutMs: 30_000 });
    expectExit0(skipped);
    expect(skipped.stdout).toBe("Added quiet to ~/.fx/mcp.json.\n");
    // Without a browser, taking the address pasted back is `fx mcp login`'s.
    const headless = await runFx(["mcp", "add", "later", auth.url], { cwd: root.workspace, env: { ...env, FX_NO_OPEN_BROWSER: "1" }, timeoutMs: 30_000 });
    expectExit0(headless);
    expect(headless.stdout).toBe("Added later to ~/.fx/mcp.json.\nlater needs a login. Sign in with: fx mcp login later\n");
    expect(auth.tokenExchanges).toBe(1);
  }, 90_000);

  // Before, nothing changed on the screen until the address came, which a
  // slow sign-in server makes seconds, and each Enter in the meantime closed
  // the port the browser comes back to, so the sign-in could never finish.
  // On the code before, this fails at "Signing in…".

  // A v1 login taken over would be refreshed by an older fx and this one
  // apart, neither seeing the other's saves, so a server that takes each
  // refresh token once signs both out. fx signs in on its own instead.
  test("a v1 login isn't carried over: the server needs its own login, and v1's store stays as it is", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const v1Store = seedExpiredCredentials(root, auth, Date.now() + 3_600_000);
    const v1Before = readFileSync(v1Store, "utf8");
    const env = v2Env(root);
    const show = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(show.signal).toBeNull();
    expect(JSON.parse(show.stdout).status).toBe("needs_login");
    expect(auth.requests.some((r) => (r.authorization ?? "").includes(ACCESS_INITIAL))).toBe(false);
    expect(auth.refreshes).toBe(0);
    expect(readFileSync(v1Store, "utf8")).toBe(v1Before);
    expect(existsSync(join(root.home, ".fx", "mcp-credentials", "credentials-v3.json"))).toBe(false);
  }, 60_000);

  // Older builds keep their logins in credentials-v2.json. Those from before
  // version 2 of it read a version-2 document as empty and write it back with
  // only their own login, and every older fx still running refreshes the
  // logins it holds apart from this one. So nothing there is carried over,
  // the server signs in once, and an older fx's writes never reach it.
  test("an older fx's credentials-v2.json is never read or written: the server signs in once, and that fx's rewrites never reach the login", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const env = v2Env(root);
    const directory = join(root.home, ".fx", "mcp-credentials");
    const older = join(directory, "credentials-v2.json");
    const own = join(directory, "credentials-v3.json");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const olderCredential = JSON.stringify({
      access: "older-fx-access", refresh: "older-fx-refresh", expires_at_ms: null, skew_ms: 30_000,
      token_endpoint: `${new URL(auth.url).origin}/token`, revocation_endpoint: null,
      resource: new URL(auth.resource).href, client_id: "older-fx", client_secret: null, method: "none",
    });
    let olderText = JSON.stringify({ version: 2, servers: [{ name: "fixture", url: auth.url, credential: olderCredential }] });
    writeFileSync(older, olderText, { mode: 0o600 });

    // The older login isn't taken: the server needs one of its own.
    const before = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(JSON.parse(before.stdout).status).toBe("needs_login");
    expect(auth.requests.some((r) => (r.authorization ?? "").includes("older-fx-access"))).toBe(false);
    expect(auth.refreshes).toBe(0);
    expect(readFileSync(older, "utf8")).toBe(olderText);
    expect(existsSync(own)).toBe(false);

    // One sign-in, saved in this fx's own store.
    expectExit0(await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 }));
    expect(readFileSync(older, "utf8")).toBe(olderText);
    const signedIn = readFileSync(own, "utf8");
    expect(JSON.parse(signedIn).servers.map((s: { name: string }) => s.name)).toEqual(["fixture"]);

    // An older fx reads its version-2 store as empty and writes it back.
    olderText = JSON.stringify({ version: 1, imported_v1: true, servers: [] });
    writeFileSync(older, olderText, { mode: 0o600 });
    const after = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(after.stderr).toBe("");
    expect(JSON.parse(after.stdout).status).toBe("ready");
    expect(readFileSync(own, "utf8")).toBe(signedIn);
    expect(readFileSync(older, "utf8")).toBe(olderText);
    expect(auth.tokenExchanges).toBe(1);
  }, 60_000);

  test("a refresh refused with HTTP 200 and ok:false, as Slack refuses, needs a new login at once and isn't tried again", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { refreshAnswer: { status: 200, body: { ok: false, error: "invalid_refresh_token" } } });
    const root = createRoot(auth);
    seedV2Credential(root, auth, { expires_at_ms: 0 });
    const env = v2Env(root);
    const started = Date.now();
    const show = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(show.signal).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(JSON.parse(show.stdout).status).toBe("needs_login");
    expect(auth.refreshes).toBe(1);
    // The dead refresh token is dropped, so the next run doesn't send it.
    const again = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(JSON.parse(again.stdout).status).toBe("needs_login");
    expect(auth.refreshes).toBe(1);
  }, 60_000);

  test("a refresh that fails for now (503) ends fx mcp show as retrying, keeps the login, and asks for no new one", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { refreshAnswer: { status: 503, body: { error: "temporarily_unavailable" } } });
    const root = createRoot(auth);
    const store = seedV2Credential(root, auth, { expires_at_ms: 0 });
    const env = v2Env(root);
    const started = Date.now();
    const show = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(show.signal).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
    // A sign-in server that didn't answer says nothing about the login.
    const status = JSON.parse(show.stdout);
    expect(status.status).toBe("retrying");
    expect(status.error).toContain("couldn't be renewed");
    expect(auth.refreshes).toBe(1);
    expect(readFileSync(store, "utf8")).toContain(REFRESH_INITIAL);
  }, 60_000);

  test("a refresh Slack answers with a temporary error at HTTP 200 keeps the login, and fx mcp show says it's retrying", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { refreshAnswer: { status: 200, body: { ok: false, error: "internal_error" } } });
    const root = createRoot(auth);
    const store = seedV2Credential(root, auth, { expires_at_ms: 0 });
    const env = v2Env(root);
    const started = Date.now();
    const show = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(show.signal).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
    // Only a refusal ends the login; a temporary error leaves it for the next try.
    const status = JSON.parse(show.stdout);
    expect(status.status).toBe("retrying");
    expect(status.error).toContain("couldn't be renewed");
    expect(auth.refreshes).toBe(1);
    expect(readFileSync(store, "utf8")).toContain(REFRESH_INITIAL);
  }, 60_000);

  // Slack refreshes a PKCE app's tokens without its secret only for a
  // localhost redirect, so fx's Slack app signs in with one.
  test("Slack signs in as fx's Slack app at Slack's own page, with a localhost redirect on its port and the app's scopes, and refreshes without a secret", async () => {
    upstream = startModernMcpHttpFixture("json");
    // Slack's 401 names one of its own scopes; the login asks for it with
    // the app's, so it adds nothing here.
    auth = startAuthFixture(upstream.url, { slackBridgeClientId: FX_SLACK_CLIENT_ID, slackLocalhostRedirect: true, challengeScope: "chat:write" });
    const root = createRoot(auth, true, "http", auth.url, true, FX_SLACK_CLIENT_ID);
    // fx's Slack app with no scopes of the config's own, on a free port.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const profilePath = join(root.home, ".fx", "mcp.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.mcp.fixture.oauth = { client_id: FX_SLACK_CLIENT_ID, callback_port: port };
    writeFileSync(profilePath, JSON.stringify(profile));
    const standIn = new URL(auth.url).origin;
    const env = { ...v2Env(root), FX_TEST_SLACK_ORIGIN: standIn };
    const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(login.stderr).toBe("");
    expectExit0(login);
    expect(login.stdout).toContain("Signed in to fixture.");
    // The browser goes to Slack's own page; nothing asks fx.sh.
    const opened = new URL(readFileSync(root.openLog, "utf8").trim());
    expect(opened.origin).toBe(standIn);
    expect(opened.pathname).toBe("/authorize");
    expect(opened.searchParams.get("client_id")).toBe(FX_SLACK_CLIENT_ID);
    expect(opened.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/callback`);
    // fx adds offline_access when the authorization server lists it, as
    // the stand-in does; Slack doesn't list it.
    expect(opened.searchParams.get("scope")!.split(" ").filter((x) => x !== "offline_access").sort()).toEqual([
      "channels:history", "channels:read", "channels:write", "chat:write", "emoji:read", "files:write",
      "groups:history", "groups:read", "im:history", "im:read", "mpim:history", "mpim:read",
      "search:read.im", "search:read.mpim", "search:read.private", "search:read.public", "search:read.users", "users:read",
    ]);
    expect(auth.requests.some((r) => r.path.startsWith("/api/slack/"))).toBe(false);
    expect(auth.tokenExchanges).toBe(1);
    // Its token runs out: the refresh goes without a secret, and the server is ready.
    const storePath = join(root.home, ".fx", "mcp-credentials", "credentials-v3.json");
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    const credential = JSON.parse(store.servers[0].credential);
    expect(credential.client_secret).toBeNull();
    store.servers[0].credential = JSON.stringify({ ...credential, expires_at_ms: 0 });
    writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 });
    const show = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(show.stderr).toBe("");
    expect(JSON.parse(show.stdout).status).toBe("ready");
    expect(auth.refreshes).toBe(1);
    const refresh = auth.requests.find((r) => r.path === "/token" && new URLSearchParams(r.body).get("grant_type") === "refresh_token");
    expect(new URLSearchParams(refresh!.body).get("client_secret")).toBeNull();
  }, 60_000);

  test("a sign-in whose fixed callback port is taken says so, and sends nothing", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("taken") });
    try {
      const profilePath = join(root.home, ".fx", "mcp.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      profile.mcp.fixture.oauth.callback_port = taken.port;
      writeFileSync(profilePath, JSON.stringify(profile));
      const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env: v2Env(root), timeoutMs: 20_000 });
      expect(login.code).toBe(1);
      expect(login.stderr).toBe(`Couldn't sign in to fixture: port ${taken.port} is in use, maybe by another app signing in. Try again once it's free.\n`);
      expect(existsSync(root.openLog)).toBe(false);
      expect(auth.tokenExchanges).toBe(0);
    } finally {
      taken.stop(true);
    }
  }, 60_000);

  test("a server that only names fx's Slack app signs in on its own, never as fx's Slack app", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    // A stand-in for Slack at another origin, which must never be asked.
    const bridgeRequests: string[] = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        bridgeRequests.push(new URL(request.url).pathname);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const root = createRoot(auth, true, "http", auth.url, true, FX_SLACK_CLIENT_ID);
      const env = { ...v2Env(root), FX_TEST_SLACK_ORIGIN: `http://127.0.0.1:${bridge.port}` };
      const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
      expect(bridgeRequests).toEqual([]);
      // The browser goes to the server's own page, with fx's own loopback redirect.
      const opened = new URL(readFileSync(root.openLog, "utf8").trim());
      expect(opened.origin).toBe(new URL(auth.url).origin);
      expect(opened.pathname).toBe("/authorize");
      expect(opened.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      // The code comes back to fx on 127.0.0.1 and is redeemed with that redirect.
      const token = auth.requests.find(r => r.path === "/token");
      expect(new URLSearchParams(token!.body).get("redirect_uri")).toBe(opened.searchParams.get("redirect_uri"));
      expect(login.stderr).toBe("");
      expectExit0(login);
      expect(login.stdout).toContain("Signed in to fixture.");
      expect(auth.tokenExchanges).toBe(1);
    } finally {
      bridge.stop(true);
    }
  }, 60_000);

  test("a token with a CR LF in it fails the sign-in, is never saved, and never reaches a header", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { accessTokenSuffix: "\r\nX-Injected: 1" });
    const root = createRoot(auth);
    const env = v2Env(root);
    const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(login.signal).toBeNull();
    expect(login.code).toBe(1);
    expect(login.stderr).toBe("Couldn't sign in to fixture: it didn't accept the sign-in (its token has characters OAuth doesn't allow).\n");
    expect(auth.tokenExchanges).toBe(1);
    expect(await statusOf(root)).not.toBe("signed_in");
    const show = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(show.signal).toBeNull();
    expect(JSON.parse(show.stdout).status).toBe("needs_login");
    expect(auth.requests.some(r => (r.authorization ?? "").includes(ACCESS_INITIAL))).toBe(false);
  }, 60_000);

  test("a saved login whose token has a CR LF doesn't crash fx; the server needs a login again", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const env = v2Env(root);
    expectExit0(await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 }));
    // The saved token gains a CR LF, as an older fx could have saved it.
    const storePath = join(root.home, ".fx", "mcp-credentials", "credentials-v3.json");
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    const saved = JSON.parse(store.servers[0].credential);
    saved.access += "\r\nX-Injected: 1";
    store.servers[0].credential = JSON.stringify(saved);
    writeFileSync(storePath, JSON.stringify(store));
    const show = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(show.signal).toBeNull();
    expect(show.code).toBe(1);
    expect(JSON.parse(show.stdout).status).toBe("needs_login");
    expect(auth.requests.some(r => (r.authorization ?? "").includes("X-Injected"))).toBe(false);
  }, 60_000);

  test("a login store a newer fx saved is never written over, and login and logout say why they can't", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const env = v2Env(root);
    expectExit0(await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 }));
    // A newer fx saves the same store as version 2.
    const storePath = join(root.home, ".fx", "mcp-credentials", "credentials-v3.json");
    writeFileSync(storePath, JSON.stringify({ ...JSON.parse(readFileSync(storePath, "utf8")), version: 3 }));
    const before = readFileSync(storePath, "utf8");
    const unreadable = "fx can't read the saved MCP sign-ins in ~/.fx/mcp-credentials/credentials-v3.json. A newer fx saved them, or they're damaged; fix or delete them, then try again.\n";

    expect((await runFx(["mcp", "list", "--json"], { cwd: root.workspace, env })).code).toBe(0);
    const logout = await runFx(["mcp", "logout", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(logout.stderr).toBe(`Can't sign out of fixture: ${unreadable}`);
    expect(logout.code).toBe(1);
    const login = await runFx(["mcp", "login", "--no-browser", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(login.stderr).toBe(`Can't sign in to fixture: ${unreadable}`);
    expect(login.code).toBe(1);
    expect(readFileSync(storePath, "utf8")).toBe(before);
    expect(auth.tokenExchanges).toBe(1);
  }, 60_000);

  // One fx refreshes a login at a time. Another that needs it meanwhile
  // waits for as long as the refresh is still going, here a token endpoint
  // that takes 15 s to answer, and then takes the login it saved: refreshing
  // with the token the first already sent would be refused. Both are
  // connected before the token runs out, as fx windows in use are.
  test("an fx waits for another's refresh that takes 15 s, and takes the login it saved", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { singleUseRefresh: { graceMs: 0 }, refreshDelayMs: 15_000 });
    const activeAuth = auth;
    const root = createRoot(auth);
    const env = v2Env(root);
    const storePath = join(root.home, ".fx", "mcp-credentials", "credentials-v3.json");
    expectExit0(await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 }));
    const until = async (what: string, done: () => boolean) => {
      const deadline = Date.now() + 30_000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(25);
      }
    };
    const models = { models: [{ id: MODEL, type: "language" as const, tags: ["tool-use"] }] };
    // The first fx calls once the second is connected, and finds the token
    // withdrawn; the second calls once the first's refresh is out.
    let second: ReturnType<typeof startFakeGateway> | null = null;
    gateway = startFakeGateway([
      fakeGatewayToolCall("select_first", "mcp_select_tool", { name: TOOL_NAME }),
      async () => {
        await until("the second fx to connect", () => (second?.requests.length ?? 0) >= 2);
        activeAuth.validTokens.delete(ACCESS_INITIAL);
        return fakeGatewayToolCall("first", TOOL_NAME, { text: "first" });
      },
      fakeGatewayFinalText("First call done."),
    ], models);
    const first = gateway;
    second = startFakeGateway([
      fakeGatewayToolCall("select_second", "mcp_select_tool", { name: TOOL_NAME }),
      async () => {
        await until("the first fx's refresh", () => activeAuth.refreshes >= 1);
        return fakeGatewayToolCall("second", TOOL_NAME, { text: "second" });
      },
      fakeGatewayFinalText("Second call done."),
    ], models);
    const other = second;
    try {
      const ask = (g: ReturnType<typeof startFakeGateway>) => runFx(["ask", "--json", "--auto", "--no-save", "Call the protected fixture."], {
        cwd: root.workspace,
        env: { ...env, FX_GATEWAY_BASE_URL: g.baseUrl, FX_GATEWAY_CHAT_URL: g.chatUrl },
        timeoutMs: 60_000,
      });
      const [a, b] = await Promise.all([ask(first), ask(other)]);
      // Refreshing with the token the first sent is refused, and both lose the login.
      expect(auth.replays).toBe(0);
      expect(auth.refreshes).toBe(1);
      expectExit0(a);
      expectExit0(b);
      expect(toolResultText(first.requests.at(-1)?.body ?? "", "first")).toContain("first");
      expect(toolResultText(other.requests.at(-1)?.body ?? "", "second")).toContain("second");
      // Both called the tool with the one refreshed login.
      const calls = auth.requests.filter((r) => r.body.includes("\"tools/call\"") && r.authorization === `Bearer ${ACCESS_REFRESHED}-1`);
      expect(calls.length).toBe(2);
      expect(readFileSync(storePath, "utf8")).toContain(`${REFRESH_ROTATED}-1`);
    } finally {
      other.stop();
    }
  }, 90_000);

  // A load balancer resets the token endpoint's keep-alive connection once it
  // sits idle. fx keeps it for the next renewal, which must find it gone and
  // go out on a new connection instead of failing every renewal until fx
  // restarts.
  test("a renewal after the token endpoint reset its idle connection still goes through", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { singleUseRefresh: { graceMs: 0 } });
    tokenProxy = await startIdleDropProxy(auth.url, "reset");
    const root = createRoot(auth);
    seedV2Credential(root, auth, { token_endpoint: `${tokenProxy.origin}/token` });
    const activeAuth = auth;
    // Each call finds its access token withdrawn, so fx renews the login
    // first. The second comes after the proxy reset the first one's
    // connection.
    const renewed = (withdrawn: string, id: string, waitMs: number) => async () => {
      await Bun.sleep(waitMs);
      activeAuth.validTokens.delete(withdrawn);
      return fakeGatewayToolCall(id, TOOL_NAME, { text: id });
    };
    gateway = startFakeGateway([
      fakeGatewayToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
      renewed(ACCESS_INITIAL, "first", 0),
      renewed(`${ACCESS_REFRESHED}-1`, "second", 600),
      fakeGatewayFinalText("Renewed twice."),
    ], { models: [{ id: MODEL, type: "language", tags: ["tool-use"] }] });
    const result = await runFx(["ask", "--json", "--auto", "--no-save", "Call the protected fixture twice."], {
      cwd: root.workspace,
      env: { ...v2Env(root), FX_GATEWAY_BASE_URL: gateway.baseUrl, FX_GATEWAY_CHAT_URL: gateway.chatUrl },
      timeoutMs: 30_000,
    });
    expectExit0(result);
    const last = gateway.requests.at(-1)?.body ?? "";
    expect(toolResultText(last, "first")).toContain("first");
    expect(toolResultText(last, "second")).toContain("second");
    expect(auth.refreshes).toBe(2);
    expect(auth.replays).toBe(0);
    // Each renewal had its own connection: the reset one wasn't used again.
    expect(tokenProxy.dropped).toBeGreaterThanOrEqual(1);
    expect(tokenProxy.connections).toBe(2);
  }, 40_000);

  // A login that can't be saved works only where it was made, so fx says so.
  test("a login that can't be saved says so, and fx mcp login fails", async () => {
    upstream = startModernMcpHttpFixture("json");
    const barrier = mkdtempSync(join(tmpdir(), "fx-mcp-code-barrier-"));
    const started = join(barrier, "started");
    const release = join(barrier, "release");
    auth = startAuthFixture(upstream.url, { codeBarrierStartedPath: started, codeBarrierReleasePath: release });
    const root = createRoot(auth);
    const env = v2Env(root);
    const login = runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    // Once the browser came back, another fx keeps the saved logins busy.
    expect(await waitForFile(started, 10_000)).toBe(true);
    const holder = await holdStoreLock(root, 6);
    writeFileSync(release, "go");
    const done = await login;
    holder.kill();
    expect(done.stderr).toBe("Signed in to fixture, but couldn't save the login: ~/.fx/mcp-credentials/credentials-v3.json couldn't be written: another fx kept it busy. Sign in again once that's fixed.\n");
    expect(done.code).toBe(1);
    expect(auth.tokenExchanges).toBe(1);
    expect(existsSync(join(root.home, ".fx", "mcp-credentials", "credentials-v3.json"))).toBe(false);
  }, 60_000);

  // A logout that can't remove the saved login says so: every other fx, and
  // the next one, would still sign in with it.
  test("a logout that can't remove the saved login says so, and fx mcp logout fails", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const storePath = seedV2Credential(root, auth);
    // Readable, but fx won't replace a file it isn't allowed to write.
    chmodSync(storePath, 0o400);
    const done = await runFx(["mcp", "logout", "fixture"], { cwd: root.workspace, env: v2Env(root), timeoutMs: 20_000 });
    expect(done.stdout).toBe("");
    expect(done.stderr).toBe("Signed out of fixture here, but couldn't remove its saved login: ~/.fx/mcp-credentials/credentials-v3.json couldn't be written: fx isn't allowed to write it. Sign out again once that's fixed.\n");
    expect(done.code).toBe(1);
    expect(readFileSync(storePath, "utf8")).toContain(ACCESS_INITIAL);
  }, 60_000);

  test("removing a server whose saved login can't be deleted says so, and fx mcp remove fails", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const storePath = seedV2Credential(root, auth);
    chmodSync(storePath, 0o400);
    const done = await runFx(["mcp", "remove", "fixture"], { cwd: root.workspace, env: v2Env(root), timeoutMs: 20_000 });
    expect(done.stdout).toBe("");
    expect(done.stderr).toBe("Removed fixture from ~/.fx/mcp.json, but couldn't delete its saved login: ~/.fx/mcp-credentials/credentials-v3.json couldn't be written: fx isn't allowed to write it. Once that's fixed, add it back and run fx mcp logout fixture to delete it.\n");
    expect(done.code).toBe(1);
    expect(readFileSync(join(root.home, ".fx", "mcp.json"), "utf8")).not.toContain("fixture");
    expect(readFileSync(storePath, "utf8")).toContain(ACCESS_INITIAL);
  }, 60_000);

  // A server waiting for approval has no session, so a saved login that
  // can't be removed means nothing changed.
  test("a logout of a held server whose saved login can't be removed changes nothing and says so", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    moveAuthFixtureToWorkspace(root);
    const storePath = seedV2Credential(root, auth);
    const doc = JSON.parse(readFileSync(storePath, "utf8"));
    doc.servers[0].workspace = root.workspace;
    writeFileSync(storePath, JSON.stringify(doc));
    chmodSync(storePath, 0o400);
    const done = await runFx(["mcp", "logout", "fixture"], { cwd: root.workspace, env: v2Env(root), timeoutMs: 20_000 });
    expect(done.stdout).toBe("");
    expect(done.stderr).toBe("Couldn't sign out of fixture: ~/.fx/mcp-credentials/credentials-v3.json couldn't be written: fx isn't allowed to write it. Try again once that's fixed.\n");
    expect(done.code).toBe(1);
    expect(readFileSync(storePath, "utf8")).toContain(ACCESS_INITIAL);
  }, 60_000);

  test("a logout while another fx keeps the saved logins busy changes nothing and says so", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const storePath = seedV2Credential(root, auth);
    // Private, as fx makes it.
    writeFileSync(join(root.home, ".fx", "mcp-credentials", "credentials-v3.lock"), "", { mode: 0o600 });
    const holder = await holdStoreLock(root, 8);
    const done = await runFx(["mcp", "logout", "fixture"], { cwd: root.workspace, env: v2Env(root), timeoutMs: 20_000 });
    holder.kill();
    expect(done.stdout).toBe("");
    expect(done.stderr).toBe("Couldn't sign out of fixture: ~/.fx/mcp-credentials/credentials-v3.json couldn't be written: another fx kept it busy. Try again once that's fixed.\n");
    expect(done.code).toBe(1);
    expect(readFileSync(storePath, "utf8")).toContain(ACCESS_INITIAL);
  }, 60_000);

  // Two shells share one login on the Keychain. Shell A starts while B is
  // idle, and A's Keychain read hangs past the 10 s it may hold the store's
  // lock; meanwhile B's token is refused, so B refreshes and saves. The
  // auth server's refresh tokens work once, as WorkOS's do.
  // Before, B waited 2 s for the lock, dropped its new login with "another
  // fx kept it busy", and A, taking the saved login, replayed a refresh
  // token B had already used. Now A's hung read is cut at its budget, B
  // waits for that and saves, and A takes B's login without refreshing.

  test("a configured oauth.resource reaches the authorization server as written", async () => {
    upstream = startModernMcpHttpFixture("json");
    // The fixture advertises its origin as the resource and checks it on
    // /authorize and /token; fx's own address is .../mcp.
    auth = startAuthFixture(upstream.url, { resourceAtOrigin: true });
    const root = createRoot(auth);
    const configPath = join(root.home, ".fx", "mcp.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.mcp.fixture.oauth.resource = `${new URL(auth.url).origin}/`;
    writeFileSync(configPath, JSON.stringify(config));
    // Freed memory reads as 0x55, so a resource fx failed to copy is garbled.
    const env = { ...v2Env(root), MallocScribble: "1", MALLOC_PERTURB_: "85" };
    const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
    expect(login.signal).toBeNull();
    expect(login.stderr).toBe("");
    expectExit0(login);
    expect(auth.tokenExchanges).toBe(1);
    expect(await statusOf(root)).toBe("signed_in");
  }, 60_000);

  test("fx mcp login explains servers it can't sign in to", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    const env = v2Env(root);
    const unknown = await runFx(["mcp", "login", "nope"], { cwd: root.workspace, env });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe("No MCP server named nope. fx mcp list shows them.\n");
    moveAuthFixtureToWorkspace(root);
    const waiting = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env });
    expect(waiting.code).toBe(1);
    expect(waiting.stderr).toBe("fixture is waiting for approval: fx mcp approve fixture.\n");
    expect(existsSync(root.openLog)).toBe(false);
    expect(auth.authorizationRequests).toBe(0);
  }, 30_000);

  // A saved login is renewed before it's sent once it's expired, or within
  // its renewal window (skew_ms before it expires), whatever the server's era.
  for (const era of ["2026-07-28", "2025-11-25"] as const) {
    test(`an expired saved login is renewed before fx first talks to a ${era} server`, async () => {
      const target = era === "2026-07-28"
        ? (upstream = startModernMcpHttpFixture("json"))
        : (legacyStreamable = startLegacyStreamableHttpFixture(era));
      auth = startAuthFixture(target.url);
      const root = createRoot(auth);
      seedV2Credential(root, auth, { expires_at_ms: 0 });
      gateway = startToolGateway();
      const result = await runFx(["ask", "--json", "--auto", "--no-save", "Call the protected fixture."], {
        cwd: root.workspace,
        env: { ...v2Env(root), FX_GATEWAY_BASE_URL: gateway.baseUrl, FX_GATEWAY_CHAT_URL: gateway.chatUrl },
        timeoutMs: 20_000,
      });
      expect(result.code).toBe(0);
      expect(auth.refreshes).toBe(1);
      // The expired token never reached the server.
      const sent = auth.requests.filter((request) => request.path === "/mcp");
      expect(sent.length).toBeGreaterThan(0);
      for (const request of sent) expect(request.authorization).toBe(`Bearer ${ACCESS_REFRESHED}`);
      expect(auth.protectedToolCalls).toBe(1);
      expect(toolResultText(gateway.requests[2]?.body ?? "", "call_mcp")).toContain("authenticated");
    }, 30_000);
  }

  test("a login that comes within its renewal window while fx runs is renewed before the next call", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    const root = createRoot(auth);
    // Renewed 6 s before it expires, 21 s from now: the first use is well
    // before that window, even when fx starts slowly on a busy machine, and
    // the call, held until 16 s from now, inside it.
    const savedAt = Date.now();
    seedV2Credential(root, auth, { expires_at_ms: savedAt + 21_000, skew_ms: 6_000 });
    gateway = startDelayedToolGateway(savedAt + 16_000, "Renewed call complete.");
    const result = await runFx(["ask", "--json", "--auto", "--no-save", "Call the protected fixture."], {
      cwd: root.workspace,
      env: { ...v2Env(root), FX_GATEWAY_BASE_URL: gateway.baseUrl, FX_GATEWAY_CHAT_URL: gateway.chatUrl },
      timeoutMs: 45_000,
    });
    expect(result.code).toBe(0);
    expect(auth.refreshes).toBe(1);
    const sent = auth.requests.filter((request) => request.path === "/mcp");
    expect(sent[0]?.authorization).toBe(`Bearer ${ACCESS_INITIAL}`);
    // The fixture takes both tokens, so the call carries the new one only
    // because fx renewed it first.
    const call = sent.find((request) => request.body.includes('"tools/call"'));
    expect(call?.authorization).toBe(`Bearer ${ACCESS_REFRESHED}`);
    expect(auth.protectedToolCalls).toBe(1);
  }, 60_000);

  // Before, a shell that started before another terminal signed in logged out
  // without that login, which stayed valid at the server for every other fx.

  // Before, a shell holding a login renewed it at its next use after another
  // terminal logged out, and saved it again: at a server that doesn't end the
  // login on revocation, as this fixture, the logout undid itself.

  // RFC 8414 section 3.2: the metadata is an application/json response.
  test("fx mcp login refuses sign-in metadata that isn't JSON before opening the browser", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url, { authorizationMetadataContentType: "text/plain" });
    const root = createRoot(auth);
    const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env: v2Env(root), timeoutMs: 20_000 });
    expect(login.code).not.toBe(0);
    expect(`${login.stdout}${login.stderr}`).toContain("text/plain");
    expect(existsSync(root.openLog)).toBe(false);
    expect(auth.authorizationRequests).toBe(0);
    expect(auth.tokenExchanges).toBe(0);
    expect(existsSync(join(root.home, ".fx", "mcp-credentials", "credentials-v3.json"))).toBe(false);
  }, 30_000);

  // MongoDB's deployed server answers server/discover with a session error
  // where a 2025-11-25 server would answer with an unknown method.
  for (const mode of ["legacy_session_required", "legacy_mongodb_session_required"] as const) {
    test(`a signed-in server that refuses discovery as MongoDB's does (${mode}) falls back and lists its tools`, async () => {
      upstream = startModernMcpHttpFixture(mode);
      auth = startAuthFixture(upstream.url);
      const root = createRoot(auth);
      const env = v2Env(root);
      const login = await runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
      expectExit0(login);
      expect(login.stdout).toContain("Signed in to fixture.");
      const show = await runFx(["mcp", "show", "fixture", "--json"], { cwd: root.workspace, env, timeoutMs: 20_000 });
      expectExit0(show);
      expect(show.stderr).toBe("");
      const status = JSON.parse(show.stdout);
      expect(status.status).toBe("ready");
      expect(status.version).toBe("2025-11-25");
      expect(status.tools).toHaveLength(1);
      for (const secret of [ACCESS_INITIAL, REFRESH_INITIAL]) {
        expect(show.stdout).not.toContain(secret);
        expect(show.stderr).not.toContain(secret);
      }
      const methods = upstream.requests.map((entry) => entry.message.method);
      expect(methods.slice(0, 3)).toEqual(["server/discover", "initialize", "notifications/initialized"]);
      expect(methods).toContain("tools/list");
    }, 30_000);
  }

  // Esc stops only the call: the renewal runs on, so a server that swaps its
  // refresh token on each renewal never sees an old one. A renewal gets 30 s;
  // the call waiting when it runs out fails, and the next call renews afresh.

  test("a pinned callback port is bound again for each of several sign-ins in a row", async () => {
    upstream = startModernMcpHttpFixture("json");
    auth = startAuthFixture(upstream.url);
    // This test plays the browser itself.
    const root = createRoot(auth, true, "http", auth.url, false);
    const callbackPort = unusedCallbackPort();
    const profilePath = join(root.home, ".fx", "mcp.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.mcp.fixture.oauth.callback_port = callbackPort;
    writeFileSync(profilePath, JSON.stringify(profile));
    const env = v2Env(root);
    const attempts = 8;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      rmSync(root.openLog, { force: true });
      const login = runFx(["mcp", "login", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
      expect(await waitForFileText(root.openLog, "http", 10_000)).toBe(true);
      const authorization = await fetch(readFileSync(root.openLog, "utf8").trim(), { redirect: "manual" });
      const callback = authorization.headers.get("location");
      expect(callback).not.toBeNull();
      expect(new URL(callback!).port).toBe(String(callbackPort));
      expect((await fetch(callback!)).status).toBe(200);
      const done = await login;
      expect({ attempt, code: done.code, stderr: done.stderr }).toEqual({ attempt, code: 0, stderr: "" });
      expect(done.stdout).toContain("Signed in to fixture.");
      const logout = await runFx(["mcp", "logout", "fixture"], { cwd: root.workspace, env, timeoutMs: 20_000 });
      expect({ attempt, code: logout.code, stderr: logout.stderr }).toEqual({ attempt, code: 0, stderr: "" });
    }
    expect(auth.authorizationRequests).toBe(attempts);
    expect(auth.tokenExchanges).toBe(attempts);
  }, 120_000);
});
