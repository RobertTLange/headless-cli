import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildAgentCommand,
  buildInteractiveAgentCommand,
  buildInteractiveOpencodeRun,
  claudeModel,
  getAgentConfig,
  listAgents,
  waitTierForAgent,
} from "../src/agents.ts";
import { acpClientCapabilities } from "../src/acp.ts";
import { runCli } from "../src/cli.ts";
import { parseHeadlessConfig } from "../src/config.ts";
import { DEFAULT_DOCKER_IMAGE } from "../src/docker.ts";
import { launchLockPath } from "../src/launch-lock.ts";
import { quoteCommand } from "../src/shell.ts";
import type { AgentName } from "../src/types.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(assertion(), true);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("lists all supported agents", () => {
  assert.deepEqual(listAgents(), ["acp", "antigravity", "claude", "codex", "cursor", "gemini", "opencode", "pi"]);
});

test("default Docker image reference is accepted by Docker", () => {
  assert.equal(DEFAULT_DOCKER_IMAGE, DEFAULT_DOCKER_IMAGE.toLowerCase());
  assert.equal(DEFAULT_DOCKER_IMAGE, "ghcr.io/roberttlange/headless:latest");
});

test("builds codex command with the headless default model", () => {
  const command = buildAgentCommand("codex", { prompt: "hello world" }, {});

  assert.deepEqual(command, {
    command: "codex",
    args: [
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--model",
      "gpt-5.5",
      "--json",
      "--skip-git-repo-check",
      "-",
    ],
    stdinText: "hello world",
  });
});

test("builds codex command using CODEX_MODEL override", () => {
  const command = buildAgentCommand("codex", { prompt: "hello" }, { CODEX_MODEL: "gpt-next" });

  assert.deepEqual(command.args.slice(2, 4), ["--model", "gpt-next"]);
  assert.equal(command.stdinText, "hello");
});

test("builds ACP adapter command from custom command", () => {
  const command = buildAgentCommand("acp", { prompt: "hello" }, {
    HEADLESS_BIN: "headless-dev",
    HEADLESS_ACP_COMMAND: "atlas alta agent run",
  });

  assert.deepEqual(command, {
    command: "headless-dev",
    args: ["acp-client", "--", "atlas", "alta", "agent", "run"],
    stdinText: "hello",
  });
});

test("builds ACP adapter command with read-only permission mode", () => {
  const command = buildAgentCommand("acp", { prompt: "hello", allow: "read-only" }, {
    HEADLESS_BIN: "headless-dev",
    HEADLESS_ACP_COMMAND: "atlas alta agent run",
  });

  assert.deepEqual(command, {
    command: "headless-dev",
    args: ["acp-client", "--", "atlas", "alta", "agent", "run"],
    env: { HEADLESS_ACP_ALLOW: "read-only" },
    stdinText: "hello",
  });
});

test("builds Antigravity one-shot command", () => {
  assert.deepEqual(buildAgentCommand("antigravity", { prompt: "hello", model: "gemini-model", workDir: "/repo/project" }, {}), {
    command: "agy",
    args: ["--model", "gemini-model", "-p", "hello", "--dangerously-skip-permissions"],
  });
});

test("builds Antigravity command with binary override and sandboxed read-only mode", () => {
  assert.deepEqual(
    buildAgentCommand("antigravity", { prompt: "review", allow: "read-only", workDir: "/repo/project" }, {
      ANTIGRAVITY_CLI_BIN: "/opt/agy",
    }),
    {
      command: "/opt/agy",
      args: ["-p", "review", "--sandbox"],
    },
  );
});

test("builds interactive Antigravity resume command", () => {
  assert.deepEqual(
    buildInteractiveAgentCommand("antigravity", { prompt: "continue", sessionMode: "resume", sessionId: "conv-123" }, {}),
    {
      command: "agy",
      args: ["--dangerously-skip-permissions", "--conversation", "conv-123"],
    },
  );
});

test("ACP client advertises read-only filesystem capability", () => {
  assert.deepEqual(acpClientCapabilities, {
    fs: { readTextFile: true, writeTextFile: false },
  });
});

test("builds ACP adapter command from registry npx distribution", () => {
  const registry = {
    agents: [
      {
        id: "example-acp",
        name: "Example ACP",
        distribution: { npx: { package: "example-acp@1.2.3", args: ["--acp"], env: { EXAMPLE_AUTO_UPDATE: "0" } } },
      },
    ],
  };
  const command = buildAgentCommand("acp", { prompt: "hello" }, {
    HEADLESS_BIN: "headless-dev",
    HEADLESS_ACP_AGENT: "example-acp",
    HEADLESS_ACP_REGISTRY_JSON: JSON.stringify(registry),
  });

  assert.deepEqual(command, {
    command: "headless-dev",
    args: ["acp-client", "--", process.platform === "win32" ? "npx.cmd" : "npx", "-y", "example-acp@1.2.3", "--acp"],
    env: { EXAMPLE_AUTO_UPDATE: "0" },
    stdinText: "hello",
  });
});

test("rejects ACP registry binary archive distributions without local install support", () => {
  const registry = {
    agents: [
      {
        id: "example-binary",
        distribution: {
          binary: {
            "darwin-aarch64": { archive: "https://example.com/example.tar.gz", cmd: "./example-acp" },
            "darwin-x86_64": { archive: "https://example.com/example.tar.gz", cmd: "./example-acp" },
            "linux-aarch64": { archive: "https://example.com/example.tar.gz", cmd: "./example-acp" },
            "linux-x86_64": { archive: "https://example.com/example.tar.gz", cmd: "./example-acp" },
            "windows-x86_64": { archive: "https://example.com/example.zip", cmd: "example-acp.exe" },
          },
        },
      },
    ],
  };

  assert.throws(
    () => buildAgentCommand("acp", { prompt: "hello" }, {
      HEADLESS_ACP_AGENT: "example-binary",
      HEADLESS_ACP_REGISTRY_JSON: JSON.stringify(registry),
    }),
    /binary archive distributions are not supported/,
  );
});

test("builds reasoning effort flags for supported agents", () => {
  assert.deepEqual(buildAgentCommand("codex", { prompt: "hello", reasoningEffort: "high" }, {}).args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "exec",
    "--model",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="high"',
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);

  assert.deepEqual(buildAgentCommand("claude", { prompt: "hello", reasoningEffort: "xhigh" }, {}).args, [
    "--model",
    "claude-opus-4-6",
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--verbose",
    "--effort",
    "xhigh",
    "--dangerously-skip-permissions",
  ]);

  assert.deepEqual(buildAgentCommand("opencode", { prompt: "hello", reasoningEffort: "medium" }, {}).args, [
    "run",
    "--format",
    "json",
    "--model",
    "openai/gpt-5.4",
    "--variant",
    "medium",
    "--dangerously-skip-permissions",
    "hello",
  ]);

  assert.deepEqual(buildAgentCommand("pi", { prompt: "hello", reasoningEffort: "low" }, {}).args, [
    "--no-session",
    "--mode",
    "json",
    "--provider",
    "openai-codex",
    "--model",
    "gpt-5.5",
    "--thinking",
    "low",
    "--tools",
    "read,bash,edit,write",
    "hello",
  ]);
});

test("maps Cursor reasoning effort to model variants and leaves Gemini unchanged", () => {
  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.5-medium", "hello"],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", reasoningEffort: "high" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.5-high", "hello"],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", reasoningEffort: "xhigh" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.5-extra-high", "hello"],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", model: "gpt-5.5", reasoningEffort: "xhigh" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.5-extra-high", "hello"],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", model: "gpt-5.4", reasoningEffort: "xhigh" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.4-xhigh", "hello"],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", model: "gpt-5.2" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.2", "hello"],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", model: "gpt-5.2", reasoningEffort: "high" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.2-high", "hello"],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", model: "gpt-5.2", reasoningEffort: "medium" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.2", "hello"],
  });

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", model: "gpt-5.5", reasoningEffort: "low" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.5", "hello"],
  });

  assert.deepEqual(
    buildAgentCommand("cursor", { prompt: "hello", model: "gpt-5.5-extra-high", reasoningEffort: "medium" }, {}),
    {
      command: "agent",
      args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "gpt-5.5-extra-high", "hello"],
    },
  );

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", model: "cursor-model", reasoningEffort: "high" }, {}), {
    command: "agent",
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "cursor-model", "hello"],
  });

  assert.deepEqual(buildAgentCommand("gemini", { prompt: "hello", reasoningEffort: "high" }, {}), {
    command: "gemini",
    args: [
      "--model",
      "gemini-3.1-pro-preview",
      "--skip-trust",
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
    ],
  });
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
    args: [
      "--model",
      "gemini-pro",
      "--skip-trust",
      "--prompt",
      "",
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
    ],
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
    args: ["-p", "--trust", "--force", "--output-format", "stream-json", "--model", "cursor-model", "hello"],
  });

  assert.deepEqual(buildAgentCommand("gemini", { prompt: "hello", model: "gemini-model" }, {}), {
    command: "gemini",
    args: [
      "--model",
      "gemini-model",
      "--skip-trust",
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
    ],
  });

  assert.deepEqual(buildAgentCommand("opencode", { prompt: "hello", model: "oc-model" }, {}), {
    command: "opencode",
    args: ["run", "--format", "json", "--model", "oc-model", "--dangerously-skip-permissions", "hello"],
  });

  assert.deepEqual(buildAgentCommand("pi", { prompt: "hello", model: "pi-model" }, {}), {
    command: "pi",
    args: ["--no-session", "--mode", "json", "--model", "pi-model", "--tools", "read,bash,edit,write", "hello"],
  });

  assert.deepEqual(buildAgentCommand("pi", { prompt: "hello", model: "openai-codex/gpt-5.4" }, {}), {
    command: "pi",
    args: [
      "--no-session",
      "--mode",
      "json",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.4",
      "--tools",
      "read,bash,edit,write",
      "hello",
    ],
  });
});

test("normalizes versioned Claude model shorthand", () => {
  assert.equal(claudeModel("opus-4.8"), "claude-opus-4-8");
  assert.equal(claudeModel("opus-4-8"), "claude-opus-4-8");
  assert.equal(claudeModel("claude-opus-4.8"), "claude-opus-4-8");
  assert.equal(claudeModel("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(claudeModel("sonnet-4.5"), "claude-sonnet-4-5");
  assert.equal(claudeModel("sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(claudeModel("claude-sonnet-4.5"), "claude-sonnet-4-5");
  assert.equal(claudeModel("haiku-4.5-20251001"), "claude-haiku-4-5-20251001");
  assert.equal(claudeModel("fable-5"), "claude-fable-5");
  assert.equal(claudeModel("claude-fable-5"), "claude-fable-5");
  assert.equal(claudeModel("fable-5.1"), "claude-fable-5-1");
  assert.equal(claudeModel(" opus-4.8 "), "claude-opus-4-8");
  assert.equal(claudeModel("opus"), "opus");
  assert.equal(claudeModel("sonnet"), "sonnet");
  assert.equal(claudeModel("haiku"), "haiku");
  assert.equal(claudeModel("fable"), "fable");
  assert.equal(claudeModel("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet-20241022");
  assert.equal(claudeModel(undefined), undefined);
});

test("builds Claude commands with normalized model shorthand", () => {
  assert.deepEqual(buildAgentCommand("claude", { prompt: "hello", model: "opus-4.8" }, {}).args.slice(0, 2), [
    "--model",
    "claude-opus-4-8",
  ]);
  assert.deepEqual(buildAgentCommand("claude", { prompt: "hello", model: "sonnet-4.5" }, {}).args.slice(0, 2), [
    "--model",
    "claude-sonnet-4-5",
  ]);
  assert.deepEqual(buildAgentCommand("claude", { prompt: "", promptFile: "prompt.md", model: "haiku-4.5-20251001" }, {}).args.slice(0, 2), [
    "--model",
    "claude-haiku-4-5-20251001",
  ]);
  assert.deepEqual(buildAgentCommand("claude", { prompt: "hello", model: "fable-5" }, {}).args.slice(0, 2), [
    "--model",
    "claude-fable-5",
  ]);
  assert.deepEqual(buildInteractiveAgentCommand("claude", { prompt: "hello", model: "claude-sonnet-4.5" }, {}).args.slice(0, 2), [
    "--model",
    "claude-sonnet-4-5",
  ]);
});

test("each harness declares its tmux-wait resolution tier", () => {
  assert.equal(waitTierForAgent("claude"), "pin");
  assert.equal(waitTierForAgent("gemini"), "pin");
  assert.equal(waitTierForAgent("cursor"), "mint");
  assert.equal(waitTierForAgent("opencode"), "tag");
  assert.equal(waitTierForAgent("pi"), "dir");
  assert.equal(waitTierForAgent("codex"), "claim");
  assert.equal(waitTierForAgent("antigravity"), "claim");
});

test("interactive Claude and Gemini commands pin a new session id when provided", () => {
  for (const agent of ["claude", "gemini"] as const) {
    const args = buildInteractiveAgentCommand(agent, { prompt: "hello", sessionMode: "new", sessionId: "abc-123" }, {}).args;
    const index = args.indexOf("--session-id");
    assert.ok(index >= 0, `expected --session-id in ${agent} interactive command`);
    assert.equal(args[index + 1], "abc-123");
  }
});

test("interactive pin agents omit session id without an explicit new session", () => {
  for (const agent of ["claude", "gemini"] as const) {
    assert.ok(!buildInteractiveAgentCommand(agent, { prompt: "hello" }, {}).args.includes("--session-id"));
    assert.ok(
      !buildInteractiveAgentCommand(agent, { prompt: "hello", sessionMode: "resume", sessionId: "abc-123" }, {}).args.includes(
        "--session-id",
      ),
    );
  }
});

test("interactive opencode run tags a new session with a unique title", () => {
  const args = buildInteractiveOpencodeRun({ prompt: "hello", sessionMode: "new", sessionTitle: "headless-wait-xyz" }).args;
  const index = args.indexOf("--title");
  assert.ok(index >= 0, "expected --title in opencode interactive run");
  assert.equal(args[index + 1], "headless-wait-xyz");
});

test("interactive pi command isolates a new session with --session-dir", () => {
  const args = buildInteractiveAgentCommand("pi", { prompt: "hello", sessionMode: "new", sessionDir: "/tmp/run-1" }, {}).args;
  const index = args.indexOf("--session-dir");
  assert.ok(index >= 0, "expected --session-dir in pi interactive command");
  assert.equal(args[index + 1], "/tmp/run-1");
});

test("CLI print-command normalizes Claude model shorthand", async () => {
  const stdout: string[] = [];
  const code = await runCli(["claude", "--prompt", "hello", "--model", "sonnet-4.5", "--print-command"], {
    env: { ...process.env, CLAUDE_CODE_BIN: undefined, CLAUDE_BIN: "claude" },
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /^claude --model claude-sonnet-4-5 -p hello/);
});

test("prefers an executable user-local Claude binary", () => {
  const home = mkdtempSync(join(tmpdir(), "headless-claude-home-"));
  const binDir = join(home, ".local", "bin");
  const claudeBin = join(binDir, "claude");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(claudeBin, "#!/bin/sh\n");
  chmodSync(claudeBin, 0o755);

  try {
    assert.equal(buildAgentCommand("claude", { prompt: "hello" }, { HOME: home }).command, claudeBin);
    assert.equal(buildInteractiveAgentCommand("claude", { prompt: "hello" }, { HOME: home }).command, claudeBin);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preserves explicit PATH precedence for Claude shims", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-claude-path-"));
  const home = join(dir, "home");
  const binDir = join(dir, "bin");
  const homeBinDir = join(home, ".local", "bin");
  const claudeShim = join(binDir, "claude");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeBinDir, { recursive: true });
  writeFileSync(claudeShim, "#!/bin/sh\n");
  writeFileSync(join(homeBinDir, "claude"), "#!/bin/sh\n");
  chmodSync(claudeShim, 0o755);
  chmodSync(join(homeBinDir, "claude"), 0o755);

  try {
    assert.equal(
      buildAgentCommand("claude", { prompt: "hello" }, { HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` }).command,
      "claude",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows explicit Claude binary overrides", () => {
  assert.equal(
    buildAgentCommand("claude", { prompt: "hello" }, { CLAUDE_CODE_BIN: "/custom/claude-code" }).command,
    "/custom/claude-code",
  );
  assert.equal(
    buildAgentCommand("claude", { prompt: "hello" }, { CLAUDE_BIN: "/custom/claude" }).command,
    "/custom/claude",
  );
  assert.equal(
    buildInteractiveAgentCommand("claude", { prompt: "hello" }, { CLAUDE_CODE_BIN: "/custom/claude-code" }).command,
    "/custom/claude-code",
  );
});

test("removes inherited Anthropic API key when Claude OAuth is available", () => {
  const home = mkdtempSync(join(tmpdir(), "headless-claude-oauth-"));
  writeFileSync(join(home, ".claude.json"), "{}\n");

  try {
    assert.deepEqual(
      buildAgentCommand("claude", { prompt: "hello" }, { ANTHROPIC_API_KEY: "sk-low-balance", HOME: home }).env,
      { ANTHROPIC_API_KEY: undefined },
    );
    assert.deepEqual(
      buildInteractiveAgentCommand("claude", { prompt: "hello" }, { ANTHROPIC_API_KEY: "sk-low-balance", HOME: home }).env,
      { ANTHROPIC_API_KEY: undefined },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keeps inherited Anthropic API key when Claude API auth is explicit", () => {
  const home = mkdtempSync(join(tmpdir(), "headless-claude-api-"));
  writeFileSync(join(home, ".claude.json"), "{}\n");

  try {
    assert.equal(
      buildAgentCommand(
        "claude",
        { prompt: "hello" },
        { ANTHROPIC_API_KEY: "sk-api", HEADLESS_CLAUDE_AUTH: "api", HOME: home },
      ).env,
      undefined,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("builds native session commands for supported agents", () => {
  assert.deepEqual(
    buildAgentCommand("claude", {
      prompt: "hello",
      sessionAlias: "work",
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionMode: "new",
    }, {}).args,
    [
      "--model",
      "claude-opus-4-6",
      "-p",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
  );

  assert.deepEqual(buildAgentCommand("codex", { prompt: "hello", sessionId: "thread-1", sessionMode: "resume" }, {}).args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "exec",
    "resume",
    "--model",
    "gpt-5.5",
    "--json",
    "--skip-git-repo-check",
    "thread-1",
    "-",
  ]);

  assert.deepEqual(buildAgentCommand("cursor", { prompt: "hello", sessionId: "chat-1", sessionMode: "resume" }, {}).args, [
    "-p",
    "--trust",
    "--force",
    "--output-format",
    "stream-json",
    "--resume",
    "chat-1",
    "--model",
    "gpt-5.5-medium",
    "hello",
  ]);

  assert.deepEqual(buildAgentCommand("gemini", { prompt: "hello", sessionId: "gem-1", sessionMode: "resume" }, {}).args, [
    "--model",
    "gemini-3.1-pro-preview",
    "--skip-trust",
    "--resume",
    "gem-1",
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--approval-mode",
    "yolo",
  ]);

  assert.deepEqual(buildAgentCommand("opencode", { prompt: "hello", sessionAlias: "work", sessionMode: "new" }, {}).args, [
    "run",
    "--format",
    "json",
    "--model",
    "openai/gpt-5.4",
    "--dangerously-skip-permissions",
    "--title",
    "work",
    "hello",
  ]);

  assert.deepEqual(buildAgentCommand("pi", { prompt: "hello", sessionId: "pi-1", sessionMode: "resume" }, {}).args, [
    "--mode",
    "json",
    "--provider",
    "openai-codex",
    "--model",
    "gpt-5.5",
    "--session",
    "pi-1",
    "--tools",
    "read,bash,edit,write",
    "hello",
  ]);
});

test("CLI passes Antigravity model selection through to agy", async () => {
  const stdout: string[] = [];
  const code = await runCli(["antigravity", "--model", "gemini-pro", "--prompt", "hello", "--print-command"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /^agy --model gemini-pro -p hello --dangerously-skip-permissions\n$/);
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

  assert.deepEqual(buildInteractiveAgentCommand("antigravity", { prompt: "hello", model: "gemini-model" }, {}), {
    command: "agy",
    args: ["--model", "gemini-model", "--dangerously-skip-permissions"],
  });

  assert.deepEqual(
    buildInteractiveAgentCommand(
      "pi",
      { prompt: "hello", model: "openai-codex/gpt-5.4" },
      {},
    ),
    {
      command: "pi",
      args: ["--provider", "openai-codex", "--model", "gpt-5.4", "--tools", "read,bash,edit,write", "hello"],
    },
  );

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

test("builds reasoning effort flags for supported interactive commands", () => {
  assert.deepEqual(buildInteractiveAgentCommand("codex", { prompt: "hello", reasoningEffort: "high" }, {}), {
    command: "codex",
    args: [
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="high"',
      "hello",
    ],
  });

  assert.deepEqual(buildInteractiveAgentCommand("claude", { prompt: "hello", reasoningEffort: "xhigh" }, {}), {
    command: "claude",
    args: ["--model", "claude-opus-4-6", "--effort", "xhigh", "--dangerously-skip-permissions", "hello"],
  });

  assert.deepEqual(buildInteractiveAgentCommand("pi", { prompt: "hello", reasoningEffort: "low" }, {}), {
    command: "pi",
    args: [
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.5",
      "--thinking",
      "low",
      "--tools",
      "read,bash,edit,write",
      "hello",
    ],
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
      args: [
        "--api-key",
        "key-123",
        "-p",
        "--trust",
        "--force",
        "--output-format",
        "stream-json",
        "--model",
        "gpt-5.5-medium",
        "hello",
      ],
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

  assert.deepEqual(getAgentConfig("antigravity"), {
    name: "antigravity",
    promptFileMode: "argument",
    configRelDir: ".gemini/antigravity-cli",
    workspaceConfigRelDir: ".agents",
    seedPaths: [".gemini/antigravity-cli", ".gemini/config"],
  });
});

test("CLI --show-config renders agent config and effective defaults as a table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const stdout: string[] = [];
    const code = await runCli(["codex", "--show-config"], {
      env: { ...process.env, HOME: join(dir, "home") },
      stdout: (text) => stdout.push(text),
    });

    const output = stdout.join("");
    assert.equal(code, 0);
    assert.match(output, /^\+[-+]+\+$/m);
    assert.match(output, /^\| Field\s+\| Value\s+\|$/m);
    assert.match(output, /^\| Agent\s+\| codex\s+\|$/m);
    assert.match(output, /^\| Model\s+\| gpt-5\.5\s+\|$/m);
    assert.match(output, /^\| Effort\s+\| -\s+\|$/m);
    assert.match(output, /^\| Config dir\s+\| \.codex\s+\|$/m);
    assert.match(output, /^\| Workspace config dir\s+\| \.codex\s+\|$/m);
    assert.match(output, /^\| Seed path\s+\| \.codex\/auth\.json\s+\|$/m);
    assert.match(output, /^\| Seed path\s+\| \.codex\/config\.toml\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --show-config displays CLI model and effort overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const stdout: string[] = [];
    const code = await runCli(["cursor", "--show-config", "--model", "gpt-custom", "--effort", "high"], {
      env: { ...process.env, HOME: join(dir, "home") },
      stdout: (text) => stdout.push(text),
    });

    const output = stdout.join("");
    assert.equal(code, 0);
    assert.match(output, /^\| Agent\s+\| cursor\s+\|$/m);
    assert.match(output, /^\| Model\s+\| gpt-custom\s+\|$/m);
    assert.match(output, /^\| Effort\s+\| high\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --show-config resolves env above headless config and built-in defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(
      join(home, ".headless", "config.toml"),
      ["[agents.codex]", 'model = "gpt-config"', 'reasoning_effort = "xhigh"', ""].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["codex", "--show-config"], {
      env: { ...process.env, CODEX_MODEL: "gpt-env", HOME: home },
      stdout: (text) => stdout.push(text),
    });

    const output = stdout.join("");
    assert.equal(code, 0);
    assert.match(output, /^\| Model\s+\| gpt-env\s+\|$/m);
    assert.match(output, /^\| Effort\s+\| xhigh\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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

test("CLI applies model and reasoning defaults from ~/.headless/config.toml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(
      join(home, ".headless", "config.toml"),
      [
        "[agents.opencode]",
        'model = "openai/gpt-5.5"',
        'reasoning_effort = "high"',
        "",
        "[agents.cursor]",
        'model = "gpt-5.5"',
        'reasoning_effort = "xhigh"',
        "",
        "[agents.claude]",
        'model = "opus-4.8"',
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const opencodeCode = await runCli(["opencode", "--prompt", "hello", "--print-command"], {
      env: { ...process.env, HOME: home },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(opencodeCode, 0);
    assert.equal(
      stdout.join(""),
      "opencode run --format json --model openai/gpt-5.5 --variant high --dangerously-skip-permissions hello\n",
    );

    stdout.length = 0;
    const cursorCode = await runCli(["cursor", "--prompt", "hello", "--print-command"], {
      env: { ...process.env, HOME: home },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(cursorCode, 0);
    assert.equal(stdout.join(""), "agent -p --trust --force --output-format stream-json --model gpt-5.5-extra-high hello\n");

    stdout.length = 0;
    const claudeCode = await runCli(["claude", "--prompt", "hello", "--print-command"], {
      env: { ...process.env, HOME: home },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(claudeCode, 0);
    assert.equal(
      stdout.join(""),
      "claude --model claude-opus-4-8 -p hello --output-format stream-json --verbose --dangerously-skip-permissions\n",
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI flags override ~/.headless/config.toml defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(
      join(home, ".headless", "config.toml"),
      ["[agents.opencode]", 'model = "openai/gpt-5.5"', 'reasoning_effort = "high"', ""].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(
      [
        "opencode",
        "--model",
        "openai/gpt-5.4",
        "--reasoning-effort",
        "low",
        "--prompt",
        "hello",
        "--print-command",
      ],
      {
        env: { ...process.env, HOME: home },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 0);
    assert.equal(
      stdout.join(""),
      "opencode run --format json --model openai/gpt-5.4 --variant low --dangerously-skip-permissions hello\n",
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI falls back to built-in defaults when ~/.headless/config.toml is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const stdout: string[] = [];
    const code = await runCli(["opencode", "--prompt", "hello", "--print-command"], {
      env: { ...process.env, HOME: join(dir, "home") },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(
      stdout.join(""),
      "opencode run --format json --model openai/gpt-5.4 --dangerously-skip-permissions hello\n",
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("config parser accepts role sections and validates role fields", () => {
  assert.deepEqual(
    parseHeadlessConfig(
      [
        "[roles.explorer]",
        'allow = "read-only"',
        'reasoning_effort = "high"',
        'base_instruction_prompt = """',
        "Configured explorer prompt.",
        '"""',
        "",
      ].join("\n"),
    ).roles.explorer,
    {
      allow: "read-only",
      reasoningEffort: "high",
      baseInstructionPrompt: "Configured explorer prompt.",
    },
  );

  assert.throws(() => parseHeadlessConfig("[roles.scout]\nallow = \"read-only\"\n"), /unsupported headless config role/);
  assert.throws(() => parseHeadlessConfig("[roles.explorer]\nunknown = \"value\"\n"), /unsupported headless role config key/);
  assert.throws(() => parseHeadlessConfig("[roles.explorer]\nallow = \"maybe\"\n"), /unsupported headless config allow/);
  assert.throws(
    () => parseHeadlessConfig("[roles.explorer]\nreasoning_effort = \"max\"\n"),
    /unsupported headless config reasoning_effort/,
  );
});

test("config parser accepts general settings and validates general fields", () => {
  assert.deepEqual(
    parseHeadlessConfig(
      [
        "[general]",
        "timeout_seconds = 120",
        'default_agent = "pi"',
        'coordination = "tmux"',
        "run_status_interval_ms = 2500",
        "list_waiting_after_ms = 30000",
        "",
      ].join("\n"),
    ).general,
    {
      timeoutSeconds: 120,
      defaultAgent: "pi",
      coordination: "tmux",
      runStatusIntervalMs: 2500,
      listWaitingAfterMs: 30000,
    },
  );

  assert.throws(() => parseHeadlessConfig("[general]\nunknown = 1\n"), /unsupported headless general config key/);
  assert.throws(() => parseHeadlessConfig("[general]\ntimeout_seconds = 0\n"), /must be a positive integer/);
  assert.throws(() => parseHeadlessConfig("[general]\ndefault_agent = \"acp\"\n"), /unsupported headless default_agent/);
  assert.throws(() => parseHeadlessConfig("[general]\ncoordination = \"swarm\"\n"), /unsupported headless config coordination/);
});

test("CLI applies configured role defaults and replaces the built-in role prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(
      join(home, ".headless", "config.toml"),
      [
        "[roles.explorer]",
        'allow = "yolo"',
        'reasoning_effort = "high"',
        'base_instruction_prompt = """',
        "Configured explorer prompt.",
        '"""',
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["codex", "--role", "explorer", "--prompt", "hello", "--print-command"], {
      env: { ...process.env, HOME: home },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const output = stdout.join("");
    assert.match(output, /codex --dangerously-bypass-approvals-and-sandbox exec --model gpt-5\.5/);
    assert.match(output, /-c 'model_reasoning_effort="high"'/);
    assert.match(output, /Configured explorer prompt/);
    assert.match(output, /User prompt:/);
    assert.doesNotMatch(output, /Stay read-only/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI applies general default_agent from ~/.headless/config.toml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    mkdirSync(join(home, ".headless"), { recursive: true });
    mkdirSync(binDir);
    await import("node:fs/promises").then(async ({ chmod, writeFile }) => {
      for (const name of ["codex", "pi"]) {
        const binary = join(binDir, name);
        await writeFile(binary, "#!/usr/bin/env node\n");
        await chmod(binary, 0o755);
      }
    });
    writeFileSync(join(home, ".headless", "config.toml"), ["[general]", 'default_agent = "pi"', ""].join("\n"));

    const stdout: string[] = [];
    const code = await runCli(["--prompt", "hello", "--print-command"], {
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^pi --no-session --mode json /);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI exits 124 when a one-shot command exceeds --timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await import("node:fs/promises").then(async ({ chmod, writeFile }) => {
      const binary = join(binDir, "opencode");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "setTimeout(() => process.stdout.write('{\"type\":\"message\",\"text\":\"late\"}\\n'), 5000);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stderr: string[] = [];
    const code = await runCli(["opencode", "--prompt", "hello", "--timeout", "1"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stderr: (text) => stderr.push(text),
    });

    assert.equal(code, 124);
    assert.match(stderr.join(""), /timed out after 1s/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI waits for timed-out child stdout to drain before appending usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "process.on('SIGTERM', () => { process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }) + '\\n'); setTimeout(() => process.exit(0), 200); });",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });
    globalThis.fetch = async () => new Response(JSON.stringify({}));

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--json", "--usage", "--timeout", "3"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 124);
    const lines = stdout.join("").trim().split("\n");
    assert.equal(JSON.parse(lines[0] ?? "").type, "turn.completed");
    assert.equal(JSON.parse(lines[1] ?? "").usage.usageStatus, "reported");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI bounds timeout drain when a descendant retains stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const pidFile = join(dir, "grandchild.pid");
  const naturalExitFile = join(dir, "grandchild-natural-exit");
  const grandchildSource = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(naturalExitFile)}, "done"), 4_000)`;
  let grandchildPid: number | undefined;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "process.on('SIGTERM', () => {",
          `  const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
          "  writeFileSync(process.env.HEADLESS_TEST_GRANDCHILD_PID, String(child.pid));",
          "  child.unref();",
          "  process.exit(0);",
          "});",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const code = await runCli(["codex", "--prompt", "hello", "--json", "--usage", "--timeout", "3"], {
      env: {
        ...process.env,
        HEADLESS_TEST_GRANDCHILD_PID: pidFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: () => {},
    });

    assert.equal(code, 124);
    assert.equal(existsSync(naturalExitFile), false);
    grandchildPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    if (process.platform !== "win32") {
      await waitFor(() => !processIsAlive(grandchildPid as number));
      assert.equal(existsSync(naturalExitFile), false);
    }
  } finally {
    try {
      grandchildPid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(grandchildPid) && grandchildPid > 0) process.kill(grandchildPid, "SIGKILL");
    } catch {
      // The child may fail before creating its descendant.
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI kills timeout descendants after the direct child closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const pidFile = join(dir, "grandchild.pid");
  let grandchildPid: number | undefined;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "process.on('SIGTERM', () => {",
          "  const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 10_000)\"], { stdio: 'ignore' });",
          "  writeFileSync(process.env.HEADLESS_TEST_GRANDCHILD_PID, String(child.pid));",
          "  child.unref();",
          "  process.exit(0);",
          "});",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const code = await runCli(["codex", "--prompt", "hello", "--json", "--timeout", "3"], {
      env: {
        ...process.env,
        HEADLESS_TEST_GRANDCHILD_PID: pidFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: () => {},
    });

    assert.equal(code, 124);
    grandchildPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    if (process.platform !== "win32") {
      await waitFor(() => !processIsAlive(grandchildPid as number));
    }
  } finally {
    if (grandchildPid && processIsAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI forwards parent signals to timeout-enabled agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const agentPidFile = join(dir, "agent.pid");
  const signalFile = join(dir, "signal.txt");
  let agentPid: number | undefined;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "const { writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.HEADLESS_TEST_AGENT_PID, String(process.pid));",
          "process.on('SIGINT', () => {",
          "  writeFileSync(process.env.HEADLESS_TEST_SIGNAL_FILE, 'SIGINT');",
          "  process.exit(130);",
          "});",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const headless = spawn(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "src", "cli.ts"), "codex", "--prompt", "hello", "--json", "--timeout", "30"],
      {
        env: {
          ...process.env,
          HEADLESS_TEST_AGENT_PID: agentPidFile,
          HEADLESS_TEST_SIGNAL_FILE: signalFile,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdio: "ignore",
      },
    );
    await waitFor(() => existsSync(agentPidFile));

    headless.kill("SIGINT");
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      headless.once("exit", (code, signal) => resolve({ code, signal }));
    });

    assert.deepEqual(exit, { code: null, signal: "SIGINT" });
    await waitFor(() => existsSync(signalFile));
    assert.equal(readFileSync(signalFile, "utf8"), "SIGINT");
  } finally {
    try {
      agentPid = Number(readFileSync(agentPidFile, "utf8"));
      if (Number.isInteger(agentPid) && agentPid > 0 && processIsAlive(agentPid)) process.kill(agentPid, "SIGKILL");
    } catch {
      // The wrapper may fail before launching its agent.
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI forwards suspend and continue signals to timeout-enabled agents", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const agentPidFile = join(dir, "agent.pid");
  const signalFile = join(dir, "signals.txt");
  let agentPid: number | undefined;
  let headless: ReturnType<typeof spawn> | undefined;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "const { appendFileSync, writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.HEADLESS_TEST_AGENT_PID, String(process.pid));",
          "process.on('SIGTSTP', () => {",
          "  appendFileSync(process.env.HEADLESS_TEST_SIGNAL_FILE, 'SIGTSTP\\n');",
          "  process.kill(process.pid, 'SIGSTOP');",
          "});",
          "process.on('SIGCONT', () => appendFileSync(process.env.HEADLESS_TEST_SIGNAL_FILE, 'SIGCONT\\n'));",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    headless = spawn(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "src", "cli.ts"), "codex", "--prompt", "hello", "--json", "--timeout", "30"],
      {
        env: {
          ...process.env,
          HEADLESS_TEST_AGENT_PID: agentPidFile,
          HEADLESS_TEST_SIGNAL_FILE: signalFile,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdio: "ignore",
      },
    );
    await waitFor(() => existsSync(agentPidFile));

    headless.kill("SIGTSTP");
    await waitFor(() => existsSync(signalFile) && readFileSync(signalFile, "utf8").includes("SIGTSTP"));
    headless.kill("SIGCONT");
    await waitFor(() => readFileSync(signalFile, "utf8").includes("SIGCONT"));

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      headless?.once("exit", (code, signal) => resolve({ code, signal }));
    });
    headless.kill("SIGTERM");
    assert.deepEqual(await exit, { code: null, signal: "SIGTERM" });
  } finally {
    if (headless && headless.exitCode === null && headless.signalCode === null) headless.kill("SIGKILL");
    try {
      agentPid = Number(readFileSync(agentPidFile, "utf8"));
      if (Number.isInteger(agentPid) && agentPid > 0 && processIsAlive(agentPid)) process.kill(agentPid, "SIGKILL");
    } catch {
      // The wrapper may fail before launching its agent.
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --json --usage keeps usage accounting bounded around a large native trace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          `process.stdout.write(JSON.stringify({ type: 'tool', text: '${"x".repeat(300_000)}' }) + '\\n');`,
          "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }) + '\\n');",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });
    globalThis.fetch = async () => new Response(JSON.stringify({}));

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--json", "--usage"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.ok(stdout.join("").length > 300_000);
    const usage = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "").usage;
    assert.equal(usage.totalTokens, 12);
    assert.equal(usage.usageStatus, "reported");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --json --usage preserves terminal usage from oversized JSON rows", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({}));
    const cases: Array<{
      agent: "claude" | "cursor" | "opencode" | "pi";
      binaryName: string;
      row: Record<string, unknown>;
      expectedTotalTokens: number;
      expectedCost?: number;
    }> = [
      {
        agent: "claude",
        binaryName: "claude",
        row: {
          type: "result",
          total_cost_usd: 0.25,
          usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 2 },
        },
        expectedTotalTokens: 15,
        expectedCost: 0.25,
      },
      {
        agent: "cursor",
        binaryName: "agent",
        row: {
          type: "result",
          usage: { inputTokens: 10, cacheReadTokens: 3, outputTokens: 2 },
        },
        expectedTotalTokens: 15,
      },
      {
        agent: "opencode",
        binaryName: "opencode",
        row: {
          type: "step_finish",
          part: { cost: 0.2, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3 } } },
        },
        expectedTotalTokens: 16,
        expectedCost: 0.2,
      },
      {
        agent: "pi",
        binaryName: "pi",
        row: {
          type: "message_end",
          message: {
            model: "gpt-test",
            provider: "openai",
            usage: { input: 10, cacheRead: 3, output: 2, cost: { total: 0.15 } },
          },
        },
        expectedTotalTokens: 15,
        expectedCost: 0.15,
      },
    ];

    for (const testCase of cases) {
      const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
      try {
        const binDir = join(dir, "bin");
        await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
          await mkdir(binDir);
          const binary = join(binDir, testCase.binaryName);
          await writeFile(
            binary,
            [
              "#!/usr/bin/env node",
              `const metadata = ${JSON.stringify(testCase.row)};`,
              "const row = { type: metadata.type, result: 'x'.repeat(300_000), ...metadata };",
              "process.stdout.write(JSON.stringify(row) + '\\n');",
              "",
            ].join("\n"),
          );
          await chmod(binary, 0o755);
        });

        const stdout: string[] = [];
        const code = await runCli([testCase.agent, "--prompt", "hello", "--json", "--usage"], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
          stdout: (text) => stdout.push(text),
        });

        assert.equal(code, 0);
        assert.ok(stdout.join("").length > 300_000);
        const usage = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "").usage;
        assert.equal(usage.totalTokens, testCase.expectedTotalTokens);
        assert.equal(usage.usageStatus, "reported");
        if (testCase.expectedCost !== undefined) {
          assert.equal(usage.cost.total, testCase.expectedCost);
          assert.equal(usage.costBasis, "native-reported");
        }
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI --json --usage preserves Codex session identity across a large relevant trace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const binDir = join(dir, "bin");
    const home = join(dir, "home");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-large' }));",
          "for (let index = 0; index < 4_000; index += 1) {",
          "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(100) } }));",
          "}",
          "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });
    globalThis.fetch = async () => new Response(JSON.stringify({}));

    const code = await runCli(["codex", "--prompt", "hello", "--session", "work", "--json", "--usage"], {
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: () => {},
    });

    assert.equal(code, 0);
    const store = JSON.parse(readFileSync(join(home, ".headless", "sessions.json"), "utf8"));
    assert.equal(store.agents.codex.work.nativeId, "thread-large");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI flags override configured role allow and reasoning effort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(
      join(home, ".headless", "config.toml"),
      ["[roles.explorer]", 'model = "gpt-role"', 'allow = "read-only"', 'reasoning_effort = "high"', ""].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(
      [
        "codex",
        "--role",
        "explorer",
        "--model",
        "gpt-cli",
        "--allow",
        "yolo",
        "--reasoning-effort",
        "low",
        "--prompt",
        "hello",
        "--print-command",
      ],
      { env: { ...process.env, HOME: home }, stdout: (text) => stdout.push(text) },
    );

    assert.equal(code, 0);
    const output = stdout.join("");
    assert.match(output, /codex --dangerously-bypass-approvals-and-sandbox exec --model gpt-cli/);
    assert.match(output, /-c 'model_reasoning_effort="low"'/);
    assert.doesNotMatch(output, /--sandbox read-only/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("environment model overrides stay above role config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(
      join(home, ".headless", "config.toml"),
      ["[agents.codex]", 'model = "gpt-agent"', "", "[roles.worker]", 'model = "gpt-role"', ""].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["codex", "--role", "worker", "--prompt", "hello", "--print-command"], {
      env: { ...process.env, HOME: home, CODEX_MODEL: "gpt-env" },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /codex --dangerously-bypass-approvals-and-sandbox exec --model gpt-env/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("role config model is optional and falls back to agent config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(
      join(home, ".headless", "config.toml"),
      [
        "[agents.opencode]",
        'model = "openai/gpt-agent"',
        "",
        "[roles.worker]",
        'reasoning_effort = "high"',
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["opencode", "--role", "worker", "--prompt", "hello", "--print-command"], {
      env: { ...process.env, HOME: home },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /opencode run --format json --model openai\/gpt-agent --variant high/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("quotes config assignments that contain shell syntax", () => {
  assert.equal(
    quoteCommand({ command: "codex", args: ["-c", 'model_reasoning_effort="high"', "hello"] }),
    'codex -c \'model_reasoning_effort="high"\' hello',
  );
});

test("quotes assignment-shaped prompt args without changing their value", () => {
  assert.equal(
    quoteCommand({ command: "agent", args: ['foo="bar"'] }),
    'agent \'foo="bar"\'',
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
    assert.equal(
      stdout.join(""),
      "opencode run --format json --model openai/gpt-5.4 --dangerously-skip-permissions 'from file'\n",
    );
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
  assert.equal(
    stdout.join(""),
    "pi --no-session --mode json --provider openai-codex --model gpt-5.5 --tools 'read,bash,edit,write' 'stdin prompt'\n",
  );
});

test("CLI --session creates and resumes a Codex alias", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "codex-args.jsonl");
    mkdirSync(home);
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "codex"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify(args) + '\\n');",
          "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));",
          "console.log(JSON.stringify({ type: 'agent_message', text: args.includes('resume') ? 'resumed' : 'started' }));",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "codex"), 0o755);
    });

    const stdout: string[] = [];
    const env = { ...process.env, HEADLESS_CAPTURE: captureFile, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    assert.equal(await runCli(["codex", "--session", "work", "--prompt", "hello"], { env, stdout: (text) => stdout.push(text) }), 0);
    assert.equal(stdout.join(""), "started\n");
    const store = JSON.parse(readFileSync(join(home, ".headless", "sessions.json"), "utf8"));
    assert.equal(store.agents.codex.work.nativeId, "thread-1");

    stdout.length = 0;
    assert.equal(await runCli(["codex", "--session", "work", "--prompt", "again"], { env, stdout: (text) => stdout.push(text) }), 0);
    assert.equal(stdout.join(""), "resumed\n");
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls[1].includes("resume"), true);
    assert.equal(calls[1].includes("thread-1"), true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --session pre-creates and stores Cursor chats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "agent-args.jsonl");
    mkdirSync(home);
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "agent"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args[0] === 'create-chat') { console.log('chat-1'); process.exit(0); }",
          "console.log(JSON.stringify({ role: 'assistant', content: 'cursor done' }));",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "agent"), 0o755);
    });

    const stdout: string[] = [];
    const env = { ...process.env, HEADLESS_CAPTURE: captureFile, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const code = await runCli(["cursor", "--session", "work", "--prompt", "hello"], {
      env,
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "cursor done\n");
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ["create-chat"]);
    assert.equal(calls[1].includes("--resume"), true);
    assert.equal(calls[1].includes("chat-1"), true);
    const store = JSON.parse(readFileSync(join(home, ".headless", "sessions.json"), "utf8"));
    assert.equal(store.agents.cursor.work.nativeId, "chat-1");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --session stores the newest Gemini session when list output is oldest first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "gemini-args.jsonl");
    mkdirSync(home);
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "gemini"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args.includes('--list-sessions')) {",
          "  console.log('Available sessions for this project (2):');",
          "  console.log('  1. older session (4 hours ago) [11111111-1111-4111-8111-111111111111]');",
          "  console.log('  2. newest session (1 hour ago) [22222222-2222-4222-8222-222222222222]');",
          "  process.exit(0);",
          "}",
          "console.log(JSON.stringify({ response: 'gemini done' }));",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "gemini"), 0o755);
    });

    const stdout: string[] = [];
    const env = { ...process.env, HEADLESS_CAPTURE: captureFile, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const code = await runCli(["gemini", "--session", "work", "--prompt", "hello"], {
      env,
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "gemini done\n");
    const store = JSON.parse(readFileSync(join(home, ".headless", "sessions.json"), "utf8"));
    assert.equal(store.agents.gemini.work.nativeId, "22222222-2222-4222-8222-222222222222");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --session stores and resumes Antigravity conversations from brain transcripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const captureFile = join(dir, "agy-args.jsonl");
    mkdirSync(home);
    mkdirSync(workDir);
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "agy"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (process.cwd() !== process.env.HEADLESS_EXPECT_CWD) {",
          "  console.error(`unexpected cwd: ${process.cwd()}`);",
          "  process.exit(17);",
          "}",
          "const id = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'agy-session-1';",
          "const cache = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');",
          "const transcript = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');",
          "fs.mkdirSync(path.dirname(cache), { recursive: true });",
          "fs.writeFileSync(cache, JSON.stringify({ [process.cwd()]: id }));",
          "fs.mkdirSync(path.dirname(transcript), { recursive: true });",
          "fs.writeFileSync(transcript, [",
          "  JSON.stringify({ type: 'SESSION_META', payload: { cwd: process.cwd() } }),",
          "  JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', content: args.includes('--conversation') ? 'resumed' : 'started' }),",
          "  '',",
          "].join('\\n'));",
          "console.log(args.includes('--conversation') ? 'resumed' : 'started');",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "agy"), 0o755);
    });

    const stdout: string[] = [];
    const env = {
      ...process.env,
      HEADLESS_CAPTURE: captureFile,
      HEADLESS_EXPECT_CWD: realpathSync(workDir),
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    assert.equal(
      await runCli(["antigravity", "--session", "work", "--prompt", "hello", "--work-dir", workDir], {
        env,
        stdout: (text) => stdout.push(text),
      }),
      0,
    );
    assert.equal(stdout.join(""), "started\n");
    const store = JSON.parse(readFileSync(join(home, ".headless", "sessions.json"), "utf8"));
    assert.equal(store.agents.antigravity.work.nativeId, "agy-session-1");

    stdout.length = 0;
    assert.equal(
      await runCli(["antigravity", "--session", "work", "--prompt", "again", "--work-dir", workDir], {
        env,
        stdout: (text) => stdout.push(text),
      }),
      0,
    );
    assert.equal(stdout.join(""), "resumed\n");
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls[0].includes("--cwd"), false);
    assert.equal(calls[1].includes("--conversation"), true);
    assert.equal(calls[1].includes("agy-session-1"), true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI rejects invalid --session combinations", async () => {
  const stderr: string[] = [];
  assert.equal(await runCli(["codex", "--session", "bad/name", "--prompt", "hello"], { stderr: (text) => stderr.push(text) }), 2);
  assert.match(stderr.join(""), /invalid session name/);

  stderr.length = 0;
  assert.equal(
    await runCli(["codex", "--session", "work", "--name", "other", "--tmux", "--prompt", "hello"], {
      stderr: (text) => stderr.push(text),
    }),
    2,
  );
  assert.match(stderr.join(""), /--session cannot be used with --name/);

  stderr.length = 0;
  assert.equal(
    await runCli(["codex", "--session", "work", "--docker", "--prompt", "hello"], { stderr: (text) => stderr.push(text) }),
    2,
  );
  assert.match(stderr.join(""), /--session cannot be used with --docker/);
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
        "--reasoning-effort",
        "high",
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
    assert.match(output, /exec --model gpt-5\.5 -c 'model_reasoning_effort="high"' --json --skip-git-repo-check -/);
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
        "--reasoning-effort",
        "high",
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
    assert.match(output, /exec --model gpt-5\.5 -c 'model_reasoning_effort="high"' --json --skip-git-repo-check -/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI applies --timeout to Modal unless --modal-timeout is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const projectDir = join(dir, "project");
    mkdirSync(join(home, ".headless"), { recursive: true });
    mkdirSync(projectDir);
    writeFileSync(join(home, ".headless", "config.toml"), ["[general]", "timeout_seconds = 77", ""].join("\n"));

    const stdout: string[] = [];
    assert.equal(
      await runCli(["codex", "--prompt", "hello", "--work-dir", projectDir, "--modal", "--timeout", "55", "--print-command"], {
        env: { ...process.env, HOME: home },
        stdout: (text) => stdout.push(text),
      }),
      0,
    );
    assert.match(stdout.join(""), /--timeout 55 /);

    stdout.length = 0;
    assert.equal(
      await runCli(
        [
          "codex",
          "--prompt",
          "hello",
          "--work-dir",
          projectDir,
          "--modal",
          "--timeout",
          "55",
          "--modal-timeout",
          "44",
          "--print-command",
        ],
        {
          env: { ...process.env, HOME: home },
          stdout: (text) => stdout.push(text),
        },
      ),
      0,
    );
    assert.match(stdout.join(""), /--timeout 44 /);
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
      "gpt-5.5",
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
    assert.match(output, /^\| docker\s+\| ✓\s+\| 27\.1\.2\s+\| ghcr\.io\/roberttlange\/headless:latest \(missing\)\s+\|$/m);
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

test("CLI --print-command --json reports selected identity for npx callers", async () => {
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
    const code = await runCli(["--prompt", "hello", "--print-command", "--json"], {
      env: { PATH: binDir },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const payload = JSON.parse(stdout.join(""));
    assert.equal(payload.agent, "codex");
    assert.equal(payload.model, "gpt-5.5");
    assert.equal(payload.reasoningEffort, undefined);
    assert.match(payload.command, /^printf %s hello \| codex --dangerously-bypass-approvals-and-sandbox exec/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --print-command --json includes configured effort and env-backed model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(binary, "#!/usr/bin/env node\n");
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["--prompt", "hello", "--reasoning-effort", "high", "--print-command", "--json"], {
      env: { PATH: binDir, CODEX_MODEL: "gpt-5.4" },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const payload = JSON.parse(stdout.join(""));
    assert.equal(payload.agent, "codex");
    assert.equal(payload.model, "gpt-5.4");
    assert.equal(payload.reasoningEffort, "high");
    assert.match(payload.command, /--model gpt-5\.4/);
    assert.match(payload.command, /model_reasoning_effort/);
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
    assert.equal(
      stdout.join(""),
      "pi-agent --no-session --mode json --provider openai-codex --model gpt-5.5 --tools 'read,bash,edit,write' hello\n",
    );
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

test("CLI rejects ACP without a registry agent or custom command", async () => {
  const stderr: string[] = [];
  const code = await runCli(["acp", "--prompt", "hello"], {
    env: { ...process.env, HEADLESS_ACP_AGENT: undefined, HEADLESS_ACP_COMMAND: undefined },
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /acp requires --acp-agent, --acp-command/);
});

test("CLI aggregates chunked ACP stdio output", async () => {
  const stdout: string[] = [];
  const code = await runCli(["acp", "--prompt", "hello acp"], {
    env: {
      ...process.env,
      HEADLESS_BIN: `${process.execPath} --import tsx ${join(repoRoot, "src", "cli.ts")}`,
      HEADLESS_ACP_COMMAND: `${process.execPath} --import tsx ${join(repoRoot, "src", "cli.ts")} acp-stdio`,
    },
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.equal(stdout.join(""), "hello acp\n");
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

test("CLI shows a waiting spinner on stderr for interactive captured runs", async () => {
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
          "setTimeout(() => {",
          "  console.log(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } }));",
          "}, 180);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["pi", "--prompt", "hello"], {
      env: { ...process.env, NO_COLOR: undefined, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stderr: (text) => stderr.push(text),
      stderrIsTTY: true,
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "final answer\n");
    const output = stderr.join("");
    assert.match(
      output,
      /\[\x1b\[36mpi\x1b\[0m-\x1b\[35mopenai-codex\/gpt-5\.5\x1b\[0m-\x1b\[33mdefault\x1b\[0m\] [a-z ]+ (?:\.{0,3})/,
    );
    assert.match(
      output,
      /\[\x1b\[36mpi\x1b\[0m-\x1b\[35mopenai-codex\/gpt-5\.5\x1b\[0m-\x1b\[33mdefault\x1b\[0m\] [a-z ]+ (?=\r|\x1b|$)/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI does not show a waiting spinner for non-interactive captured runs", async () => {
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
          "setTimeout(() => {",
          "  console.log(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } }));",
          "}, 180);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["pi", "--prompt", "hello"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stderr: (text) => stderr.push(text),
      stderrIsTTY: false,
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "final answer\n");
    assert.equal(stderr.join(""), "");
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

test("CLI --json does not show a waiting spinner on stderr", async () => {
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
          "setTimeout(() => {",
          `  process.stdout.write(${JSON.stringify(trace)});`,
          "}, 180);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["pi", "--prompt", "hello", "--json"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stderr: (text) => stderr.push(text),
      stderrIsTTY: true,
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), trace);
    assert.equal(stderr.join(""), "");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --json streams raw trace output for every provider", async () => {
  const providerBinaries: Record<AgentName, string> = {
    antigravity: "agy",
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

test("CLI Claude execution prefers OAuth over inherited Anthropic API key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "env.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".claude.json"), "{}\n");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "claude");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "fs.writeFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify({ anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null }));",
          "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'final answer' }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["claude", "--prompt", "hello"], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-low-balance",
        HEADLESS_CAPTURE: captureFile,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "final answer\n");
    assert.deepEqual(JSON.parse(readFileSync(captureFile, "utf8")), { anthropicApiKey: null });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --usage prints final message and normalized usage JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'agent_message', text: 'final answer' }));",
          "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5": {
                cost: {
                  input: 1.25,
                  cache_read: 0.125,
                  output: 10,
                },
              },
            },
          },
        }),
      );

    const stdout: string[] = [];
    const code = await runCli(["codex", "--model", "gpt-5", "--prompt", "hello", "--usage"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const lines = stdout.join("").trim().split("\n");
    assert.equal(lines[0], "final answer");
    assert.deepEqual(JSON.parse(lines[1]), {
      usage: {
        agent: "codex",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 600,
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
        totalTokens: 1100,
        usageStatus: "reported",
        cost: {
          input: 0.00075,
          cacheRead: 0.00005,
          cacheWrite: 0,
          output: 0.001,
          total: 0.0018,
        },
        costBasis: "api-list-price-estimate",
        pricingSource: "models.dev",
        pricingStatus: "priced",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --json --usage streams raw trace and appends usage without requiring a final message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const binDir = join(dir, "bin");
    const firstRecord = { type: "thread.started", thread_id: "thread-1" };
    const usageRecord = {
      type: "turn.completed",
      usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 },
    };
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          `console.log(${JSON.stringify(JSON.stringify(firstRecord))});`,
          `setTimeout(() => console.log(${JSON.stringify(JSON.stringify(usageRecord))}), 150);`,
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5": { cost: { input: 1.25, cache_read: 0.125, output: 10 } },
            },
          },
        }),
      );

    const stdout: string[] = [];
    let completed = false;
    const result = runCli(["codex", "--model", "gpt-5", "--prompt", "hello", "--json", "--usage"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    }).finally(() => {
      completed = true;
    });

    await waitFor(() => stdout.join("").startsWith(`${JSON.stringify(firstRecord)}\n`) && !completed);
    assert.equal(completed, false);
    assert.equal(await result, 0);

    const lines = stdout.join("").trim().split("\n");
    assert.deepEqual(JSON.parse(lines[0] ?? ""), firstRecord);
    assert.deepEqual(JSON.parse(lines[1] ?? ""), usageRecord);
    const usage = JSON.parse(lines[2] ?? "").usage;
    assert.equal(usage.inputTokens, 600);
    assert.equal(usage.cacheReadTokens, 400);
    assert.equal(usage.outputTokens, 100);
    assert.equal(usage.usageStatus, "reported");
    assert.equal(usage.cost.total, 0.0018);
    assert.equal(usage.costBasis, "api-list-price-estimate");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --json --usage appends partial usage and preserves a nonzero agent status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));",
          "process.exitCode = 7;",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });
    globalThis.fetch = async () => new Response(JSON.stringify({}));

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--json", "--usage"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 7);
    const lines = stdout.join("").trim().split("\n");
    assert.equal(JSON.parse(lines[0] ?? "").type, "turn.completed");
    const usage = JSON.parse(lines[1] ?? "").usage;
    assert.equal(usage.totalTokens, 12);
    assert.equal(usage.usageStatus, "reported");
    assert.equal(usage.cost, null);
    assert.equal(usage.costBasis, null);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --json --usage captures Antigravity status usage without changing real settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "agy-capture.json");
    mkdirSync(join(appDir, "brain"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(
      join(appDir, "settings.json"),
      `${JSON.stringify({ statusLine: { type: "", command: "", enabled: true }, useG1Credits: true })}\n`,
    );
    const binary = join(binDir, "agy");
    writeFileSync(
      binary,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const { spawnSync } = require('node:child_process');",
        "const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));",
        "fs.writeFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify({ home: process.env.HOME, settings }));",
        "const payload = { conversation_id: 'agy-1', model: { id: 'Gemini 3.5 Flash (Low)', display_name: 'Gemini 3.5 Flash (Low)' }, context_window: { current_usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 } } };",
        "const status = spawnSync('/bin/sh', ['-c', settings.statusLine.command], { input: JSON.stringify(payload), env: process.env, encoding: 'utf8' });",
        "if (status.status !== 0) { process.stderr.write(status.stderr); process.exit(status.status ?? 1); }",
        "process.stdout.write('final answer\\n');",
        "",
      ].join("\n"),
    );
    chmodSync(binary, 0o755);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          google: {
            models: {
              "gemini-3.5-flash": { cost: { input: 1.5, cache_read: 0.15, output: 9 } },
            },
          },
        }),
      );

    const stdout: string[] = [];
    const code = await runCli(
      ["antigravity", "--model", "Gemini 3.5 Flash (Low)", "--prompt", "hello", "--json", "--usage"],
      {
        env: {
          ...process.env,
          ANTIGRAVITY_CLI_BIN: binary,
          HEADLESS_CAPTURE: captureFile,
          HOME: home,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 0);
    const lines = stdout.join("").trim().split("\n");
    assert.equal(lines[0], "final answer");
    assert.deepEqual(JSON.parse(lines[1]).usage, {
      agent: "antigravity",
      provider: "google",
      model: "Gemini 3.5 Flash (Low)",
      inputTokens: 1000,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      totalTokens: 1250,
      usageStatus: "reported",
      cost: {
        input: 0.0015,
        cacheRead: 0.00003,
        cacheWrite: 0,
        output: 0.00045,
        total: 0.00198,
      },
      costBasis: "api-list-price-estimate",
      pricingSource: "models.dev",
      pricingStatus: "priced",
    });
    const invocation = JSON.parse(readFileSync(captureFile, "utf8"));
    assert.notEqual(invocation.home, home);
    assert.equal(invocation.settings.statusLine.type, "command");
    assert.deepEqual(JSON.parse(readFileSync(join(appDir, "settings.json"), "utf8")), {
      statusLine: { type: "", command: "", enabled: true },
      useG1Credits: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI cleans the Antigravity usage overlay when the parent receives SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    const binDir = join(dir, "bin");
    const overlayPath = join(dir, "overlay-home.txt");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(appDir, "settings.json"), `${JSON.stringify({ statusLine: { type: "", command: "", enabled: true } })}\n`);
    const binary = join(binDir, "agy");
    writeFileSync(
      binary,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(overlayPath)}, process.env.HOME);`,
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));",
        "setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 100);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(binary, 0o755);
    const runner = join(dir, "runner.mjs");
    writeFileSync(
      runner,
      [
        `import { runCli } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "cli.ts")).href)};`,
        "const code = await runCli(['antigravity', '--prompt', 'hello', '--json', '--usage']);",
        "process.exitCode = code;",
        "",
      ].join("\n"),
    );

    const child = spawnSync(process.execPath, ["--import", "tsx", runner], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ANTIGRAVITY_CLI_BIN: binary, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });
    assert.equal(child.status, null, child.stderr);
    assert.equal(child.signal, "SIGTERM", child.stderr);
    assert.equal(existsSync(readFileSync(overlayPath, "utf8")), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI skips the Antigravity usage overlay on Windows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    const binDir = join(dir, "bin");
    const overlayPath = join(dir, "overlay-home.txt");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(appDir, "settings.json"), `${JSON.stringify({ statusLine: { type: "", command: "", enabled: true } })}\n`);
    const binary = join(binDir, "agy");
    writeFileSync(
      binary,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(overlayPath)}, process.env.HOME);`,
        "process.stdout.write('antigravity final\\n');",
        "",
      ].join("\n"),
    );
    chmodSync(binary, 0o755);
    const runner = join(dir, "runner.mjs");
    writeFileSync(
      runner,
      [
        "Object.defineProperty(process, 'platform', { value: 'win32' });",
        `const { runCli } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "src", "cli.ts")).href)});`,
        "const code = await runCli(['antigravity', '--prompt', 'hello', '--json', '--usage']);",
        "process.exitCode = code;",
        "",
      ].join("\n"),
    );

    const child = spawnSync(process.execPath, ["--import", "tsx", runner], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ANTIGRAVITY_CLI_BIN: binary, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(overlayPath, "utf8"), home);
    assert.deepEqual(JSON.parse(readFileSync(join(appDir, "settings.json"), "utf8")), {
      statusLine: { type: "", command: "", enabled: true },
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI does not redeliver parent signals to embedded host listeners", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    const binDir = join(dir, "bin");
    const signalCountPath = join(dir, "signal-count.txt");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(appDir, "settings.json"), `${JSON.stringify({ statusLine: { type: "", command: "", enabled: true } })}\n`);
    const binary = join(binDir, "agy");
    writeFileSync(
      binary,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => process.exit(0));",
        "setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 100);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(binary, 0o755);
    const runner = join(dir, "runner.mjs");
    writeFileSync(
      runner,
      [
        "import { writeFileSync } from 'node:fs';",
        `const signalCountPath = ${JSON.stringify(signalCountPath)};`,
        "let signalCount = 0;",
        "process.on('SIGTERM', () => writeFileSync(signalCountPath, String(++signalCount)));",
        `const { runCli } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "src", "cli.ts")).href)});`,
        "process.exitCode = await runCli(['antigravity', '--prompt', 'hello', '--json', '--usage']);",
        "",
      ].join("\n"),
    );

    const child = spawnSync(process.execPath, ["--import", "tsx", runner], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ANTIGRAVITY_CLI_BIN: binary, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(signalCountPath, "utf8"), "1");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI bounds Antigravity stdout drain after the direct child exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const grandchildPidPath = join(dir, "grandchild.pid");
  const naturalExitPath = join(dir, "grandchild-natural-exit");
  const grandchildSource = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(naturalExitPath)}, "done"), 4_000)`;
  let grandchildPid: number | undefined;
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    const binDir = join(dir, "bin");
    const overlayPath = join(dir, "overlay-home.txt");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(appDir, "settings.json"), `${JSON.stringify({ statusLine: { type: "", command: "", enabled: true } })}\n`);
    const binary = join(binDir, "agy");
    writeFileSync(
      binary,
      [
        "#!/usr/bin/env node",
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(overlayPath)}, process.env.HOME);`,
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
        `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));`,
        "child.unref();",
        "process.stdout.write('antigravity final\\n');",
        "",
      ].join("\n"),
    );
    chmodSync(binary, 0o755);

    const code = await runCli(["antigravity", "--prompt", "hello", "--json", "--usage"], {
      env: { ...process.env, ANTIGRAVITY_CLI_BIN: binary, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: () => {},
    });

    assert.equal(code, 0);
    assert.equal(existsSync(readFileSync(overlayPath, "utf8")), false);
    grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
    await waitFor(() => !processIsAlive(grandchildPid as number));
    assert.equal(existsSync(naturalExitPath), false);
  } finally {
    if (grandchildPid && processIsAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  }
});

test(
  "CLI kills Antigravity descendants that close inherited stdio",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
    const grandchildPidPath = join(dir, "grandchild.pid");
    let grandchildPid: number | undefined;
    try {
      const home = join(dir, "home");
      const appDir = join(home, ".gemini", "antigravity-cli");
      const binDir = join(dir, "bin");
      const overlayPath = join(dir, "overlay-home.txt");
      mkdirSync(appDir, { recursive: true });
      mkdirSync(binDir);
      writeFileSync(
        join(appDir, "settings.json"),
        `${JSON.stringify({ statusLine: { type: "", command: "", enabled: true } })}\n`,
      );
      const binary = join(binDir, "agy");
      writeFileSync(
        binary,
        [
          "#!/usr/bin/env node",
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          `writeFileSync(${JSON.stringify(overlayPath)}, process.env.HOME);`,
          "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore' });",
          `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));`,
          "child.unref();",
          "process.stdout.write('antigravity final\\n');",
          "",
        ].join("\n"),
      );
      chmodSync(binary, 0o755);

      const code = await runCli(["antigravity", "--prompt", "hello", "--json", "--usage", "--timeout", "60"], {
        env: { ...process.env, ANTIGRAVITY_CLI_BIN: binary, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: () => {},
      });

      assert.equal(code, 0);
      assert.equal(existsSync(readFileSync(overlayPath, "utf8")), false);
      grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
      await waitFor(() => !processIsAlive(grandchildPid as number));
    } finally {
      if (grandchildPid && processIsAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
      rmSync(dir, { force: true, recursive: true });
    }
  },
);

test("CLI --usage prices Codex hard default model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const binDir = join(dir, "bin");
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), 'model = "ignored-model"\n[projects]\n');
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "codex");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'agent_message', text: 'final answer' }));",
          "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5.5": {
                cost: {
                  input: 2,
                  output: 20,
                },
              },
            },
          },
        }),
      );

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--usage"], {
      env: { ...process.env, CODEX_HOME: codexHome, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const usage = JSON.parse(stdout.join("").trim().split("\n")[1]).usage;
    assert.equal(usage.model, "gpt-5.5");
    assert.equal(usage.pricingStatus, "priced");
    assert.equal(usage.costBasis, "api-list-price-estimate");
    assert.deepEqual(usage.cost, {
      input: 0.002,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0.002,
      total: 0.004,
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --usage reports Cursor reasoning model variant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "agent");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } }));",
          "console.log(JSON.stringify({ type: 'result', usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5.5": {
                cost: {
                  input: 2,
                  output: 20,
                },
              },
            },
          },
        }),
      );

    const stdout: string[] = [];
    const code = await runCli(
      ["cursor", "--prompt", "hello", "--model", "gpt-5.5", "--reasoning-effort", "xhigh", "--usage"],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 0);
    const usage = JSON.parse(stdout.join("").trim().split("\n")[1]).usage;
    assert.equal(usage.model, "gpt-5.5-extra-high");
    assert.equal(usage.pricingStatus, "priced");
    assert.equal(usage.costBasis, "api-list-price-estimate");
    assert.deepEqual(usage.cost, {
      input: 0.0002,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0.0002,
      total: 0.0004,
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --usage splits Pi provider/model specs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "pi");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'final answer' }));",
          "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });
    globalThis.fetch = async () => new Response(JSON.stringify({}));

    const stdout: string[] = [];
    const code = await runCli(["pi", "--model", "openai-codex/gpt-5.4", "--prompt", "hello", "--usage"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const usage = JSON.parse(stdout.join("").trim().split("\n")[1]).usage;
    assert.equal(usage.provider, "openai-codex");
    assert.equal(usage.model, "gpt-5.4");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --usage reports OpenCode hard default model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "opencode");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ role: 'assistant', parts: [{ type: 'text', text: 'final answer' }] }));",
          "console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 0, write: 0 } }, cost: 0.5 } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["opencode", "--prompt", "hello", "--usage"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const usage = JSON.parse(stdout.join("").trim().split("\n")[1]).usage;
    assert.equal(usage.provider, "openai");
    assert.equal(usage.model, "gpt-5.4");
    assert.equal(usage.pricingStatus, "native");
    assert.equal(usage.costBasis, "native-reported");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI rejects --usage in tmux mode", async () => {
  const stderr: string[] = [];
  assert.equal(
    await runCli(["codex", "--prompt", "hello", "--usage", "--tmux"], {
      stderr: (text) => stderr.push(text),
    }),
    2,
  );
  assert.match(stderr.join(""), /--usage cannot be used with --tmux/);
});

test("CLI help lists usage output option", async () => {
  const stdout: string[] = [];
  const code = await runCli(["--help"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /--usage/);
});

test("CLI help lists timeout option", async () => {
  const stdout: string[] = [];
  const code = await runCli(["--help"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /--timeout <s>/);
});

test("CLI help explains what Headless accomplishes", async () => {
  const stdout: string[] = [];
  const code = await runCli(["--help"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(
    stdout.join(""),
    /Headless gives coding-agent CLIs one shared interface for prompts, models, reasoning effort, output modes, sessions, and work directories\.\nIt runs supported agents locally, in tmux, in Docker, or in Modal while preserving each backend's native execution behavior\.\nUse it to launch one-off tasks, resume named sessions, or coordinate multi-agent runs from scripts and terminals\./,
  );
});

test("CLI --version prints package version", async () => {
  const stdout: string[] = [];
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
  const code = await runCli(["--version"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.equal(stdout.join(""), `${packageJson.version}\n`);
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

test("CLI --tmux --wait prints final message from native transcript activity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const captureFile = join(dir, "tmux.jsonl");
    const transcriptPath = join(home, ".codex", "sessions", "2026", "05", "14", "rollout-wait.jsonl");
    mkdirSync(workDir, { recursive: true });
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args[0] === 'new-session') {",
          "  fs.mkdirSync(path.dirname(process.env.HEADLESS_TRANSCRIPT), { recursive: true });",
          "  const sessionName = args[3];",
          "  const cwd = args[5];",
          "  fs.writeFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'wait', cwd } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello <!-- headless-tmux-wait:' + sessionName + ' -->' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'wait final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_CAPTURE: captureFile,
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HEADLESS_TRANSCRIPT: transcriptPath,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stderr: (text) => stderr.push(text),
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "wait final\n");
    assert.match(stderr.join(""), /tmux session: headless-codex-\d+/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux --wait ignores stale transcript bytes from an existing session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const transcriptPath = join(home, ".codex", "sessions", "2026", "05", "14", "rollout-existing.jsonl");
    mkdirSync(dirname(transcriptPath), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ timestamp: "2026-05-14T09:00:00.000Z", type: "session_meta", payload: { id: "existing", cwd: workDir } }),
        JSON.stringify({
          timestamp: "2026-05-14T09:00:01.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "stale final" }] },
        }),
        JSON.stringify({ timestamp: "2026-05-14T09:00:02.000Z", type: "event_msg", payload: { type: "task_complete" } }),
        "",
      ].join("\n"),
    );
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'new-session') {",
          "  fs.appendFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again <!-- headless-tmux-wait:' + args[3] + ' -->' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fresh final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "again", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_WAIT_FORCE_MARKER: "1",
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HEADLESS_TRANSCRIPT: transcriptPath,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "fresh final\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux --wait accepts terminal completion even when final answer asks a question", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const transcriptPath = join(home, ".codex", "sessions", "2026", "05", "14", "rollout-question.jsonl");
    mkdirSync(workDir, { recursive: true });
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'new-session') {",
          "  fs.mkdirSync(path.dirname(process.env.HEADLESS_TRANSCRIPT), { recursive: true });",
          "  fs.writeFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'question', cwd: args[5] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello <!-- headless-tmux-wait:' + args[3] + ' -->' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Should I run the full gate?' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(1);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HEADLESS_TRANSCRIPT: transcriptPath,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "Should I run the full gate?\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux --wait ignores another same-workdir transcript without its wait marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const sessionsDir = join(home, ".codex", "sessions", "2026", "05", "14");
    mkdirSync(workDir, { recursive: true });
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'new-session') {",
          "  const sessionName = args[3];",
          "  const cwd = args[5];",
          "  const sessionsDir = process.env.HEADLESS_SESSIONS_DIR;",
          "  fs.mkdirSync(sessionsDir, { recursive: true });",
          "  fs.writeFileSync(path.join(sessionsDir, 'rollout-target.jsonl'), [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'target', cwd } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello <!-- headless-tmux-wait:' + sessionName + ' -->' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'target final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "  fs.writeFileSync(path.join(sessionsDir, 'rollout-other.jsonl'), [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'other', cwd } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'other <!-- headless-tmux-wait:headless-codex-other -->' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'other final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(1);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_SESSIONS_DIR: sessionsDir,
        HEADLESS_TMUX_WAIT_FORCE_MARKER: "1",
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "target final\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux --wait --delete kills the tmux session after final output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const captureFile = join(dir, "tmux.jsonl");
    const transcriptPath = join(home, ".codex", "sessions", "2026", "05", "14", "rollout-delete.jsonl");
    mkdirSync(workDir, { recursive: true });
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args[0] === 'new-session') {",
          "  fs.mkdirSync(path.dirname(process.env.HEADLESS_TRANSCRIPT), { recursive: true });",
          "  fs.writeFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'delete', cwd: args[5] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello <!-- headless-tmux-wait:' + args[3] + ' -->' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'delete final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--delete", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_CAPTURE: captureFile,
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HEADLESS_TRANSCRIPT: transcriptPath,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const sessionName = calls[0][3];
    assert.equal(code, 0);
    assert.equal(stdout.join(""), "delete final\n");
    assert.deepEqual(calls.at(-1), ["kill-session", "-t", sessionName]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux --wait pins the Claude session id instead of injecting a marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const captureFile = join(dir, "tmux.jsonl");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      // On new-session the fake tmux mirrors Claude: it reads the caller-assigned
      // --session-id out of the launched command and writes a transcript at the
      // path headless resolves by that id, so no marker is needed to find it.
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args[0] === 'new-session') {",
          "  const command = args[6];",
          "  const sessionId = /--session-id\\s+(\\S+)/.exec(command)[1];",
          "  const workspace = fs.realpathSync(args[5]);",
          "  const projectRoot = path.join(process.env.HOME, '.claude', 'projects', workspace.replace(/\\//g, '-'));",
          "  fs.mkdirSync(projectRoot, { recursive: true });",
          "  fs.writeFileSync(path.join(projectRoot, sessionId + '.jsonl'), [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'pinned final' }] } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["claude", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_CAPTURE: captureFile,
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    const launchCommand = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0][6];
    assert.equal(code, 0);
    assert.equal(stdout.join(""), "pinned final\n");
    assert.match(launchCommand, /--session-id /);
    assert.doesNotMatch(launchCommand, /headless-tmux-wait/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI codex --tmux --wait claims its new transcript without a marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const captureFile = join(dir, "tmux.jsonl");
    const transcriptPath = join(home, ".codex", "sessions", "2026", "05", "14", "rollout-claim.jsonl");
    mkdirSync(workDir, { recursive: true });
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      // No --session-id for codex; the fake writes a brand-new rollout the claim
      // tier then attributes to this run via the pre-launch baseline diff.
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args[0] === 'new-session') {",
          "  fs.mkdirSync(path.dirname(process.env.HEADLESS_TRANSCRIPT), { recursive: true });",
          "  fs.writeFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'claim', cwd: args[5] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex claim final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_CAPTURE: captureFile,
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HEADLESS_TRANSCRIPT: transcriptPath,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    const launchCommand = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0][6];
    assert.equal(code, 0);
    assert.equal(stdout.join(""), "codex claim final\n");
    assert.doesNotMatch(launchCommand, /headless-tmux-wait/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI codex --tmux --wait ignores a transcript that existed before launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const stalePath = join(home, ".codex", "sessions", "2026", "05", "13", "rollout-stale.jsonl");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(dirname(stalePath), { recursive: true });
    // A pre-existing terminal transcript in the same workdir must NOT be claimed.
    writeFileSync(
      stalePath,
      [
        JSON.stringify({ timestamp: "2026-05-13T10:00:00.000Z", type: "session_meta", payload: { id: "stale", cwd: workDir } }),
        JSON.stringify({
          timestamp: "2026-05-13T10:00:01.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "stale final" }] },
        }),
        JSON.stringify({ timestamp: "2026-05-13T10:00:02.000Z", type: "event_msg", payload: { type: "task_complete" } }),
        "",
      ].join("\n"),
    );
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'new-session') {",
          "  fs.mkdirSync(path.dirname(process.env.HEADLESS_TRANSCRIPT), { recursive: true });",
          "  fs.writeFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'fresh', cwd: args[5] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fresh claim final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HEADLESS_TRANSCRIPT: join(home, ".codex", "sessions", "2026", "05", "14", "rollout-fresh.jsonl"),
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "fresh claim final\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI codex --tmux --wait holds the claim lock until the transcript appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const transcriptPath = join(home, ".codex", "sessions", "2026", "05", "14", "rollout-delayed.jsonl");
    const lockObservedPath = join(dir, "lock-observed.txt");
    mkdirSync(workDir, { recursive: true });
    const lockPath = launchLockPath({ HOME: home }, "codex", realpathSync(workDir))!;
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "tmux"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const { spawn } = require('node:child_process');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'new-session') {",
          "  const code = `",
          "    const fs = require('node:fs');",
          "    const path = require('node:path');",
          "    setTimeout(() => {",
          "      fs.writeFileSync(process.env.HEADLESS_LOCK_OBSERVED, fs.existsSync(process.env.HEADLESS_LOCK_PATH) ? 'present' : 'missing');",
          "      fs.mkdirSync(path.dirname(process.env.HEADLESS_TRANSCRIPT), { recursive: true });",
          "      fs.writeFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "        JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'delayed', cwd: process.env.HEADLESS_WORK_DIR } }),",
          "        JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'delayed claim final' }] } }),",
          "        JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "        '',",
          "      ].join('\\\\n'));",
          "    }, 120);",
          "  `;",
          "  spawn(process.execPath, ['-e', code], { detached: true, env: process.env, stdio: 'ignore' }).unref();",
          "}",
          "if (args[0] === 'has-session') process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "tmux"), 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_LOCK_OBSERVED: lockObservedPath,
        HEADLESS_LOCK_PATH: lockPath,
        HEADLESS_TMUX_CLAIM_TIMEOUT_MS: "20",
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HEADLESS_TRANSCRIPT: transcriptPath,
        HEADLESS_WORK_DIR: workDir,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "delayed claim final\n");
    assert.equal(readFileSync(lockObservedPath, "utf8"), "present");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI codex --tmux --session --wait reuses stored claim identity without a marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const activeFile = join(dir, "active");
    const bufferFile = join(dir, "buffer.txt");
    const transcriptPath = join(home, ".codex", "sessions", "2026", "05", "14", "rollout-session-claim.jsonl");
    mkdirSync(workDir, { recursive: true });
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "tmux"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'has-session') process.exit(fs.existsSync(process.env.HEADLESS_TMUX_ACTIVE) ? 0 : 1);",
          "if (args[0] === 'new-session') {",
          "  fs.writeFileSync(process.env.HEADLESS_TMUX_ACTIVE, '1');",
          "  fs.mkdirSync(path.dirname(process.env.HEADLESS_TRANSCRIPT), { recursive: true });",
          "  fs.writeFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'claim', cwd: args[5] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'set-buffer') fs.writeFileSync(process.env.HEADLESS_TMUX_BUFFER, args[3]);",
          "if (args[0] === 'send-keys' && args.at(-1) === 'Enter' && fs.existsSync(process.env.HEADLESS_TMUX_BUFFER)) {",
          "  const prompt = fs.readFileSync(process.env.HEADLESS_TMUX_BUFFER, 'utf8');",
          "  fs.appendFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "tmux"), 0o755);
    });

    const env = {
      ...process.env,
      HEADLESS_TMUX_ACTIVE: activeFile,
      HEADLESS_TMUX_BUFFER: bufferFile,
      HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
      HEADLESS_TRANSCRIPT: transcriptPath,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    const firstStdout: string[] = [];
    assert.equal(
      await runCli(["codex", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--session", "work", "--wait", "--timeout", "2"], {
        env,
        stdout: (text) => firstStdout.push(text),
      }),
      0,
    );
    assert.equal(firstStdout.join(""), "first final\n");

    const store = JSON.parse(readFileSync(join(home, ".headless", "sessions.json"), "utf8"));
    assert.deepEqual(store.agents.codex.work.tmuxWaitStrategy, { kind: "claim", claimed: transcriptPath });

    const secondStdout: string[] = [];
    assert.equal(
      await runCli(["codex", "--prompt", "again", "--work-dir", workDir, "--tmux", "--session", "work", "--wait", "--timeout", "2"], {
        env,
        stdout: (text) => secondStdout.push(text),
      }),
      0,
    );
    assert.equal(secondStdout.join(""), "second final\n");
    assert.doesNotMatch(readFileSync(bufferFile, "utf8"), /headless-tmux-wait/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux --session --wait ignores stale native session ids without tmux identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const activeFile = join(dir, "active");
    const bufferFile = join(dir, "buffer.txt");
    const transcriptPath = join(home, ".codex", "sessions", "2026", "05", "14", "rollout-stale-native.jsonl");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(home, ".headless"), { recursive: true });
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(activeFile, "1");
    writeFileSync(
      join(home, ".headless", "sessions.json"),
      JSON.stringify({
        version: 1,
        agents: {
          codex: {
            work: {
              agent: "codex",
              alias: "work",
              nativeId: "stale-native",
              workDir,
              createdAt: "2026-05-14T10:00:00.000Z",
              updatedAt: "2026-05-14T10:00:00.000Z",
            },
          },
        },
      }),
    );
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ timestamp: "2026-05-14T10:00:00.000Z", type: "session_meta", payload: { id: "stale-native", cwd: workDir } })}\n`,
    );
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "tmux"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'has-session') process.exit(fs.existsSync(process.env.HEADLESS_TMUX_ACTIVE) ? 0 : 1);",
          "if (args[0] === 'set-buffer') fs.writeFileSync(process.env.HEADLESS_TMUX_BUFFER, args[3]);",
          "if (args[0] === 'send-keys' && args.at(-1) === 'Enter') {",
          "  const prompt = fs.readFileSync(process.env.HEADLESS_TMUX_BUFFER, 'utf8');",
          "  fs.appendFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'marker fallback final' }] } }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "tmux"), 0o755);
    });

    const stdout: string[] = [];
    assert.equal(
      await runCli(["codex", "--prompt", "again", "--work-dir", workDir, "--tmux", "--session", "work", "--wait", "--timeout", "2"], {
        env: {
          ...process.env,
          HEADLESS_TMUX_ACTIVE: activeFile,
          HEADLESS_TMUX_BUFFER: bufferFile,
          HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
          HEADLESS_TRANSCRIPT: transcriptPath,
          HOME: home,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: (text) => stdout.push(text),
      }),
      0,
    );

    assert.equal(stdout.join(""), "marker fallback final\n");
    assert.match(readFileSync(bufferFile, "utf8"), /headless-tmux-wait/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI pi --tmux --wait isolates its transcript in a per-run session dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const captureFile = join(dir, "tmux.jsonl");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      // The fake reads pi's --session-dir and drops the run's only transcript there.
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args[0] === 'new-session') {",
          "  const sessionDir = /--session-dir\\s+(\\S+)/.exec(args[6])[1];",
          "  fs.mkdirSync(sessionDir, { recursive: true });",
          "  fs.writeFileSync(path.join(sessionDir, '2026-05-14T10-00-00-000Z_run.jsonl'), [",
          "    JSON.stringify({ type: 'session', id: 'run', cwd: args[5] }),",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:01.000Z', type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'pi dir final', textSignature: '{\"phase\":\"final_answer\"}' }] } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["pi", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_CAPTURE: captureFile,
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    const launchCommand = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0][6];
    assert.equal(code, 0);
    assert.equal(stdout.join(""), "pi dir final\n");
    assert.match(launchCommand, /--session-dir /);
    assert.doesNotMatch(launchCommand, /headless-tmux-wait/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test(
  "CLI opencode --tmux --wait tags its session by title without a marker",
  { skip: spawnSync("sqlite3", ["--version"]).status !== 0 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
    try {
      const dataHome = join(dir, "opencode-data");
      const binDir = join(dir, "bin");
      const workDir = join(dir, "work");
      const captureFile = join(dir, "tmux.jsonl");
      const dbPath = join(dataHome, "opencode.db");
      mkdirSync(workDir, { recursive: true });
      mkdirSync(dataHome, { recursive: true });
      await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
        await mkdir(binDir);
        const tmux = join(binDir, "tmux");
        // The fake records the unique --title headless assigned, so resolution
        // is by title rather than by a marker embedded in the prompt.
        await writeFile(
          tmux,
          [
            "#!/usr/bin/env node",
            "const fs = require('node:fs');",
            "const { spawnSync } = require('node:child_process');",
            "const args = process.argv.slice(2);",
            "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
            "if (args[0] === 'new-session') {",
            "  const title = /--title\\s+(\\S+)/.exec(args[6])[1];",
            "  const sessionId = 'ses_tag';",
            "  const now = Date.now();",
            "  const sql = `",
            "create table session (id text primary key, directory text not null, title text not null, time_updated integer not null, data text);",
            "create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);",
            "create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);",
            "insert into session values ('${sessionId}', '${args[5].replaceAll(\"'\", \"''\")}', '${title.replaceAll(\"'\", \"''\")}', ${now}, '{}');",
            "insert into message values ('assistant_msg', '${sessionId}', ${now}, ${now + 2}, '{\"role\":\"assistant\"}');",
            "insert into part values ('text_part', 'assistant_msg', '${sessionId}', ${now + 1}, ${now + 1}, '{\"type\":\"text\",\"text\":\"opencode tag final\",\"metadata\":{\"openai\":{\"phase\":\"final_answer\"}}}');",
            "insert into part values ('finish_part', 'assistant_msg', '${sessionId}', ${now + 2}, ${now + 2}, '{\"type\":\"step-finish\",\"reason\":\"stop\"}');",
            "`;",
            "  const created = spawnSync('sqlite3', [process.env.HEADLESS_OPENCODE_DB, sql], { encoding: 'utf8' });",
            "  if (created.status !== 0) { process.stderr.write(created.stderr); process.exit(created.status ?? 1); }",
            "}",
            "if (args[0] === 'has-session') process.exit(0);",
            "",
          ].join("\n"),
        );
        await chmod(tmux, 0o755);
      });

      const stdout: string[] = [];
      const code = await runCli(["opencode", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
        env: {
          ...process.env,
          HEADLESS_OPENCODE_DB: dbPath,
          HEADLESS_TMUX_CAPTURE: captureFile,
          HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
          OPENCODE_DATA_HOME: dataHome,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: (text) => stdout.push(text),
      });

      const launchCommand = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0][6];
      assert.equal(code, 0);
      assert.equal(stdout.join(""), "opencode tag final\n");
      assert.match(launchCommand, /--title headless-wait-/);
      assert.doesNotMatch(launchCommand, /headless-tmux-wait/);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
);

test("CLI cursor --tmux --wait mints and pins a session id without a marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const captureFile = join(dir, "tmux.jsonl");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      // Fake cursor binary: create-chat mints a stable id headless then pins.
      const agentBin = join(binDir, "agent");
      await writeFile(
        agentBin,
        ["#!/usr/bin/env node", "if (process.argv[2] === 'create-chat') { process.stdout.write('cur-1234\\n'); }", ""].join("\n"),
      );
      await chmod(agentBin, 0o755);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args[0] === 'new-session') {",
          "  const id = /--resume\\s+(\\S+)/.exec(args[6])[1];",
          "  const ws = fs.realpathSync(args[5]);",
          "  const key = ws.replace(/^\\/+/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');",
          "  const transcriptDir = path.join(process.env.HOME, '.cursor', 'projects', key, 'agent-transcripts', id);",
          "  fs.mkdirSync(transcriptDir, { recursive: true });",
          "  fs.writeFileSync(path.join(transcriptDir, id + '.jsonl'), [",
          "    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'cursor mint final' }] } }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["cursor", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        CURSOR_CLI_BIN: join(binDir, "agent"),
        HEADLESS_TMUX_CAPTURE: captureFile,
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    const launchCommand = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0][6];
    assert.equal(code, 0);
    assert.equal(stdout.join(""), "cursor mint final\n");
    assert.match(launchCommand, /--resume cur-1234/);
    assert.doesNotMatch(launchCommand, /headless-tmux-wait/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test(
  "CLI opencode --tmux --wait runs prompt-bearing interactive command without deleting the session",
  { skip: spawnSync("sqlite3", ["--version"]).status !== 0 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
    try {
      const dataHome = join(dir, "opencode-data");
      const binDir = join(dir, "bin");
      const workDir = join(dir, "work");
      const captureFile = join(dir, "tmux.jsonl");
      const dbPath = join(dataHome, "opencode.db");
      mkdirSync(workDir, { recursive: true });
      mkdirSync(dataHome, { recursive: true });
      await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
        await mkdir(binDir);
        const tmux = join(binDir, "tmux");
        await writeFile(
          tmux,
          [
            "#!/usr/bin/env node",
            "const fs = require('node:fs');",
            "const { spawnSync } = require('node:child_process');",
            "const args = process.argv.slice(2);",
            "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
            "if (args[0] === 'new-session') {",
            "  const sessionId = 'ses_wait_delete';",
            "  const now = Date.now();",
            "  const userPart = JSON.stringify({ type: 'text', text: args[6] }).replaceAll(\"'\", \"''\");",
            "  const sql = `",
            "create table session (id text primary key, directory text not null, time_updated integer not null, data text);",
            "create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);",
            "create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);",
            "insert into session values ('${sessionId}', '${args[5].replaceAll(\"'\", \"''\")}', ${now}, '{}');",
            "insert into message values ('user_msg', '${sessionId}', ${now}, ${now}, '{\"role\":\"user\"}');",
            "insert into message values ('assistant_msg', '${sessionId}', ${now}, ${now + 2}, '{\"role\":\"assistant\"}');",
            "insert into part values ('user_part', 'user_msg', '${sessionId}', ${now}, ${now}, '${userPart}');",
            "insert into part values ('text_part', 'assistant_msg', '${sessionId}', ${now + 1}, ${now + 1}, '{\"type\":\"text\",\"text\":\"opencode wait final\",\"metadata\":{\"openai\":{\"phase\":\"final_answer\"}}}');",
            "insert into part values ('finish_part', 'assistant_msg', '${sessionId}', ${now + 2}, ${now + 2}, '{\"type\":\"step-finish\",\"reason\":\"stop\"}');",
            "`;",
            "  const created = spawnSync('sqlite3', [process.env.HEADLESS_OPENCODE_DB, sql], { encoding: 'utf8' });",
            "  if (created.status !== 0) { process.stderr.write(created.stderr); process.exit(created.status ?? 1); }",
            "}",
            "if (args[0] === 'has-session') process.exit(0);",
            "if (args[0] === 'kill-session') process.exit(9);",
            "",
          ].join("\n"),
        );
        await chmod(tmux, 0o755);
      });

      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(
        ["opencode", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"],
        {
          env: {
            ...process.env,
            HEADLESS_OPENCODE_DB: dbPath,
            HEADLESS_TMUX_CAPTURE: captureFile,
            HEADLESS_TMUX_WAIT_FORCE_MARKER: "1",
            HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
            OPENCODE_DATA_HOME: dataHome,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
          },
          stderr: (text) => stderr.push(text),
          stdout: (text) => stdout.push(text),
        },
      );

      const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(code, 0);
      assert.equal(stdout.join(""), "opencode wait final\n");
      assert.doesNotMatch(stderr.join(""), /no server running/);
      assert.match(calls[0][6], /opencode run --interactive/);
      assert.match(calls[0][6], /hello/);
      assert.deepEqual(calls.map((call) => call[0]), ["new-session"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
);

test("CLI --tmux --session starts or sends to a named tmux session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
    const stateFile = join(dir, "active");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "tmux"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args[0] === 'has-session') process.exit(fs.existsSync(process.env.HEADLESS_TMUX_ACTIVE) ? 0 : 1);",
          "if (args[0] === 'new-session') fs.writeFileSync(process.env.HEADLESS_TMUX_ACTIVE, '1');",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "tmux"), 0o755);
    });

    const env = {
      ...process.env,
      HEADLESS_TMUX_ACTIVE: stateFile,
      HEADLESS_TMUX_CAPTURE: captureFile,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const stdout: string[] = [];
    assert.equal(
      await runCli(["codex", "--prompt", "hello", "--work-dir", dir, "--tmux", "--session", "work"], {
        env,
        stdout: (text) => stdout.push(text),
      }),
      0,
    );
    assert.match(stdout.join(""), /tmux session: headless-codex-work/);

    stdout.length = 0;
    assert.equal(
      await runCli(["codex", "--prompt", "again", "--work-dir", dir, "--tmux", "--session", "work"], {
        env,
        stdout: (text) => stdout.push(text),
      }),
      0,
    );
    assert.equal(stdout.join(""), "sent: headless-codex-work\n");
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ["has-session", "-t", "headless-codex-work"]);
    assert.deepEqual(calls[1].slice(0, 4), ["new-session", "-d", "-s", "headless-codex-work"]);
    assert.deepEqual(calls.at(-3), ["set-buffer", "-b", "headless-codex-work-send", "again"]);
    assert.deepEqual(calls.at(-1), ["send-keys", "-t", "headless-codex-work", "Enter"]);
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

test("CLI --tmux sends Enter after launching Antigravity prompt", async () => {
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
    const code = await runCli(["antigravity", "--prompt", "hello world", "--work-dir", dir, "--tmux"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_CAPTURE: captureFile,
        HEADLESS_TMUX_ANTIGRAVITY_ENTER_DELAY_MS: "0",
        HEADLESS_TMUX_ANTIGRAVITY_PASTE_DELAY_MS: "0",
        HEADLESS_TMUX_ANTIGRAVITY_SUBMIT_DELAY_MS: "0",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const sessionName = calls[0][3];
    assert.equal(code, 0);
    assert.deepEqual(calls, [
      ["new-session", "-d", "-s", sessionName, "-c", dir, "agy --dangerously-skip-permissions"],
      ["send-keys", "-t", sessionName, "Space", "BSpace"],
      ["set-buffer", "-b", `${sessionName}-prompt`, "hello world"],
      ["paste-buffer", "-d", "-b", `${sessionName}-prompt`, "-t", sessionName],
      ["send-keys", "-t", sessionName, "Enter"],
    ]);
    assert.match(sessionName, /^headless-antigravity-\d+$/);
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
    assert.match(calls[0][6], /agent --model gpt-5\.5-medium --force hello/);
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

test("CLI --tmux --print-command includes Antigravity Enter submit command", async () => {
  const stdout: string[] = [];
  const code = await runCli(["antigravity", "--prompt", "hello world", "--tmux", "--print-command"], {
    env: {
      ...process.env,
      HEADLESS_TMUX_ANTIGRAVITY_ENTER_DELAY_MS: "0",
      HEADLESS_TMUX_ANTIGRAVITY_PASTE_DELAY_MS: "0",
      HEADLESS_TMUX_ANTIGRAVITY_SUBMIT_DELAY_MS: "0",
    },
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.match(stdout.join(""), /^tmux new-session -d -s headless-antigravity-\d+ -c /);
  assert.match(stdout.join(""), /\ntmux send-keys -t headless-antigravity-\d+ Space BSpace\n/);
  assert.match(stdout.join(""), /\ntmux set-buffer -b headless-antigravity-\d+-prompt 'hello world'\n/);
  assert.match(stdout.join(""), /\ntmux paste-buffer -d -b headless-antigravity-\d+-prompt -t headless-antigravity-\d+\n/);
  assert.match(stdout.join(""), /\ntmux send-keys -t headless-antigravity-\d+ Enter\n$/);
});

test("CLI Antigravity --tmux --wait claims its brain transcript without a marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const captureFile = join(dir, "tmux.jsonl");
    const transcriptPath = join(home, ".gemini", "antigravity-cli", "brain", "agy-wait-1", ".system_generated", "logs", "transcript.jsonl");
    const distractorPath = join(home, ".gemini", "antigravity-cli", "brain", "agy-distractor", ".system_generated", "logs", "transcript.jsonl");
    const hasSessionMarker = join(dir, "has-session-once");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(dirname(distractorPath), { recursive: true });
    writeFileSync(
      distractorPath,
      [
        JSON.stringify({ timestamp: "2026-05-14T09:59:00.000Z", type: "PLANNER_RESPONSE", status: "DONE", content: "old distractor" }),
        "",
      ].join("\n"),
    );
    utimesSync(distractorPath, new Date("2026-05-14T09:59:00.000Z"), new Date("2026-05-14T09:59:00.000Z"));
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      await writeFile(
        join(binDir, "tmux"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(args) + '\\n');",
          "if (args[0] === 'new-session') {",
          "  fs.mkdirSync(path.dirname(process.env.HEADLESS_TRANSCRIPT), { recursive: true });",
          "  fs.writeFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'USER_INPUT', status: 'DONE', content: 'hello' }),",
          "    '',",
          "  ].join('\\n'));",
          "  fs.writeFileSync(process.env.HEADLESS_DISTRACTOR_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:02.000Z', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'wrong distractor final' }),",
          "    '',",
          "  ].join('\\n'));",
          "}",
          "if (args[0] === 'has-session') {",
          "  if (!fs.existsSync(process.env.HEADLESS_HAS_SESSION_MARKER)) {",
          "    fs.writeFileSync(process.env.HEADLESS_HAS_SESSION_MARKER, '1');",
          "    for (let index = 0; index < 25; index += 1) {",
          "      const newer = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', `agy-newer-${index}`, '.system_generated', 'logs', 'transcript.jsonl');",
          "      fs.mkdirSync(path.dirname(newer), { recursive: true });",
          "      fs.writeFileSync(newer, [",
          "        JSON.stringify({ timestamp: '2026-05-14T10:00:03.000Z', type: 'PLANNER_RESPONSE', status: 'DONE', content: `newer ${index}` }),",
          "        '',",
          "      ].join('\\n'));",
          "    }",
          "    fs.appendFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "      JSON.stringify({ timestamp: '2026-05-14T10:00:04.000Z', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'antigravity wait final' }),",
          "      '',",
          "    ].join('\\n'));",
          "  }",
          "  process.exit(0);",
          "}",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "tmux"), 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["antigravity", "--prompt", "hello", "--work-dir", workDir, "--tmux", "--wait", "--timeout", "2"], {
      env: {
        ...process.env,
        HEADLESS_TMUX_CAPTURE: captureFile,
        HEADLESS_TMUX_WAIT_INTERVAL_MS: "10",
        HEADLESS_DISTRACTOR_TRANSCRIPT: distractorPath,
        HEADLESS_HAS_SESSION_MARKER: hasSessionMarker,
        HEADLESS_TRANSCRIPT: transcriptPath,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    const launchCommand = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0][6];
    assert.equal(code, 0);
    assert.equal(stdout.join(""), "antigravity wait final\n");
    assert.doesNotMatch(launchCommand, /headless-tmux-wait/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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
          "if (process.argv.slice(2).join(' ') !== 'list-sessions -F #{session_name}\\t#{session_created}\\t#{window_activity}\\t#{pane_dead}\\t#{pane_current_path}') process.exit(2);",
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
        "headless-codex-123     codex     running  2023-11-14T22:13:20.000Z  2100-01-01T00:00:00.000Z  env -u TMUX tmux attach-session -t headless-codex-123",
        "headless-opencode-456  opencode  waiting  2023-11-14T22:13:20.000Z  2023-11-14T22:13:20.000Z  env -u TMUX tmux attach-session -t headless-opencode-456",
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
        "headless-opencode-456  opencode  waiting  2023-11-14T22:13:20.000Z  2023-11-14T22:13:20.000Z  env -u TMUX tmux attach-session -t headless-opencode-456",
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

test("CLI --list uses native transcript completion before tmux inactivity fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    const binDir = join(dir, "bin");
    const transcriptPath = join(home, ".codex", "sessions", "2026", "05", "13", "rollout-complete.jsonl");
    mkdirSync(dirname(transcriptPath), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ timestamp: "2026-05-13T10:00:00.000Z", type: "session_meta", payload: { id: "complete", cwd: workDir } }),
        JSON.stringify({
          timestamp: "2026-05-13T10:00:01.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        }),
        JSON.stringify({ timestamp: "2026-05-13T10:00:02.000Z", type: "event_msg", payload: { type: "task_complete" } }),
        "",
      ].join("\n"),
    );
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          `process.stdout.write('headless-codex-complete\\t1770000000\\t1700000000\\t0\\t${workDir}\\n');`,
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["--list"], {
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^headless-codex-complete\s+codex\s+idle\s+/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --list assigns same-workdir native transcripts to one tmux session each", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    const binDir = join(dir, "bin");
    const nativeDir = join(home, ".codex", "sessions", "2026", "05", "13");
    const olderPath = join(nativeDir, "rollout-alpha.jsonl");
    const newerPath = join(nativeDir, "rollout-beta.jsonl");
    mkdirSync(nativeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      olderPath,
      [
        JSON.stringify({ timestamp: "2026-05-13T10:00:00.000Z", type: "session_meta", payload: { id: "alpha", cwd: workDir } }),
        JSON.stringify({ timestamp: "2026-05-13T10:00:02.000Z", type: "event_msg", payload: { type: "task_complete" } }),
        "",
      ].join("\n"),
    );
    writeFileSync(
      newerPath,
      [
        JSON.stringify({ timestamp: "2026-05-13T10:01:00.000Z", type: "session_meta", payload: { id: "beta", cwd: workDir } }),
        JSON.stringify({ timestamp: "2026-05-13T10:01:02.000Z", type: "event_msg", payload: { type: "task_complete" } }),
        "",
      ].join("\n"),
    );
    const nowMs = Date.now();
    const olderMtimeMs = nowMs + 1000;
    const newerMtimeMs = nowMs + 2000;
    utimesSync(olderPath, new Date(olderMtimeMs), new Date(olderMtimeMs));
    utimesSync(newerPath, new Date(newerMtimeMs), new Date(newerMtimeMs));
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          `process.stdout.write('headless-codex-alpha\\t1770000000\\t1700000000\\t0\\t${workDir}\\nheadless-codex-beta\\t1770000001\\t1700000000\\t0\\t${workDir}\\n');`,
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["--list"], {
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });
    const output = stdout.join("");

    assert.equal(code, 0);
    assert.match(output, new RegExp(`^headless-codex-alpha\\s+codex\\s+idle\\s+.*${new Date(Math.floor(olderMtimeMs / 1000) * 1000).toISOString()}`, "m"));
    assert.match(output, new RegExp(`^headless-codex-beta\\s+codex\\s+idle\\s+.*${new Date(Math.floor(newerMtimeMs / 1000) * 1000).toISOString()}`, "m"));
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

test("CLI --list uses configured list_waiting_after_ms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(join(home, ".headless", "config.toml"), ["[general]", "list_waiting_after_ms = 1000", ""].join("\n"));
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const tmux = join(binDir, "tmux");
      await writeFile(
        tmux,
        [
          "#!/usr/bin/env node",
          "const activity = Math.floor(Date.now() / 1000) - 2;",
          "process.stdout.write(`headless-codex-configured\\t1700000000\\t${activity}\\t0\\n`);",
          "",
        ].join("\n"),
      );
      await chmod(tmux, 0o755);
    });

    const stdout: string[] = [];
    const code = await runCli(["--list"], {
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^headless-codex-configured\s+codex\s+waiting\s+/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --list defaults tmux sessions to waiting after 15 seconds of inactivity", async () => {
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
          "const activity = Math.floor(Date.now() / 1000) - 16;",
          "process.stdout.write(`headless-codex-quiet\\t1700000000\\t${activity}\\t0\\n`);",
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

test("CLI reports agent JSON error events before extraction failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "opencode");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'error', error: { name: 'ProviderAuthError', data: { providerID: 'gemini', message: 'missing api key' } } }));",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stderr: string[] = [];
    const code = await runCli(["opencode", "--prompt", "hello"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stderr: (text) => stderr.push(text),
    });

    assert.equal(code, 1);
    assert.equal(stderr.join(""), "headless: opencode error: ProviderAuthError: missing api key\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI reports agent JSON error events from nonzero exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
      await mkdir(binDir);
      const binary = join(binDir, "opencode");
      await writeFile(
        binary,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'error', error: { name: 'ProviderAuthError', data: { providerID: 'gemini', message: 'missing api key' } } }));",
          "process.exit(2);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
    });

    const stderr: string[] = [];
    const code = await runCli(["opencode", "--prompt", "hello"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stderr: (text) => stderr.push(text),
    });

    assert.equal(code, 2);
    assert.equal(stderr.join(""), "headless: opencode error: ProviderAuthError: missing api key\n");
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
    assert.equal(
      readFileSync(captureFile, "utf8"),
      "run|--format|json|--model|openai/gpt-5.4|--dangerously-skip-permissions|hello",
    );
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

test("CLI entrypoint prints version", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src", "cli.ts"), "--version"],
    { encoding: "utf8" },
  );

  assert.equal(run.status, 0);
  assert.equal(run.stdout, `${packageJson.version}\n`);
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
