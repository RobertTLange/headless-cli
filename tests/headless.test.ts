import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAgentCommand, buildInteractiveAgentCommand, getAgentConfig, listAgents } from "../src/agents.ts";
import { acpClientCapabilities } from "../src/acp.ts";
import { runCli } from "../src/cli.ts";
import { parseHeadlessConfig } from "../src/config.ts";
import { DEFAULT_DOCKER_IMAGE } from "../src/docker.ts";
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

test("lists all supported agents", () => {
  assert.deepEqual(listAgents(), ["acp", "claude", "codex", "cursor", "gemini", "opencode", "pi"]);
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
        cost: {
          input: 0.00075,
          cacheRead: 0.00005,
          cacheWrite: 0,
          output: 0.001,
          total: 0.0018,
        },
        pricingSource: "models.dev",
        pricingStatus: "priced",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { force: true, recursive: true });
  }
});

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
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI rejects --usage in raw json and tmux modes", async () => {
  const stderr: string[] = [];
  assert.equal(
    await runCli(["codex", "--prompt", "hello", "--usage", "--json"], {
      stderr: (text) => stderr.push(text),
    }),
    2,
  );
  assert.match(stderr.join(""), /--usage cannot be used with --json/);

  stderr.length = 0;
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
          "  const cwd = args[5];",
          "  fs.writeFileSync(process.env.HEADLESS_TRANSCRIPT, [",
          "    JSON.stringify({ timestamp: '2026-05-14T10:00:00.000Z', type: 'session_meta', payload: { id: 'wait', cwd } }),",
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
            "  const sql = `",
            "create table session (id text primary key, directory text not null, time_updated integer not null, data text);",
            "create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);",
            "create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);",
            "insert into session values ('${sessionId}', '${args[5].replaceAll(\"'\", \"''\")}', ${now}, '{}');",
            "insert into message values ('assistant_msg', '${sessionId}', ${now}, ${now + 2}, '{\"role\":\"assistant\"}');",
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
