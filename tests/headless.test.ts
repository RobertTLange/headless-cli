import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAgentCommand, buildInteractiveAgentCommand, getAgentConfig, listAgents } from "../src/agents.ts";
import { runCli } from "../src/cli.ts";
import { quoteCommand } from "../src/shell.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("lists all supported agents", () => {
  assert.deepEqual(listAgents(), ["claude", "codex", "cursor", "gemini", "opencode", "pi"]);
});

test("builds codex command with default model and prompt stdin", () => {
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
      "-",
    ],
    stdinText: "hello world",
  });
});

test("builds codex command using CODEX_MODEL fallback", () => {
  const command = buildAgentCommand("codex", { prompt: "hello" }, { CODEX_MODEL: "gpt-next" });

  assert.equal(command.args[2], "gpt-next");
  assert.equal(command.stdinText, "hello");
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

test("builds interactive commands for tmux mode", () => {
  assert.deepEqual(buildInteractiveAgentCommand("codex", { prompt: "hello", model: "gpt-next" }, {}), {
    command: "codex",
    args: ["--model", "gpt-next", "hello"],
  });

  assert.deepEqual(buildInteractiveAgentCommand("claude", { prompt: "hello", model: "sonnet" }, {}), {
    command: "claude",
    args: ["--model", "sonnet", "hello"],
  });

  assert.deepEqual(buildInteractiveAgentCommand("gemini", { prompt: "hello", model: "gemini-model" }, {}), {
    command: "gemini",
    args: ["--model", "gemini-model", "hello"],
  });

  assert.deepEqual(buildInteractiveAgentCommand("opencode", { prompt: "hello", model: "oc-model" }, {}), {
    command: "opencode",
    args: ["--model", "oc-model", "--prompt", "hello"],
  });

  assert.deepEqual(
    buildInteractiveAgentCommand(
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
      args: ["--provider", "bedrock", "--model", "opus", "--models", "opus,sonnet", "hello"],
    },
  );
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

test("quotes commands with stdin text for print-command output", () => {
  assert.equal(
    quoteCommand({ command: "codex", args: ["exec", "-"], stdinText: "hello world" }),
    "printf %s hello\\ world | codex exec -",
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

test("CLI auto-selects the preferred installed agent when omitted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      for (const name of ["claude", "codex", "pi"]) {
        const binary = join(binDir, name);
        await writeFile(binary, "#!/usr/bin/env node\n");
        await chmod(binary, 0o755);
      }
    });

    const stdout: string[] = [];
    const code = await runCli(["--prompt", "hello", "--print-command"], {
      env: { PATH: binDir },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^printf %s hello \| codex exec/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI auto-selection follows fallback order and env-backed binaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      for (const name of ["opencode", "pi-agent"]) {
        const binary = join(binDir, name);
        await writeFile(binary, "#!/usr/bin/env node\n");
        await chmod(binary, 0o755);
      }
    });

    const stdout: string[] = [];
    const code = await runCli(["--prompt", "hello", "--print-command"], {
      env: { PATH: binDir, PI_CODING_AGENT_BIN: "pi-agent" },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "pi-agent --no-session --mode json hello\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI reports when no installed agent can be auto-selected", async () => {
  const stderr: string[] = [];
  const code = await runCli(["--prompt", "hello"], {
    env: { PATH: "" },
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /no supported agent found/);
});

test("CLI prints final assistant message by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "pi");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["pi", "--prompt", "hello"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "final answer\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI does not pass inherited stdin to agent when prompt is an argument", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "stdin.txt");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "pi");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const stdin = fs.readFileSync(0, 'utf8');",
          "fs.writeFileSync(process.env.HEADLESS_STDIN_CAPTURE, stdin);",
          "console.log(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const code = await runCli(["pi", "--prompt", "hello"], {
      env: {
        ...process.env,
        HEADLESS_STDIN_CAPTURE: captureFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: () => undefined,
    });

    assert.equal(code, 0);
    assert.equal(readFileSync(captureFile, "utf8"), "");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --json prints raw trace output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const trace = `${JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    })}\n`;
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "pi");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          `process.stdout.write(${JSON.stringify(trace)});`,
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["pi", "--prompt", "hello", "--json"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), trace);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux launches an interactive tmux session and sends the prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "hello world");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(
      ["codex", "--prompt-file", promptFile, "--model", "gpt-next", "--work-dir", dir, "--tmux"],
      {
        env: { ...process.env, HEADLESS_TMUX_CAPTURE: captureFile, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      },
    );

    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const sessionName = calls[0][3];
    assert.equal(code, 0);
    assert.deepEqual(calls, [
      ["new-session", "-d", "-s", sessionName, "-c", dir, "codex --model gpt-next hello\\ world"],
    ]);
    assert.match(sessionName, /^headless-codex-\d+$/);
    assert.match(stdout.join(""), new RegExp(`tmux attach-session -t ${sessionName}`));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux --print-command prints tmux commands without executing them", async () => {
  const stdout: string[] = [];
  const code = await runCli(["pi", "--prompt", "hello world", "--tmux", "--print-command"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /^tmux new-session -d -s headless-pi-\d+ -c /);
  assert.match(stdout.join(""), /pi/);
  assert.match(stdout.join(""), /hello/);
  assert.match(stdout.join(""), /world/);
  assert.doesNotMatch(stdout.join(""), /send-keys/);
});

test("CLI rejects --json with --tmux", async () => {
  const stderr: string[] = [];
  const code = await runCli(["codex", "--prompt", "hello", "--json", "--tmux"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /--json cannot be used with --tmux/);
});

test("CLI suppresses known Gemini startup warnings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "gemini");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "process.stderr.write('(node:1) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.\\n');",
          "process.stderr.write('(Use `node --trace-deprecation ...` to show where the warning was created)\\n');",
          "process.stderr.write('YOLO mode is enabled. All tool calls will be automatically approved.\\n');",
          "process.stderr.write('Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.\\n');",
          "process.stderr.write('real gemini error\\n');",
          "console.log(JSON.stringify({ type: 'model', content: { parts: [{ text: 'final answer' }] } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["gemini", "--prompt", "hello"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "final answer\n");
    assert.equal(stderr.join(""), "real gemini error\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI reports extraction failure for successful empty traces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "pi");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'message', message: { role: 'toolresult', content: [{ type: 'text', text: 'tool output' }] } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stderr: string[] = [];
    const code = await runCli(["pi", "--prompt", "hello"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stderr: (text) => stderr.push(text),
    });

    assert.equal(code, 1);
    assert.match(stderr.join(""), /could not extract final message/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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

test("CLI entrypoint runs when invoked as a script", () => {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src", "cli.ts"), "--help"],
    { encoding: "utf8" },
  );

  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage: headless \[agent\]/);
});
