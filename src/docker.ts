import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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

export function ensureDockerSessionHome(path: string): string {
  if (process.platform === "win32") {
    throw new Error(
      "durable Docker sessions are not supported on Windows because private directory ACLs cannot be validated",
    );
  }
  const sessionHome = resolve(path);
  const agentRoot = dirname(sessionHome);
  const sessionRoot = dirname(agentRoot);
  if (dirname(sessionRoot) === sessionRoot) {
    throw new Error("Docker session root cannot be the filesystem root");
  }
  let realSessionRoot = ensureDockerSessionRoot(sessionRoot);
  assertTrustedDirectoryAncestors(dirname(realSessionRoot));
  realSessionRoot = validateOwnedDirectory(realSessionRoot, false, true);
  const realAgentRoot = ensurePrivateOwnedDirectory(join(realSessionRoot, basename(agentRoot)));
  const realSessionHome = ensurePrivateOwnedDirectory(join(realAgentRoot, basename(sessionHome)));
  const relativeHome = relative(realSessionRoot, realSessionHome);
  if (!isContainedRelativePath(relativeHome)) {
    throw new Error("Docker session home escapes its configured root");
  }
  return realSessionHome;
}

export function ensureDockerSessionStoreDirectory(sessionHome: string): void {
  ensurePrivateOwnedDirectory(join(sessionHome, ".headless"));
}

function ensureDockerSessionRoot(path: string): string {
  const created = mkdirSync(path, { recursive: true, mode: 0o700 }) !== undefined;
  return validateOwnedDirectory(path, created, false);
}

function ensurePrivateOwnedDirectory(path: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return validateOwnedDirectory(path, true, true);
}

function validateOwnedDirectory(path: string, hardenPermissions: boolean, validateAcl: boolean): string {
  const pathStats = lstatSync(path);
  if (pathStats.isSymbolicLink()) {
    throw new Error(`Docker session path contains a symbolic link: ${path}`);
  }
  if (!pathStats.isDirectory()) {
    throw new Error(`Docker session path is not a directory: ${path}`);
  }
  assertCurrentUserOwnsDirectory(path, pathStats.uid);

  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const descriptorStats = fstatSync(descriptor);
    assertCurrentUserOwnsDirectory(path, descriptorStats.uid);
    if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) {
      throw new Error(`Docker session path changed while validating: ${path}`);
    }
    if (!hardenPermissions && (descriptorStats.mode & 0o022) !== 0) {
      throw new Error(`Docker session root must not be group- or world-writable: ${path}`);
    }
    if (hardenPermissions) {
      fchmodSync(descriptor, 0o700);
    }
    assertDirectoryIdentity(path, descriptorStats);
    const realPath = realpathSync(path);
    assertDirectoryIdentity(realPath, descriptorStats);
    if (validateAcl) {
      assertNoUnsafeMacAcl(realPath);
      assertDirectoryIdentity(realPath, descriptorStats);
    }
    return realPath;
  } finally {
    closeSync(descriptor);
  }
}

function assertTrustedDirectoryAncestors(path: string): void {
  const currentUserId = process.getuid?.();
  let currentPath = realpathSync(path);
  const ancestors: string[] = [];
  while (true) {
    ancestors.push(currentPath);
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }
  for (const ancestor of ancestors.reverse()) {
    const pathStats = lstatSync(ancestor);
    const descriptor = openSync(ancestor, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stats = fstatSync(descriptor);
      if (
        !pathStats.isDirectory() ||
        stats.dev !== pathStats.dev ||
        stats.ino !== pathStats.ino
      ) {
        throw new Error(`Docker session root ancestor changed while validating: ${ancestor}`);
      }
      if (currentUserId !== undefined && stats.uid !== currentUserId && stats.uid !== 0) {
        throw new Error(`Docker session root ancestor is owned by an untrusted user: ${ancestor}`);
      }
      const writableByOthers = (stats.mode & 0o022) !== 0;
      const sticky = (stats.mode & 0o1000) !== 0;
      if (writableByOthers && !sticky) {
        throw new Error(`Docker session root ancestor is writable by other users: ${ancestor}`);
      }
      assertNoUnsafeMacAcl(ancestor);
      assertDirectoryIdentity(ancestor, stats);
    } finally {
      closeSync(descriptor);
    }
  }
}

function assertDirectoryIdentity(path: string, expected: ReturnType<typeof fstatSync>): void {
  const stats = lstatSync(path);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.dev !== expected.dev ||
    stats.ino !== expected.ino
  ) {
    throw new Error(`Docker session path changed while validating: ${path}`);
  }
}

function assertNoUnsafeMacAcl(path: string): void {
  if (process.platform !== "darwin") return;
  const result = spawnSync("/bin/ls", ["-lde", "--", path], {
    encoding: "utf8",
    env: { LC_ALL: "C" },
    maxBuffer: 64 * 1024,
    timeout: 2_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not validate Docker session path ACL: ${path}`);
  }
  if (/^\s*\d+:.*\ballow\b/im.test(result.stdout)) {
    throw new Error(`Docker session path has a permissive access ACL: ${path}`);
  }
}

function assertCurrentUserOwnsDirectory(path: string, ownerId: number): void {
  if (typeof process.getuid === "function" && ownerId !== process.getuid()) {
    throw new Error(`Docker session path is not owned by the current user: ${path}`);
  }
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
  let resolvedNativeId = resolve(nativeId);
  try {
    resolvedNativeId = realpathSync(resolvedNativeId);
  } catch {
    // Retain the original value when a previously stored transcript no longer exists.
  }
  const relativePath = relative(resolve(persistentHome), resolvedNativeId);
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
