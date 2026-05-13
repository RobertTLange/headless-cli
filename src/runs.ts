import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { CoordinationMode, Role, RunStatus } from "./roles.js";
import type { AgentName, AllowMode, Env, ReasoningEffort } from "./types.js";

const privateDirMode = 0o700;
const privateFileMode = 0o600;

export interface RunNode {
  runId: string;
  nodeId: string;
  role: Role;
  agent: AgentName;
  coordination: CoordinationMode;
  status: RunStatus;
  lastMessage?: string;
  dependsOn: string[];
  planned: boolean;
  unplanned: boolean;
  allow?: AllowMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  workDir?: string;
  sessionAlias?: string;
  tmuxSessionName?: string;
  logs?: {
    stdout: string;
    stderr: string;
  };
  metrics?: RunNodeMetrics;
  createdAt: string;
  updatedAt: string;
}

export interface RunNodeMetrics {
  turns?: number;
  durationMs?: number;
  apiDurationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface NativeTranscript {
  kind: "jsonl" | "sqlite";
  path: string;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface RunEvent {
  type:
    | "run_started"
    | "node_registered"
    | "node_started"
    | "message_sent"
    | "status_changed"
    | "node_output"
    | "node_failed"
    | "node_completed";
  runId: string;
  nodeId?: string;
  parentNodeId?: string;
  targetNodeId?: string;
  role?: Role;
  agent?: AgentName;
  coordination?: CoordinationMode;
  status?: RunStatus;
  message?: string;
  dependsOn?: string[];
  createdAt: string;
}

export interface RunRecord {
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  nodes: Record<string, RunNode>;
  events: RunEvent[];
}

export interface RegisterNodeInput {
  runId: string;
  nodeId: string;
  role: Role;
  agent: AgentName;
  coordination: CoordinationMode;
  status?: RunStatus;
  dependsOn?: string[];
  planned?: boolean;
  allow?: AllowMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  workDir?: string;
  sessionAlias?: string;
  tmuxSessionName?: string;
}

export function validateRunId(value: string | undefined, label: string): string {
  if (!value || value === "." || value === ".." || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`invalid ${label}; use letters, numbers, dots, dashes, or underscores`);
  }
  return value;
}

export function runDirectory(env: Env, runId: string): string {
  const override = env.HEADLESS_RUN_DIR;
  if (override) {
    return basename(override) === runId ? override : override;
  }
  if (!env.HOME) {
    throw new Error("HOME is required for --run");
  }
  return join(env.HOME, ".headless", "runs", runId);
}

export function runStoreRoot(env: Env): string {
  if (env.HEADLESS_RUN_DIR) {
    return dirname(env.HEADLESS_RUN_DIR);
  }
  if (!env.HOME) {
    throw new Error("HOME is required for headless run");
  }
  return join(env.HOME, ".headless", "runs");
}

export function nodeDirectory(env: Env, runId: string, nodeId: string): string {
  return join(runDirectory(env, runId), "nodes", nodeId);
}

export function nodeLockPath(env: Env, runId: string, nodeId: string): string {
  return join(nodeDirectory(env, runId, nodeId), "session.lock");
}

export function nodeLogPath(env: Env, runId: string, nodeId: string, stream: "stdout" | "stderr"): string {
  return readRun(env, runId)?.nodes[nodeId]?.logs?.[stream] ?? logPaths(env, runId, nodeId)[stream];
}

export function appendNodeLog(
  env: Env,
  runId: string,
  nodeId: string,
  stream: "stdout" | "stderr",
  text: string,
): void {
  if (!text) {
    return;
  }
  const path = nodeLogPath(env, runId, nodeId, stream);
  ensurePrivateDir(dirname(path));
  appendPrivateFile(path, text);
}

export function readRun(env: Env, runId: string): RunRecord | undefined {
  const path = join(runDirectory(env, runId), "run.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunRecord>;
    if (parsed.version !== 1 || parsed.runId !== runId || !parsed.nodes || !parsed.events) {
      return undefined;
    }
    return {
      version: 1,
      runId,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      nodes: parsed.nodes,
      events: parsed.events,
    };
  } catch {
    return undefined;
  }
}

export function listRuns(env: Env): RunRecord[] {
  const root = runStoreRoot(env);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .map((entry) => readRun({ ...env, HEADLESS_RUN_DIR: join(root, entry) }, entry))
    .filter((run): run is RunRecord => Boolean(run))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function registerNode(env: Env, input: RegisterNodeInput): RunNode {
  validateRunId(input.runId, "run");
  validateRunId(input.nodeId, "node");
  return withRunLock(env, input.runId, () => {
    const run = readRun(env, input.runId) ?? emptyRun(input.runId);
    const now = new Date().toISOString();
    const existing = run.nodes[input.nodeId];
    const status =
      existing?.status === "busy" && input.status === "starting"
        ? "busy"
        : (input.status ?? existing?.status ?? "planned");
    const node: RunNode = {
      runId: input.runId,
      nodeId: input.nodeId,
      role: input.role,
      agent: input.agent,
      coordination: input.coordination,
      status,
      lastMessage: existing?.lastMessage,
      dependsOn: unique(input.dependsOn ?? existing?.dependsOn ?? []),
      planned: input.planned ?? existing?.planned ?? false,
      unplanned: !(input.planned ?? existing?.planned ?? false),
      allow: input.allow ?? existing?.allow,
      model: input.model ?? existing?.model,
      reasoningEffort: input.reasoningEffort ?? existing?.reasoningEffort,
      workDir: input.workDir ?? existing?.workDir,
      sessionAlias: input.sessionAlias ?? existing?.sessionAlias,
      tmuxSessionName: input.tmuxSessionName ?? existing?.tmuxSessionName,
      logs: existing?.logs ?? logPaths(env, input.runId, input.nodeId),
      metrics: existing?.metrics,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    run.nodes[input.nodeId] = node;
    addEvent(run, {
      type: existing ? "node_started" : "node_registered",
      runId: input.runId,
      nodeId: input.nodeId,
      role: input.role,
      agent: input.agent,
      coordination: input.coordination,
      status: node.status,
      dependsOn: node.dependsOn,
      createdAt: now,
    });
    writeRun(env, run);
    return node;
  });
}

export function updateNodeStatus(
  env: Env,
  runId: string,
  nodeId: string,
  status: RunStatus,
  message?: string,
  metrics?: RunNodeMetrics,
): RunNode {
  validateRunId(runId, "run");
  return withRunLock(env, runId, () => {
    const run = requireRun(env, runId);
    const node = requireNode(run, nodeId);
    const now = new Date().toISOString();
    node.status = status;
    node.updatedAt = now;
    if (message) {
      node.lastMessage = message;
    }
    if (metrics && Object.keys(metrics).length > 0) {
      node.metrics = { ...node.metrics, ...metrics };
    }
    addEvent(run, {
      type: status === "failed" ? "node_failed" : status === "done" || status === "idle" ? "node_completed" : "status_changed",
      runId,
      nodeId,
      status,
      message,
      createdAt: now,
    });
    writeRun(env, run);
    return node;
  });
}

export function completeIdleRunNodes(env: Env, runId: string, orchestratorNodeId: string, orchestratorMessage?: string): void {
  validateRunId(runId, "run");
  withRunLock(env, runId, () => {
    const run = requireRun(env, runId);
    const now = new Date().toISOString();
    for (const node of Object.values(run.nodes)) {
      const shouldComplete = node.nodeId === orchestratorNodeId || node.status === "idle";
      if (!shouldComplete) {
        continue;
      }
      node.status = "done";
      node.updatedAt = now;
      if (node.nodeId === orchestratorNodeId && orchestratorMessage) {
        node.lastMessage = orchestratorMessage;
      }
      addEvent(run, {
        type: "node_completed",
        runId,
        nodeId: node.nodeId,
        status: "done",
        message: node.nodeId === orchestratorNodeId ? orchestratorMessage : undefined,
        createdAt: now,
      });
    }
    writeRun(env, run);
  });
}

export function recordMessage(
  env: Env,
  runId: string,
  fromNodeId: string,
  targetNodeId: string,
  message: string,
): void {
  validateRunId(runId, "run");
  withRunLock(env, runId, () => {
    const run = requireRun(env, runId);
    const now = new Date().toISOString();
    if (!run.nodes[targetNodeId]) {
      throw new Error(`unknown node in run ${runId}: ${targetNodeId}`);
    }
    const sourceNode = run.nodes[fromNodeId];
    const messageOwner = sourceNode ?? run.nodes[targetNodeId];
    messageOwner.lastMessage = message;
    messageOwner.updatedAt = now;
    addEvent(run, {
      type: "message_sent",
      runId,
      nodeId: fromNodeId,
      targetNodeId,
      message,
      createdAt: now,
    });
    writeRun(env, run);
  });
}

export function acquireNodeLock(env: Env, runId: string, nodeId: string): () => void {
  const lockPath = nodeLockPath(env, runId, nodeId);
  ensurePrivateDir(dirname(lockPath));
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", privateFileMode);
    chmodSync(lockPath, privateFileMode);
  } catch {
    throw new Error(`node is locked: ${nodeId}`);
  }
  writeFileSync(fd, `${process.pid}\n`);
  return () => {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  };
}

export function writeRun(env: Env, run: RunRecord): void {
  const dir = runDirectory(env, run.runId);
  ensurePrivateDir(dir);
  for (const node of Object.values(run.nodes)) {
    ensurePrivateDir(nodeDirectory(env, run.runId, node.nodeId));
  }
  run.updatedAt = new Date().toISOString();
  const path = join(dir, "run.json");
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(run, null, 2)}\n`, { mode: privateFileMode });
  chmodSync(tmpPath, privateFileMode);
  renameSync(tmpPath, path);
  chmodSync(path, privateFileMode);
  const eventsPath = join(dir, "events.jsonl");
  const event = run.events.at(-1);
  if (event) {
    appendPrivateFile(eventsPath, `${JSON.stringify(event)}\n`);
  }
}

function withRunLock<T>(env: Env, runId: string, callback: () => T): T {
  const release = acquireRunLock(env, runId);
  try {
    return callback();
  } finally {
    release();
  }
}

function acquireRunLock(env: Env, runId: string): () => void {
  const dir = runDirectory(env, runId);
  ensurePrivateDir(dir);
  const lockPath = join(dir, "run.lock");
  const deadline = Date.now() + 30000;
  let fd: number;
  while (true) {
    try {
      fd = openSync(lockPath, "wx", privateFileMode);
      chmodSync(lockPath, privateFileMode);
      break;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`run is locked: ${runId}`);
      }
      sleepSync(10);
    }
  }
  writeFileSync(fd, `${process.pid}\n`);
  return () => {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  };
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function requireRun(env: Env, runId: string): RunRecord {
  const run = readRun(env, runId);
  if (!run) {
    throw new Error(`unknown run: ${runId}`);
  }
  return run;
}

function requireNode(run: RunRecord, nodeId: string): RunNode {
  const node = run.nodes[nodeId];
  if (!node) {
    throw new Error(`unknown node in run ${run.runId}: ${nodeId}`);
  }
  return node;
}

function emptyRun(runId: string): RunRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId,
    createdAt: now,
    updatedAt: now,
    nodes: {},
    events: [{ type: "run_started", runId, createdAt: now }],
  };
}

function addEvent(run: RunRecord, event: RunEvent): void {
  run.events.push(event);
  if (run.events.length > 200) {
    run.events = run.events.slice(-200);
  }
}

function logPaths(env: Env, runId: string, nodeId: string): { stdout: string; stderr: string } {
  const dir = nodeDirectory(env, runId, nodeId);
  return {
    stdout: join(dir, "latest.stdout.log"),
    stderr: join(dir, "latest.stderr.log"),
  };
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: privateDirMode });
  chmodSync(path, privateDirMode);
}

function appendPrivateFile(path: string, text: string): void {
  appendFileSync(path, text, { mode: privateFileMode });
  chmodSync(path, privateFileMode);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
