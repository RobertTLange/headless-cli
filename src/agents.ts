import type {
  AgentConfig,
  AgentHarness,
  AgentName,
  AllowMode,
  BuildOptions,
  BuiltCommand,
  Env,
  ReasoningEffort,
} from "./types.js";

const agentOrder: AgentName[] = ["claude", "codex", "cursor", "gemini", "opencode", "pi"];
const defaultClaudeModel = "claude-opus-4-6";
const defaultCodexModel = "gpt-5.5";
export const DEFAULT_CURSOR_MODEL = "gpt-5.5";
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";
export const DEFAULT_OPENCODE_MODEL = "openai/gpt-5.4";
export const DEFAULT_PI_MODEL = "gpt-5.5";
const opencodeReadOnlyConfig = JSON.stringify({
  permission: {
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    websearch: "deny",
    codesearch: "deny",
    task: "deny",
  },
});

function withModel(args: string[], model: string | undefined): string[] {
  return model ? [...args, "--model", model] : args;
}

function withClaudeEffort(args: string[], effort: ReasoningEffort | undefined): string[] {
  return effort ? [...args, "--effort", effort] : args;
}

function withClaudeAllow(args: string[], allow: AllowMode | undefined): string[] {
  if (allow === "read-only") {
    return [...args, "--permission-mode", "plan"];
  }
  return allow === "yolo" || allow === undefined ? [...args, "--dangerously-skip-permissions"] : args;
}

function withCursorAllow(args: string[], allow: AllowMode | undefined): string[] {
  if (allow === "read-only") {
    return args;
  }
  return allow === "yolo" || allow === undefined ? [...args, "--force"] : args;
}

function withGeminiAllow(args: string[], allow: AllowMode | undefined): string[] {
  if (allow === "read-only") {
    return [...args, "--approval-mode", "plan"];
  }
  return [...args, "--approval-mode", "yolo"];
}

function opencodeEnv(allow: AllowMode | undefined): Env | undefined {
  return allow === "read-only" ? { OPENCODE_CONFIG_CONTENT: opencodeReadOnlyConfig } : undefined;
}

function commandWithOptionalEnv(command: string, args: string[], env: Env | undefined): BuiltCommand {
  return env ? { command, args, env } : { command, args };
}

function buildClaude(options: BuildOptions): BuiltCommand {
  const args = withModel([], options.model ?? defaultClaudeModel);
  args.push("-p");

  if (options.promptFile) {
    args.push("--output-format", "stream-json", "--verbose");
    args.push(...withClaudeEffort([], options.reasoningEffort));
    args.push(...withClaudeAllow([], options.allow));
    return { command: "claude", args, stdinFile: options.promptFile };
  }

  args.push(options.prompt, "--output-format", "stream-json", "--verbose");
  args.push(...withClaudeEffort([], options.reasoningEffort));
  args.push(...withClaudeAllow([], options.allow));
  return { command: "claude", args };
}

function buildCodex(options: BuildOptions, env: Env): BuiltCommand {
  const model = options.model || env.CODEX_MODEL || defaultCodexModel;
  const args = [
    ...(options.allow === "read-only"
      ? ["--sandbox", "read-only", "--ask-for-approval", "never"]
      : ["--dangerously-bypass-approvals-and-sandbox"]),
    "exec",
    ...withModel([], model),
    ...(options.reasoningEffort ? ["-c", `model_reasoning_effort="${options.reasoningEffort}"`] : []),
    "--json",
    "--skip-git-repo-check",
  ];

  if (options.promptFile) {
    args.push("-");
    return { command: "codex", args, stdinFile: options.promptFile };
  }

  args.push("-");
  return { command: "codex", args, stdinText: options.prompt };
}

function buildInteractiveCodex(options: BuildOptions, env: Env): BuiltCommand {
  const model = options.model || env.CODEX_MODEL || defaultCodexModel;
  const args =
    options.allow === "read-only"
      ? ["--sandbox", "read-only", "--ask-for-approval", "never"]
      : options.allow === "yolo" || options.allow === undefined
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : [];
  args.push(...withModel([], model));
  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }
  args.push(options.prompt);
  return { command: "codex", args };
}

function buildCursor(options: BuildOptions, env: Env): BuiltCommand {
  const command = env.CURSOR_CLI_BIN || "agent";
  const args = ["-p", ...withCursorAllow([], options.allow), "--output-format", "stream-json"];
  const model = options.model ?? DEFAULT_CURSOR_MODEL;

  if (env.CURSOR_API_KEY) {
    args.unshift("--api-key", env.CURSOR_API_KEY);
  }
  args.push("--model", model);
  if (options.allow === "read-only") {
    args.push("--mode", "plan");
  }

  args.push(options.prompt);
  return { command, args };
}

function buildInteractiveCursor(options: BuildOptions, env: Env): BuiltCommand {
  const command = env.CURSOR_CLI_BIN || "agent";
  const args: string[] = [];
  const model = options.model ?? DEFAULT_CURSOR_MODEL;

  if (env.CURSOR_API_KEY) {
    args.push("--api-key", env.CURSOR_API_KEY);
  }
  args.push("--model", model);
  if (options.allow === "yolo" || options.allow === undefined) {
    args.push("--force");
  }
  if (options.allow === "read-only") {
    args.push("--mode", "plan");
  }
  args.push(options.prompt);

  return { command, args };
}

function buildGemini(options: BuildOptions): BuiltCommand {
  const args = withModel([], options.model ?? DEFAULT_GEMINI_MODEL);
  args.push("--skip-trust");

  if (options.promptFile) {
    args.push("--prompt", "", "--output-format", "stream-json", ...withGeminiAllow([], options.allow));
    return { command: "gemini", args, stdinFile: options.promptFile };
  }

  args.push("-p", options.prompt, "--output-format", "stream-json", ...withGeminiAllow([], options.allow));
  return { command: "gemini", args };
}

function buildInteractiveGemini(options: BuildOptions): BuiltCommand {
  const args = withModel([], options.model ?? DEFAULT_GEMINI_MODEL);
  args.push("--skip-trust");
  args.push(...withGeminiAllow([], options.allow));
  args.push(options.prompt);
  return { command: "gemini", args };
}

function buildOpencode(options: BuildOptions): BuiltCommand {
  const args = ["run", "--format", "json"];
  const model = options.model ?? DEFAULT_OPENCODE_MODEL;

  args.push("--model", model);
  if (options.reasoningEffort) {
    args.push("--variant", options.reasoningEffort);
  }
  if (options.allow === "yolo" || options.allow === undefined) {
    args.push("--dangerously-skip-permissions");
  }
  args.push(options.prompt);

  return commandWithOptionalEnv("opencode", args, opencodeEnv(options.allow));
}

function buildInteractiveOpencode(options: BuildOptions): BuiltCommand {
  const args = withModel([], options.model ?? DEFAULT_OPENCODE_MODEL);
  if (options.allow === "yolo" || options.allow === undefined) {
    args.push("--dangerously-skip-permissions");
  }
  return commandWithOptionalEnv("opencode", args, opencodeEnv(options.allow));
}

function buildPi(options: BuildOptions, env: Env): BuiltCommand {
  const command = env.PI_CODING_AGENT_BIN || "pi";
  const args = ["--no-session", "--mode", "json"];
  const model = options.model ?? env.PI_CODING_AGENT_MODEL ?? DEFAULT_PI_MODEL;

  if (env.PI_CODING_AGENT_PROVIDER) {
    args.push("--provider", env.PI_CODING_AGENT_PROVIDER);
  }
  args.push("--model", model);
  if (env.PI_CODING_AGENT_MODELS) {
    args.push("--models", env.PI_CODING_AGENT_MODELS);
  }
  if (options.reasoningEffort) {
    args.push("--thinking", options.reasoningEffort);
  }
  if (options.allow === "read-only") {
    args.push("--tools", "read,grep,find,ls");
  } else if (options.allow === "yolo" || options.allow === undefined) {
    args.push("--tools", "read,bash,edit,write");
  }

  args.push(options.prompt);
  return { command, args };
}

function buildInteractivePi(options: BuildOptions, env: Env): BuiltCommand {
  const command = env.PI_CODING_AGENT_BIN || "pi";
  const args: string[] = [];
  const model = options.model ?? env.PI_CODING_AGENT_MODEL ?? DEFAULT_PI_MODEL;

  if (env.PI_CODING_AGENT_PROVIDER) {
    args.push("--provider", env.PI_CODING_AGENT_PROVIDER);
  }
  args.push("--model", model);
  if (env.PI_CODING_AGENT_MODELS) {
    args.push("--models", env.PI_CODING_AGENT_MODELS);
  }
  if (options.reasoningEffort) {
    args.push("--thinking", options.reasoningEffort);
  }
  if (options.allow === "read-only") {
    args.push("--tools", "read,grep,find,ls");
  } else if (options.allow === "yolo" || options.allow === undefined) {
    args.push("--tools", "read,bash,edit,write");
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
    seedPaths: [".claude.json", ".claude/settings.json", ".claude/.credentials.json", ".claude/auth.json"],
    buildCommand: buildClaude,
    buildInteractiveCommand: (options) => {
      const args = withModel([], options.model ?? defaultClaudeModel);
      args.push(...withClaudeEffort([], options.reasoningEffort));
      args.push(...withClaudeAllow([], options.allow));
      args.push(options.prompt);
      return { command: "claude", args };
    },
  },
  codex: {
    name: "codex",
    promptFileMode: "stdin",
    configRelDir: ".codex",
    workspaceConfigRelDir: ".codex",
    seedPaths: [".codex/auth.json", ".codex/config.toml"],
    buildCommand: buildCodex,
    buildInteractiveCommand: buildInteractiveCodex,
  },
  cursor: {
    name: "cursor",
    promptFileMode: "argument",
    configRelDir: ".cursor",
    workspaceConfigRelDir: ".cursor",
    seedPaths: [".cursor/cli-config.json"],
    buildCommand: buildCursor,
    buildInteractiveCommand: buildInteractiveCursor,
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
    buildInteractiveCommand: buildInteractiveGemini,
  },
  opencode: {
    name: "opencode",
    promptFileMode: "argument",
    configRelDir: ".config/opencode",
    workspaceConfigRelDir: ".opencode",
    seedPaths: [".config/opencode"],
    buildCommand: buildOpencode,
    buildInteractiveCommand: buildInteractiveOpencode,
  },
  pi: {
    name: "pi",
    promptFileMode: "argument",
    configRelDir: ".pi/agent",
    workspaceConfigRelDir: ".pi/agent",
    seedPaths: [".pi/agent/auth.json", ".pi/agent/settings.json"],
    buildCommand: buildPi,
    buildInteractiveCommand: buildInteractivePi,
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
  const {
    buildCommand: _buildCommand,
    buildInteractiveCommand: _buildInteractiveCommand,
    ...config
  } = harnesses[name];
  return { ...config, seedPaths: [...config.seedPaths] };
}

export function buildAgentCommand(name: AgentName, options: BuildOptions, env: Env = process.env): BuiltCommand {
  return getAgentHarness(name).buildCommand(options, env);
}

export function buildInteractiveAgentCommand(
  name: AgentName,
  options: BuildOptions,
  env: Env = process.env,
): BuiltCommand {
  return getAgentHarness(name).buildInteractiveCommand(options, env);
}
