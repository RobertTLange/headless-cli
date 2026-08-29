import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { win32 } from "node:path";

import type { lockSync as LockSync } from "proper-lockfile";

const privateDirMode = 0o700;
const legacyInitializationGraceMs = 1_000;
const runLockStaleMs = 5_000;
const runLockUpdateMs = 2_500;
const nodeLockStaleMs = 10_000;
const nodeLockUpdateMs = 5_000;
const runLockTimeoutMs = 30_000;
const runLockRetryMs = 10;
const ownerIdentityLifetimeMs = 24 * 60 * 60 * 1_000;
const windowsProbeFailureGraceMs = 30_000;
const windowsRenameAttempts = 40;
const windowsRenameRetryMs = 25;
const windowsRenameRetryCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
const managedSignals: NodeJS.Signals[] = process.platform === "win32"
  ? ["SIGINT", "SIGTERM", "SIGBREAK"]
  : ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];
const runStoreLockSignalListeners = new Set<NodeJS.SignalsListener>();
let lockSync: typeof LockSync | undefined;

export interface NodeStoreLockOwner {
  processTreeRootPid: number;
}

interface StoredNodeStoreLockOwner extends NodeStoreLockOwner {
  createdAtMs: number;
  processStartIdentity?: string;
}

export interface RunStateReplacementOptions {
  platform?: NodeJS.Platform;
  rename?: (source: string, destination: string) => void;
  sleep?: (milliseconds: number) => void;
}

export function acquireRunStoreLock(lockPath: string, runId: string): () => void {
  const deadline = Date.now() + runLockTimeoutMs;
  while (true) {
    try {
      return acquireStoreLock(lockPath, runLockStaleMs, runLockUpdateMs);
    } catch (error) {
      if (!isLockContention(error)) throw error;
      if (Date.now() >= deadline) throw new Error(`run is locked: ${runId}`);
      sleepSync(runLockRetryMs);
    }
  }
}

export function acquireNodeStoreLock(lockPath: string, nodeId: string, owner?: NodeStoreLockOwner): () => void {
  try {
    return acquireStoreLock(lockPath, nodeLockStaleMs, nodeLockUpdateMs, owner);
  } catch (error) {
    if (!isLockContention(error)) throw error;
    throw new Error(`node is locked: ${nodeId}`);
  }
}

export function isRunStoreLockSignalListener(listener: NodeJS.SignalsListener): boolean {
  return runStoreLockSignalListeners.has(listener);
}

export function removeRunStoreLockSignalListeners(): void {
  for (const signal of managedSignals) {
    for (const listener of runStoreLockSignalListeners) process.off(signal, listener);
  }
}

export function replaceRunStateFile(
  source: string,
  destination: string,
  options: RunStateReplacementOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const rename = options.rename ?? renameSync;
  const sleep = options.sleep ?? sleepSync;
  for (let attempt = 1; attempt <= windowsRenameAttempts; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = platform === "win32" && code !== undefined && windowsRenameRetryCodes.has(code);
      if (!retryable || attempt === windowsRenameAttempts) throw error;
      sleep(windowsRenameRetryMs);
    }
  }
}

function acquireStoreLock(
  lockPath: string,
  stale: number,
  update: number,
  owner?: NodeStoreLockOwner,
): () => void {
  if (leaseOwnerBlocksAcquisition(lockPath)) throw lockContentionError(lockPath);
  if (legacyLockBlocksAcquisition(lockPath)) throw lockContentionError(lockPath);

  let compromisedError: Error | undefined;
  const release = loadLockSync()(lockPath, {
    lockfilePath: lockPath,
    onCompromised: (error) => {
      compromisedError = error;
    },
    realpath: false,
    retries: 0,
    stale,
    update,
  });
  let released = false;
  const releaseLease = () => {
    if (released) return;
    released = true;
    release();
  };
  try {
    chmodSync(lockPath, privateDirMode);
    if (ownerSidecarBlocksAcquisition(lockPath)) {
      releaseLease();
      throw lockContentionError(lockPath);
    }
    rmSync(lockOwnerPath(lockPath), { force: true });
    if (owner) writeLockOwner(lockPath, owner);
  } catch (error) {
    releaseLease();
    throw error;
  }

  return () => {
    if (owner) rmSync(lockOwnerPath(lockPath), { force: true });
    if (compromisedError) throw compromisedError;
    releaseLease();
  };
}

function leaseOwnerBlocksAcquisition(lockPath: string): boolean {
  return storedOwnerBlocksAcquisition(lockPath, leaseHeartbeatAt(lockPath));
}

function ownerSidecarBlocksAcquisition(lockPath: string): boolean {
  return storedOwnerBlocksAcquisition(lockPath);
}

function storedOwnerBlocksAcquisition(lockPath: string, leaseHeartbeatAtMs?: number): boolean {
  const ownerPath = lockOwnerPath(lockPath);
  let owner: StoredNodeStoreLockOwner;
  let ownerHeartbeatAtMs: number;
  try {
    ownerHeartbeatAtMs = lstatSync(ownerPath).mtimeMs;
    owner = JSON.parse(readFileSync(ownerPath, "utf8")) as StoredNodeStoreLockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    return true;
  }
  if (
    !Number.isSafeInteger(owner.processTreeRootPid)
    || owner.processTreeRootPid <= 0
    || !Number.isFinite(owner.createdAtMs)
    || Date.now() - owner.createdAtMs > ownerIdentityLifetimeMs
  ) {
    return false;
  }
  return processTreeAlive(owner, leaseHeartbeatAtMs ?? ownerHeartbeatAtMs);
}

function leaseHeartbeatAt(lockPath: string): number | undefined {
  try {
    const status = lstatSync(lockPath);
    return status.isDirectory() ? status.mtimeMs : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function writeLockOwner(lockPath: string, owner: NodeStoreLockOwner): void {
  const path = lockOwnerPath(lockPath);
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  const storedOwner: StoredNodeStoreLockOwner = {
    ...owner,
    createdAtMs: Date.now(),
    processStartIdentity: processStartIdentity(owner.processTreeRootPid),
  };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(storedOwner)}\n`);
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function lockOwnerPath(lockPath: string): string {
  return `${lockPath}.owner`;
}

function loadLockSync(): typeof LockSync {
  if (lockSync) return lockSync;

  const listenersBeforeImport = new Map(
    managedSignals.map((signal) => [signal, new Set(process.listeners(signal))] as const),
  );
  lockSync = (createRequire(import.meta.url)("proper-lockfile") as { lockSync: typeof LockSync }).lockSync;
  for (const signal of managedSignals) {
    for (const listener of process.listeners(signal)) {
      if (!listenersBeforeImport.get(signal)?.has(listener)) runStoreLockSignalListeners.add(listener);
    }
  }
  return lockSync;
}

function legacyLockBlocksAcquisition(lockPath: string): boolean {
  let status;
  try {
    status = lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!status.isFile()) return false;

  const pid = readLegacyLockPid(lockPath);
  const malformedAndFresh = pid === undefined && Date.now() - status.mtimeMs < legacyInitializationGraceMs;
  if (malformedAndFresh || (pid !== undefined && processAlive(pid))) return true;

  try {
    rmSync(lockPath, { force: true });
    return false;
  } catch (error) {
    try {
      if (lstatSync(lockPath).isDirectory()) return true;
    } catch (statusError) {
      if ((statusError as NodeJS.ErrnoException).code === "ENOENT") return false;
    }
    throw error;
  }
}

function readLegacyLockPid(lockPath: string): number | undefined {
  let value: string;
  try {
    value = readFileSync(lockPath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processTreeAlive(owner: StoredNodeStoreLockOwner, lastHeartbeatAtMs: number): boolean {
  const rootPid = owner.processTreeRootPid;
  if (processAlive(rootPid)) {
    const currentIdentity = processStartIdentity(rootPid);
    if (owner.processStartIdentity && currentIdentity && owner.processStartIdentity !== currentIdentity) return false;
    return true;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-rootPid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  try {
    return execFileSync(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsDescendantProbe,
      String(rootPid),
    ], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    }).trim() === "1";
  } catch {
    return Date.now() - lastHeartbeatAtMs < windowsProbeFailureGraceMs;
  }
}

function processStartIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot;
  const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const windowsDescendantProbe = [
  "$rootPid = [uint32]$args[0]",
  "$processes = @(Get-CimInstance Win32_Process)",
  "$parents = @($rootPid)",
  "$found = $false",
  "do {",
  "  $children = @($processes | Where-Object { $parents -contains $_.ParentProcessId })",
  "  if ($children.Count -gt 0) { $found = $true }",
  "  $parents = @($children | ForEach-Object { $_.ProcessId })",
  "} while ($parents.Count -gt 0)",
  "if ($found) { '1' } else { '0' }",
].join("; ");

function lockContentionError(lockPath: string): Error {
  return Object.assign(new Error(`lock is already held: ${lockPath}`), { code: "ELOCKED" });
}

function isLockContention(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ELOCKED";
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
