import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { getAgentConfig } from "./agents.js";
import type { AgentName, BuiltCommand, Env } from "./types.js";

export const DEFAULT_DOCKER_IMAGE = "ghcr.io/RobertTLange/headless:latest";
export const LOCAL_DOCKER_IMAGE = "headless-local:dev";
const containerHome = "/headless-home";
const hostHomeMountRoot = "/tmp/headless-host-home";
const bootstrapScript = [
  "set -eu",
  `mkdir -p "${containerHome}"`,
  `if [ -d "${hostHomeMountRoot}" ]; then cp -R "${hostHomeMountRoot}/." "$HOME"/; fi`,
  'exec "$@"',
].join("; ");

const defaultDockerEnvNames = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
  "CURSOR_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "PI_CODING_AGENT_API_KEY",
  "PI_CODING_AGENT_MODEL",
  "PI_CODING_AGENT_MODELS",
  "PI_CODING_AGENT_PROVIDER",
];

export interface DockerAgentCommandOptions {
  agent: AgentName;
  command: BuiltCommand;
  dockerArgs: string[];
  dockerEnv: string[];
  env: Env;
  hostUser?: string;
  image: string;
  workDir: string;
}

export function detectDockerHostUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}

export function buildDockerAgentCommand(options: DockerAgentCommandOptions): BuiltCommand {
  const args = ["run", "--rm"];
  if (options.command.stdinText !== undefined || options.command.stdinFile !== undefined) {
    args.push("--interactive");
  }
  args.push("--tmpfs", `${containerHome}:rw,mode=1777`);
  if (options.hostUser) {
    args.push("--user", options.hostUser);
  }

  const workDir = realpathSync(options.workDir);
  args.push("--workdir", workDir, "--volume", `${workDir}:${workDir}`);
  args.push(...agentConfigMountArgs(options.agent, options.env));
  args.push(...dockerEnvArgs(options.env, options.command.env, options.dockerEnv));
  args.push(...options.dockerArgs);
  args.push(options.image, "sh", "-lc", bootstrapScript, "headless-agent", options.command.command, ...options.command.args);

  const dockerCommand: BuiltCommand = { command: "docker", args };
  if (options.command.env) {
    dockerCommand.env = options.command.env;
  }
  if (options.command.stdinFile) {
    dockerCommand.stdinFile = options.command.stdinFile;
  }
  if (options.command.stdinText !== undefined) {
    dockerCommand.stdinText = options.command.stdinText;
  }
  return dockerCommand;
}

function agentConfigMountArgs(agent: AgentName, env: Env): string[] {
  const home = env.HOME;
  if (!home) {
    return [];
  }

  const mounted = new Set<string>();
  const args: string[] = [];
  for (const relPath of getAgentConfig(agent).seedPaths) {
    const hostPath = join(home, relPath);
    if (!existsSync(hostPath) || mounted.has(hostPath)) {
      continue;
    }
    mounted.add(hostPath);
    args.push("--volume", `${hostPath}:${join(hostHomeMountRoot, relPath)}:ro`);
    if (statSync(hostPath).isDirectory()) {
      break;
    }
  }
  return args;
}

function dockerEnvArgs(env: Env, commandEnv: Env | undefined, explicitDockerEnv: string[]): string[] {
  const values = new Map<string, string | undefined>();
  for (const name of defaultDockerEnvNames) {
    if (env[name] !== undefined) {
      values.set(name, undefined);
    }
  }
  for (const [name, value] of Object.entries(commandEnv ?? {})) {
    if (value !== undefined) {
      values.set(name, value);
    }
  }
  for (const item of explicitDockerEnv) {
    const equals = item.indexOf("=");
    if (equals === -1) {
      values.set(item, undefined);
    } else {
      values.set(item.slice(0, equals), item);
    }
  }
  values.set("HOME", `HOME=${containerHome}`);

  const args: string[] = [];
  for (const [name, value] of values) {
    args.push("--env", value ?? name);
  }
  return args;
}
