export type AgentName = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi";

export type PromptFileMode = "argument" | "stdin";

export type Env = Record<string, string | undefined>;

export interface BuildOptions {
  prompt: string;
  promptFile?: string;
  model?: string;
}

export interface BuiltCommand {
  command: string;
  args: string[];
  stdinFile?: string;
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
}
