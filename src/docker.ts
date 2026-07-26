import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { getAgentConfig } from "./agents.js";
import { collectForwardedEnvEntries, type ForwardedEnvEntry } from "./env.js";
import type { AgentName, BuiltCommand, Env } from "./types.js";

export const DEFAULT_DOCKER_IMAGE = "ghcr.io/roberttlange/headless:latest";
export const LOCAL_DOCKER_IMAGE = "headless-local:dev";
export const DOCKER_SESSION_ROOT_ENV = "HEADLESS_DOCKER_SESSION_ROOT";
const containerHome = "/headless-home";
const hostHomeMountRoot = "/tmp/headless-host-home";

type DockerEnvEntry = ForwardedEnvEntry;
type DockerSessionBootstrap = "initialize-cursor";

const dockerSessionAgentHomeVariables = {
  acp: [],
  antigravity: ["AGY_HOME", "ANTIGRAVITY_HOME"],
  claude: ["CLAUDE_CONFIG_DIR"],
  codex: ["CODEX_HOME"],
  cursor: ["CURSOR_HOME"],
  gemini: ["GEMINI_HOME"],
  opencode: ["OPENCODE_DATA_HOME"],
  pi: ["PI_CODING_AGENT_HOME"],
} satisfies Record<AgentName, readonly string[]>;

export interface DockerAgentCommandOptions {
  agent: AgentName;
  command: BuiltCommand;
  dockerArgs: string[];
  dockerEnv: string[];
  env: Env;
  hostUser?: string;
  image: string;
  persistentHome?: string;
  runDirHost?: string;
  runId?: string;
  sessionBootstrap?: DockerSessionBootstrap;
  workDir: string;
}

export function detectDockerHostUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}

export function dockerSessionHomePath(agent: AgentName, alias: string, env: Env): string | undefined {
  const configuredRoot = env[DOCKER_SESSION_ROOT_ENV]?.trim();
  if (configuredRoot && !isAbsolute(configuredRoot)) {
    throw new Error(`${DOCKER_SESSION_ROOT_ENV} must be an absolute path`);
  }
  const root =
    configuredRoot || (env.HOME ? join(env.HOME, ".headless", "docker-sessions") : undefined);
  return root ? resolve(root, agent, alias) : undefined;
}

export function ensureDockerSessionHome(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function dockerSessionAgentHomeEnvNames(agent: AgentName): readonly string[] {
  return dockerSessionAgentHomeVariables[agent];
}

export function readDockerCursorSessionId(persistentHome: string): string {
  const path = join(persistentHome, ".headless-cursor-session-id");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > 256) {
      return "";
    }
    const nativeId = readFileSync(descriptor, "utf8").trim();
    return /^[A-Za-z0-9_.:-]{1,256}$/.test(nativeId) ? nativeId : "";
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function dockerSessionNativeId(agent: AgentName, nativeId: string | undefined, persistentHome: string): string | undefined {
  if (!nativeId || agent !== "pi") {
    return nativeId;
  }
  const relativePath = relative(resolve(persistentHome), resolve(nativeId));
  if (!isContainedRelativePath(relativePath)) {
    return nativeId;
  }
  return join(containerHome, relativePath);
}

function isContainedRelativePath(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

export function buildDockerAgentCommand(options: DockerAgentCommandOptions): BuiltCommand {
  const args = ["run", "--rm"];
  if (options.command.stdinText !== undefined || options.command.stdinFile !== undefined) {
    args.push("--interactive");
  }
  if (options.persistentHome) {
    args.push("--volume", `${options.persistentHome}:${containerHome}:rw`);
  } else {
    args.push("--tmpfs", `${containerHome}:rw,mode=1777`);
  }
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
  args.push(
    options.image,
    "sh",
    "-lc",
    bootstrapScript(options.agent, Boolean(options.persistentHome), options.sessionBootstrap),
    "headless-agent",
    options.command.command,
    ...options.command.args,
  );

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

function bootstrapScript(agent: AgentName, persistentHome: boolean, sessionBootstrap?: DockerSessionBootstrap): string {
  const copyFlags = persistentHome ? "-R -n" : "-R";
  const commands = [
    "set -eu",
    `export HOME="${containerHome}"`,
    `mkdir -p "${containerHome}"`,
    `if [ -d "${hostHomeMountRoot}" ]; then cp ${copyFlags} "${hostHomeMountRoot}/." "$HOME"/; fi`,
  ];
  if (persistentHome) {
    const agentHomeVariables = dockerSessionAgentHomeEnvNames(agent);
    if (agentHomeVariables.length > 0) {
      commands.push(`unset ${agentHomeVariables.join(" ")}`);
    }
  }
  if (sessionBootstrap === "initialize-cursor") {
    commands.push(
      'cursor_session_id="$("$1" create-chat)"',
      'if [ -z "$cursor_session_id" ]; then echo "Cursor did not return a session id" >&2; exit 1; fi',
      'cursor_session_id_tmp="$(mktemp "$HOME/.headless-cursor-session-id.XXXXXX")"',
      `printf '%s\\n' "$cursor_session_id" > "$cursor_session_id_tmp"`,
      'mv -f "$cursor_session_id_tmp" "$HOME/.headless-cursor-session-id"',
      'cursor_command="$1"',
      "shift",
      'exec "$cursor_command" --resume "$cursor_session_id" "$@"',
    );
  } else {
    commands.push('exec "$@"');
  }
  return commands.join("; ");
}

function agentConfigMountArgs(agent: AgentName, env: Env): string[] {
  const home = env.HOME;
  if (!home) {
    return [];
  }

  const config = getAgentConfig(agent);
  const dockerSeedFiles = config.dockerSeedFiles ?? {};
  const mounted = new Set<string>();
  const args: string[] = [];
  for (const relPath of config.seedPaths) {
    const hostPath = join(home, relPath);
    if (!existsSync(hostPath) || mounted.has(hostPath)) {
      continue;
    }

    const selectedFiles = dockerSeedFiles[relPath];
    if (selectedFiles && statSync(hostPath).isDirectory()) {
      for (const fileName of selectedFiles) {
        const hostFile = join(hostPath, fileName);
        if (!existsSync(hostFile)) {
          continue;
        }
        const mountSource = lstatSync(hostFile).isSymbolicLink() ? realpathSync(hostFile) : hostFile;
        if (!statSync(mountSource).isFile()) {
          continue;
        }
        args.push("--volume", `${mountSource}:${join(hostHomeMountRoot, relPath, fileName)}:ro`);
      }
      mounted.add(hostPath);
      break;
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
