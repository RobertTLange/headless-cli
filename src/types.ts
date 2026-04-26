export type AgentName = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi";

export type PromptFileMode = "argument" | "stdin";

export type AllowMode = "read-only" | "yolo";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type Env = Record<string, string | undefined>;

export interface BuildOptions {
  prompt: string;
  promptFile?: string;
  model?: string;
  allow?: AllowMode;
  reasoningEffort?: ReasoningEffort;
}

export interface BuiltCommand {
  command: string;
  args: string[];
  env?: Env;
  stdinFile?: string;
  stdinText?: string;
}

export interface AgentConfig {
  name: AgentName;
  promptFileMode: PromptFileMode;
  configRelDir: string;
  workspaceConfigRelDir: string;
  seedPaths: string[];
}

export interface AgentHarness extends AgentConfig {
  buildCommand(options: BuildOptions, env: Env): BuiltCommand;
  buildInteractiveCommand(options: BuildOptions, env: Env): BuiltCommand;
}
