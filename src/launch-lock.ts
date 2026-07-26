import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, win32 } from "node:path";

import type { AgentName, Env } from "./types.js";

const privateDirMode = 0o700;
const privateFileMode = 0o600;
const dockerSessionLockSignalListeners = new Set<NodeJS.SignalsListener>();

export interface LaunchLock {
  release: () => void;
}

export interface DockerSessionLock {
  release: () => Promise<Error | undefined>;
}

interface LaunchLockOptions {
  timeoutMs?: number;
}

// Serializes only the brief launch window of concurrent same-(agent, workspace)
// runs so the `claim` wait tier can attribute a brand-new transcript to this run.
// Different agents and different workspaces never contend (distinct lock files),
// and the lock is released before the agent's actual work is awaited.
export function acquireLaunchLock(
  env: Env,
  agent: AgentName,
  workspace: string,
  options: LaunchLockOptions = {},
): LaunchLock {
  const lockPath = launchLockPath(env, agent, workspace);
  if (!lockPath) return { release: () => {} };

  ensurePrivateDir(dirname(lockPath));
  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx", privateFileMode);
      chmodSync(lockPath, privateFileMode);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return { release: () => rmSync(lockPath, { force: true }) };
    } catch {
      if (reapDeadOwnerLock(lockPath)) continue;
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(`timed out acquiring launch lock: ${lockPath}`);
      }
      sleepSync(25);
    }
  }
}

export function launchLockPath(env: Env, agent: AgentName, workspace: string): string | undefined {
  if (!env.HOME) return undefined;
  const key = `${agent}-${workspace.replace(/\//g, "-")}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(env.HOME, ".headless", "launch-locks", `${key}.lock`);
}

export async function acquireDockerSessionLock(persistentHome: string): Promise<DockerSessionLock> {
  const signals: NodeJS.Signals[] =
    process.platform === "win32"
      ? ["SIGINT", "SIGTERM", "SIGBREAK"]
      : ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];
  const listenersBeforeImport = new Map(
    signals.map((signal) => [signal, new Set(process.listeners(signal))] as const),
  );
  const { lock: lockFile } = await import("proper-lockfile");
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!listenersBeforeImport.get(signal)?.has(listener)) {
        dockerSessionLockSignalListeners.add(listener);
      }
    }
  }
  const lockPath = dockerSessionLockPath(persistentHome);
  const ownerPath = `${lockPath}.owner`;
  ensurePrivateDir(dirname(lockPath));
  let compromisedError: Error | undefined;
  let verifiedOwner: { checkedAt: number; token: string } | undefined;
  let release: (() => Promise<void>) | undefined;
  while (!release) {
    const owner = readDockerLockOwner(ownerPath);
    const recentlyVerified =
      owner &&
      verifiedOwner?.token === owner.token &&
      Date.now() - verifiedOwner.checkedAt < 5_000;
    if (
      owner?.hostname === hostname() &&
      owner.startIdentity !== undefined &&
      (recentlyVerified || owner.startIdentity === processStartIdentity(owner.pid))
    ) {
      if (!recentlyVerified) {
        verifiedOwner = { checkedAt: Date.now(), token: owner.token };
      }
      await sleep(250);
      continue;
    }
    try {
      release = await lockFile(persistentHome, {
        lockfilePath: lockPath,
        onCompromised: (error) => {
          compromisedError = error;
        },
        retries: 0,
        stale: 60_000,
        update: 20_000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      await sleep(50);
    }
  }

  const owner = {
    hostname: hostname(),
    pid: process.pid,
    startIdentity: processStartIdentity(process.pid),
    token: randomUUID(),
  };
  try {
    writeDockerLockOwner(ownerPath, owner);
  } catch (error) {
    await release();
    throw error;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return compromisedError;
      released = true;
      let cleanupError: Error | undefined;
      try {
        removeDockerLockOwner(ownerPath, owner.token);
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
      }
      try {
        await release();
      } catch (error) {
        cleanupError ??= error instanceof Error ? error : new Error(String(error));
      }
      return compromisedError ?? cleanupError;
    },
  };
}

export function isDockerSessionLockSignalListener(listener: NodeJS.SignalsListener): boolean {
  return dockerSessionLockSignalListeners.has(listener);
}

export function dockerSessionLockPath(persistentHome: string): string {
  const canonicalHome = realpathSync(persistentHome);
  const sessionRoot = dirname(dirname(canonicalHome));
  const key = createHash("sha256").update(canonicalHome).digest("hex");
  return join(sessionRoot, ".headless-session-locks", `${key}.lock`);
}

function writeDockerLockOwner(
  ownerPath: string,
  owner: { hostname: string; pid: number; startIdentity: string | undefined; token: string },
): void {
  const temporaryPath = `${ownerPath}.${owner.token}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: privateFileMode });
  try {
    renameSync(temporaryPath, ownerPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readDockerLockOwner(
  ownerPath: string,
): { hostname: string; pid: number; startIdentity: string | undefined; token: string } | undefined {
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    if (typeof owner.hostname !== "string" || !owner.hostname) return undefined;
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return undefined;
    if (owner.startIdentity !== undefined && typeof owner.startIdentity !== "string") return undefined;
    if (typeof owner.token !== "string" || !/^[0-9a-f-]{36}$/.test(owner.token)) return undefined;
    return {
      hostname: owner.hostname,
      pid: owner.pid as number,
      startIdentity: owner.startIdentity as string | undefined,
      token: owner.token,
    };
  } catch {
    return undefined;
  }
}

function removeDockerLockOwner(ownerPath: string, token: string): void {
  if (readDockerLockOwner(ownerPath)?.token === token) {
    rmSync(ownerPath, { force: true });
  }
}

function processStartIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const fieldsAfterName = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const startTicks = fieldsAfterName[19];
      return bootId && startTicks ? `linux:${bootId}:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  const result = process.platform === "win32"
    ? spawnSync(
        windowsPowerShellPath(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: "utf8", timeout: 1_000, windowsHide: true },
      )
    : spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        timeout: 1_000,
      });
  const identity = result.status === 0 ? result.stdout.trim() : "";
  return identity ? `${process.platform}:${identity}` : undefined;
}

function windowsPowerShellPath(systemRoot = process.env.SystemRoot): string {
  const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// A lock can be reaped only when its writer process is gone. A live holder may
// be slow to launch or claim its transcript; bypassing it would break attribution.
function reapDeadOwnerLock(lockPath: string): boolean {
  let pid: number | undefined;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return false; // lock vanished between attempts; let the caller retry the open
  }
  const writerGone = Number.isFinite(pid) && !processAlive(pid as number);
  if (writerGone) {
    rmSync(lockPath, { force: true });
    return true;
  }
  return false;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: privateDirMode });
  chmodSync(path, privateDirMode);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
