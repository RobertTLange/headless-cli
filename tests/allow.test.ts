import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAgentCommand, buildInteractiveAgentCommand } from "../src/agents.ts";
import { runCli } from "../src/cli.ts";
import { quoteCommand } from "../src/shell.ts";

async function writeExecutable(path: string, source: string): Promise<void> {
  await import("node:fs/promises").then(async ({ chmod, writeFile }) => {
    await writeFile(path, source);
    await chmod(path, 0o755);
  });
}

test("builds read-only commands for supported agents", () => {
  assert.deepEqual(buildAgentCommand("codex", { prompt: "hello", allow: "read-only" }, {}), {
    command: "codex",
    args: [
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-",
    ],
    stdinText: "hello",
  });

  assert.deepEqual(buildAgentCommand("claude", { prompt: "hello", allow: "read-only" }, {}), {
    command: "claude",
    args: ["-p", "hello", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", allow: "read-only" }, {}), {
    command: "agent",
    args: ["-p", "--output-format", "stream-json", "--mode", "plan", "hello"],
  });

  assert.deepEqual(buildAgentCommand("gemini", { prompt: "hello", allow: "read-only" }, {}), {
    command: "gemini",
    args: ["-p", "hello", "--output-format", "stream-json", "--approval-mode", "plan"],
  });

  assert.deepEqual(buildAgentCommand("opencode", { prompt: "hello", allow: "read-only" }, {}), {
    command: "opencode",
    args: ["run", "--format", "json", "hello"],
    env: {
      OPENCODE_CONFIG_CONTENT:
        '{"permission":{"edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","task":"deny"}}',
    },
  });

  assert.deepEqual(buildAgentCommand("pi", { prompt: "hello", allow: "read-only" }, {}), {
    command: "pi",
    args: ["--no-session", "--mode", "json", "--tools", "read,grep,find,ls", "hello"],
  });
});

test("builds explicit yolo commands for supported agents", () => {
  assert.deepEqual(buildAgentCommand("codex", { prompt: "hello", allow: "yolo" }, {}).args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);
  assert.deepEqual(buildAgentCommand("claude", { prompt: "hello", allow: "yolo" }, {}).args, [
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ]);
  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", allow: "yolo" }, {}).args, [
    "-p",
    "--force",
    "--output-format",
    "stream-json",
    "hello",
  ]);
  assert.deepEqual(buildAgentCommand("gemini", { prompt: "hello", allow: "yolo" }, {}).args, [
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--approval-mode",
    "yolo",
  ]);
  assert.deepEqual(buildAgentCommand("opencode", { prompt: "hello", allow: "yolo" }, {}).args, [
    "run",
    "--format",
    "json",
    "--dangerously-skip-permissions",
    "hello",
  ]);
  assert.deepEqual(buildAgentCommand("pi", { prompt: "hello", allow: "yolo" }, {}).args, [
    "--no-session",
    "--mode",
    "json",
    "--tools",
    "read,bash,edit,write",
    "hello",
  ]);
});

test("defaults to yolo commands for supported agents", () => {
  const agents = ["claude", "codex", "cursor", "gemini", "opencode", "pi"] as const;

  for (const agent of agents) {
    assert.deepEqual(
      buildAgentCommand(agent, { prompt: "hello" }, {}),
      buildAgentCommand(agent, { prompt: "hello", allow: "yolo" }, {}),
    );
    assert.deepEqual(
      buildInteractiveAgentCommand(agent, { prompt: "hello" }, {}),
      buildInteractiveAgentCommand(agent, { prompt: "hello", allow: "yolo" }, {}),
    );
  }
});

test("builds read-only interactive commands for tmux mode", () => {
  assert.deepEqual(buildInteractiveAgentCommand("codex", { prompt: "hello", allow: "read-only" }, {}), {
    command: "codex",
    args: ["--sandbox", "read-only", "--ask-for-approval", "never", "hello"],
  });
  assert.deepEqual(buildInteractiveAgentCommand("claude", { prompt: "hello", allow: "read-only" }, {}), {
    command: "claude",
    args: ["--permission-mode", "plan", "hello"],
  });
  assert.deepEqual(buildInteractiveAgentCommand("gemini", { prompt: "hello", allow: "read-only" }, {}), {
    command: "gemini",
    args: ["--skip-trust", "--approval-mode", "plan", "hello"],
  });
  assert.deepEqual(buildInteractiveAgentCommand("opencode", { prompt: "hello", allow: "read-only" }, {}), {
    command: "opencode",
    args: [],
    env: {
      OPENCODE_CONFIG_CONTENT:
        '{"permission":{"edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","task":"deny"}}',
    },
  });
});

test("quotes command environment overrides for print-command output", () => {
  assert.equal(
    quoteCommand({
      command: "opencode",
      args: ["run", "--format", "json", "hello"],
      env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"deny"}}' },
    }),
    "OPENCODE_CONFIG_CONTENT='{\"permission\":{\"edit\":\"deny\"}}' opencode run --format json hello",
  );
});

test("CLI rejects invalid allow mode", async () => {
  const stderr: string[] = [];
  const code = await runCli(["codex", "--allow", "maybe", "--prompt", "hello"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /unsupported allow mode: maybe/);
});

test("CLI rejects invalid reasoning effort", async () => {
  const stderr: string[] = [];
  const code = await runCli(["codex", "--reasoning-effort", "max", "--prompt", "hello"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /unsupported reasoning effort: max/);
});

test("CLI print-command includes allow mode flags", async () => {
  const stdout: string[] = [];
  const code = await runCli(["gemini", "--allow", "read-only", "--prompt", "hello", "--print-command"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.equal(stdout.join(""), "gemini -p hello --output-format stream-json --approval-mode plan\n");
});

test("CLI print-command includes reasoning effort flags", async () => {
  const stdout: string[] = [];
  const code = await runCli(["codex", "--reasoning-effort", "high", "--prompt", "hello", "--print-command"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /-c 'model_reasoning_effort="high"'/);
});

test("CLI warns when reasoning effort is unsupported", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["cursor", "--reasoning-effort", "high", "--prompt", "hello", "--print-command"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 0);
  assert.equal(stdout.join(""), "agent -p --force --output-format stream-json hello\n");
  assert.match(stderr.join(""), /reasoning effort is not supported by cursor and was ignored/);
});

test("CLI warns when Gemini reasoning effort is unsupported", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["gemini", "--reasoning-effort", "high", "--prompt", "hello", "--print-command"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 0);
  assert.equal(stdout.join(""), "gemini -p hello --output-format stream-json --approval-mode yolo\n");
  assert.match(stderr.join(""), /reasoning effort is not supported by gemini and was ignored/);
});

test("CLI tmux print-command includes reasoning effort flags", async () => {
  const stdout: string[] = [];
  const code = await runCli(["codex", "--tmux", "--reasoning-effort", "high", "--prompt", "hello", "--print-command"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /codex .* -c '\\''model_reasoning_effort="high"'\\'' hello/);
});

test("CLI tmux warns when reasoning effort is unsupported", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["opencode", "--tmux", "--reasoning-effort", "high", "--prompt", "hello", "--print-command"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /opencode --dangerously-skip-permissions/);
  assert.match(stderr.join(""), /reasoning effort is not supported by opencode in tmux mode and was ignored/);
});

test("CLI tmux print-command includes allow mode flags", async () => {
  const stdout: string[] = [];
  const code = await runCli(["codex", "--tmux", "--allow", "read-only", "--prompt", "hello", "--print-command"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /codex --sandbox read-only --ask-for-approval never hello/);
});

test("CLI execution passes command environment overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-allow-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "env.txt");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "opencode"),
      [
        "#!/bin/sh",
        "printf '%s' \"$OPENCODE_CONFIG_CONTENT\" > \"$HEADLESS_CAPTURE\"",
        "printf '%s\\n' '{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}'",
        "",
      ].join("\n"),
    );

    const code = await runCli(["opencode", "--allow", "read-only", "--prompt", "hello"], {
      env: { ...process.env, HEADLESS_CAPTURE: captureFile, PATH: binDir },
      stdout: () => undefined,
    });

    assert.equal(code, 0);
    assert.match(readFileSync(captureFile, "utf8"), /"edit":"deny"/);
    assert.match(readFileSync(captureFile, "utf8"), /"bash":"deny"/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
