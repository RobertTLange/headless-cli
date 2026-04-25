import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { getAgentConfig } from "./agents.js";
import { collectForwardedEnvEntries } from "./env.js";
import type { AgentName, BuiltCommand, Env } from "./types.js";

export const DEFAULT_MODAL_IMAGE = "ghcr.io/roberttlange/headless:latest";
export const DEFAULT_MODAL_APP = "headless-cli";
export const DEFAULT_MODAL_CPU = 2;
export const DEFAULT_MODAL_MEMORY_MIB = 4096;
export const DEFAULT_MODAL_TIMEOUT_SECONDS = 3600;

const remoteWorkDir = "/workspace";
const remoteHome = "/home/node";
const remoteHostHome = "/tmp/headless-host-home";
const sandboxUser = "node";
const bootstrapScript = [
  "set -eu",
  `mkdir -p "${remoteHome}"`,
  `if [ -d "${remoteHostHome}" ]; then cp -R "${remoteHostHome}/." "$HOME"/; fi`,
  `chown -R ${sandboxUser}:${sandboxUser} "${remoteHome}" "${remoteWorkDir}"`,
  `exec runuser -u ${sandboxUser} -- "$@"`,
].join("; ");

export type StdoutHandling = "capture" | "stream" | "capture-and-stream";

export interface ExecuteModalOptions {
  agent: AgentName;
  appName: string;
  command: BuiltCommand;
  cpu: number;
  env: Env;
  image: string;
  imageSecret?: string;
  includeGit: boolean;
  memoryMiB: number;
  modalEnv: string[];
  modalSecrets: string[];
  stdout: (text: string) => void;
  stdoutHandling: StdoutHandling;
  stderr: (text: string) => void;
  timeoutSeconds: number;
  workDir: string;
  clientFactory?: () => Promise<ModalClientLike>;
}

export interface ExecuteModalResult {
  code: number;
  stdout: string;
  conflicts: string[];
}

export interface ModalClientLike {
  apps: {
    fromName(name: string, params?: { createIfMissing?: boolean }): Promise<unknown>;
  };
  images: {
    fromRegistry(image: string, secret?: unknown): unknown;
  };
  secrets: {
    fromName(name: string): Promise<unknown>;
  };
  sandboxes: {
    create(app: unknown, image: unknown, params?: ModalSandboxCreateParams): Promise<ModalSandboxLike>;
  };
  close?: () => void;
}

export interface ModalSandboxCreateParams {
  command?: string[];
  cpu?: number;
  env?: Record<string, string>;
  idleTimeoutMs?: number;
  memoryMiB?: number;
  secrets?: unknown[];
  timeoutMs?: number;
  workdir?: string;
}

export interface ModalExecParams {
  env?: Record<string, string>;
  mode?: "text" | "binary";
  secrets?: unknown[];
  stderr?: "pipe" | "ignore";
  stdout?: "pipe" | "ignore";
  timeoutMs?: number;
  workdir?: string;
}

export interface ModalSandboxLike {
  sandboxId?: string;
  exec(command: string[], params?: ModalExecParams): Promise<ModalProcessLike<string | Uint8Array>>;
  terminate(): Promise<void>;
}

export interface ModalProcessLike<R extends string | Uint8Array> {
  stdin: ModalWriteStreamLike<R>;
  stdout: ModalReadStreamLike<R>;
  stderr: ModalReadStreamLike<R>;
  wait(): Promise<number>;
}

export interface ModalReadStreamLike<R extends string | Uint8Array> {
  getReader?: () => ReadableStreamDefaultReader<R>;
  readText?: () => Promise<string>;
  readBytes?: () => Promise<Uint8Array>;
}

export interface ModalWriteStreamLike<R extends string | Uint8Array> {
  close?: () => Promise<void>;
  writeBytes?: (bytes: Uint8Array) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}

interface FileState {
  hash?: string;
  mode: number;
  target?: string;
  type: "file" | "symlink";
}

interface GeneratedSeedFile {
  content: string;
  mode: number;
  relPath: string;
}

export interface WorkspaceSyncResult {
  changed: string[];
  conflicts: string[];
}

export function buildModalRunSummary(options: {
  appName: string;
  command: BuiltCommand;
  cpu: number;
  image: string;
  imageSecret?: string;
  memoryMiB: number;
  modalSecrets: string[];
  timeoutSeconds: number;
  workDir: string;
}): BuiltCommand {
  const args = [
    "run",
    "--app",
    options.appName,
    "--image",
    options.image,
    "--cpu",
    String(options.cpu),
    "--memory",
    String(options.memoryMiB),
    "--timeout",
    String(options.timeoutSeconds),
    "--work-dir",
    options.workDir,
  ];
  if (options.imageSecret) {
    args.push("--image-secret", options.imageSecret);
  }
  for (const secret of options.modalSecrets) {
    args.push("--secret", secret);
  }
  args.push("--", options.command.command, ...options.command.args);
  return {
    command: "modal-sandbox",
    args,
    env: options.command.env,
    stdinFile: options.command.stdinFile,
    stdinText: options.command.stdinText,
  };
}

export function collectModalEnv(env: Env, commandEnv: Env | undefined, explicitModalEnv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of collectForwardedEnvEntries(env, commandEnv, explicitModalEnv)) {
    if (entry.actualValue !== undefined) {
      result[entry.name] = entry.actualValue;
    }
  }
  result.HOME = remoteHome;
  return result;
}

export async function executeModalAgent(options: ExecuteModalOptions): Promise<ExecuteModalResult> {
  const workDir = realpathSync(options.workDir);
  const timeoutMs = options.timeoutSeconds * 1000;
  const env = collectModalEnv(options.env, options.command.env, options.modalEnv);
  const client = await (options.clientFactory ?? createModalClient)();
  const app = await client.apps.fromName(options.appName, { createIfMissing: true });
  const imageSecret = options.imageSecret ? await client.secrets.fromName(options.imageSecret) : undefined;
  const image = client.images.fromRegistry(options.image, imageSecret);
  const secrets = await Promise.all(options.modalSecrets.map((name) => client.secrets.fromName(name)));
  let sandbox: ModalSandboxLike | undefined;
  const baselineDir = mkdtempSync(join(tmpdir(), "headless-modal-baseline-"));
  const resultDir = mkdtempSync(join(tmpdir(), "headless-modal-result-"));

  try {
    sandbox = await client.sandboxes.create(app, image, {
      command: ["sleep", "infinity"],
      cpu: options.cpu,
      env,
      idleTimeoutMs: timeoutMs,
      memoryMiB: options.memoryMiB,
      secrets,
      timeoutMs,
      workdir: "/",
    });

    const workspaceArchive = await createWorkspaceArchive(workDir, options.includeGit);
    extractArchiveLocally(workspaceArchive, baselineDir);
    await runRemoteTar(sandbox, ["mkdir", "-p", remoteWorkDir], timeoutMs);
    await runRemoteTar(sandbox, ["tar", "-xzf", "-", "-C", remoteWorkDir], timeoutMs, workspaceArchive);

    const seedArchive = await createAgentSeedArchive(options.agent, options.env);
    if (seedArchive.length > 0) {
      await runRemoteTar(sandbox, ["mkdir", "-p", remoteHostHome], timeoutMs);
      await runRemoteTar(sandbox, ["tar", "-xzf", "-", "-C", remoteHostHome], timeoutMs, seedArchive);
    }

    const runProcess = await sandbox.exec(
      ["sh", "-lc", bootstrapScript, "headless-agent", options.command.command, ...options.command.args],
      {
        env,
        mode: "text",
        secrets,
        stderr: "pipe",
        stdout: "pipe",
        timeoutMs,
        workdir: remoteWorkDir,
      },
    );
    const stdoutPromise = readTextStream(runProcess.stdout, (text) => {
      if (options.stdoutHandling !== "capture") {
        options.stdout(text);
      }
    });
    const stderrPromise = readTextStream(runProcess.stderr, options.stderr);
    await writeModalStdin(runProcess.stdin, options.command);
    const [stdout, , code] = await Promise.all([stdoutPromise, stderrPromise, runProcess.wait()]);

    const resultArchive = await captureRemoteArchive(sandbox, timeoutMs);
    extractArchiveLocally(resultArchive, resultDir);
    const sync = syncWorkspace({ baselineDir, resultDir, workDir });
    for (const conflict of sync.conflicts) {
      options.stderr(`headless: modal sync skipped local conflict: ${conflict}\n`);
    }

    return { code, stdout, conflicts: sync.conflicts };
  } finally {
    if (sandbox) {
      await sandbox.terminate();
    }
    client.close?.();
    rmSync(baselineDir, { force: true, recursive: true });
    rmSync(resultDir, { force: true, recursive: true });
  }
}

async function createModalClient(): Promise<ModalClientLike> {
  const { ModalClient } = await import("modal");
  return new ModalClient() as ModalClientLike;
}

async function createWorkspaceArchive(workDir: string, includeGit: boolean): Promise<Uint8Array> {
  const files = includeGit ? listFilesRecursive(workDir) : await listGitFiles(workDir);
  const selected = files ?? listFilesRecursive(workDir).filter((path) => path !== ".git" && !path.startsWith(".git/"));
  return await runLocalTar(workDir, selected);
}

async function createAgentSeedArchive(agent: AgentName, env: Env): Promise<Uint8Array> {
  const home = env.HOME;
  if (!home) {
    return new Uint8Array();
  }
  const paths: string[] = [];
  for (const relPath of getAgentConfig(agent).seedPaths) {
    const path = join(home, relPath);
    if (!existsSync(path)) {
      continue;
    }
    paths.push(relPath);
    if (lstatSync(path).isDirectory()) {
      break;
    }
  }
  const generatedFiles = collectGeneratedSeedFiles(agent, env, paths);
  if (generatedFiles.length === 0) {
    return paths.length > 0 ? await runLocalTar(home, paths) : new Uint8Array();
  }

  const seedDir = mkdtempSync(join(tmpdir(), "headless-modal-seed-"));
  try {
    for (const relPath of paths) {
      const source = join(home, relPath);
      const target = join(seedDir, relPath);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    }
    for (const file of generatedFiles) {
      const target = join(seedDir, file.relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { mode: file.mode });
      if (!paths.includes(file.relPath)) {
        paths.push(file.relPath);
      }
    }
    return paths.length > 0 ? await runLocalTar(seedDir, paths) : new Uint8Array();
  } finally {
    rmSync(seedDir, { force: true, recursive: true });
  }
}

function collectGeneratedSeedFiles(agent: AgentName, env: Env, selectedPaths: string[]): GeneratedSeedFile[] {
  if (agent !== "claude" || !env.HOME || selectedPaths.includes(".claude/.credentials.json")) {
    return [];
  }
  const content = readClaudeKeychainCredentials(env);
  return content ? [{ content, mode: 0o600, relPath: ".claude/.credentials.json" }] : [];
}

function readClaudeKeychainCredentials(env: Env): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const user = process.env.USER;
  if (!user) {
    return undefined;
  }
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME ?? "", ".claude");
  const configSuffix = env.CLAUDE_CONFIG_DIR ? `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}` : "";
  const service = `Claude Code-credentials${configSuffix}`;
  const result = spawnSync("security", ["find-generic-password", "-a", user, "-w", "-s", service], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  return result.stdout;
}

async function listGitFiles(workDir: string): Promise<string[] | undefined> {
  const result = await captureLocalCommand("git", ["-C", workDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]);
  if (result.code !== 0) {
    return undefined;
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => path !== ".")
    .sort();
}

function listFilesRecursive(root: string): string[] {
  const result: string[] = [];
  const ignoredDirs = new Set([".cache", "coverage", "dist", "node_modules"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) {
        continue;
      }
      const path = join(dir, entry.name);
      const relPath = normalizeRelative(root, path);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        result.push(relPath);
      }
    }
  };
  walk(root);
  return result.sort();
}

async function runLocalTar(cwd: string, paths: string[]): Promise<Uint8Array> {
  const result = await captureLocalCommand("tar", ["-czf", "-", "--null", "-T", "-"], {
    cwd,
    stdin: paths.length > 0 ? `${paths.join("\0")}\0` : "",
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || "could not create Modal workspace archive");
  }
  return result.stdout;
}

function extractArchiveLocally(archive: Uint8Array, dir: string): void {
  const result = spawnSync("tar", ["-xzf", "-", "-C", dir], { input: archive, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || "could not extract Modal workspace archive");
  }
}

async function runRemoteTar(
  sandbox: ModalSandboxLike,
  command: string[],
  timeoutMs: number,
  stdin?: Uint8Array,
): Promise<string> {
  const process = await sandbox.exec(command, {
    mode: stdin ? "binary" : "text",
    stderr: "pipe",
    stdout: "pipe",
    timeoutMs,
    workdir: "/",
  });
  const stdoutPromise = stdin ? readBytes(process.stdout as ModalReadStreamLike<Uint8Array>) : readTextStream(process.stdout);
  const stderrPromise = readTextStream(process.stderr);
  if (stdin) {
    await process.stdin.writeBytes?.(stdin);
  }
  await process.stdin.close?.();
  const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, process.wait()]);
  if (code !== 0) {
    throw new Error(stderr || `${command[0]} failed in Modal sandbox`);
  }
  return typeof stdout === "string" ? stdout : "";
}

async function captureRemoteArchive(sandbox: ModalSandboxLike, timeoutMs: number): Promise<Uint8Array> {
  const process = await sandbox.exec(["tar", "-czf", "-", "-C", remoteWorkDir, "."], {
    mode: "binary",
    stderr: "pipe",
    stdout: "pipe",
    timeoutMs,
    workdir: remoteWorkDir,
  });
  const [stdout, stderr, code] = await Promise.all([
    readBytes(process.stdout as ModalReadStreamLike<Uint8Array>),
    readTextStream(process.stderr),
    process.wait(),
  ]);
  if (code !== 0) {
    throw new Error(stderr || "could not download Modal workspace archive");
  }
  return stdout;
}

async function writeModalStdin(stdin: ModalWriteStreamLike<string | Uint8Array>, command: BuiltCommand): Promise<void> {
  if (command.stdinText !== undefined) {
    await stdin.writeText?.(command.stdinText);
  } else if (command.stdinFile) {
    await stdin.writeBytes?.(readFileSync(command.stdinFile));
  }
  await stdin.close?.();
}

async function readTextStream<R extends string | Uint8Array>(
  stream: ModalReadStreamLike<R>,
  onChunk?: (text: string) => void,
): Promise<string> {
  if (!stream.getReader) {
    const text = (await stream.readText?.()) ?? "";
    if (text) {
      onChunk?.(text);
    }
    return text;
  }
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const text = typeof value === "string" ? value : decoder.decode(value, { stream: true });
    output += text;
    onChunk?.(text);
  }
  const tail = decoder.decode();
  if (tail) {
    output += tail;
    onChunk?.(tail);
  }
  return output;
}

async function readBytes(stream: ModalReadStreamLike<Uint8Array>): Promise<Uint8Array> {
  if (!stream.getReader) {
    return (await stream.readBytes?.()) ?? new Uint8Array();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    length += value.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function syncWorkspace(options: { baselineDir: string; resultDir: string; workDir: string }): WorkspaceSyncResult {
  const baseline = snapshotTree(options.baselineDir);
  const result = snapshotTree(options.resultDir);
  const allPaths = new Set([...baseline.keys(), ...result.keys()]);
  const changed: string[] = [];
  const conflicts: string[] = [];

  for (const relPath of [...allPaths].sort()) {
    const before = baseline.get(relPath);
    const after = result.get(relPath);
    if (sameState(before, after)) {
      continue;
    }
    const localPath = resolve(options.workDir, relPath);
    if (!isWithin(options.workDir, localPath)) {
      conflicts.push(relPath);
      continue;
    }
    if (!parentRealPathIsWithin(options.workDir, localPath)) {
      conflicts.push(relPath);
      continue;
    }
    const local = snapshotPath(options.workDir, relPath);
    if (!before && local) {
      conflicts.push(relPath);
      continue;
    }
    if (before && !sameState(before, local)) {
      conflicts.push(relPath);
      continue;
    }
    if (!after) {
      if (existsSync(localPath)) {
        rmSync(localPath, { force: true, recursive: true });
      }
      changed.push(relPath);
      continue;
    }
    mkdirSync(dirname(localPath), { recursive: true });
    if (after.type === "symlink") {
      removePathIfPresent(localPath);
      symlinkSync(after.target ?? "", localPath);
    } else {
      copyFileSync(join(options.resultDir, relPath), localPath);
      chmodSync(localPath, after.mode);
    }
    changed.push(relPath);
  }

  return { changed, conflicts };
}

function snapshotTree(root: string): Map<string, FileState> {
  const result = new Map<string, FileState>();
  for (const relPath of listFilesRecursive(root)) {
    const state = snapshotPath(root, relPath);
    if (state) {
      result.set(relPath, state);
    }
  }
  return result;
}

function snapshotPath(root: string, relPath: string): FileState | undefined {
  const path = resolve(root, relPath);
  if (!isWithin(root, path)) {
    return undefined;
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    return { mode, target: readlinkText(path), type: "symlink" };
  }
  if (!stat.isFile()) {
    return undefined;
  }
  return { hash: createHash("sha256").update(readFileSync(path)).digest("hex"), mode, type: "file" };
}

function sameState(left: FileState | undefined, right: FileState | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.type === right.type && left.hash === right.hash && left.mode === right.mode && left.target === right.target;
}

function readlinkText(path: string): string {
  return readlinkSync(path);
}

function removePathIfPresent(path: string): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  rmSync(path, { force: true, recursive: true });
}

function normalizeRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

function isWithin(root: string, path: string): boolean {
  const relPath = relative(resolve(root), resolve(path));
  return relPath === "" || (!relPath.startsWith("..") && !relPath.startsWith("/"));
}

function parentRealPathIsWithin(root: string, path: string): boolean {
  let parent = dirname(path);
  try {
    while (!existsSync(parent)) {
      const next = dirname(parent);
      if (next === parent) {
        return false;
      }
      parent = next;
    }
    const rootReal = realpathSync(root);
    const parentReal = realpathSync(parent);
    const relPath = relative(rootReal, parentReal);
    return relPath === "" || (!relPath.startsWith("..") && !relPath.startsWith("/"));
  } catch {
    return false;
  }
}

async function captureLocalCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdin?: string | Uint8Array } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolvePromise({ code: 127, stdout: Buffer.concat(stdout), stderr: `${error.message}\n` });
    });
    child.on("close", (code, signal) => {
      resolvePromise({ code: signal ? 1 : (code ?? 1), stdout: Buffer.concat(stdout), stderr });
    });
    child.stdin.end(options.stdin);
  });
}
