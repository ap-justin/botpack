import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { runLia } from "../evals/eval-helpers";
import {
  FAKE_GATEWAY_MODEL,
  fakeGatewayFinalText,
  fakeGatewaySerializedToolCall,
  fakeGatewaySse,
  fakeGatewayToolCall,
  startFakeGateway,
} from "./fake-gateway";

// `lia ask` as a script sees it: stdout and stderr redirected, no terminal.

const TIMEOUT = 30_000;
const MARKDOWN =
  "# Ask presentation\n\n" +
  "**bold** and [docs](https://example.com)\n\n" +
  "- first item\n- second item\n\n---\n\n" +
  "| Name | Value |\n| --- | --- |\n| one | two |\n\n" +
  "```zig\nconst answer: u8 = 42;\n```\n";

type GatewayRequestBody = {
  prompt: Array<{ role: string; content: unknown }>;
};

const roots: string[] = [];
const gateways: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "lia-e2e-ask-presentation-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  roots.push(root);
  return { root, home: realpathSync(home), workspace: realpathSync(workspace) };
}

function gatewayEnv(
  home: string,
  gateway: ReturnType<typeof startFakeGateway>,
): Record<string, string | undefined> {
  return {
    HOME: home,
    AI_GATEWAY_API_KEY: "fake-ask-presentation-key",
    VERCEL_OIDC_TOKEN: undefined,
    LIA_DISABLE_KEYCHAIN: "1",
    LIA_TEST_SKIP_ONBOARDING: "1",
    LIA_MODEL: FAKE_GATEWAY_MODEL,
    LIA_PERMISSION_MODE: "auto",
    LIA_GATEWAY_BASE_URL: gateway.baseUrl,
    LIA_GATEWAY_CHAT_URL: gateway.chatUrl,
    LIA_TEST_GATEWAY_MODELS_URL: `${gateway.baseUrl}/coding-agent/v1/models`,
  };
}

describe("lia ask presentation", () => {
  test("redirected command output separates the next tool header", async () => {
    const root = createRoot();
    const gateway = startFakeGateway([
      fakeGatewaySse([
        {
          type: "tool-call",
          toolCallId: "no-final-newline",
          toolName: "shell",
          input: { request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: "printf no-final-newline" } },
        },
        {
          type: "tool-call",
          toolCallId: "next-command",
          toolName: "shell",
          input: { request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: "printf 'next-output\\n'" } },
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
        },
      ]),
      fakeGatewayFinalText("Commands complete.\n"),
    ]);
    gateways.push(gateway);

    const result = await runLia(
      ["ask", "--json", "--yolo", "--no-save", "--no-color", "Run both commands."],
      {
        cwd: root.workspace,
        env: gatewayEnv(root.home, gateway),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Running printf no-final-newline\n");
    expect(result.stderr).toContain("Running printf 'next-output\\n'\n");
    expect(JSON.parse(result.stdout).output).toBe("Commands complete.\n");
  }, TIMEOUT);

  test("no-save advertises process-local shell actions and preserves run profiles", async () => {
    const configuredShell = userInfo().shell;
    if (!configuredShell.endsWith("/bash") && !configuredShell.endsWith("/zsh")) return;

    const root = createRoot();
    if (configuredShell.endsWith("/zsh")) {
      writeFileSync(
        join(root.home, ".zprofile"),
        "export LIA_PROFILE_LOGIN=login\nexport PATH=\"$HOME/profile-bin:$PATH\"\n",
      );
      writeFileSync(
        join(root.home, ".zshrc"),
        "export LIA_PROFILE_RC=rc\nalias lia_profile_alias='printf alias-user'\n" +
          "lia_profile_function() { printf function-user; }\n",
      );
    } else {
      writeFileSync(
        join(root.home, ".bash_profile"),
        "export LIA_PROFILE_LOGIN=login\nexport PATH=\"$HOME/profile-bin:$PATH\"\n" +
          "source \"$HOME/.bashrc\"\n",
      );
      writeFileSync(
        join(root.home, ".bashrc"),
        "export LIA_PROFILE_RC=rc\nalias lia_profile_alias='printf alias-user'\n" +
          "lia_profile_function() { printf function-user; }\n",
      );
    }

    const profileCommand =
      "printf 'mode=%s:%s:' \"${LIA_PROFILE_LOGIN-unset}\" \"${LIA_PROFILE_RC-unset}\"; " +
      "case :\"$PATH\": in *:\"$HOME/profile-bin\":*) printf 'path-user:';; *) printf 'path-clean:';; esac; " +
      "if alias lia_profile_alias >/dev/null 2>&1; then lia_profile_alias; else printf no-alias; fi; printf ':'; " +
      "if command -v lia_profile_function >/dev/null; then lia_profile_function; else printf no-function; fi";
    const nestedExecMarker = join(root.workspace, "nested-no-save-ran");
    const gateway = startFakeGateway([
      fakeGatewayToolCall("shell-omitted", "shell", {
        request: { action: "run", command: profileCommand, yield_time_ms: 30_000 },
      }),
      fakeGatewayToolCall("shell-clean", "shell", {
        request: { action: "run", command: profileCommand, profile: "clean", yield_time_ms: 30_000 },
      }),
      fakeGatewayToolCall("shell-user", "shell", {
        request: { action: "run", command: profileCommand, profile: "user", yield_time_ms: 30_000 },
      }),
      fakeGatewayToolCall("shell-stale-tty", "shell", {
        request: {
          action: "run",
          command: "printf should-not-start",
          tty: true,
        },
      }),
      fakeGatewayToolCall("shell-nested-run", "shell", {
        request: {
          action: "run",
          profile: "clean",
          yield_time_ms: 30_000,
          command: `printf nested > ${JSON.stringify(nestedExecMarker)}`,
        },
      }),
      fakeGatewayToolCall("shell-neighbor-run", "shell", {
        request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: "printf neighbor-exec" },
      }),
      fakeGatewayFinalText("Shell no-save profiles verified.\n"),
    ]);
    gateways.push(gateway);

    const result = await runLia(
      ["ask", "--json", "--yolo", "--no-save", "Verify shell run profiles."],
      {
        cwd: root.workspace,
        env: gatewayEnv(root.home, gateway),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      output: string;
      tool_calls: Array<{ name: string; status: string }>;
    };
    expect(output.output).toBe("Shell no-save profiles verified.\n");
    expect(output.tool_calls.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "shell", status: "success" },
      { name: "shell", status: "success" },
      { name: "shell", status: "success" },
      { name: "shell", status: "error" },
      { name: "shell", status: "success" },
      { name: "shell", status: "success" },
    ]);
    expect(gateway.requests).toHaveLength(7);

    const firstRequest = JSON.parse(gateway.requests[0]!.body) as {
      tools: Array<any>;
    };
    const shellTool = firstRequest.tools.find(({ name }) => name === "shell");
    const shellSchema = shellTool?.inputSchema;
    // No-save asks advertise the process-only fields, flat with one action enum.
    expect(Object.keys(shellSchema?.properties ?? {})).toEqual([
      "action",
      "command",
      "cwd",
      "profile",
      "yield_time_ms",
      "timeout_ms",
      "session_id",
      "force",
    ]);
    expect(shellSchema?.required).toEqual(["action"]);
    expect(shellSchema?.additionalProperties).toBe(false);
    expect(shellSchema?.properties?.action?.enum).toEqual(["run", "interact", "stop"]);
    const serializedShellTool = JSON.stringify(shellTool);
    expect(serializedShellTool).not.toContain('"tty"');
    expect(serializedShellTool).not.toContain('"write"');
    expect(serializedShellTool).not.toContain('"terminal"');

    for (const requestIndex of [1, 3]) {
      expect(gateway.requests[requestIndex]!.body).toContain("mode=login:rc:path-user:");
      expect(gateway.requests[requestIndex]!.body).toContain("alias-user:function-user");
    }
    expect(gateway.requests[2]!.body).toContain("mode=unset:unset:path-clean:");
    expect(gateway.requests[2]!.body).toContain("no-alias:no-function");
    expect(gateway.requests[4]!.body).toContain("tool_execution_failed");
    expect(gateway.requests[4]!.body).toContain("tool_execution_failed");
    expect(gateway.requests[4]!.body).not.toContain("authority_denied");
    expect(gateway.requests[4]!.body).not.toContain("tool_permission_denied");
    expect(gateway.requests[5]!.body).toContain("nested");
    expect(existsSync(nestedExecMarker)).toBe(true);
    expect(gateway.requests[6]!.body).toContain("neighbor-exec");
    // The refused tty run never reached the terminal store.
    expect(
      existsSync(join(root.home, ".lia"))
        ? Array.from(new Bun.Glob("**/terminal/state/record-*.json").scanSync({
          cwd: join(root.home, ".lia"),
          dot: true,
        }))
        : [],
    ).toEqual([]);
  }, TIMEOUT);

  test("redirected and JSON stdout preserve raw assistant Markdown", async () => {
    const root = createRoot();
    const rawGateway = startFakeGateway([fakeGatewayFinalText(MARKDOWN)]);
    gateways.push(rawGateway);
    const raw = await runLia(["ask", "--no-save", "Render the fixture."], {
      cwd: root.workspace,
      env: gatewayEnv(root.home, rawGateway),
      timeoutMs: TIMEOUT,
    });

    expect(raw.code).toBe(0);
    expect(raw.stdout).toBe(MARKDOWN);
    expect(raw.stdout).not.toContain("\x1b");
    expect(raw.stderr).toBe("");

    const jsonGateway = startFakeGateway([fakeGatewayFinalText(MARKDOWN)]);
    gateways.push(jsonGateway);
    const json = await runLia(
      ["ask", "--json", "--no-save", "Render the fixture."],
      {
        cwd: root.workspace,
        env: gatewayEnv(root.home, jsonGateway),
        timeoutMs: TIMEOUT,
      },
    );

    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).output).toBe(MARKDOWN);
    expect(json.stdout).not.toContain("\x1b");
    expect(json.stderr).toBe("");
  }, TIMEOUT);

  test("JSON separates accumulated assistant Markdown from the completed final response", async () => {
    const root = createRoot();
    writeFileSync(join(root.workspace, "fixture.txt"), "fixture contents\n");
    const intermediate = "I will inspect the fixture first.\n";
    const final = "The fixture inspection is complete.";
    const gateway = startFakeGateway([
      fakeGatewaySerializedToolCall(
        "read_fixture_for_final_output",
        "read_file",
        JSON.stringify({ path: "fixture.txt" }),
        intermediate,
      ),
      fakeGatewayFinalText(final),
    ]);
    gateways.push(gateway);

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Inspect fixture.txt."],
      {
        cwd: root.workspace,
        env: gatewayEnv(root.home, gateway),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      output: string;
      final_output: string;
      tool_calls: Array<{ name: string; status: string }>;
    };
    expect(output.output).toContain(intermediate.trim());
    expect(output.output).toContain(final.trim());
    expect(output.output.indexOf(intermediate.trim())).toBeLessThan(
      output.output.indexOf(final.trim()),
    );
    expect(output.final_output).toBe(final);
    expect(output.final_output).not.toContain(intermediate.trim());
    expect(output.tool_calls).toEqual([
      { name: "read_file", status: "success" },
    ]);
    expect(gateway.requests).toHaveLength(2);
    expect(result.stderr).toContain("Reading fixture.txt");
  }, TIMEOUT);

  test("tool recovery keeps progress updates ordered before the final response", async () => {
    const root = createRoot();
    writeFileSync(join(root.workspace, "fallback.txt"), "fallback contents\n");
    const initial = "I will inspect the requested file first.";
    const recovery = "The requested file was missing, so I will inspect fallback.txt next.";
    const final = "The fallback inspection is complete.";
    const gateway = startFakeGateway([
      fakeGatewaySerializedToolCall(
        "read_missing_for_progress",
        "read_file",
        JSON.stringify({ path: "missing.txt" }),
        initial,
      ),
      fakeGatewaySerializedToolCall(
        "read_fallback_for_progress",
        "read_file",
        JSON.stringify({ path: "fallback.txt" }),
        recovery,
      ),
      fakeGatewayFinalText(final),
    ]);
    gateways.push(gateway);

    const result = await runLia(
      ["ask", "--json", "--auto", "--no-save", "Inspect missing.txt and recover with fallback.txt."],
      {
        cwd: root.workspace,
        env: gatewayEnv(root.home, gateway),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    expect(gateway.requests).toHaveLength(3);
    const firstPrompt = (JSON.parse(gateway.requests[0]!.body) as GatewayRequestBody)
      .prompt
      .filter((message) => message.role === "system")
      .map((message) => typeof message.content === "string" ? message.content : "")
      .join("\n");
    expect(firstPrompt).toContain(
      "Before the first tool call in a tool-driven task, always send one brief user-visible update",
    );
    expect(firstPrompt).toContain("Never start the first tool silently.");
    expect(firstPrompt).toContain(
      "If another tool call will follow, always first tell the user what failed",
    );
    expect(firstPrompt).toContain("Do not narrate each routine tool call.");

    const output = JSON.parse(result.stdout) as {
      output: string;
      final_output: string;
      tool_calls: Array<{ name: string; status: string }>;
    };
    expect(output.output).toContain(initial);
    expect(output.output).toContain(recovery);
    expect(output.output).toContain(final);
    expect(output.output.indexOf(initial)).toBeLessThan(
      output.output.indexOf(recovery),
    );
    expect(output.output.indexOf(recovery)).toBeLessThan(
      output.output.indexOf(final),
    );
    expect(output.final_output).toBe(final);
    expect(output.tool_calls).toEqual([
      { name: "read_file", status: "error" },
      { name: "read_file", status: "success" },
    ]);
    expect(gateway.requests[1]!.body).toContain("Path not found: missing.txt");
    expect(gateway.requests[2]!.body).toContain(recovery);
    expect(result.stderr).toContain("Reading missing.txt");
    expect(result.stderr).toContain("Reading fallback.txt");
  }, TIMEOUT);
});

function userShellRun(id: string, command: string) {
  return fakeGatewayToolCall(id, "shell", {
    request: { action: "run", command, yield_time_ms: 30_000 },
  });
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// Both login shells read these files, so the tests hold for zsh and bash.
function writeStartupFiles(home: string, body: string): void {
  writeFileSync(join(home, ".zshrc"), body);
  writeFileSync(join(home, ".bash_profile"), body);
}

function startupLoads(home: string): number {
  const log = join(home, "rc.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
}

describe("lia ask shell startup files", () => {
  test("user-profile commands load startup files once and reload after an edit", async () => {
    const root = createRoot();
    writeStartupFiles(
      root.home,
      "printf 'loaded\\n' >> \"$HOME/rc.log\"\n" +
        "export PATH=\"$HOME/lia-startup-marker:$PATH\"\n",
    );
    const edit = "for f in ~/.zshrc ~/.bash_profile; do " +
      "printf '%s\\n' \"alias fxlate='printf LIA_RELOADED_ALIAS'\" >> \"$f\"; done";
    const gateway = startFakeGateway([
      userShellRun("path-0", "echo \"PATH=$PATH\""),
      userShellRun("path-1", "echo \"PATH=$PATH\""),
      userShellRun("path-2", "echo \"PATH=$PATH\""),
      userShellRun("edit", edit),
      userShellRun("reloaded", "fxlate"),
      fakeGatewayFinalText("Startup files checked.\n"),
    ]);
    gateways.push(gateway);

    const result = await runLia(
      ["ask", "--json", "--yolo", "--no-save", "Check the startup files."],
      { cwd: root.workspace, env: gatewayEnv(root.home, gateway), timeoutMs: TIMEOUT },
    );

    expect(result.code).toBe(0);
    const marker = `${root.home}/lia-startup-marker:`;
    for (const index of [1, 2, 3]) {
      expect(gateway.requests[index]!.body).toContain(`PATH=${marker}`);
    }
    expect(gateway.requests[5]!.body).toContain("LIA_RELOADED_ALIAS");
    // One capture, and one more after the edit: never once per command.
    expect(startupLoads(root.home)).toBe(2);
    expect(result.stderr).not.toContain("shell snapshot unavailable");
  }, TIMEOUT);

  test("a user-profile command with a quoting error carries rewrite guidance", async () => {
    const root = createRoot();
    const gateway = startFakeGateway([
      userShellRun("unmatched", "echo \"oops"),
      fakeGatewayFinalText("Guidance checked.\n"),
    ]);
    gateways.push(gateway);

    const result = await runLia(
      ["ask", "--json", "--yolo", "--no-save", "Check the guidance."],
      { cwd: root.workspace, env: { ...gatewayEnv(root.home, gateway), LIA_SOUND: "0" }, timeoutMs: TIMEOUT },
    );

    expect(result.code).toBe(0);
    // The snapshot runs the command through eval, so zsh reports the error as
    // `(eval):1:` and bash as `/dev/fd/0: eval:` instead of under the shell's name.
    expect(result.stderr).not.toContain("shell snapshot unavailable");
    expect(gateway.requests[1]!.body).toMatch(/\(eval\):1:|\/dev\/fd\/0: eval:/);
    expect(gateway.requests[1]!.body).toContain("The shell could not parse this command");
  }, TIMEOUT);

  test("startup files the snapshot cannot capture fall back with one notice", async () => {
    const root = createRoot();
    // A 9 MB alias exceeds the 8 MiB capture limit, while full startup still
    // works for every command.
    writeStartupFiles(
      root.home,
      "printf 'loaded\\n' >> \"$HOME/rc.log\"\n" +
        "alias fxbig=\"$(head -c 9000000 /dev/zero | tr '\\0' x)\"\n" +
        "alias fxsmall='printf LIA_FULL_STARTUP_ALIAS'\n",
    );
    const gateway = startFakeGateway([
      userShellRun("first", "fxsmall"),
      userShellRun("second", "fxsmall"),
      fakeGatewayFinalText("Fallback checked.\n"),
    ]);
    gateways.push(gateway);

    const result = await runLia(
      ["ask", "--json", "--yolo", "--no-save", "Check the fallback."],
      { cwd: root.workspace, env: gatewayEnv(root.home, gateway), timeoutMs: TIMEOUT },
    );

    expect(result.code).toBe(0);
    const notice = "shell snapshot unavailable (the captured state exceeded 8 MiB)";
    expect(occurrences(result.stderr, `lia ask: warning: ${notice}`)).toBe(1);
    expect(occurrences(gateway.requests[1]!.body, notice)).toBe(1);
    // The later request repeats the history, so one notice in total.
    expect(occurrences(gateway.requests[2]!.body, notice)).toBe(1);
    expect(occurrences(gateway.requests[2]!.body, "LIA_FULL_STARTUP_ALIAS")).toBe(2);
    // The failed capture plus one full startup per command.
    expect(startupLoads(root.home)).toBe(3);
  }, TIMEOUT);

  test("a fallback notice still appears when the snapshot recovers in the same run", async () => {
    const root = createRoot();
    // The first startup run, the capture, kills its own shell; later runs work.
    writeStartupFiles(
      root.home,
      "if [ ! -e \"$HOME/fault-fired\" ]; then : > \"$HOME/fault-fired\"; kill -9 $$; fi\n" +
        "alias fxa='printf LIA_RECOVERY_ALIAS'\n",
    );
    const gateway = startFakeGateway([
      userShellRun("fallback", "fxa"),
      userShellRun("edit", "printf '# edited\\n' >> ~/.zshrc; printf '# edited\\n' >> ~/.bash_profile"),
      userShellRun("recovered", "fxa"),
      fakeGatewayFinalText("Recovery checked.\n"),
    ]);
    gateways.push(gateway);

    const result = await runLia(
      ["ask", "--json", "--yolo", "--no-save", "Check recovery."],
      { cwd: root.workspace, env: gatewayEnv(root.home, gateway), timeoutMs: TIMEOUT },
    );

    expect(result.code).toBe(0);
    expect(existsSync(join(root.home, "fault-fired"))).toBe(true);
    const notice = "lia ask: warning: shell snapshot unavailable (the login shell exited before reporting its state)";
    expect(occurrences(result.stderr, notice)).toBe(1);
    expect(gateway.requests[3]!.body).toContain("LIA_RECOVERY_ALIAS");
  }, TIMEOUT);
});
