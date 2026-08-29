import { execFileSync, spawn, type ChildProcess } from "node:child_process";

import { windowsTaskkillPath } from "./process-tree.js";
import {
  handoffNodeStoreLockOwner,
  nodeStoreLockHasLiveSuccessor,
  removeRunStoreLockSignalListeners,
} from "./run-storage.js";
import {
  acquireNodeLock,
  appendNodeLog,
  nodeLockPath,
  updateNodeStatus,
} from "./runs.js";
import type { Env } from "./types.js";

export interface AsyncRunMessageTask {
  command: { command: string; args: string[] };
  cwd?: string;
  runId: string;
  nodeId: string;
}

export type AsyncRunMessageRequest =
  | { type: "task"; task: AsyncRunMessageTask }
  | { type: "start" }
  | { type: "cancel" };

export type AsyncRunMessageResponse =
  | { type: "ready" }
  | { type: "error"; message: string };

let task: AsyncRunMessageTask | undefined;
let releaseLock: (() => void) | undefined;
let activeChild: ChildProcess | undefined;
let started = false;
let finished = false;

if (process.send) {
  process.on("message", (message: AsyncRunMessageRequest) => {
    void handleRequest(message);
  });
  process.once("disconnect", () => {
    if (!started) finish();
  });
  for (const signal of forwardedSignals()) {
    process.on(signal, () => terminateActiveChild(signal));
  }
}

async function handleRequest(request: AsyncRunMessageRequest): Promise<void> {
  if (request.type === "task") {
    await prepare(request.task);
    return;
  }
  if (request.type === "cancel") {
    if (started) {
      terminateActiveChild("SIGTERM");
    } else {
      finish();
    }
    return;
  }
  if (request.type === "start" && task && releaseLock && !started) {
    started = true;
    await execute(task);
  }
}

function terminateActiveChild(signal: NodeJS.Signals): void {
  if (!activeChild) return;
  if (process.platform === "win32" && activeChild.pid) {
    try {
      execFileSync(windowsTaskkillPath(), ["/pid", String(activeChild.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 3_000,
        windowsHide: true,
      });
      return;
    } catch {
      return;
    }
  }
  activeChild.kill(signal);
}

async function prepare(nextTask: AsyncRunMessageTask): Promise<void> {
  if (task || finished) return;
  try {
    releaseLock = acquireNodeLock(process.env as Env, nextTask.runId, nextTask.nodeId, {
      processTreeRootPid: process.pid,
    });
    removeRunStoreLockSignalListeners();
    task = nextTask;
    send({ type: "ready" });
  } catch (error) {
    send({ type: "error", message: errorMessage(error) });
    finish(2);
  }
}

async function execute(currentTask: AsyncRunMessageTask): Promise<void> {
  let code = 1;
  try {
    code = await runChild(currentTask);
    if (code !== 0) {
      appendNodeLog(
        process.env as Env,
        currentTask.runId,
        currentTask.nodeId,
        "stderr",
        `async child exited with code ${code}\n`,
      );
    }
    updateNodeStatus(
      process.env as Env,
      currentTask.runId,
      currentTask.nodeId,
      code === 0 ? "idle" : "failed",
    );
  } catch (error) {
    const message = errorMessage(error);
    appendNodeLog(process.env as Env, currentTask.runId, currentTask.nodeId, "stderr", `${message}\n`);
    updateNodeStatus(process.env as Env, currentTask.runId, currentTask.nodeId, "failed", message);
  } finally {
    finish(code);
  }
}

function runChild(currentTask: AsyncRunMessageTask): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(currentTask.command.command, currentTask.command.args, {
      cwd: currentTask.cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        HEADLESS_ASYNC_MESSAGE_OWNER_PID: String(process.pid),
        HEADLESS_ASYNC_MESSAGE_WORKER: "1",
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    activeChild = child;
    child.once("error", reject);
    child.once("spawn", () => {
      try {
        if (!child.pid) throw new Error("async message CLI started without a process ID");
        handoffNodeStoreLockOwner(
          nodeLockPath(process.env as Env, currentTask.runId, currentTask.nodeId),
          process.pid,
          { processTreeRootPid: child.pid },
        );
      } catch (error) {
        terminateActiveChild("SIGKILL");
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      activeChild = undefined;
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

function finish(code = 0): void {
  if (finished) return;
  finished = true;
  try {
    if (!task || !nodeStoreLockHasLiveSuccessor(
      nodeLockPath(process.env as Env, task.runId, task.nodeId),
      process.pid,
    )) {
      releaseLock?.();
    }
  } finally {
    releaseLock = undefined;
    if (process.connected) process.disconnect();
    process.exitCode = code;
  }
}

function send(response: AsyncRunMessageResponse): void {
  if (process.send) process.send(response);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function forwardedSignals(): NodeJS.Signals[] {
  return process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];
}
