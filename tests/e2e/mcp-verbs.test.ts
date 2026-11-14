import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLia } from "../evals/eval-helpers";
import { fakeGatewayFinalText, startFakeGateway } from "./fake-gateway";

// `lia mcp`. Sign-in is covered in mcp-auth.test.ts.

const MODERN_FIXTURE = join(import.meta.dirname, "fixtures", "mcp-modern-stdio.mjs");

let cleanup: string | null = null;
let gateway: ReturnType<typeof startFakeGateway> | null = null;

afterEach(async () => {
  gateway?.stop();
  gateway = null;
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  cleanup = null;
});

function createRoot(profile?: unknown, project?: unknown) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lia-mcp-verbs-")));
  cleanup = root;
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".lia"), { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, ".lia", "settings.json"), "{}");
  if (profile !== undefined) writeFileSync(join(home, ".lia", "mcp.json"), typeof profile === "string" ? profile : JSON.stringify(profile));
  if (project !== undefined) writeFileSync(join(workspace, ".mcp.json"), JSON.stringify(project));
  return {
    home,
    workspace,
    profilePath: join(home, ".lia", "mcp.json"),
    projectPath: join(workspace, ".mcp.json"),
    env: {
      HOME: home,
      LIA_DISABLE_KEYCHAIN: "1",
      AI_GATEWAY_API_KEY: "fake-mcp-verbs-key",
      VERCEL_OIDC_TOKEN: undefined,
    },
  };
}

type Root = ReturnType<typeof createRoot>;

function mcp(root: Root, ...args: string[]) {
  return runLia(["mcp", ...args], { cwd: root.workspace, env: root.env, timeoutMs: 20_000 });
}

const fixtureServer = (extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [MODERN_FIXTURE],
  ...extra,
});

describe("lia mcp", () => {
  test("add writes each file and keeps every key it doesn't know", async () => {
    // Raw text, so the number's spelling reaches lia as written.
    const root = createRoot('{"theme":"dark","mcp":{"old":{"command":"true","environment":{"A":"1"},"startup_timeout_ms":1.50}}}');
    writeFileSync(root.projectPath, '{"mcpServers":{},"note":"shared"}');
    chmodSync(root.projectPath, 0o640);

    const http = await mcp(root, "add", "web", "https://mcp.example/mcp", "--header", "X-Key=${KEY}");
    expect(http.stderr).toBe("");
    expect(http.code).toBe(0);
    expect(http.stdout).toBe("Added web to ~/.lia/mcp.json.\n");
    const stdio = await mcp(root, "add", "--project", "--env", "TOKEN=x", "local", "--", "node", "server.js", "-h");
    expect(stdio.code).toBe(0);
    expect(stdio.stdout).toBe("Added local to .mcp.json.\n");

    const profileText = readFileSync(root.profilePath, "utf8");
    expect(profileText).toContain('"startup_timeout_ms": 1.50');
    expect(JSON.parse(profileText)).toEqual({
      theme: "dark",
      mcp: {
        old: { command: "true", environment: { A: "1" }, startup_timeout_ms: 1.5 },
        web: { type: "http", url: "https://mcp.example/mcp", headers: { "X-Key": "${KEY}" } },
      },
    });
    expect(JSON.parse(readFileSync(root.projectPath, "utf8"))).toEqual({
      mcpServers: { local: { command: "node", args: ["server.js", "-h"], env: { TOKEN: "x" } } },
      note: "shared",
    });
    expect(statSync(root.profilePath).mode & 0o777).toBe(0o600);
    expect(statSync(root.projectPath).mode & 0o777).toBe(0o640);
  });

  test("add refuses a name that's there, a file it can't read, and a bad name", async () => {
    const root = createRoot({ mcpServers: { web: { type: "http", url: "https://a/mcp" } } });
    const before = readFileSync(root.profilePath, "utf8");
    const taken = await mcp(root, "add", "web", "https://b/mcp");
    expect(taken.code).toBe(1);
    expect(taken.stderr).toBe("Couldn't add web to ~/.lia/mcp.json: that name is already in the file; remove it first.\n");
    expect(readFileSync(root.profilePath, "utf8")).toBe(before);

    writeFileSync(root.profilePath, '{"mcpServers":{},"mcpServers":{}}');
    const broken = await mcp(root, "add", "other", "https://b/mcp");
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("isn't valid JSON, or repeats a key");
    expect(readFileSync(root.profilePath, "utf8")).toBe('{"mcpServers":{},"mcpServers":{}}');

    const bad = await mcp(root, "add", "bad name", "https://b/mcp");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toStartWith("'bad name' can't be a server name: use letters, digits, '-' and '_'.\nusage: lia mcp add ");
    const notUrl = await mcp(root, "add", "web2", "mcp.example");
    expect(notUrl.code).toBe(2);
    expect(notUrl.stderr).toStartWith("'mcp.example' isn't a URL. A stdio server's command goes after --.\n");
  });

  // lia never edits a linked file. Replacing a link forks the file it
  // points to, and following one could write outside the project.
  test("add and remove refuse a linked config file and name what it points to", async () => {
    const root = createRoot();
    const shared = join(root.workspace, "shared");
    mkdirSync(shared);
    const target = join(shared, "mcp.json");
    const text = JSON.stringify({ mcpServers: { one: { command: "true" } } });
    writeFileSync(target, text);
    symlinkSync(target, root.projectPath);
    const why = `it's a link to ${target}, and lia edits only a plain file; edit ${target} by hand.\n`;
    const added = await mcp(root, "add", "--project", "two", "--", "true");
    expect(added.code).toBe(1);
    expect(added.stderr).toBe(`Couldn't add two to .mcp.json: ${why}`);
    const removed = await mcp(root, "remove", "--project", "one");
    expect(removed.code).toBe(1);
    expect(removed.stderr).toBe(`Couldn't remove one from .mcp.json: ${why}`);
    expect(lstatSync(root.projectPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(text);

    // A hard link would fork the same way.
    rmSync(root.projectPath);
    linkSync(target, root.projectPath);
    const hard = await mcp(root, "add", "--project", "two", "--", "true");
    expect(hard.code).toBe(1);
    expect(hard.stderr).toBe("Couldn't add two to .mcp.json: it has another hard link, and lia edits only a plain file; edit it by hand.\n");
    expect(readFileSync(target, "utf8")).toBe(text);

    // The profile's own replace refuses a link too, and says so the same way.
    const profileTarget = join(shared, "profile.json");
    writeFileSync(profileTarget, "{}");
    symlinkSync(profileTarget, root.profilePath);
    const profile = await mcp(root, "add", "three", "--", "true");
    expect(profile.code).toBe(1);
    expect(profile.stderr).toBe(`Couldn't add three to ~/.lia/mcp.json: it's a link to ${profileTarget}, and lia edits only a plain file; edit ${profileTarget} by hand.\n`);
    expect(lstatSync(root.profilePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(profileTarget, "utf8")).toBe("{}");
  });

  test("list shows each server's file, transport, and status without connecting", async () => {
    const root = createRoot(
      {
        mcpServers: {
          ctx: { type: "http", url: "https://mcp.example/mcp" },
          off: { command: "never-run", enabled: false },
          sse: { type: "sse", url: "https://old.example/sse" },
          keyed: { type: "http", url: "https://k.example/mcp", bearer_token_env: "MISSING_TOKEN" },
        },
      },
      { mcpServers: { docs: { command: "never-run" } } },
    );
    const text = await mcp(root, "list");
    expect(text.stderr).toBe("");
    expect(text.code).toBe(0);
    expect(text.stdout).toBe(
      [
        "NAME   SOURCE          TRANSPORT  STATUS",
        "ctx    ~/.lia/mcp.json  http       not started",
        "off    ~/.lia/mcp.json  stdio      disabled",
        "sse    ~/.lia/mcp.json  sse        not supported",
        "keyed  ~/.lia/mcp.json  http       needs $MISSING_TOKEN",
        "docs   .mcp.json       stdio      waiting for approval",
        "",
      ].join("\n"),
    );
    const json = await mcp(root, "list", "--json");
    expect(json.code).toBe(0);
    const servers = JSON.parse(json.stdout).servers;
    expect(servers.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ["ctx", "not_started"],
      ["off", "disabled"],
      ["sse", "not_supported"],
      ["keyed", "missing_env"],
      ["docs", "waiting_for_approval"],
    ]);
    expect(servers[4]).toMatchObject({ source: "project", file: root.projectPath, transport: "stdio", tools: null, error: null });

    // A server whose ${VAR} isn't set is skipped, and list says why.
    writeFileSync(root.projectPath, JSON.stringify({ mcpServers: { docs: { command: "x", args: ["${LIA_VERBS_UNSET}"] } } }));
    await mcp(root, "approve", "docs");
    const noted = await mcp(root, "list");
    expect(noted.code).toBe(0);
    expect(noted.stderr).toBe("note: .mcp.json server 'docs' field argument requires environment variable 'LIA_VERBS_UNSET'; set it or use ${LIA_VERBS_UNSET:-default}.\n");
    expect(noted.stdout).not.toContain("docs");

    // lia won't send a token written into an Authorization header: that
    // server is skipped, and the note says where the token goes.
    writeFileSync(root.profilePath, JSON.stringify({ mcpServers: { bad: { type: "http", url: "https://b/mcp", headers: { Authorization: "Bearer x" } } } }));
    const refused = await mcp(root, "list");
    expect(refused.code).toBe(0);
    expect(refused.stderr).toContain(
      "note: ~/.lia/mcp.json server 'bad' was skipped: lia won't send its Authorization header; put the token in \"bearer_token_env\", or sign in with login.\n",
    );
    expect(refused.stdout).not.toContain("bad");

    const empty = await mcp(createRoot(), "list");
    expect(empty.code).toBe(0);
    expect(empty.stdout).toBe("No MCP servers configured. Add one with: lia mcp add NAME URL\n");
  });

  test("show connects to a server and lists its tools; a broken one exits 1", async () => {
    const root = createRoot({ mcpServers: { fixture: fixtureServer(), broken: { command: "lia-mcp-verbs-missing-binary" } } });
    const text = await mcp(root, "show", "fixture");
    expect(text.stderr).toBe("");
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^fixture\n  status     ready, \d+ tools?\n  version    2026-07-28\n  transport  stdio\n  command    /);
    expect(text.stdout).toMatch(/\n    echo +Echo text through the modern MCP fixture\n/);

    const json = await mcp(root, "show", "fixture", "--json");
    expect(json.code).toBe(0);
    const shown = JSON.parse(json.stdout);
    expect(shown).toMatchObject({ name: "fixture", status: "ready", version: "2026-07-28", url: null });
    expect(shown.tools).toContainEqual({ name: "echo", description: "Echo text through the modern MCP fixture" });

    const broken = await mcp(root, "show", "broken");
    expect(broken.code).toBe(1);
    expect(broken.stdout).toMatch(/status     (failed|retrying)\n/);
    expect(broken.stdout).toMatch(/\n  error      .+\n/);

    const unknown = await mcp(root, "show", "nope");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe("No MCP server named nope. lia mcp list shows them.\n");
  });

  test("a variable a header can't carry holds its server back instead of aborting lia", async () => {
    // Nothing listens on port 1, and nothing should be sent there.
    const root = createRoot({
      mcp: {
        token: { type: "http", url: "http://127.0.0.1:1/mcp", bearer_token_env: "LIA_VERBS_TOKEN" },
        team: { type: "http", url: "http://127.0.0.1:1/mcp", header_env: { "X-Team": "LIA_VERBS_TEAM" } },
      },
    });
    root.env = { ...root.env, LIA_VERBS_TOKEN: "a\r\nb", LIA_VERBS_TEAM: "x\nInjected: yes" } as typeof root.env;
    const shown = await mcp(root, "show", "token");
    expect(shown.stderr).toBe("");
    expect(shown.code).toBe(1);
    expect(shown.stdout).toContain("  status     can't use $LIA_VERBS_TOKEN\n");
    const json = await mcp(root, "list", "--json");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).servers.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ["token", "invalid_env"],
      ["team", "invalid_env"],
    ]);
  });

  test("${VAR} works in the profile too", async () => {
    const root = createRoot({ mcpServers: { fixture: fixtureServer({ args: ["${LIA_VERBS_FIXTURE}"] }) } });
    root.env = { ...root.env, LIA_VERBS_FIXTURE: MODERN_FIXTURE } as typeof root.env;
    const shown = await mcp(root, "show", "fixture");
    expect(shown.stderr).toBe("");
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("status     ready");
  });

  test("remove finds the server's file, and asks when both files have it", async () => {
    const root = createRoot(
      { mcpServers: { twin: { command: "a" }, solo: { command: "b" } }, other: 1 },
      { mcpServers: { twin: { command: "c" } } },
    );
    const both = await mcp(root, "remove", "twin");
    expect(both.code).toBe(2);
    expect(both.stderr).toBe("twin is in both ~/.lia/mcp.json and .mcp.json. Add --global or --project.\n");

    const project = await mcp(root, "remove", "--project", "twin");
    expect(project.code).toBe(0);
    expect(project.stdout).toBe("Removed twin from .mcp.json.\n");
    expect(JSON.parse(readFileSync(root.projectPath, "utf8"))).toEqual({ mcpServers: {} });

    const solo = await mcp(root, "remove", "solo");
    expect(solo.code).toBe(0);
    expect(JSON.parse(readFileSync(root.profilePath, "utf8"))).toEqual({ mcpServers: { twin: { command: "a" } }, other: 1 });

    const gone = await mcp(root, "remove", "solo");
    expect(gone.code).toBe(1);
    expect(gone.stderr).toBe("No MCP server named solo in ~/.lia/mcp.json or .mcp.json.\n");

    // `--global` names ~/.lia/mcp.json; the older `--profile` still works.
    const global = await mcp(root, "remove", "--global", "twin");
    expect(global.code).toBe(0);
    expect(JSON.parse(readFileSync(root.profilePath, "utf8"))).toEqual({ mcpServers: {}, other: 1 });
    const profile = await mcp(root, "remove", "--profile", "twin");
    expect(profile.code).toBe(1);
    // The older --profile still names the profile file, with a warning.
    expect(profile.stderr).toBe(
      "lia mcp remove: --profile is deprecated and stops working in lia 0.2.0; use --global\nNo MCP server named twin in ~/.lia/mcp.json.\n",
    );
  });

  test("approve and reject say exactly what they trust", async () => {
    const root = createRoot(
      { mcpServers: { mine: { command: "x" } } },
      { mcpServers: { docs: { command: "node", args: ["docs server.js"] }, web: { type: "http", url: "https://w.example/mcp" } } },
    );
    const approved = await mcp(root, "approve", "docs");
    expect(approved.stderr).toBe("");
    expect(approved.code).toBe(0);
    expect(approved.stdout).toBe("Approved docs, which runs: node 'docs server.js'\n");

    const rejected = await mcp(root, "reject", "web");
    expect(rejected.code).toBe(0);
    expect(rejected.stdout).toBe("Rejected web. lia won't start it in this project.\n");

    const all = await mcp(root, "approve", "--all");
    expect(all.code).toBe(0);
    expect(all.stdout).toBe("Approved docs, which runs: node 'docs server.js'\n");
    // `--all` approves the servers it shows, not a server added later.
    const settings = JSON.parse(readFileSync(join(root.home, ".lia", "settings.json"), "utf8"));
    expect(settings.workspaces[root.workspace]).toEqual({ enabledMcpjsonServers: ["docs"], disabledMcpjsonServers: ["web"] });

    const list = JSON.parse((await mcp(root, "list", "--json")).stdout).servers;
    expect(list.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ["mine", "not_started"],
      ["docs", "not_started"],
      ["web", "rejected"],
    ]);

    const profileServer = await mcp(root, "approve", "mine");
    expect(profileServer.code).toBe(1);
    expect(profileServer.stderr).toBe("No project server named mine in .mcp.json.\n");
    const project = JSON.parse(readFileSync(root.projectPath, "utf8"));
    project.mcpServers.later = { command: "node", args: ["later.js"] };
    writeFileSync(root.projectPath, JSON.stringify(project));
    const after = JSON.parse((await mcp(root, "list", "--json")).stdout).servers;
    expect(after.find((s: { name: string }) => s.name === "later")?.status).toBe("waiting_for_approval");
  });

  test("approve --all approves each server it shows, and one added later still waits", async () => {
    const root = createRoot(undefined, { mcpServers: { a: { command: "node", args: ["a.js"] }, b: { type: "http", url: "https://b.example/mcp" } } });
    const all = await mcp(root, "approve", "--all");
    expect(all.code).toBe(0);
    expect(all.stdout).toBe("Approved a, which runs: node a.js\nApproved b, which connects to: https://b.example/mcp\n");
    const settings = JSON.parse(readFileSync(join(root.home, ".lia", "settings.json"), "utf8"));
    expect(settings.workspaces[root.workspace]).toEqual({ enabledMcpjsonServers: ["a", "b"] });
    writeFileSync(root.projectPath, JSON.stringify({ mcpServers: { a: { command: "node", args: ["a.js"] }, b: { type: "http", url: "https://b.example/mcp" }, c: { command: "node", args: ["c.js"] } } }));
    const list = JSON.parse((await mcp(root, "list", "--json")).stdout).servers;
    expect(list.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ["a", "not_started"],
      ["b", "not_started"],
      ["c", "waiting_for_approval"],
    ]);
  });

  test("help, usage mistakes, and old verbs", async () => {
    const root = createRoot();
    const overview = await mcp(root);
    expect(overview.code).toBe(0);
    expect(overview.stdout).toStartWith("usage: lia mcp COMMAND\n\n  list [--json]               configured servers; never connects\n");
    const verbHelp = await mcp(root, "remove", "-h");
    expect(verbHelp.code).toBe(0);
    expect(verbHelp.stdout).toBe("usage: lia mcp remove [--global | --project] NAME\n");

    const unknownVerb = await mcp(root, "nope");
    expect(unknownVerb.code).toBe(2);
    expect(unknownVerb.stderr).toStartWith("'nope' isn't a lia mcp command.\nusage: lia mcp COMMAND\n");
    const badFlag = await mcp(root, "logout", "--json", "x");
    expect(badFlag.code).toBe(2);
    expect(badFlag.stderr).toBe("lia mcp logout: unknown flag --json\nusage: lia mcp logout NAME\n");

    for (const [args, message] of [
      [["auth", "x"], "lia mcp auth is now lia mcp login NAME.\n"],
      [["trust", "approve", "x"], "lia mcp trust is now lia mcp approve NAME and lia mcp reject NAME.\n"],
      [["path"], "lia mcp path is gone: lia mcp list shows each server's file.\n"],
      [["list", "--connect"], "lia mcp list --connect is now lia mcp show NAME.\n"],
    ] as const) {
      const old = await mcp(root, ...args);
      expect(old.code).toBe(2);
      expect(old.stderr).toBe(message);
      expect(old.stdout).toBe("");
    }
    expect(existsSync(root.profilePath)).toBe(false);
  });

  test("lia mcp commands keep a trace when LIA_TRACE_LOG asks for one", async () => {
    const root = createRoot({ mcp: { noisy: { command: "sh", args: ["-c", "echo trace-me >&2; exit 3"], startup_timeout_ms: 2_000 } } });
    const trace = join(root.home, "trace.log");
    const show = await runLia(["mcp", "show", "noisy"], { cwd: root.workspace, env: { ...root.env, LIA_TRACE_LOG: trace, LIA_TRACE_SCOPES: "mcp" }, timeoutMs: 20_000 });
    expect(show.signal).toBeNull();
    expect(existsSync(trace)).toBe(true);
    expect(readFileSync(trace, "utf8")).toContain("line=trace-me");
  }, 30_000);
});

describe("/mcp in the shell", () => {

});

describe("lia ask", () => {
  test("lia ask names unapproved project servers and the command that approves them", async () => {
    const root = createRoot(undefined, { mcpServers: { proj: fixtureServer() } });
    gateway = startFakeGateway([fakeGatewayFinalText("done")], { models: [{ id: "openai/gpt-5", type: "language", tags: ["tool-use"] }] });
    const result = await runLia(["ask", "--no-save", "hello"], {
      cwd: root.workspace,
      env: { ...root.env, LIA_GATEWAY_BASE_URL: gateway.baseUrl, LIA_GATEWAY_CHAT_URL: gateway.chatUrl, LIA_MODEL: "openai/gpt-5" },
      timeoutMs: 30_000,
    });
    expect(result.stderr).toContain("lia ask: skipped unapproved project MCP servers: proj. Approve with lia mcp approve <name> before retrying.");
    expect(result.stderr).not.toContain("trust");
  }, 60_000);

  test("a project server whose name holds an escape sequence is skipped with an escaped note, never printed raw", async () => {
    // An OSC sequence that would retitle the terminal if printed as is.
    const evil = "evil\u001b]0;pwned\u0007";
    const root = createRoot(undefined, { mcpServers: { proj: fixtureServer(), [evil]: fixtureServer() } });
    const note = "note: .mcp.json server 'evil\\x1b]0;pwned\\x07' was skipped: its name has a character lia won't print.";

    const list = await runLia(["mcp", "list"], { cwd: root.workspace, env: root.env, timeoutMs: 30_000 });
    expect(list.code).toBe(0);
    expect(list.stderr).toContain(note);
    expect(list.stdout).toContain("proj");
    expect(list.stdout).not.toContain("evil");
    expect(list.stdout + list.stderr).not.toContain("\u001b");

    gateway = startFakeGateway([fakeGatewayFinalText("done")], { models: [{ id: "openai/gpt-5", type: "language", tags: ["tool-use"] }] });
    const ask = await runLia(["ask", "--no-save", "hello"], {
      cwd: root.workspace,
      env: { ...root.env, LIA_GATEWAY_BASE_URL: gateway.baseUrl, LIA_GATEWAY_CHAT_URL: gateway.chatUrl, LIA_MODEL: "openai/gpt-5" },
      timeoutMs: 30_000,
    });
    expect(ask.stderr).toContain(note);
    expect(ask.stderr).toContain("lia ask: skipped unapproved project MCP servers: proj. Approve");
    expect(ask.stdout + ask.stderr).not.toContain("\u001b");
  }, 60_000);

  test("a profile with both mcp and mcpServers names each server it leaves out", async () => {
    const root = createRoot({ mcp: { alpha: fixtureServer() }, mcpServers: { beta: fixtureServer() } });
    const note = "note: ~/.lia/mcp.json server 'beta' was skipped: the file has both \"mcp\" and \"mcpServers\", and lia reads only \"mcp\"; merge them into one.";

    const list = await runLia(["mcp", "list"], { cwd: root.workspace, env: root.env, timeoutMs: 30_000 });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("alpha");
    expect(list.stdout).not.toContain("beta");
    expect(list.stderr).toContain(note);

    gateway = startFakeGateway([fakeGatewayFinalText("done")], { models: [{ id: "openai/gpt-5", type: "language", tags: ["tool-use"] }] });
    const ask = await runLia(["ask", "--no-save", "hello"], {
      cwd: root.workspace,
      env: { ...root.env, LIA_GATEWAY_BASE_URL: gateway.baseUrl, LIA_GATEWAY_CHAT_URL: gateway.chatUrl, LIA_MODEL: "openai/gpt-5" },
      timeoutMs: 30_000,
    });
    expect(ask.code).toBe(0);
    expect(ask.stderr).toContain(note);
  }, 60_000);
});
