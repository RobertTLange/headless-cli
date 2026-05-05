import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isRole, type Role } from "./roles.js";
import type { AgentName, AllowMode, Env, ReasoningEffort } from "./types.js";

export interface AgentDefaults {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface RoleDefaults {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  allow?: AllowMode;
  baseInstructionPrompt?: string;
}

export interface InvocationDefaults extends AgentDefaults {
  allow?: AllowMode;
  baseInstructionPrompt?: string;
}

export interface HeadlessConfig {
  agents: Partial<Record<AgentName, AgentDefaults>>;
  roles: Partial<Record<Role, RoleDefaults>>;
}

export const BUILTIN_AGENT_DEFAULTS: Record<AgentName, AgentDefaults> = {
  acp: {},
  claude: { model: "claude-opus-4-6" },
  codex: { model: "gpt-5.5" },
  cursor: { model: "gpt-5.5", reasoningEffort: "medium" },
  gemini: { model: "gemini-3.1-pro-preview" },
  opencode: { model: "openai/gpt-5.4" },
  pi: { model: "openai-codex/gpt-5.5" },
};

export function headlessConfigPath(env: Env): string | undefined {
  return env.HOME ? join(env.HOME, ".headless", "config.toml") : undefined;
}

export function loadHeadlessConfig(env: Env): HeadlessConfig {
  const path = headlessConfigPath(env);
  if (!path) return emptyHeadlessConfig();

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return emptyHeadlessConfig();
  }
  return parseHeadlessConfig(content);
}

export function resolveAgentDefaults(
  agent: AgentName,
  options: AgentDefaults,
  env: Env,
  config: HeadlessConfig,
): AgentDefaults {
  const configured = config.agents[agent] ?? {};
  return {
    model: options.model ?? envModelDefault(agent, env) ?? configured.model,
    reasoningEffort: options.reasoningEffort ?? configured.reasoningEffort,
  };
}

export function resolveInvocationDefaults(
  agent: AgentName,
  role: Role | undefined,
  options: InvocationDefaults,
  env: Env,
  config: HeadlessConfig,
): InvocationDefaults {
  const configuredAgent = config.agents[agent] ?? {};
  const configuredRole = role ? (config.roles[role] ?? {}) : {};
  return {
    model: options.model ?? envModelDefault(agent, env) ?? configuredRole.model ?? configuredAgent.model,
    reasoningEffort: options.reasoningEffort ?? configuredRole.reasoningEffort ?? configuredAgent.reasoningEffort,
    allow: options.allow ?? configuredRole.allow,
    baseInstructionPrompt: configuredRole.baseInstructionPrompt,
  };
}

function envModelDefault(agent: AgentName, env: Env): string | undefined {
  if (agent === "codex") return env.CODEX_MODEL;
  if (agent === "pi") return env.PI_CODING_AGENT_MODEL;
  return undefined;
}

function emptyHeadlessConfig(): HeadlessConfig {
  return { agents: {}, roles: {} };
}

type ConfigSection = { kind: "agent"; name: AgentName } | { kind: "role"; name: Role };

export function parseHeadlessConfig(content: string): HeadlessConfig {
  const config = emptyHeadlessConfig();
  let currentSection: ConfigSection | undefined;
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const section = line.match(/^\[(agents|roles)\.([A-Za-z0-9_-]+)\]$/);
    if (section) {
      if (section[1] === "agents") {
        const name = parseAgentName(section[2] ?? "", index + 1);
        currentSection = { kind: "agent", name };
        config.agents[name] = config.agents[name] ?? {};
      } else {
        const name = parseRoleName(section[2] ?? "", index + 1);
        currentSection = { kind: "role", name };
        config.roles[name] = config.roles[name] ?? {};
      }
      continue;
    }
    if (/^\[/.test(line)) {
      throw new Error(`unsupported headless config section at line ${index + 1}: ${rawLine}`);
    }

    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!assignment) {
      throw new Error(`invalid headless config at line ${index + 1}: ${rawLine}`);
    }
    if (!currentSection) {
      throw new Error(`headless config key must be inside [agents.<name>] or [roles.<name>] at line ${index + 1}`);
    }

    const key = assignment[1] ?? "";
    const parsedValue = parseTomlString(assignment[2] ?? "", index + 1, lines, index);
    index = parsedValue.nextIndex;
    if (currentSection.kind === "agent") {
      const defaults = config.agents[currentSection.name] ?? {};
      if (key === "model") {
        defaults.model = parsedValue.value;
      } else if (key === "reasoning_effort") {
        defaults.reasoningEffort = parseConfigReasoningEffort(parsedValue.value, index + 1);
      } else {
        throw new Error(`unsupported headless agent config key at line ${index + 1}: ${key}`);
      }
      config.agents[currentSection.name] = defaults;
      continue;
    }

    const defaults = config.roles[currentSection.name] ?? {};
    if (key === "model") {
      defaults.model = parsedValue.value;
    } else if (key === "reasoning_effort") {
      defaults.reasoningEffort = parseConfigReasoningEffort(parsedValue.value, index + 1);
    } else if (key === "allow") {
      defaults.allow = parseConfigAllow(parsedValue.value, index + 1);
    } else if (key === "base_instruction_prompt") {
      defaults.baseInstructionPrompt = parsedValue.value;
    } else {
      throw new Error(`unsupported headless role config key at line ${index + 1}: ${key}`);
    }
    config.roles[currentSection.name] = defaults;
  }

  return config;
}

function parseAgentName(value: string, lineNumber: number): AgentName {
  if (
    value === "acp" ||
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "gemini" ||
    value === "opencode" ||
    value === "pi"
  ) {
    return value;
  }
  throw new Error(`unsupported headless config agent at line ${lineNumber}: ${value}`);
}

function parseRoleName(value: string, lineNumber: number): Role {
  if (isRole(value)) {
    return value;
  }
  throw new Error(`unsupported headless config role at line ${lineNumber}: ${value}`);
}

function parseConfigReasoningEffort(value: string, lineNumber: number): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new Error(`unsupported headless config reasoning_effort at line ${lineNumber}: ${value}`);
}

function parseConfigAllow(value: string, lineNumber: number): AllowMode {
  if (value === "read-only" || value === "yolo") {
    return value;
  }
  throw new Error(`unsupported headless config allow at line ${lineNumber}: ${value}`);
}

function parseTomlString(
  value: string,
  lineNumber: number,
  lines: string[],
  index: number,
): { value: string; nextIndex: number } {
  const trimmed = value.trim();
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
    return parseMultilineTomlString(trimmed, lineNumber, lines, index);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return { value: JSON.parse(trimmed) as string, nextIndex: index };
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return { value: trimmed.slice(1, -1), nextIndex: index };
  }
  throw new Error(`headless config value must be a quoted string at line ${lineNumber}`);
}

function parseMultilineTomlString(
  firstValue: string,
  lineNumber: number,
  lines: string[],
  startIndex: number,
): { value: string; nextIndex: number } {
  const delimiter = firstValue.startsWith('"""') ? '"""' : "'''";
  const pieces: string[] = [];
  let rest = firstValue.slice(3);
  let nextIndex = startIndex;

  while (true) {
    const end = rest.indexOf(delimiter);
    if (end >= 0) {
      pieces.push(rest.slice(0, end));
      return { value: normalizeMultilineString(pieces.join("\n")), nextIndex };
    }
    pieces.push(rest);
    nextIndex += 1;
    if (nextIndex >= lines.length) {
      throw new Error(`unterminated multiline string at line ${lineNumber}`);
    }
    rest = lines[nextIndex] ?? "";
  }
}

function normalizeMultilineString(value: string): string {
  return value.replace(/^\n/, "").replace(/\n$/, "");
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && quote === '"') {
      index += 1;
      continue;
    }
    if ((char === '"' || char === "'") && quote === undefined) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (char === "#" && quote === undefined) {
      return line.slice(0, index);
    }
  }
  return line;
}
