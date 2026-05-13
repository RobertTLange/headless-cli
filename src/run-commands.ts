import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { extractFinalMessage } from "./output.js";
import { deriveNativeTranscriptActivity, nativeTranscriptKey, resolveLatestNativeTranscripts } from "./native-transcripts.js";
import { extractRunNodeMetrics } from "./run-metrics.js";
import { renderRunList, renderRunView } from "./run-view.js";
import {
  acquireNodeLock,
  appendNodeLog,
  listRuns,
  nodeLockPath,
  readRun,
  recordMessage,
  runDirectory,
  updateNodeStatus,
  type RunNode,
} from "./runs.js";
import { quoteCommand } from "./shell.js";
import type { AgentName, Env } from "./types.js";
import type { RunStatus } from "./roles.js";

export interface RunCommandInput {
  command: "list" | "view" | "mark" | "message" | "wait";
  runId?: string;
  nodeId?: string;
  status?: RunStatus;
  async: boolean;
  printCommand: boolean;
}

export interface ResolvedPrompt {
  prompt: string;
  promptFile?: string;
}

export interface RunCommandHandlers {
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  resolvePrompt: () => Promise<ResolvedPrompt>;
  executeNode: (node: RunNode, prompt: string) => Promise<{ code: number; stdout: string }>;
  sendTmux: (sessionName: string, prompt: string, printCommand: boolean) => Promise<number>;
}

export async function handleRunCommand(input: RunCommandInput, handlers: RunCommandHandlers): Promise<number> {
  if (input.command === "list") {
    handlers.stdout(renderRunList(listRuns(handlers.env)));
    return 0;
  }
  const runId = requireValue(input.runId, "run");
  if (input.command === "view") {
    reconcileTmuxRunNodes(handlers.env, runId);
    const run = readRun(handlers.env, runId);
    if (!run) {
      throw new Error(`unknown run: ${runId}`);
    }
    handlers.stdout(renderRunView(run));
    return 0;
  }
  if (input.command === "mark") {
    const nodeId = requireValue(input.nodeId, "node");
    if (!input.status) {
      throw new Error("run mark requires --status");
    }
    updateNodeStatus(handlers.env, runId, nodeId, input.status);
    handlers.stdout(`marked: ${runId}/${nodeId} ${input.status}\n`);
    return 0;
  }
  if (input.command === "wait") {
    await waitForRunIdle(handlers.env, runId);
    handlers.stdout(`run idle: ${runId}\n`);
    return 0;
  }
  if (input.command === "message") {
    return await handleRunMessage(input, handlers, runId);
  }
  throw new Error("unsupported run command");
}

async function handleRunMessage(
  input: RunCommandInput,
  handlers: RunCommandHandlers,
  runId: string,
): Promise<number> {
  const nodeId = requireValue(input.nodeId, "node");
  const run = readRun(handlers.env, runId);
  if (!run) {
    throw new Error(`unknown run: ${runId}`);
  }
  const node = run.nodes[nodeId];
  if (!node) {
    throw new Error(`unknown node in run ${runId}: ${nodeId}`);
  }
  const prompt = await handlers.resolvePrompt();

  if (node.coordination === "tmux") {
    const sessionName = node.tmuxSessionName ?? `headless-${node.agent}-${node.sessionAlias ?? node.nodeId}`;
    const code = await handlers.sendTmux(sessionName, prompt.prompt, input.printCommand);
    if (code === 0 && !input.printCommand) {
      recordMessage(handlers.env, runId, handlers.env.HEADLESS_RUN_NODE || "cli", nodeId, prompt.prompt);
      updateNodeStatus(handlers.env, runId, nodeId, "busy");
      handlers.stdout(`sent: ${runId}/${nodeId}\n`);
    }
    return code;
  }

  if (input.printCommand) {
    const command = input.async
      ? buildAsyncRunMessageCommand(handlers.env, runId, nodeId, node, prompt.prompt)
      : buildNodeInvocationCommand(handlers.env, runId, nodeId, node, prompt.prompt);
    handlers.stdout(`${quoteCommand(command)}\n`);
    return 0;
  }

  if (input.async) {
    return startAsyncRunMessage(handlers, runId, nodeId, node, prompt.prompt);
  }

  const releaseLock = acquireNodeLock(handlers.env, runId, nodeId);
  try {
    recordMessage(handlers.env, runId, handlers.env.HEADLESS_RUN_NODE || "cli", nodeId, prompt.prompt);
    updateNodeStatus(handlers.env, runId, nodeId, "busy");
    const result = await handlers.executeNode(node, prompt.prompt);
    const finalMessage = extractFinalMessage(node.agent, result.stdout);
    updateNodeStatus(
      handlers.env,
      runId,
      nodeId,
      result.code === 0 ? "idle" : "failed",
      finalMessage || undefined,
      extractRunNodeMetrics(node.agent, result.stdout, { model: node.model }),
    );
    if (finalMessage) {
      handlers.stdout(`${finalMessage}\n`);
    }
    return result.code;
  } finally {
    releaseLock();
  }
}

async function waitForRunIdle(env: Env, runId: string): Promise<void> {
  const intervalMs = parseDelayMs(env.HEADLESS_RUN_WAIT_INTERVAL_MS, 1000);
  const currentNode = env.HEADLESS_RUN_NODE;
  while (true) {
    reconcileTmuxRunNodes(env, runId);
    const run = readRun(env, runId);
    if (!run) {
      throw new Error(`unknown run: ${runId}`);
    }
    const busy = Object.values(run.nodes).some(
      (node) => node.nodeId !== currentNode && (node.status === "busy" || node.status === "starting"),
    );
    if (!busy) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function reconcileTmuxRunNodes(env: Env, runId: string): void {
  const run = readRun(env, runId);
  if (!run) return;
  const claimedTranscripts = new Set<string>();
  const nodes = Object.values(run.nodes)
    .filter(shouldReconcileTmuxNode)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.updatedAt.localeCompare(left.updatedAt) || right.nodeId.localeCompare(left.nodeId));
  const candidatesByScope = tmuxTranscriptCandidatesByScope(nodes, env);

  for (const node of nodes) {
    const transcript = (candidatesByScope.get(tmuxTranscriptScope(node.agent, node.workDir)) ?? []).find(
      (candidate) => !claimedTranscripts.has(nativeTranscriptKey(candidate)),
    );
    if (!transcript) continue;
    claimedTranscripts.add(nativeTranscriptKey(transcript));
    const activity = deriveNativeTranscriptActivity(node.agent, transcript);
    if (!activity) continue;
    const status = activity.status === "running" ? "busy" : activity.status === "waiting_input" ? "waiting" : "idle";
    if (status === node.status && (!activity.message || activity.message === node.lastMessage)) continue;
    updateNodeStatus(env, runId, node.nodeId, status, activity.message);
  }
}

function shouldReconcileTmuxNode(node: RunNode): boolean {
  if (node.coordination !== "tmux") return false;
  return node.status === "busy" || node.status === "starting" || node.status === "waiting";
}

function tmuxTranscriptCandidatesByScope(nodes: RunNode[], env: Env): Map<string, ReturnType<typeof resolveLatestNativeTranscripts>> {
  const nodesByScope = new Map<string, RunNode[]>();
  for (const node of nodes) {
    const scope = tmuxTranscriptScope(node.agent, node.workDir);
    const scopedNodes = nodesByScope.get(scope) ?? [];
    scopedNodes.push(node);
    nodesByScope.set(scope, scopedNodes);
  }

  const candidatesByScope = new Map<string, ReturnType<typeof resolveLatestNativeTranscripts>>();
  for (const [scope, scopedNodes] of nodesByScope) {
    const firstNode = scopedNodes[0];
    if (!firstNode) continue;
    const earliestCreatedAt = scopedNodes.reduce((earliest, node) => (node.createdAt < earliest ? node.createdAt : earliest), scopedNodes[0]?.createdAt ?? "");
    candidatesByScope.set(
      scope,
      resolveLatestNativeTranscripts(firstNode.agent, firstNode.workDir, env, { startedAt: earliestCreatedAt }, scopedNodes.length),
    );
  }
  return candidatesByScope;
}

function tmuxTranscriptScope(agent: AgentName, workDir: string | undefined): string {
  return `${agent}\t${workDir ?? ""}`;
}

function startAsyncRunMessage(
  handlers: RunCommandHandlers,
  runId: string,
  nodeId: string,
  node: RunNode,
  prompt: string,
): number {
  const releaseLock = acquireNodeLock(handlers.env, runId, nodeId);
  const stderrLog = node.logs?.stderr ?? join(runDirectory(handlers.env, runId), "nodes", nodeId, "latest.stderr.log");
  recordMessage(handlers.env, runId, handlers.env.HEADLESS_RUN_NODE || "cli", nodeId, prompt);
  updateNodeStatus(handlers.env, runId, nodeId, "busy");
  appendNodeLog(handlers.env, runId, nodeId, "stdout", `\n===== async message ${new Date().toISOString()} =====\n`);
  appendNodeLog(handlers.env, runId, nodeId, "stderr", `\n===== async message ${new Date().toISOString()} =====\n`);
  const command = buildAsyncRunMessageCommand(handlers.env, runId, nodeId, node, prompt);

  const errFd = openSync(stderrLog, "a");
  try {
    const childProcess = spawn(command.command, command.args, {
      cwd: node.workDir,
      env: handlers.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", "ignore", errFd],
    });
    childProcess.unref();
  } catch (error) {
    releaseLock();
    updateNodeStatus(handlers.env, runId, nodeId, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    closeSync(errFd);
  }
  handlers.stdout(`started: ${runId}/${nodeId}\n`);
  return 0;
}

function buildNodeInvocationCommand(env: Env, runId: string, nodeId: string, node: RunNode, prompt: string): {
  command: string;
  args: string[];
} {
  const cli = headlessCli(env);
  return {
    command: cli,
    args: [
      node.agent,
      "--role",
      node.role,
      "--coordination",
      node.coordination,
      "--run",
      runId,
      "--node",
      nodeId,
      "--prompt",
      prompt,
      ...(node.allow ? ["--allow", node.allow] : []),
      ...(node.model ? ["--model", node.model] : []),
      ...(node.reasoningEffort ? ["--reasoning-effort", node.reasoningEffort] : []),
      ...(node.workDir ? ["--work-dir", node.workDir] : []),
      ...(node.coordination === "session" ? ["--session", node.sessionAlias ?? nodeId] : []),
    ],
  };
}

function buildAsyncRunMessageCommand(env: Env, runId: string, nodeId: string, node: RunNode, prompt: string): {
  command: string;
  args: string[];
} {
  const stderrLog = node.logs?.stderr ?? join(runDirectory(env, runId), "nodes", nodeId, "latest.stderr.log");
  const child = quoteCommand(buildNodeInvocationCommand(env, runId, nodeId, node, prompt));
  const cli = headlessCli(env);
  const success = quoteCommand({ command: cli, args: ["run", "mark", runId, nodeId, "--status", "idle"] });
  const failure = quoteCommand({ command: cli, args: ["run", "mark", runId, nodeId, "--status", "failed"] });
  const unlock = quoteCommand({ command: "rm", args: ["-f", nodeLockPath(env, runId, nodeId)] });
  const quotedStderrLog = quotePath(stderrLog);
  const signalFailure = `${failure} >/dev/null 2>> ${quotedStderrLog}; ${unlock}; exit 143`;
  const script = [
    `trap "${signalFailure}" INT TERM HUP`,
    `trap "${unlock}" EXIT`,
    `${child} >/dev/null 2>> ${quotedStderrLog}`,
    "code=$?",
    `if [ "$code" -eq 0 ]; then ${success} >/dev/null 2>> ${quotedStderrLog}; else printf '%s\\n' "async child exited with code $code" >> ${quotedStderrLog}; ${failure} >/dev/null 2>> ${quotedStderrLog}; fi`,
    'exit "$code"',
  ].join("; ");
  return { command: "sh", args: ["-c", script] };
}

function headlessCli(env: Env): string {
  return env.HEADLESS_CLI_BIN ?? env.HEADLESS_BIN ?? "headless";
}

function parseDelayMs(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function quotePath(path: string): string {
  return quoteCommand({ command: path, args: [] });
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`invalid ${label}; use letters, numbers, dots, dashes, or underscores`);
  }
  return value;
}
