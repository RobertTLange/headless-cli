import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { extractFinalMessage } from "./output.js";
import type { NativeTranscript } from "./runs.js";
import type { AgentName, Env } from "./types.js";
export { deriveNativeTranscriptActivity } from "./native-activity.js";
export type { NativeActivityStatus, NativeTranscriptActivity, NativeTranscriptActivityOptions } from "./native-activity.js";

export interface NativeAssistantCompletion {
  message: string;
  source: "native-transcript";
  path: string;
}

export function resolveNativeTranscript(
  agent: AgentName,
  nativeId: string | undefined,
  workDir: string | undefined,
  env: Env,
  partial: Partial<NativeTranscript> = {},
): NativeTranscript | undefined {
  if (!nativeId) return undefined;

  const path =
    agent === "claude"
      ? claudeTranscriptPath(nativeId, workDir, env)
      : agent === "codex"
        ? findFileContaining(codexSessionsRoot(env), nativeId)
        : agent === "cursor"
          ? cursorTranscriptPath(nativeId, workDir, env)
          : agent === "gemini"
            ? geminiTranscriptPath(nativeId, workDir, env)
            : agent === "opencode"
              ? opencodeDatabasePath(env)
              : agent === "pi"
                ? piTranscriptPath(nativeId, workDir, env)
                : undefined;

  if (!path || !existsSync(path)) return undefined;
  const kind = agent === "opencode" ? "sqlite" : "jsonl";
  return {
    kind,
    path,
    sessionId: nativeId,
    ...partial,
    endOffset: kind === "jsonl" ? statSync(path).size : partial.endOffset,
  };
}

export function beginNativeTranscript(
  agent: AgentName,
  nativeId: string | undefined,
  workDir: string | undefined,
  env: Env,
): NativeTranscript | undefined {
  const startedAt = new Date().toISOString();
  const transcript = resolveNativeTranscript(agent, nativeId, workDir, env, { startedAt });
  if (!transcript || transcript.kind !== "jsonl") {
    return transcript ?? (agent === "opencode" ? resolveNativeTranscript(agent, nativeId, workDir, env, { startedAt }) : undefined);
  }
  return { ...transcript, startOffset: transcript.endOffset, endOffset: undefined };
}

export function finalizeNativeTranscript(
  agent: AgentName,
  nativeId: string | undefined,
  workDir: string | undefined,
  env: Env,
  started?: NativeTranscript,
): NativeTranscript | undefined {
  const completedAt = new Date().toISOString();
  const transcript = resolveNativeTranscript(agent, nativeId, workDir, env, {
    ...started,
    completedAt,
    startOffset: started?.startOffset,
  });
  if (transcript || !started?.path || !existsSync(started.path)) return transcript;
  return {
    ...started,
    completedAt,
    endOffset: started.kind === "jsonl" ? statSync(started.path).size : started.endOffset,
  };
}

export function resolveLatestNativeTranscript(
  agent: AgentName,
  workDir: string | undefined,
  env: Env,
  partial: Partial<NativeTranscript> = {},
): NativeTranscript | undefined {
  const workspace = realWorkspace(workDir);
  if (!workspace) return undefined;
  if (agent === "opencode") {
    return latestOpenCodeTranscript(workspace, workDir, env, partial);
  }

  const path =
    agent === "claude"
      ? latestFileInDirectory(claudeProjectRoot(workspace, env), partial)
      : agent === "codex"
        ? latestWorkspaceFile(codexSessionsRoot(env), workspace, workDir, partial)
        : agent === "cursor"
          ? latestFileInDirectory(cursorTranscriptsRoot(workspace, env), partial)
          : agent === "gemini"
            ? latestGeminiTranscript(workspace, env, partial)
            : agent === "pi"
              ? latestFileInDirectory(piProjectRoot(workspace, env), partial)
              : undefined;
  if (!path) return undefined;
  const nativeId = nativeIdFromPath(agent, path);
  return {
    kind: "jsonl",
    path,
    sessionId: nativeId,
    ...partial,
    endOffset: statSync(path).size,
  };
}

export function indexNativeAssistantCompletion(
  agent: AgentName,
  transcript: NativeTranscript | undefined,
): NativeAssistantCompletion | undefined {
  if (!transcript || !existsSync(transcript.path)) return undefined;
  const message =
    transcript.kind === "sqlite"
      ? indexOpenCodeCompletion(transcript)
      : extractFinalMessage(agent, readTranscriptSlice(transcript));
  if (!message) return undefined;
  return { message, source: "native-transcript", path: transcript.path };
}

function readTranscriptSlice(transcript: NativeTranscript): string {
  const bytes = readFileSync(transcript.path);
  const start = transcript.startOffset ?? 0;
  const end = transcript.endOffset ?? bytes.length;
  return bytes.subarray(start, end).toString("utf8");
}

function indexOpenCodeCompletion(transcript: NativeTranscript): string {
  if (!transcript.sessionId || !/^[A-Za-z0-9_.:-]+$/.test(transcript.sessionId)) return "";
  const startedAtMs = transcript.startedAt ? Date.parse(transcript.startedAt) : Number.NaN;
  const sqlite = spawnSync(
    "sqlite3",
    [
      transcript.path,
      [
        "select json_extract(part.data, '$.text')",
        "from part",
        "join message on message.id = part.message_id",
        `where part.session_id = '${transcript.sessionId.replaceAll("'", "''")}'`,
        "and json_extract(part.data, '$.type') = 'text'",
        "and json_extract(message.data, '$.role') = 'assistant'",
        ...(Number.isFinite(startedAtMs) ? [`and part.time_created >= ${Math.floor(startedAtMs)}`] : []),
        "order by json_extract(part.data, '$.metadata.openai.phase') = 'final_answer' desc, part.time_created desc",
        "limit 1;",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  if (sqlite.status !== 0) return "";
  return sqlite.stdout.trim();
}

function claudeTranscriptPath(nativeId: string, workDir: string | undefined, env: Env): string | undefined {
  const root = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : undefined);
  const workspace = realWorkspace(workDir);
  return root && workspace ? join(claudeProjectRoot(workspace, env) ?? root, `${nativeId}.jsonl`) : undefined;
}

function claudeProjectRoot(workspace: string, env: Env): string | undefined {
  const root = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : undefined);
  return root ? join(root, "projects", claudeProjectKey(workspace)) : undefined;
}

function codexSessionsRoot(env: Env): string | undefined {
  return env.CODEX_HOME ? join(env.CODEX_HOME, "sessions") : env.HOME ? join(env.HOME, ".codex", "sessions") : undefined;
}

function cursorTranscriptPath(nativeId: string, workDir: string | undefined, env: Env): string | undefined {
  const workspace = realWorkspace(workDir);
  return workspace
    ? join(cursorTranscriptsRoot(workspace, env) ?? "", nativeId, `${nativeId}.jsonl`)
    : undefined;
}

function cursorTranscriptsRoot(workspace: string, env: Env): string | undefined {
  const root = env.CURSOR_HOME ?? (env.HOME ? join(env.HOME, ".cursor") : undefined);
  return root ? join(root, "projects", cursorProjectKey(workspace), "agent-transcripts") : undefined;
}

function geminiTranscriptPath(nativeId: string, workDir: string | undefined, env: Env): string | undefined {
  const root = env.GEMINI_HOME ?? (env.HOME ? join(env.HOME, ".gemini") : undefined);
  const workspace = realWorkspace(workDir);
  if (!root || !workspace) return undefined;
  const projectSlot = geminiProjectSlot(root, workspace);
  if (!projectSlot) return undefined;
  return findFileContaining(join(root, "tmp", projectSlot, "chats"), nativeId.slice(0, 8));
}

function opencodeDatabasePath(env: Env): string | undefined {
  return env.OPENCODE_DATA_HOME
    ? join(env.OPENCODE_DATA_HOME, "opencode.db")
    : env.HOME
      ? join(env.HOME, ".local", "share", "opencode", "opencode.db")
      : undefined;
}

function piTranscriptPath(nativeId: string, workDir: string | undefined, env: Env): string | undefined {
  if (nativeId.endsWith(".jsonl")) return nativeId;
  const workspace = realWorkspace(workDir);
  return workspace ? findFileContaining(piProjectRoot(workspace, env), nativeId) : undefined;
}

function piProjectRoot(workspace: string, env: Env): string | undefined {
  const root = env.PI_CODING_AGENT_HOME ?? (env.HOME ? join(env.HOME, ".pi", "agent") : undefined);
  return root ? join(root, "sessions", piProjectKey(workspace)) : undefined;
}

function geminiProjectSlot(root: string, workspace: string): string {
  const projectsPath = join(root, "projects.json");
  if (!existsSync(projectsPath)) return "";
  try {
    const config = JSON.parse(readFileSync(projectsPath, "utf8")) as Record<string, unknown>;
    const projects = isRecord(config.projects) ? config.projects : config;
    const direct = projects[workspace];
    if (typeof direct === "string") return direct;
    for (const [key, value] of Object.entries(projects)) {
      if (realWorkspace(key) === workspace && typeof value === "string") return value;
    }
  } catch {
    return "";
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findFileContaining(root: string | undefined, text: string): string | undefined {
  if (!root || !text || !existsSync(root)) return undefined;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.includes(text)) {
        return path;
      }
    }
  }
  return undefined;
}

function latestGeminiTranscript(
  workspace: string,
  env: Env,
  partial: Partial<NativeTranscript>,
): string | undefined {
  const root = env.GEMINI_HOME ?? (env.HOME ? join(env.HOME, ".gemini") : undefined);
  if (!root) return undefined;
  const projectSlot = geminiProjectSlot(root, workspace);
  return projectSlot ? latestFileInDirectory(join(root, "tmp", projectSlot, "chats"), partial) : undefined;
}

function latestOpenCodeTranscript(
  workspace: string,
  workDir: string | undefined,
  env: Env,
  partial: Partial<NativeTranscript>,
): NativeTranscript | undefined {
  const path = opencodeDatabasePath(env);
  if (!path || !existsSync(path)) return undefined;
  const directories = uniqueStrings([workspace, workDir].filter((value): value is string => Boolean(value)));
  const startedAtMs = partial.startedAt ? Date.parse(partial.startedAt) : Number.NaN;
  const whereDirectory = directories.map((directory) => `'${directory.replaceAll("'", "''")}'`).join(", ");
  const sqlite = spawnSync(
    "sqlite3",
    [
      path,
      [
        "select id",
        "from session",
        `where directory in (${whereDirectory})`,
        ...(Number.isFinite(startedAtMs) ? [`and time_updated >= ${Math.floor(startedAtMs)}`] : []),
        "order by time_updated desc",
        "limit 1;",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  const sessionId = sqlite.status === 0 ? sqlite.stdout.trim() : "";
  return sessionId ? { kind: "sqlite", path, sessionId, ...partial } : undefined;
}

function latestWorkspaceFile(
  root: string | undefined,
  workspace: string,
  workDir: string | undefined,
  partial: Partial<NativeTranscript>,
): string | undefined {
  const candidates = latestFiles(root, partial);
  const needles = uniqueStrings([workspace, workDir].filter((value): value is string => Boolean(value)));
  return candidates.find((path) => fileHasWorkspaceCwd(path, needles));
}

function latestFileInDirectory(root: string | undefined, partial: Partial<NativeTranscript>): string | undefined {
  return latestFiles(root, partial)[0];
}

function latestFiles(root: string | undefined, partial: Partial<NativeTranscript>): string[] {
  if (!root || !existsSync(root)) return [];
  const startedAtMs = partial.startedAt ? Date.parse(partial.startedAt) : Number.NaN;
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const stat = statSync(path);
      if (Number.isFinite(startedAtMs) && stat.mtimeMs < startedAtMs) continue;
      files.push({ path, mtimeMs: stat.mtimeMs });
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)).map((file) => file.path);
}

function fileHasWorkspaceCwd(path: string, needles: string[]): boolean {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/).slice(0, 40)) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      const cwd = cwdFromRecord(record);
      if (cwd && needles.includes(cwd)) return true;
      const realCwd = realWorkspace(cwd);
      if (realCwd && needles.includes(realCwd)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function cwdFromRecord(record: Record<string, unknown>): string {
  const payload = isRecord(record.payload) ? record.payload : undefined;
  const path = isRecord(record.path) ? record.path : undefined;
  return asString(record.cwd) || asString(payload?.cwd) || asString(path?.cwd);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nativeIdFromPath(agent: AgentName, path: string): string | undefined {
  const name = path.split("/").at(-1)?.replace(/\.jsonl$/, "");
  if (!name) return undefined;
  if (agent === "codex") {
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name);
    return match?.[1] ?? name;
  }
  if (agent === "gemini") {
    const match = /session-[^-]+-[^-]+-(.+)$/.exec(name);
    return match?.[1] ?? name;
  }
  return name;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function realWorkspace(workDir: string | undefined): string | undefined {
  if (!workDir) return undefined;
  try {
    return realpathSync(workDir);
  } catch {
    return workDir;
  }
}

function claudeProjectKey(workspace: string): string {
  return workspace.replace(/\//g, "-");
}

function cursorProjectKey(workspace: string): string {
  return workspace.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function piProjectKey(workspace: string): string {
  return `--${workspace.replace(/^\/+/, "").replace(/[\\/]+/g, "-")}--`;
}
