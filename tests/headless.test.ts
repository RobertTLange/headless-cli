import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAgentCommand, getAgentConfig, listAgents } from "../src/agents.ts";
import { runCli } from "../src/cli.ts";
import { quoteCommand } from "../src/shell.ts";

test("lists all supported agents", () => {
  assert.deepEqual(listAgents(), ["claude", "codex", "cursor", "gemini", "opencode", "pi"]);
});

test("builds codex command with default model and prompt argument", () => {
  const command = buildAgentCommand("codex", { prompt: "hello world" }, {});

  assert.deepEqual(command, {
    command: "codex",
    args: [
      "exec",
      "--model",
      "gpt-5.2",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "hello world",
    ],
  });
});

test("builds codex command using CODEX_MODEL fallback", () => {
  const command = buildAgentCommand("codex", { prompt: "hello" }, { CODEX_MODEL: "gpt-next" });

  assert.equal(command.args[2], "gpt-next");
});

test("builds prompt-file stdin commands for codex, claude, and gemini", () => {
  assert.deepEqual(buildAgentCommand("codex", { prompt: "", promptFile: "prompt.md", model: "m" }, {}), {
    command: "codex",
    args: [
      "exec",
      "--model",
      "m",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-",
    ],
    stdinFile: "prompt.md",
  });

  assert.deepEqual(buildAgentCommand("claude", { prompt: "", promptFile: "prompt.md", model: "sonnet" }, {}), {
    command: "claude",
    args: [
      "--model",
      "sonnet",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    stdinFile: "prompt.md",
  });

  assert.deepEqual(buildAgentCommand("gemini", { prompt: "", promptFile: "prompt.md", model: "gemini-pro" }, {}), {
    command: "gemini",
    args: ["--model", "gemini-pro", "--prompt", "", "--output-format", "stream-json", "--yolo"],
    stdinFile: "prompt.md",
  });
});

test("builds claude, cursor, gemini, opencode, and pi prompt commands", () => {
  assert.deepEqual(buildAgentCommand("claude", { prompt: "hello", model: "sonnet" }, {}), {
    command: "claude",
    args: [
      "--model",
      "sonnet",
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", model: "cursor-model" }, {}), {
    command: "agent",
    args: ["-p", "--force", "--output-format", "stream-json", "--model", "cursor-model", "hello"],
  });

  assert.deepEqual(buildAgentCommand("gemini", { prompt: "hello", model: "gemini-model" }, {}), {
    command: "gemini",
    args: ["--model", "gemini-model", "-p", "hello", "--output-format", "stream-json", "--yolo"],
  });

  assert.deepEqual(buildAgentCommand("opencode", { prompt: "hello", model: "oc-model" }, {}), {
    command: "opencode",
    args: ["run", "--format", "json", "--model", "oc-model", "hello"],
  });

  assert.deepEqual(buildAgentCommand("pi", { prompt: "hello", model: "pi-model" }, {}), {
    command: "pi",
    args: ["--no-session", "--mode", "json", "--model", "pi-model", "hello"],
  });
});

test("forwards cursor and pi environment-backed options", () => {
  assert.deepEqual(
    buildAgentCommand(
      "cursor",
      { prompt: "hello" },
      { CURSOR_CLI_BIN: "cursor-agent", CURSOR_API_KEY: "key-123" },
    ),
    {
      command: "cursor-agent",
      args: ["--api-key", "key-123", "-p", "--force", "--output-format", "stream-json", "hello"],
    },
  );

  assert.deepEqual(
    buildAgentCommand(
      "pi",
      { prompt: "hello" },
      {
        PI_CODING_AGENT_BIN: "pi-agent",
        PI_CODING_AGENT_PROVIDER: "bedrock",
        PI_CODING_AGENT_MODEL: "opus",
        PI_CODING_AGENT_MODELS: "opus,sonnet",
      },
    ),
    {
      command: "pi-agent",
      args: [
        "--no-session",
        "--mode",
        "json",
        "--provider",
        "bedrock",
        "--model",
        "opus",
        "--models",
        "opus,sonnet",
        "hello",
      ],
    },
  );
});

test("exposes config metadata", () => {
  assert.deepEqual(getAgentConfig("opencode"), {
    name: "opencode",
    promptFileMode: "argument",
    configRelDir: ".config/opencode",
    workspaceConfigRelDir: ".opencode",
    seedPaths: [".config/opencode"],
  });
});

test("quotes commands for print-command output", () => {
  assert.equal(
    quoteCommand({ command: "codex", args: ["exec", "hello world"], stdinFile: "/tmp/prompt file.md" }),
    "codex exec hello\\ world < /tmp/prompt\\ file.md",
  );
});

test("CLI print-command reads argument-mode prompt files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "from file");
    const stdout: string[] = [];

    const code = await runCli(["opencode", "--prompt-file", promptFile, "--print-command"], {
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "opencode run --format json from\\ file\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI accepts stdin fallback", async () => {
  const stdout: string[] = [];
  const code = await runCli(["pi", "--print-command"], {
    stdin: "stdin prompt",
    stdinIsTTY: false,
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.equal(stdout.join(""), "pi --no-session --mode json stdin\\ prompt\n");
});

test("CLI reports invalid input", async () => {
  const stderr: string[] = [];
  assert.equal(await runCli(["unknown", "--prompt", "hello"], { stderr: (text) => stderr.push(text) }), 2);
  assert.match(stderr.join(""), /unsupported agent/);

  stderr.length = 0;
  assert.equal(
    await runCli(["codex", "--prompt", "hello", "--prompt-file", "prompt.md"], { stderr: (text) => stderr.push(text) }),
    2,
  );
  assert.match(stderr.join(""), /use either --prompt or --prompt-file/);

  stderr.length = 0;
  assert.equal(await runCli(["codex"], { stdinIsTTY: true, stderr: (text) => stderr.push(text) }), 2);
  assert.match(stderr.join(""), /missing prompt/);
});

test("CLI validates work-dir", async () => {
  const stderr: string[] = [];
  const code = await runCli(["codex", "--prompt", "hello", "--work-dir", "/definitely/missing"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /work dir not found/);
});

test("CLI executes fake binaries and propagates exit codes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "capture.txt");
    writeFileSync(
      join(dir, "opencode"),
      "",
    );
    await import("node:fs/promises").then(async ({ mkdir, rename, chmod, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "opencode");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "fs.writeFileSync(process.env.HEADLESS_CAPTURE, process.argv.slice(2).join('|'));",
          "process.exit(7);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
      await rename(join(dir, "opencode"), join(dir, "unused"));
    });

    const code = await runCli(["opencode", "--prompt", "hello"], {
      env: { ...process.env, HEADLESS_CAPTURE: captureFile, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    assert.equal(code, 7);
    assert.equal(readFileSync(captureFile, "utf8"), "run|--format|json|hello");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
