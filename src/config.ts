import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentName, Env, ReasoningEffort } from "./types.js";

export interface AgentDefaults {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface HeadlessConfig {
  agents: Partial<Record<AgentName, AgentDefaults>>;
}

export const BUILTIN_AGENT_DEFAULTS: Record<AgentName, AgentDefaults> = {
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
  if (!path) return { agents: {} };

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { agents: {} };
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

function envModelDefault(agent: AgentName, env: Env): string | undefined {
  if (agent === "codex") return env.CODEX_MODEL;
  if (agent === "pi") return env.PI_CODING_AGENT_MODEL;
  return undefined;
}

function parseHeadlessConfig(content: string): HeadlessConfig {
  const config: HeadlessConfig = { agents: {} };
  let currentAgent: AgentName | undefined;

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const section = line.match(/^\[agents\.([A-Za-z0-9_-]+)\]$/);
    if (section) {
      currentAgent = parseAgentName(section[1] ?? "", index + 1);
      config.agents[currentAgent] = config.agents[currentAgent] ?? {};
      continue;
    }

    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!assignment) {
      throw new Error(`invalid headless config at line ${index + 1}: ${rawLine}`);
    }
    if (!currentAgent) {
      throw new Error(`headless config key must be inside [agents.<name>] at line ${index + 1}`);
    }

    const key = assignment[1] ?? "";
    const value = parseTomlString(assignment[2] ?? "", index + 1);
    const defaults = config.agents[currentAgent] ?? {};
    if (key === "model") {
      defaults.model = value;
    } else if (key === "reasoning_effort") {
      defaults.reasoningEffort = parseConfigReasoningEffort(value, index + 1);
    } else {
      throw new Error(`unsupported headless config key at line ${index + 1}: ${key}`);
    }
    config.agents[currentAgent] = defaults;
  }

  return config;
}

function parseAgentName(value: string, lineNumber: number): AgentName {
  if (
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

function parseConfigReasoningEffort(value: string, lineNumber: number): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new Error(`unsupported headless config reasoning_effort at line ${lineNumber}: ${value}`);
}

function parseTomlString(value: string, lineNumber: number): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  throw new Error(`headless config value must be a quoted string at line ${lineNumber}`);
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
