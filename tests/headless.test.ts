import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAgentCommand, buildInteractiveAgentCommand, getAgentConfig, listAgents } from "../src/agents.ts";
import { runCli } from "../src/cli.ts";
import { DEFAULT_DOCKER_IMAGE } from "../src/docker.ts";
import { quoteCommand } from "../src/shell.ts";
import type { AgentName } from "../src/types.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(assertion(), true);
}

test("lists all supported agents", () => {
  assert.deepEqual(listAgents(), ["claude", "codex", "cursor", "gemini", "opencode", "pi"]);
});

test("default Docker image reference is accepted by Docker", () => {
  assert.equal(DEFAULT_DOCKER_IMAGE, DEFAULT_DOCKER_IMAGE.toLowerCase());
  assert.equal(DEFAULT_DOCKER_IMAGE, "ghcr.io/roberttlange/headless:latest");
});

test("builds codex command with default model and prompt stdin", () => {
  const command = buildAgentCommand("codex", { prompt: "hello world" }, {});

  assert.deepEqual(command, {
    command: "codex",
    args: [
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--model",
      "gpt-5.2",
      "--json",
      "--skip-git-repo-check",
      "-",
    ],
    stdinText: "hello world",
  });
});

test("builds codex command using CODEX_MODEL fallback", () => {
  const command = buildAgentCommand("codex", { prompt: "hello" }, { CODEX_MODEL: "gpt-next" });

  assert.equal(command.args[3], "gpt-next");
  assert.equal(command.stdinText, "hello");
});

test("builds prompt-file stdin commands for codex, claude, and gemini", () => {
  assert.deepEqual(buildAgentCommand("codex", { prompt: "", promptFile: "prompt.md", model: "m" }, {}), {
    command: "codex",
    args: [
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--model",
      "m",
      "--json",
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
    args: ["--model", "gemini-pro", "--prompt", "", "--output-format", "stream-json", "--approval-mode", "yolo"],
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
    args: ["--model", "gemini-model", "-p", "hello", "--output-format", "stream-json", "--approval-mode", "yolo"],
  });

  assert.deepEqual(buildAgentCommand("opencode", { prompt: "hello", model: "oc-model" }, {}), {
    command: "opencode",
    args: ["run", "--format", "json", "--model", "oc-model", "--dangerously-skip-permissions", "hello"],
  });

  assert.deepEqual(buildAgentCommand("pi", { prompt: "hello", model: "pi-model" }, {}), {
    command: "pi",
    args: ["--no-session", "--mode", "json", "--model", "pi-model", "--tools", "read,bash,edit,write", "hello"],
  });
});

test("builds interactive commands for tmux mode", () => {
  assert.deepEqual(buildInteractiveAgentCommand("codex", { prompt: "hello", model: "gpt-next" }, {}), {
    command: "codex",
    args: ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-next", "hello"],
  });

  assert.deepEqual(buildInteractiveAgentCommand("claude", { prompt: "hello", model: "sonnet" }, {}), {
    command: "claude",
    args: ["--model", "sonnet", "--dangerously-skip-permissions", "hello"],
  });

  assert.deepEqual(buildInteractiveAgentCommand("gemini", { prompt: "hello", model: "gemini-model" }, {}), {
    command: "gemini",
    args: ["--model", "gemini-model", "--skip-trust", "--approval-mode", "yolo", "hello"],
  });

  assert.deepEqual(buildInteractiveAgentCommand("opencode", { prompt: "hello", model: "oc-model" }, {}), {
    command: "opencode",
    args: ["--model", "oc-model", "--dangerously-skip-permissions"],
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
      args: [
        "--provider",
        "bedrock",
        "--model",
        "opus",
        "--models",
        "opus,sonnet",
        "--tools",
        "read,bash,edit,write",
        "hello",
      ],
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
        "--tools",
        "read,bash,edit,write",
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
    "codex exec 'hello world' < '/tmp/prompt file.md'",
  );
});

test("quotes commands with stdin text for print-command output", () => {
  assert.equal(
    quoteCommand({ command: "codex", args: ["exec", "-"], stdinText: "hello world" }),
    "printf %s 'hello world' | codex exec -",
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
    assert.equal(stdout.join(""), "opencode run --format json --dangerously-skip-permissions 'from file'\n");
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
  assert.equal(stdout.join(""), "pi --no-session --mode json --tools 'read,bash,edit,write' 'stdin prompt'\n");
});

test("CLI --docker print-command wraps the selected agent command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const homeDir = join(dir, "home");
    const projectDir = join(dir, "project");
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    mkdirSync(projectDir);
    writeFileSync(join(homeDir, ".codex", "config.toml"), "model = 'test'\n");

    const stdout: string[] = [];
    const code = await runCli(
      [
        "codex",
        "--prompt",
        "hello",
        "--work-dir",
        projectDir,
        "--docker",
        "--docker-image",
        "custom/headless:dev",
        "--docker-env",
        "EXTRA_TOKEN=value",
        "--docker-arg",
        "--network=host",
        "--print-command",
      ],
      {
        env: { ...process.env, HOME: homeDir },
        stdout: (text) => stdout.push(text),
      },
    );

    const output = stdout.join("");
    assert.equal(code, 0);
    assert.match(output, /^printf %s hello \| docker run --rm --interactive --tmpfs '\/headless-home:rw,mode=1777' --user \d+:\d+ /);
    assert.match(output, new RegExp(`--workdir ${quoteCommand({ command: realpathSync(projectDir), args: [] })}`));
    assert.match(output, /--env EXTRA_TOKEN=value --env HOME=\/headless-home --network=host custom\/headless:dev sh -lc/);
    assert.match(output, /headless-agent codex/);
    assert.match(output, /exec --model gpt-5\.2 --json --skip-git-repo-check -/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --modal print-command wraps the selected agent command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const projectDir = join(dir, "project");
    mkdirSync(projectDir);

    const stdout: string[] = [];
    const code = await runCli(
      [
        "codex",
        "--prompt",
        "hello",
        "--work-dir",
        projectDir,
        "--modal",
        "--modal-app",
        "headless-dev",
        "--modal-image",
        "custom/headless:modal",
        "--modal-image-secret",
        "ghcr",
        "--modal-cpu",
        "4",
        "--modal-memory",
        "8192",
        "--modal-timeout",
        "900",
        "--modal-secret",
        "provider-secret",
        "--print-command",
      ],
      { stdout: (text) => stdout.push(text) },
    );

    const output = stdout.join("");
    assert.equal(code, 0);
    assert.match(output, /^printf %s hello \| modal-sandbox run --app headless-dev --image custom\/headless:modal /);
    assert.match(output, /--cpu 4 --memory 8192 --timeout 900 /);
    assert.match(output, /--image-secret ghcr --secret provider-secret -- codex/);
    assert.match(output, /exec --model gpt-5\.2 --json --skip-git-repo-check -/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI rejects invalid Modal option combinations", async () => {
  const stderr: string[] = [];
  assert.equal(
    await runCli(["codex", "--prompt", "hello", "--modal", "--docker"], { stderr: (text) => stderr.push(text) }),
    2,
  );
  assert.match(stderr.join(""), /--docker cannot be used with --modal/);

  stderr.length = 0;
  assert.equal(
    await runCli(["codex", "--prompt", "hello", "--modal-env", "BAD-NAME"], { stderr: (text) => stderr.push(text) }),
    2,
  );
  assert.match(stderr.join(""), /invalid modal env/);

  stderr.length = 0;
  assert.equal(
    await runCli(["codex", "--prompt", "hello", "--modal-secret", "bad/name"], { stderr: (text) => stderr.push(text) }),
    2,
  );
  assert.match(stderr.join(""), /invalid modal secret/);
});

test("CLI --docker executes through docker and preserves stdin prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const homeDir = join(dir, "home");
    const projectDir = join(dir, "project");
    const captureFile = join(dir, "docker.json");
    mkdirSync(binDir);
    mkdirSync(homeDir);
    mkdirSync(projectDir);
    await import("node:fs/promises").then(async ({ chmod, writeFile }) => {
      const docker = join(binDir, "docker");
      await writeFile(
        docker,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const stdin = fs.readFileSync(0, 'utf8');",
          "fs.writeFileSync(process.env.HEADLESS_DOCKER_CAPTURE, JSON.stringify({ args: process.argv.slice(2), stdin }));",
          "console.log(JSON.stringify({ type: 'agent_message', text: 'docker final' }));",
          "",
        ].join("\n"),
      );
      await chmod(docker, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--work-dir", projectDir, "--docker"], {
      env: {
        ...process.env,
        HEADLESS_DOCKER_CAPTURE: captureFile,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    const capture = JSON.parse(readFileSync(captureFile, "utf8"));
    assert.equal(code, 0);
    assert.equal(stdout.join(""), "docker final\n");
    assert.equal(capture.stdin, "hello");
    assert.equal(capture.args[0], "run");
    assert.ok(capture.args.includes("ghcr.io/roberttlange/headless:latest"));
    assert.deepEqual(capture.args.slice(-8), [
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--model",
      "gpt-5.2",
      "--json",
      "--skip-git-repo-check",
      "-",
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI docker doctor reports image status and local build guidance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await import("node:fs/promises").then(async ({ chmod, writeFile }) => {
      const docker = join(binDir, "docker");
      await writeFile(
        docker,
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'Docker version 27.1.2, build abc'; exit 0; fi",
          "if [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 1; fi",
          "exit 2",
          "",
        ].join("\n"),
      );
      await chmod(docker, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["docker", "doctor"], {
      env: { PATH: binDir },
      stdout: (text) => stdout.push(text),
    });

    const output = stdout.join("");
    assert.equal(code, 0);
    assert.match(output, /^docker\s+✓\s+27\.1\.2\s+ghcr\.io\/roberttlange\/headless:latest \(missing\)$/m);
    assert.match(output, /Plain `headless --docker` will let Docker pull the default image automatically\./);
    assert.match(output, /For local development, run: headless docker build/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI docker build prints the packaged Dockerfile build command", async () => {
  const stdout: string[] = [];
  const code = await runCli(["docker", "build", "--print-command"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /^docker build -t headless-local:dev -f .*Dockerfile /);
});

test("CLI docker build runs docker with a custom image tag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "docker-args.json");
    mkdirSync(binDir);
    await import("node:fs/promises").then(async ({ chmod, writeFile }) => {
      const docker = join(binDir, "docker");
      await writeFile(
        docker,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "fs.writeFileSync(process.env.HEADLESS_DOCKER_CAPTURE, JSON.stringify(process.argv.slice(2)));",
          "process.stdout.write('built\\n');",
          "",
        ].join("\n"),
      );
      await chmod(docker, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["docker", "build", "--docker-image", "custom/headless:dev"], {
      env: { ...process.env, HEADLESS_DOCKER_CAPTURE: captureFile, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    const args = JSON.parse(readFileSync(captureFile, "utf8"));
    assert.equal(code, 0);
    assert.equal(stdout.join(""), "built\n");
    assert.deepEqual(args.slice(0, 4), ["build", "-t", "custom/headless:dev", "-f"]);
    assert.match(args[4], /Dockerfile$/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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
    assert.match(stdout.join(""), /^printf %s hello \| codex --dangerously-bypass-approvals-and-sandbox exec/);
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
    assert.equal(stdout.join(""), "pi-agent --no-session --mode json --tools 'read,bash,edit,write' hello\n");
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

test("CLI --json streams raw trace output for every provider", async () => {
  const providerBinaries: Record<AgentName, string> = {
    claude: "claude",
    codex: "codex",
    cursor: "agent",
    gemini: "gemini",
    opencode: "opencode",
    pi: "pi",
  };

  for (const [agent, binaryName] of Object.entries(providerBinaries) as [AgentName, string][]) {
    const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
    try {
      const binDir = join(dir, "bin");
      const firstChunk = `${agent}:first\n`;
      const secondChunk = `${agent}:second\n`;
      await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
        await mkdir(binDir);
        const binary = join(binDir, binaryName);
        await writeFile(
          binary,
          [
            "#!/usr/bin/env node",
            `process.stdout.write(${JSON.stringify(firstChunk)});`,
            `setTimeout(() => { process.stdout.write(${JSON.stringify(secondChunk)}); }, 120);`,
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);
      });

      const stdout: string[] = [];
      let completed = false;
      const result = runCli([agent, "--prompt", "hello", "--json"], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      }).finally(() => {
        completed = true;
      });

      await waitFor(() => stdout.join("").startsWith(firstChunk) && !completed);
      assert.equal(completed, false);

      const code = await result;
      assert.equal(code, 0);
      assert.equal(stdout.join(""), `${firstChunk}${secondChunk}`);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
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
      [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        dir,
        "codex --dangerously-bypass-approvals-and-sandbox --model gpt-next 'hello world'",
      ],
    ]);
    assert.match(sessionName, /^headless-codex-\d+$/);
    assert.match(stdout.join(""), new RegExp(`tmux attach-session -t ${sessionName}`));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux preserves multiline prompt-file text through the tmux shell command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const agentCaptureFile = join(dir, "agent-argv.json");
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "line one\nline two");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      const codex = join(binDir, "codex");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const { spawnSync } = require('node:child_process');",
          "const args = process.argv.slice(2);",
          "if (args[0] !== 'new-session') process.exit(2);",
          "const shellCommand = args[6];",
          "const result = spawnSync('/bin/sh', ['-c', shellCommand], { cwd: args[5], env: process.env });",
          "process.exit(result.status ?? 1);",
          "",
        ].join("\n"),
      );
      await writeFile(
        codex,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "fs.writeFileSync(process.env.HEADLESS_AGENT_CAPTURE, JSON.stringify(process.argv.slice(2)));",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
      await chmod(codex, 0o755);
    });

    const code = await runCli(
      ["codex", "--prompt-file", promptFile, "--model", "gpt-next", "--work-dir", dir, "--tmux"],
      {
        env: {
          ...process.env,
          HEADLESS_AGENT_CAPTURE: agentCaptureFile,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: () => undefined,
      },
    );

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(agentCaptureFile, "utf8")), [
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-next",
      "line one\nline two",
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux sends Enter after launching opencode prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
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
      ["opencode", "--prompt", "hello world", "--model", "oc-model", "--work-dir", dir, "--tmux"],
      {
        env: {
          ...process.env,
          HEADLESS_TMUX_CAPTURE: captureFile,
          HEADLESS_TMUX_OPENCODE_ENTER_DELAY_MS: "0",
          HEADLESS_TMUX_OPENCODE_PASTE_DELAY_MS: "0",
          HEADLESS_TMUX_OPENCODE_SUBMIT_DELAY_MS: "0",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: (text) => stdout.push(text),
      },
    );

    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const sessionName = calls[0][3];
    assert.equal(code, 0);
    assert.deepEqual(calls, [
      ["new-session", "-d", "-s", sessionName, "-c", dir, "opencode --model oc-model --dangerously-skip-permissions"],
      ["send-keys", "-t", sessionName, "Space", "BSpace"],
      ["set-buffer", "-b", `${sessionName}-prompt`, "hello world"],
      ["paste-buffer", "-d", "-b", `${sessionName}-prompt`, "-t", sessionName],
      ["send-keys", "-t", sessionName, "Enter"],
    ]);
    assert.match(sessionName, /^headless-opencode-\d+$/);
    assert.match(stdout.join(""), new RegExp(`tmux attach-session -t ${sessionName}`));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux marks Claude workspaces trusted before launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const homeDir = join(dir, "home");
    const binDir = join(dir, "bin");
    const projectDir = join(dir, "project");
    const captureFile = join(dir, "tmux.jsonl");
    mkdirSync(homeDir);
    mkdirSync(projectDir);
    writeFileSync(join(homeDir, ".claude.json"), JSON.stringify({ projects: { "/existing": { keep: true } } }));
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

    const code = await runCli(["claude", "--prompt", "hello", "--work-dir", projectDir, "--tmux"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_CAPTURE: captureFile,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: () => undefined,
    });

    const config = JSON.parse(readFileSync(join(homeDir, ".claude.json"), "utf8"));
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(code, 0);
    assert.deepEqual(config.projects["/existing"], { keep: true });
    assert.equal(config.projects[realpathSync(projectDir)].hasTrustDialogAccepted, true);
    assert.match(calls[0][6], /claude .*--dangerously-skip-permissions .*hello/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux marks Cursor workspaces trusted before launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const homeDir = join(dir, "home");
    const binDir = join(dir, "bin");
    const projectDir = join(dir, "project");
    const captureFile = join(dir, "tmux.jsonl");
    mkdirSync(homeDir);
    mkdirSync(projectDir);
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

    const code = await runCli(["cursor", "--prompt", "hello", "--work-dir", projectDir, "--tmux"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_CAPTURE: captureFile,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: () => undefined,
    });

    const workspace = realpathSync(projectDir);
    const projectKey = workspace.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const trustPath = join(homeDir, ".cursor", "projects", projectKey, ".workspace-trusted");
    const trust = JSON.parse(readFileSync(trustPath, "utf8"));
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(code, 0);
    assert.equal(trust.workspacePath, workspace);
    assert.match(trust.trustedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(calls[0][6], /agent --force hello/);
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

test("CLI --tmux --print-command includes opencode Enter submit command", async () => {
  const stdout: string[] = [];
  const code = await runCli(["opencode", "--prompt", "hello world", "--tmux", "--print-command"], {
    env: {
      ...process.env,
      HEADLESS_TMUX_OPENCODE_ENTER_DELAY_MS: "0",
      HEADLESS_TMUX_OPENCODE_PASTE_DELAY_MS: "0",
      HEADLESS_TMUX_OPENCODE_SUBMIT_DELAY_MS: "0",
    },
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /^tmux new-session -d -s headless-opencode-\d+ -c /);
  assert.match(stdout.join(""), /\ntmux send-keys -t headless-opencode-\d+ Space BSpace\n/);
  assert.match(stdout.join(""), /\ntmux set-buffer -b headless-opencode-\d+-prompt 'hello world'\n/);
  assert.match(stdout.join(""), /\ntmux paste-buffer -d -b headless-opencode-\d+-prompt -t headless-opencode-\d+\n/);
  assert.match(stdout.join(""), /\ntmux send-keys -t headless-opencode-\d+ Enter\n$/);
});

test("CLI --list lists active headless tmux sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "if (process.argv.slice(2).join(' ') !== 'list-sessions -F #{session_name}\\t#{session_created}\\t#{window_activity}\\t#{pane_dead}') process.exit(2);",
          "process.stdout.write('headless-codex-123\\t1700000000\\t4102444800\\t0\\nother\\t1700000000\\t1700000000\\t0\\nheadless-opencode-456\\t1700000000\\t1700000000\\t0\\nheadless-unknown-789\\t1700000000\\t1700000000\\t0\\n');",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["--list"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(
      stdout.join(""),
      [
        "NAME                   AGENT     STATE    CREATED                   LAST_ACTIVITY             ATTACH",
        "headless-codex-123     codex     running  2023-11-14T22:13:20.000Z  2100-01-01T00:00:00.000Z  tmux attach-session -t headless-codex-123",
        "headless-opencode-456  opencode  waiting  2023-11-14T22:13:20.000Z  2023-11-14T22:13:20.000Z  tmux attach-session -t headless-opencode-456",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI agent --list filters active headless tmux sessions by agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "process.stdout.write('headless-codex-123\\t1700000000\\t4102444800\\t0\\nheadless-opencode-456\\t1700000000\\t1700000000\\t0\\n');",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["opencode", "--list"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(
      stdout.join(""),
      [
        "NAME                   AGENT     STATE    CREATED                   LAST_ACTIVITY             ATTACH",
        "headless-opencode-456  opencode  waiting  2023-11-14T22:13:20.000Z  2023-11-14T22:13:20.000Z  tmux attach-session -t headless-opencode-456",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --list marks dead tmux panes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "process.stdout.write('headless-claude-dead\\t1700000000\\t4102444800\\t1\\n');",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["--list"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^headless-claude-dead\s+claude\s+dead\s+/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --list honors HEADLESS_LIST_WAITING_AFTER_MS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const activity = Math.floor(Date.now() / 1000) - 2;",
          "process.stdout.write(`headless-codex-quiet\\t1700000000\\t${activity}\\t0\\n`);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["--list"], {
      env: { ...process.env, HEADLESS_LIST_WAITING_AFTER_MS: "1000", PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^headless-codex-quiet\s+codex\s+waiting\s+/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --list uses tmux window activity for last activity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "if (!process.argv.slice(2).join(' ').includes('#{window_activity}')) process.exit(2);",
          "process.stdout.write('headless-codex-active\\t1700000000\\t1700000100\\t0\\n');",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["--list"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /2023-11-14T22:15:00\.000Z/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --list treats missing tmux server as no active sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "process.stderr.write('no server running on /private/tmp/tmux-501/default\\n');",
          "process.exit(1);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["--list"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "No active headless tmux sessions\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI rejects --json with --tmux", async () => {
  const stderr: string[] = [];
  const code = await runCli(["codex", "--prompt", "hello", "--json", "--tmux"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /--json cannot be used with --tmux/);
});

test("CLI rejects docker for tmux and session-management commands", async () => {
  const stderr: string[] = [];
  assert.equal(
    await runCli(["codex", "--prompt", "hello", "--docker", "--tmux"], { stderr: (text) => stderr.push(text) }),
    2,
  );
  assert.match(stderr.join(""), /--docker cannot be used with --tmux/);

  stderr.length = 0;
  assert.equal(
    await runCli(["send", "headless-codex-work", "--prompt", "hello", "--docker"], {
      stderr: (text) => stderr.push(text),
    }),
    2,
  );
  assert.match(stderr.join(""), /--docker cannot be used with send/);

  stderr.length = 0;
  assert.equal(
    await runCli(["rename", "headless-codex-work", "next", "--docker"], { stderr: (text) => stderr.push(text) }),
    2,
  );
  assert.match(stderr.join(""), /--docker cannot be used with rename/);
});

test("CLI validates docker env names", async () => {
  const stderr: string[] = [];
  const code = await runCli(["codex", "--prompt", "hello", "--docker", "--docker-env", "BAD-NAME"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /invalid docker env/);
});

test("CLI reports missing docker at execution time", async () => {
  const stderr: string[] = [];
  const code = await runCli(["codex", "--prompt", "hello", "--docker"], {
    env: { ...process.env, PATH: "" },
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /docker not found on PATH/);
});

test("CLI requires --docker for docker execution options", async () => {
  const stderr: string[] = [];
  const code = await runCli(["codex", "--prompt", "hello", "--docker-image", "custom/headless:dev"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /require --docker/);
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

test("CLI suppresses known Codex rollout recording warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "process.stderr.write('2026-04-25T16:54:20.076657Z ERROR codex_core::session: failed to record rollout items: thread 019dc590-3a4c-78d1-a11a-8c28174c8902 not found\\n');",
          "console.log(JSON.stringify({ type: 'agent_message', text: 'final answer' }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "final answer\n");
    assert.equal(stderr.join(""), "");
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
    assert.equal(readFileSync(captureFile, "utf8"), "run|--format|json|--dangerously-skip-permissions|hello");
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

test("CLI help lists all Modal options", async () => {
  const stdout: string[] = [];
  const code = await runCli(["--help"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  const help = stdout.join("");
  for (const flag of [
    "--modal",
    "--modal-image",
    "--modal-image-secret",
    "--modal-app",
    "--modal-cpu",
    "--modal-memory",
    "--modal-timeout",
    "--modal-secret",
    "--modal-env",
    "--modal-include-git",
  ]) {
    assert.match(help, new RegExp(flag));
  }
});
