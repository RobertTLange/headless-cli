import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentName, Env } from "./types.js";

const privateDirMode = 0o700;
const privateFileMode = 0o600;

export interface LaunchLock {
  release: () => void;
}

// Serializes only the brief launch window of concurrent same-(agent, workspace)
// runs so the `claim` wait tier can attribute a brand-new transcript to this run.
// Different agents and different workspaces never contend (distinct lock files),
// and the lock is released before the agent's actual work is awaited.
export function acquireLaunchLock(
  env: Env,
  agent: AgentName,
  workspace: string,
): LaunchLock {
  const lockPath = launchLockPath(env, agent, workspace);
  if (!lockPath) return { release: () => {} };

  ensurePrivateDir(lockPath.slice(0, lockPath.lastIndexOf("/")));
  while (true) {
    try {
      const fd = openSync(lockPath, "wx", privateFileMode);
      chmodSync(lockPath, privateFileMode);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return { release: () => rmSync(lockPath, { force: true }) };
    } catch {
      if (reapDeadOwnerLock(lockPath)) continue;
      sleepSync(25);
    }
  }
}

export function launchLockPath(env: Env, agent: AgentName, workspace: string): string | undefined {
  if (!env.HOME) return undefined;
  const key = `${agent}-${workspace.replace(/\//g, "-")}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(env.HOME, ".headless", "launch-locks", `${key}.lock`);
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
