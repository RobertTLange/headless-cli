import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { getAgentConfig } from "./agents.js";
import { collectForwardedEnvEntries, type ForwardedEnvEntry } from "./env.js";
import type { AgentName, BuiltCommand, Env } from "./types.js";

export const DEFAULT_DOCKER_IMAGE = "ghcr.io/roberttlange/headless:latest";
export const LOCAL_DOCKER_IMAGE = "headless-local:dev";
const containerHome = "/headless-home";
const hostHomeMountRoot = "/tmp/headless-host-home";
const bootstrapScript = [
  "set -eu",
  `mkdir -p "${containerHome}"`,
  `if [ -d "${hostHomeMountRoot}" ]; then cp -R "${hostHomeMountRoot}/." "$HOME"/; fi`,
  'exec "$@"',
].join("; ");

type DockerEnvEntry = ForwardedEnvEntry;

export interface DockerAgentCommandOptions {
  agent: AgentName;
  command: BuiltCommand;
  dockerArgs: string[];
  dockerEnv: string[];
  env: Env;
  hostUser?: string;
  image: string;
  runDirHost?: string;
  runId?: string;
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
  const dockerEnvEntries = collectDockerEnvEntries(options.env, options.command.env, options.dockerEnv);
  args.push("--workdir", workDir, "--volume", `${workDir}:${workDir}`);
  if (options.runDirHost && options.runId) {
    const containerRunDir = `/headless-runs/${options.runId}`;
    args.push("--volume", `${options.runDirHost}:${containerRunDir}`, "--env", `HEADLESS_RUN_DIR=${containerRunDir}`);
  }
  args.push(...agentConfigMountArgs(options.agent, options.env));
  args.push(...credentialMountArgs(options.env, dockerEnvEntries, workDir));
  args.push(...dockerEnvArgs(dockerEnvEntries));
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

function collectDockerEnvEntries(env: Env, commandEnv: Env | undefined, explicitDockerEnv: string[]): DockerEnvEntry[] {
  const entries = new Map(collectForwardedEnvEntries(env, commandEnv, explicitDockerEnv).map((entry) => [entry.name, entry]));
  entries.set("HOME", { name: "HOME", value: `HOME=${containerHome}`, actualValue: containerHome });

  return [...entries.values()];
}

function credentialMountArgs(env: Env, entries: DockerEnvEntry[], workDir: string): string[] {
  const args: string[] = [];
  const googleCredentials = entries.find((entry) => entry.name === "GOOGLE_APPLICATION_CREDENTIALS")?.actualValue;
  if (googleCredentials) {
    const hostPath = resolve(workDir, googleCredentials);
    if (existsSync(hostPath) && statSync(hostPath).isFile()) {
      args.push("--volume", `${hostPath}:${hostPath}:ro`);
    }
  }

  const awsProfile = entries.find((entry) => entry.name === "AWS_PROFILE")?.actualValue;
  const awsDir = env.HOME ? join(env.HOME, ".aws") : undefined;
  if (awsProfile && awsDir && existsSync(awsDir) && statSync(awsDir).isDirectory()) {
    args.push("--volume", `${awsDir}:${join(hostHomeMountRoot, ".aws")}:ro`);
  }

  return args;
}

function dockerEnvArgs(entries: DockerEnvEntry[]): string[] {
  const args: string[] = [];
  for (const entry of entries) {
    args.push("--env", entry.value ?? entry.name);
  }
  return args;
}
