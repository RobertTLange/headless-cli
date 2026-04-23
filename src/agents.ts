import type { AgentConfig, AgentHarness, AgentName, BuildOptions, BuiltCommand, Env } from "./types.js";

const agentOrder: AgentName[] = ["claude", "codex", "cursor", "gemini", "opencode", "pi"];

function withModel(args: string[], model: string | undefined): string[] {
  return model ? [...args, "--model", model] : args;
}

function buildClaude(options: BuildOptions): BuiltCommand {
  const args = withModel([], options.model);
  args.push("-p");

  if (options.promptFile) {
    args.push("--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions");
    return { command: "claude", args, stdinFile: options.promptFile };
  }

  args.push(options.prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions");
  return { command: "claude", args };
}

function buildCodex(options: BuildOptions, env: Env): BuiltCommand {
  const model = options.model || env.CODEX_MODEL || "gpt-5.2";
  const args = [
    "exec",
    "--model",
    model,
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ];

  if (options.promptFile) {
    args.push("-");
    return { command: "codex", args, stdinFile: options.promptFile };
  }

  args.push("-");
  return { command: "codex", args, stdinText: options.prompt };
}

function buildCursor(options: BuildOptions, env: Env): BuiltCommand {
  const command = env.CURSOR_CLI_BIN || "agent";
  const args = ["-p", "--force", "--output-format", "stream-json"];

  if (env.CURSOR_API_KEY) {
    args.unshift("--api-key", env.CURSOR_API_KEY);
  }
  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(options.prompt);
  return { command, args };
}

function buildGemini(options: BuildOptions): BuiltCommand {
  const args = withModel([], options.model);

  if (options.promptFile) {
    args.push("--prompt", "", "--output-format", "stream-json", "--yolo");
    return { command: "gemini", args, stdinFile: options.promptFile };
  }

  args.push("-p", options.prompt, "--output-format", "stream-json", "--yolo");
  return { command: "gemini", args };
}

function buildOpencode(options: BuildOptions): BuiltCommand {
  const args = ["run", "--format", "json"];

  if (options.model) {
    args.push("--model", options.model);
  }
  args.push(options.prompt);

  return { command: "opencode", args };
}

function buildPi(options: BuildOptions, env: Env): BuiltCommand {
  const command = env.PI_CODING_AGENT_BIN || "pi";
  const args = ["--no-session", "--mode", "json"];

  if (env.PI_CODING_AGENT_PROVIDER) {
    args.push("--provider", env.PI_CODING_AGENT_PROVIDER);
  }
  if (options.model) {
    args.push("--model", options.model);
  } else if (env.PI_CODING_AGENT_MODEL) {
    args.push("--model", env.PI_CODING_AGENT_MODEL);
  }
  if (env.PI_CODING_AGENT_MODELS) {
    args.push("--models", env.PI_CODING_AGENT_MODELS);
  }

  args.push(options.prompt);
  return { command, args };
}

const harnesses: Record<AgentName, AgentHarness> = {
  claude: {
    name: "claude",
    promptFileMode: "stdin",
    configRelDir: ".claude",
    workspaceConfigRelDir: ".claude",
    seedPaths: [".claude/settings.json", ".claude/.credentials.json", ".claude/auth.json"],
    buildCommand: buildClaude,
  },
  codex: {
    name: "codex",
    promptFileMode: "stdin",
    configRelDir: ".codex",
    workspaceConfigRelDir: ".codex",
    seedPaths: [".codex/auth.json", ".codex/config.toml"],
    buildCommand: buildCodex,
  },
  cursor: {
    name: "cursor",
    promptFileMode: "argument",
    configRelDir: ".cursor",
    workspaceConfigRelDir: ".cursor",
    seedPaths: [".cursor/cli-config.json"],
    buildCommand: buildCursor,
  },
  gemini: {
    name: "gemini",
    promptFileMode: "stdin",
    configRelDir: ".gemini",
    workspaceConfigRelDir: ".gemini",
    seedPaths: [
      ".gemini/google_accounts.json",
      ".gemini/settings.json",
      ".gemini/state.json",
      ".gemini/trustedFolders.json",
      ".gemini/installation_id",
    ],
    buildCommand: buildGemini,
  },
  opencode: {
    name: "opencode",
    promptFileMode: "argument",
    configRelDir: ".config/opencode",
    workspaceConfigRelDir: ".opencode",
    seedPaths: [".config/opencode"],
    buildCommand: buildOpencode,
  },
  pi: {
    name: "pi",
    promptFileMode: "argument",
    configRelDir: ".pi/agent",
    workspaceConfigRelDir: ".pi/agent",
    seedPaths: [".pi/agent/auth.json", ".pi/agent/settings.json"],
    buildCommand: buildPi,
  },
};

export function listAgents(): AgentName[] {
  return [...agentOrder];
}

export function isAgentName(value: string): value is AgentName {
  return Object.hasOwn(harnesses, value);
}

export function getAgentHarness(name: AgentName): AgentHarness {
  return harnesses[name];
}

export function getAgentConfig(name: AgentName): AgentConfig {
  const { buildCommand: _buildCommand, ...config } = harnesses[name];
  return { ...config, seedPaths: [...config.seedPaths] };
}

export function buildAgentCommand(name: AgentName, options: BuildOptions, env: Env = process.env): BuiltCommand {
  return getAgentHarness(name).buildCommand(options, env);
}
