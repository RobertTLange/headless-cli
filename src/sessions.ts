import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentName, Env } from "./types.js";

export interface StoredSession {
  agent: AgentName;
  alias: string;
  nativeId: string;
  workDir?: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionStoreFile {
  version: 1;
  agents: Partial<Record<AgentName, Record<string, StoredSession>>>;
}

export function sessionStorePath(env: Env): string | undefined {
  return env.HOME ? join(env.HOME, ".headless", "sessions.json") : undefined;
}

export function readStoredSession(env: Env, agent: AgentName, alias: string): StoredSession | undefined {
  return readSessionStore(env).agents[agent]?.[alias];
}

export function writeStoredSession(
  env: Env,
  session: Pick<StoredSession, "agent" | "alias" | "nativeId" | "workDir">,
): StoredSession {
  const path = sessionStorePath(env);
  if (!path) {
    throw new Error("HOME is required for --session");
  }

  const store = readSessionStore(env);
  const existing = store.agents[session.agent]?.[session.alias];
  const now = new Date().toISOString();
  const stored: StoredSession = {
    agent: session.agent,
    alias: session.alias,
    nativeId: session.nativeId,
    workDir: session.workDir,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.agents[session.agent] = { ...(store.agents[session.agent] ?? {}), [session.alias]: stored };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmpPath, path);
  return stored;
}

function readSessionStore(env: Env): SessionStoreFile {
  const path = sessionStorePath(env);
  if (!path || !existsSync(path)) {
    return emptyStore();
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionStoreFile>;
    if (parsed.version !== 1 || !parsed.agents || typeof parsed.agents !== "object") {
      return emptyStore();
    }
    return { version: 1, agents: parsed.agents };
  } catch {
    return emptyStore();
  }
}

function emptyStore(): SessionStoreFile {
  return { version: 1, agents: {} };
}
