import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentName, Env } from "./types.js";

const privateDirMode = 0o700;
const privateFileMode = 0o600;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 30_000;

export interface LaunchLock {
  release: () => void;
}

interface LaunchLockOptions {
  timeoutMs?: number;
  staleMs?: number;
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

  ensurePrivateDir(lockPath.slice(0, lockPath.lastIndexOf("/")));
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx", privateFileMode);
      chmodSync(lockPath, privateFileMode);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return { release: () => rmSync(lockPath, { force: true }) };
    } catch {
      if (reapStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        // Don't block the run forever on a wedged lock; proceed unsynchronized.
        return { release: () => {} };
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

// A lock is stale if its writer process is gone or it outlived the staleness
// window (covers crashes and pid reuse across hosts). Returns true if removed.
function reapStaleLock(lockPath: string, staleMs: number): boolean {
  let pid: number | undefined;
  let mtimeMs: number;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return false; // lock vanished between attempts; let the caller retry the open
  }
  const writerGone = Number.isFinite(pid) && !processAlive(pid as number);
  const expired = Date.now() - mtimeMs > staleMs;
  if (writerGone || expired) {
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
