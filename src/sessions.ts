import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type { AgentName, Env } from "./types.js";
import { validateCodexProfileName } from "./codex-profile.js";

export type StoredTmuxWaitStrategy =
  | { kind: "pin"; sessionId: string }
  | { kind: "title"; title: string }
  | { kind: "dir"; sessionDir: string }
  | { kind: "claim"; claimed: string };

export interface StoredSession {
  agent: AgentName;
  alias: string;
  nativeId?: string;
  profile?: string;
  tmuxWaitStrategy?: StoredTmuxWaitStrategy;
  workDir?: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionStoreFile {
  version: 1;
  agents: Partial<Record<AgentName, Record<string, StoredSession>>>;
}

export const SECURE_SESSION_STORE_ENV = "HEADLESS_INTERNAL_SECURE_SESSION_STORE";
const maxSessionStoreBytes = 1024 * 1024;

export function sessionStorePath(env: Env): string | undefined {
  return env.HOME ? join(env.HOME, ".headless", "sessions.json") : undefined;
}

export function readStoredSession(env: Env, agent: AgentName, alias: string): StoredSession | undefined {
  return readSessionStore(env).agents[agent]?.[alias];
}

export function writeStoredSession(
  env: Env,
  session: Pick<StoredSession, "agent" | "alias" | "nativeId" | "profile" | "workDir">,
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
    profile: session.profile ?? existing?.profile,
    tmuxWaitStrategy: existing?.tmuxWaitStrategy,
    workDir: session.workDir,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.agents[session.agent] = { ...(store.agents[session.agent] ?? {}), [session.alias]: stored };
  writeSessionStore(path, store, env[SECURE_SESSION_STORE_ENV] === "1");
  return stored;
}

export function writeStoredTmuxSession(
  env: Env,
  session: Pick<StoredSession, "agent" | "alias" | "profile" | "tmuxWaitStrategy" | "workDir">,
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
    nativeId: existing?.nativeId,
    profile: session.profile ?? existing?.profile,
    tmuxWaitStrategy: session.tmuxWaitStrategy,
    workDir: session.workDir,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.agents[session.agent] = { ...(store.agents[session.agent] ?? {}), [session.alias]: stored };
  writeSessionStore(path, store, env[SECURE_SESSION_STORE_ENV] === "1");
  return stored;
}

function readSessionStore(env: Env): SessionStoreFile {
  const path = sessionStorePath(env);
  if (env[SECURE_SESSION_STORE_ENV] === "1") {
    return path ? readSecureSessionStore(path) : emptyStore();
  }
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

function readSecureSessionStore(path: string): SessionStoreFile {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > maxSessionStoreBytes) {
      throw new Error("Docker session store must be a bounded regular file");
    }
    return normalizeSessionStore(JSON.parse(readFileSync(descriptor, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    if (error instanceof SyntaxError) return emptyStore();
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function normalizeSessionStore(value: unknown): SessionStoreFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.agents)) return emptyStore();
  const store = emptyStore();
  for (const agent of ["acp", "antigravity", "claude", "codex", "cursor", "gemini", "opencode", "pi"] as const) {
    const sessions = value.agents[agent];
    if (!isRecord(sessions)) continue;
    const normalizedSessions = Object.create(null) as Record<string, StoredSession>;
    for (const [alias, candidate] of Object.entries(sessions)) {
      const session = normalizeStoredSession(candidate, agent, alias);
      if (session) {
        normalizedSessions[alias] = session;
      }
    }
    if (Object.keys(normalizedSessions).length > 0) {
      store.agents[agent] = normalizedSessions;
    }
  }
  return store;
}

function normalizeStoredSession(value: unknown, agent: AgentName, alias: string): StoredSession | undefined {
  if (
    !isRecord(value) ||
    value.agent !== agent ||
    value.alias !== alias ||
    alias === "." ||
    alias === ".." ||
    !/^[A-Za-z0-9_.-]+$/.test(alias) ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length > 64 ||
    typeof value.updatedAt !== "string" ||
    value.updatedAt.length > 64
  ) {
    return undefined;
  }
  const nativeId = boundedOptionalString(value.nativeId, 4096);
  const profile = boundedOptionalProfile(value.profile);
  const workDir = boundedOptionalString(value.workDir, 4096);
  if (nativeId === null || profile === null || workDir === null) return undefined;
  return {
    agent,
    alias,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(nativeId === undefined ? {} : { nativeId }),
    ...(profile === undefined ? {} : { profile }),
    ...(workDir === undefined ? {} : { workDir }),
  };
}

function boundedOptionalString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function boundedOptionalProfile(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  try {
    return validateCodexProfileName(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyStore(): SessionStoreFile {
  return { version: 1, agents: {} };
}

function writeSessionStore(path: string, store: SessionStoreFile, secure: boolean): void {
  if (secure) {
    writeSecureSessionStore(path, store);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmpPath, path);
}

function writeSecureSessionStore(path: string, store: SessionStoreFile): void {
  const contents = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(contents) > maxSessionStoreBytes) {
    throw new Error("Docker session store exceeds its size limit");
  }
  const tmpPath = join(dirname(path), `.sessions.json.tmp-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, contents);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmpPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(tmpPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}
