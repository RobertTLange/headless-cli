export type AgentName = "acp" | "antigravity" | "claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi";

export type PromptFileMode = "argument" | "stdin";

export type AllowMode = "read-only" | "yolo";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type Env = Record<string, string | undefined>;

export interface BuildOptions {
  prompt: string;
  promptFile?: string;
  workDir?: string;
  model?: string;
  allow?: AllowMode;
  reasoningEffort?: ReasoningEffort;
  timeoutSeconds?: number;
  sessionAlias?: string;
  sessionId?: string;
  sessionMode?: "new" | "resume";
  // Unique non-prompt identity used by `--tmux --wait` to locate this run's
  // native transcript without injecting a marker into the executed prompt.
  // Only one is set per launch, matching the agent's wait-resolution tier.
  sessionTitle?: string; // opencode `--title`
  sessionDir?: string; // pi `--session-dir`
}

// How `--tmux --wait` identifies the native transcript for a given harness
// without polluting the prompt. See waitTierForAgent in agents.ts.
//  pin   — caller assigns a resolvable new-session id (claude/gemini --session-id)
//  mint  — round-trip to mint a resumable id, then pin it (cursor create-chat)
//  tag   — unique metadata resolvable later (opencode --title)
//  dir   — unique per-run session directory (pi --session-dir)
//  claim — no caller-assignable id; claim the new transcript under a launch lock (antigravity/codex)
//  unsupported — no reliable native transcript resolution yet
export type WaitTier = "pin" | "mint" | "tag" | "dir" | "claim" | "unsupported";

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
  // Optional allowlists for directory seed paths used by Docker. These keep
  // provider caches and conversation history out of the container seed.
  dockerSeedFiles?: Record<string, string[]>;
}

export interface AgentHarness extends AgentConfig {
  buildCommand(options: BuildOptions, env: Env): BuiltCommand;
  buildInteractiveCommand(options: BuildOptions, env: Env): BuiltCommand;
}
