import type {
  AgentConfig,
  AgentHarness,
  AgentName,
  AllowMode,
  BuildOptions,
  BuiltCommand,
  Env,
  ReasoningEffort,
  WaitTier,
} from "./types.js";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { commandFromCustom, resolveAcpCommand } from "./acp.js";
import { BUILTIN_AGENT_DEFAULTS } from "./config.js";
import { validateCodexProfileName } from "./codex-profile.js";

const agentOrder: AgentName[] = ["acp", "antigravity", "claude", "codex", "cursor", "gemini", "opencode", "pi"];
const defaultClaudeModel = BUILTIN_AGENT_DEFAULTS.claude.model;
const defaultCodexModel = BUILTIN_AGENT_DEFAULTS.codex.model;
export const DEFAULT_CURSOR_MODEL = BUILTIN_AGENT_DEFAULTS.cursor.model ?? "gpt-5.5";
export const DEFAULT_GEMINI_MODEL = BUILTIN_AGENT_DEFAULTS.gemini.model ?? "gemini-3.1-pro-preview";
export const DEFAULT_OPENCODE_MODEL = BUILTIN_AGENT_DEFAULTS.opencode.model ?? "openai/gpt-5.4";
export const DEFAULT_PI_MODEL = BUILTIN_AGENT_DEFAULTS.pi.model ?? "openai-codex/gpt-5.5";
const claudeReadOnlyTools = "Read,Grep,Glob,LS,WebFetch,WebSearch";
const opencodeReadOnlyConfig = JSON.stringify({
  permission: {
    read: "allow",
    edit: "deny",
    bash: "deny",
    webfetch: "allow",
    websearch: "allow",
    codesearch: "allow",
    task: "deny",
  },
});

function withModel(args: string[], model: string | undefined): string[] {
  return model ? [...args, "--model", model] : args;
}

export function claudeModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;

  const trimmed = model.trim();
  const match = trimmed.match(/^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?(-\d{8})?$/i);
  if (!match) return trimmed;

  const family = match[1]?.toLowerCase();
  const major = match[2];
  const minor = match[3] ? `-${match[3]}` : "";
  const suffix = match[4] ?? "";
  return `claude-${family}-${major}${minor}${suffix}`;
}

function withClaudeModel(args: string[], model: string | undefined): string[] {
  return withModel(args, claudeModel(model));
}

function withClaudeEffort(args: string[], effort: ReasoningEffort | undefined): string[] {
  return effort ? [...args, "--effort", effort] : args;
}

function withClaudeFastMode(args: string[], fast: boolean | undefined): string[] {
  if (fast === undefined) return args;
  return [...args, "--settings", JSON.stringify({ fastMode: fast })];
}

function withCodexServiceTier(args: string[], fast: boolean | undefined): string[] {
  if (fast === undefined) return args;
  return [...args, "-c", `service_tier="${fast ? "fast" : "default"}"`];
}

function withClaudeAllow(args: string[], allow: AllowMode | undefined): string[] {
  if (allow === "read-only") {
    return [...args, "--allowedTools", claudeReadOnlyTools];
  }
  return allow === "yolo" || allow === undefined ? [...args, "--dangerously-skip-permissions"] : args;
}

function withCursorAllow(args: string[], allow: AllowMode | undefined): string[] {
  if (allow === "read-only") {
    return args;
  }
  return allow === "yolo" || allow === undefined ? [...args, "--force"] : args;
}

function isCursorReasoningVariant(model: string): boolean {
  return /-(low|medium|high|xhigh|extra-high)(-fast)?$/i.test(model);
}

function supportsCursorReasoningVariants(model: string): boolean {
  return /^gpt-\d/i.test(model);
}

function cursorReasoningVariant(model: string, effort: ReasoningEffort): string | undefined {
  const variants: Partial<Record<ReasoningEffort, string>> =
    model === "gpt-5.5"
      ? { medium: "gpt-5.5-medium", high: "gpt-5.5-high", xhigh: "gpt-5.5-extra-high" }
      : model === "gpt-5.4" ||
          model === "gpt-5.4-mini" ||
          model === "gpt-5.4-nano" ||
          model === "gpt-5.2" ||
          model.endsWith("-codex") ||
          model.endsWith("-codex-spark-preview")
        ? {
            low: `${model}-low`,
            high: `${model}-high`,
            xhigh: `${model}-xhigh`,
            ...(model === "gpt-5.4" || model === "gpt-5.4-mini" || model === "gpt-5.4-nano"
              ? { medium: `${model}-medium` }
              : {}),
          }
        : model === "gpt-5.1"
          ? { low: "gpt-5.1-low", high: "gpt-5.1-high" }
          : {};

  return variants[effort];
}

export function cursorModel(options: Pick<BuildOptions, "model" | "reasoningEffort">): string {
  const model = options.model ?? DEFAULT_CURSOR_MODEL;
  if (isCursorReasoningVariant(model)) return model;
  if (!supportsCursorReasoningVariants(model)) return model;
  const effort = options.reasoningEffort ?? (options.model ? undefined : "medium");
  if (!effort) return model;
  return cursorReasoningVariant(model, effort) ?? model;
}

export function piModelSpec(modelSpec: string | undefined, env: Env): { provider?: string; model: string } {
  const rawModel = modelSpec ?? env.PI_CODING_AGENT_MODEL ?? DEFAULT_PI_MODEL;
  const slashIndex = rawModel.indexOf("/");
  if (slashIndex > 0 && slashIndex < rawModel.length - 1) {
    return {
      provider: rawModel.slice(0, slashIndex),
      model: rawModel.slice(slashIndex + 1),
    };
  }
  return {
    provider: env.PI_CODING_AGENT_PROVIDER,
    model: rawModel,
  };
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

function buildAcp(options: BuildOptions, env: Env): BuiltCommand {
  const acpCommand = resolveAcpCommand(env);
  const commandEnv = { ...(acpCommand.env ?? {}) };
  if (options.allow) {
    commandEnv.HEADLESS_ACP_ALLOW = options.allow;
  }
  const headlessCommand = commandFromCustom(env.HEADLESS_BIN || "headless");
  const command = headlessCommand.command;
  const args = [...headlessCommand.args, "acp-client", "--", acpCommand.command, ...acpCommand.args];
  if (Object.keys(commandEnv).length > 0) {
    return { command, args, env: commandEnv, stdinText: options.prompt };
  }
  return { command, args, stdinText: options.prompt };
}

function antigravityCommand(env: Env): string {
  return env.ANTIGRAVITY_CLI_BIN || env.AGY_CLI_BIN || "agy";
}

function withAntigravityAllow(args: string[], allow: AllowMode | undefined): string[] {
  if (allow === "read-only") {
    return [...args, "--sandbox"];
  }
  return allow === "yolo" || allow === undefined ? [...args, "--dangerously-skip-permissions"] : args;
}

function buildAntigravity(options: BuildOptions, env: Env): BuiltCommand {
  const args = withModel([], options.model);
  args.push("-p", options.prompt);
  if (options.timeoutSeconds !== undefined) {
    args.push("--print-timeout", `${options.timeoutSeconds}s`);
  }
  args.push(...withAntigravityAllow([], options.allow));
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("--conversation", options.sessionId);
  } else if (options.sessionMode === "resume") {
    args.push("--continue");
  }
  return { command: antigravityCommand(env), args };
}

function buildInteractiveAntigravity(options: BuildOptions, env: Env): BuiltCommand {
  const args = withAntigravityAllow(withModel([], options.model), options.allow);
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("--conversation", options.sessionId);
  } else if (options.sessionMode === "resume") {
    args.push("--continue");
  }
  return { command: antigravityCommand(env), args };
}

function buildInteractiveAcp(_options: BuildOptions, env: Env): BuiltCommand {
  const acpCommand = resolveAcpCommand(env);
  return { command: acpCommand.command, args: acpCommand.args, env: acpCommand.env };
}

function executableExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function pathExecutable(command: string, env: Env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (executableExists(candidate)) return candidate;
  }
  return undefined;
}

export function claudeCommand(env: Env): string {
  if (env.CLAUDE_CODE_BIN) return env.CLAUDE_CODE_BIN;
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;

  const homeLocalClaude = env.HOME ? join(env.HOME, ".local", "bin", "claude") : undefined;
  if (!homeLocalClaude || !executableExists(homeLocalClaude)) return "claude";

  const firstPathClaude = pathExecutable("claude", env);
  if (!firstPathClaude || firstPathClaude === homeLocalClaude || firstPathClaude === "/usr/local/bin/claude") {
    return homeLocalClaude;
  }

  return "claude";
}

export function claudeOauthExists(env: Env): boolean {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  if (env.CLAUDE_CONFIG_DIR) {
    return fileExists(join(env.CLAUDE_CONFIG_DIR, ".credentials.json")) || fileExists(join(env.CLAUDE_CONFIG_DIR, "auth.json"));
  }
  if (!env.HOME) return false;
  return (
    fileExists(join(env.HOME, ".claude.json")) ||
    fileExists(join(env.HOME, ".claude", ".credentials.json")) ||
    fileExists(join(env.HOME, ".claude", "auth.json"))
  );
}

function claudeEnv(env: Env): Env | undefined {
  if (env.HEADLESS_CLAUDE_AUTH === "api") return undefined;
  return env.ANTHROPIC_API_KEY !== undefined && claudeOauthExists(env) ? { ANTHROPIC_API_KEY: undefined } : undefined;
}

function buildClaudeCommand(args: string[], env: Env, extra?: Pick<BuiltCommand, "stdinFile">): BuiltCommand {
  return { ...commandWithOptionalEnv(claudeCommand(env), args, claudeEnv(env)), ...extra };
}

function buildClaude(options: BuildOptions, env: Env): BuiltCommand {
  const args = withClaudeFastMode(withClaudeModel([], options.model ?? defaultClaudeModel), options.fast);
  args.push("-p");
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("--resume", options.sessionId);
  } else if (options.sessionMode === "new" && options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  if (options.promptFile) {
    args.push("--output-format", "stream-json", "--verbose");
    args.push(...withClaudeEffort([], options.reasoningEffort));
    args.push(...withClaudeAllow([], options.allow));
    return buildClaudeCommand(args, env, { stdinFile: options.promptFile });
  }

  args.push(options.prompt, "--output-format", "stream-json", "--verbose");
  args.push(...withClaudeEffort([], options.reasoningEffort));
  args.push(...withClaudeAllow([], options.allow));
  return buildClaudeCommand(args, env);
}

function codexModel(options: BuildOptions, env: Env): string | undefined {
  return options.model || env.CODEX_MODEL || (options.profile ? undefined : defaultCodexModel);
}

function buildCodex(options: BuildOptions, env: Env): BuiltCommand {
  const model = codexModel(options, env);
  const args = [
    ...(options.allow === "read-only"
      ? ["--sandbox", "read-only", "--ask-for-approval", "never", "--search"]
      : ["--dangerously-bypass-approvals-and-sandbox"]),
    ...(options.profile ? ["--profile", options.profile] : []),
    "exec",
    ...(options.sessionMode === "resume" && options.sessionId ? ["resume"] : []),
    ...withModel([], model),
    ...withCodexServiceTier([], options.fast),
    ...(options.reasoningEffort ? ["-c", `model_reasoning_effort="${options.reasoningEffort}"`] : []),
    "--json",
    "--skip-git-repo-check",
  ];
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push(options.sessionId);
  }

  if (options.promptFile) {
    args.push("-");
    return { command: "codex", args, stdinFile: options.promptFile };
  }

  args.push("-");
  return { command: "codex", args, stdinText: options.prompt };
}

function buildInteractiveCodex(options: BuildOptions, env: Env): BuiltCommand {
  const model = codexModel(options, env);
  const args =
    options.allow === "read-only"
      ? ["--sandbox", "read-only", "--ask-for-approval", "never", "--search"]
      : options.allow === "yolo" || options.allow === undefined
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : [];
  if (options.profile) {
    args.push("--profile", options.profile);
  }
  args.push(...withModel([], model));
  args.push(...withCodexServiceTier([], options.fast));
  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("resume", options.sessionId, options.prompt);
  } else {
    args.push(options.prompt);
  }
  return { command: "codex", args };
}

function buildCursor(options: BuildOptions, env: Env): BuiltCommand {
  const command = env.CURSOR_CLI_BIN || "agent";
  const args = ["-p", "--trust", ...withCursorAllow([], options.allow), "--output-format", "stream-json"];
  const model = cursorModel(options);

  if (env.CURSOR_API_KEY) {
    args.unshift("--api-key", env.CURSOR_API_KEY);
  }
  if (options.sessionId && (options.sessionMode === "resume" || options.sessionMode === "new")) {
    args.push("--resume", options.sessionId);
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
  const model = cursorModel(options);

  if (env.CURSOR_API_KEY) {
    args.push("--api-key", env.CURSOR_API_KEY);
  }
  if (options.sessionId && (options.sessionMode === "resume" || options.sessionMode === "new")) {
    args.push("--resume", options.sessionId);
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
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("--resume", options.sessionId);
  }

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
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("--resume", options.sessionId);
  } else if (options.sessionMode === "new" && options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
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
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("--session", options.sessionId);
  } else if (options.sessionMode === "new" && options.sessionAlias) {
    args.push("--title", options.sessionAlias);
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

export function buildInteractiveOpencodeRun(options: BuildOptions): BuiltCommand {
  const args = ["run", "--interactive"];
  const model = options.model ?? DEFAULT_OPENCODE_MODEL;

  args.push("--model", model);
  if (options.reasoningEffort) {
    args.push("--variant", options.reasoningEffort);
  }
  if (options.allow === "yolo" || options.allow === undefined) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("--session", options.sessionId);
  } else if (options.sessionMode === "new" && options.sessionTitle) {
    args.push("--title", options.sessionTitle);
  }
  args.push(options.prompt);

  return commandWithOptionalEnv("opencode", args, opencodeEnv(options.allow));
}

function buildPi(options: BuildOptions, env: Env): BuiltCommand {
  const command = env.PI_CODING_AGENT_BIN || "pi";
  const args = options.sessionMode ? ["--mode", "json"] : ["--no-session", "--mode", "json"];
  const { provider, model } = piModelSpec(options.model, env);

  if (provider) {
    args.push("--provider", provider);
  }
  args.push("--model", model);
  if (env.PI_CODING_AGENT_MODELS) {
    args.push("--models", env.PI_CODING_AGENT_MODELS);
  }
  if (options.reasoningEffort) {
    args.push("--thinking", options.reasoningEffort);
  }
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("--session", options.sessionId);
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
  const { provider, model } = piModelSpec(options.model, env);

  if (provider) {
    args.push("--provider", provider);
  }
  args.push("--model", model);
  if (env.PI_CODING_AGENT_MODELS) {
    args.push("--models", env.PI_CODING_AGENT_MODELS);
  }
  if (options.reasoningEffort) {
    args.push("--thinking", options.reasoningEffort);
  }
  if (options.sessionMode === "resume" && options.sessionId) {
    args.push("--session", options.sessionId);
  } else if (options.sessionMode === "new" && options.sessionDir) {
    args.push("--session-dir", options.sessionDir);
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
  acp: {
    name: "acp",
    promptFileMode: "argument",
    configRelDir: ".config/acp",
    workspaceConfigRelDir: ".acp",
    seedPaths: [".config/acp"],
    buildCommand: buildAcp,
    buildInteractiveCommand: buildInteractiveAcp,
  },
  antigravity: {
    name: "antigravity",
    promptFileMode: "argument",
    configRelDir: ".gemini/antigravity-cli",
    workspaceConfigRelDir: ".agents",
    seedPaths: [".gemini/antigravity-cli", ".gemini/config"],
    dockerSeedFiles: {
      ".gemini/antigravity-cli": [
        "antigravity-oauth-token",
        "settings.json",
        "installation_id",
        "jetski_state.pbtxt",
      ],
    },
    buildCommand: buildAntigravity,
    buildInteractiveCommand: buildInteractiveAntigravity,
  },
  claude: {
    name: "claude",
    promptFileMode: "stdin",
    configRelDir: ".claude",
    workspaceConfigRelDir: ".claude",
    seedPaths: [".claude.json", ".claude/settings.json", ".claude/.credentials.json", ".claude/auth.json"],
    buildCommand: buildClaude,
    buildInteractiveCommand: (options, env) => {
      const args = withClaudeFastMode(withClaudeModel([], options.model ?? defaultClaudeModel), options.fast);
      if (options.sessionMode === "new" && options.sessionId) {
        args.push("--session-id", options.sessionId);
      }
      args.push(...withClaudeEffort([], options.reasoningEffort));
      args.push(...withClaudeAllow([], options.allow));
      args.push(options.prompt);
      return buildClaudeCommand(args, env);
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
  return {
    ...config,
    seedPaths: [...config.seedPaths],
    ...(config.dockerSeedFiles
      ? {
          dockerSeedFiles: Object.fromEntries(
            Object.entries(config.dockerSeedFiles).map(([path, files]) => [path, [...files]]),
          ),
        }
      : {}),
  };
}

export function buildAgentCommand(name: AgentName, options: BuildOptions, env: Env = process.env): BuiltCommand {
  validateProfileAgent(name, options.profile);
  return getAgentHarness(name).buildCommand(options, env);
}

export function buildInteractiveAgentCommand(
  name: AgentName,
  options: BuildOptions,
  env: Env = process.env,
): BuiltCommand {
  validateProfileAgent(name, options.profile);
  return getAgentHarness(name).buildInteractiveCommand(options, env);
}

function validateProfileAgent(name: AgentName, profile: string | undefined): void {
  if (profile !== undefined && name !== "codex") {
    throw new Error("--profile is supported only by codex");
  }
  if (profile !== undefined) validateCodexProfileName(profile);
}

// How each harness lets `--tmux --wait` identify this run's native transcript
// without injecting a marker into the executed prompt. See WaitTier in types.ts
// for what each tier means and how the interactive builders consume it.
const waitTiers: Record<AgentName, WaitTier> = {
  antigravity: "claim", // claim the new brain/<conversation>/transcript.jsonl under a launch lock
  claude: "pin", // --session-id <uuid>
  gemini: "pin", // --session-id <uuid>
  cursor: "mint", // create-chat mints an id, then --resume <id>
  opencode: "tag", // --title <uuid>, resolved via the session store
  pi: "dir", // --session-dir <unique dir>
  codex: "claim", // no caller-assignable id; claim the new transcript under a launch lock
  acp: "claim", // generic ACP harness has no shared id mechanism
};

export function waitTierForAgent(name: AgentName): WaitTier {
  return waitTiers[name];
}
