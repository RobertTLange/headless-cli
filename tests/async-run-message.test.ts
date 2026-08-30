import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import {
  acquireNodeLock,
  nodeLockPath,
  readRun,
  registerNode,
  runDirectory,
  updateNodeStatus,
} from "../src/runs.ts";
import type { AsyncRunMessageResponse, AsyncRunMessageTask } from "../src/async-run-message.ts";
import type { Env } from "../src/types.ts";

interface AsyncMessageFixture {
  directory: string;
  env: Env;
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(assertion(), true);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createFixture(agentSource?: string, extraEnv: Env = {}): Promise<AsyncMessageFixture> {
  const directory = mkdtempSync(join(tmpdir(), "headless-async-message-test-"));
  const home = join(directory, "home");
  const binDirectory = join(directory, "bin");
  await mkdir(home);
  await writeExecutable(
    join(binDirectory, "headless"),
    [
      "#!/bin/sh",
      `exec "${process.execPath}" --import tsx "${join(process.cwd(), "src", "cli.ts")}" "$@"`,
      "",
    ].join("\n"),
  );
  if (agentSource) await writeExecutable(join(binDirectory, "codex"), agentSource);
  const env = {
    ...process.env,
    ...extraEnv,
    HEADLESS_CLI_BIN: join(binDirectory, "headless"),
    HOME: home,
    PATH: binDirectory,
  };
  registerNode(env, {
    runId: "auth",
    nodeId: "worker-1",
    role: "worker",
    agent: "codex",
    coordination: "oneshot",
    status: "idle",
    planned: true,
  });
  return { directory, env };
}

async function startAsyncMessage(env: Env): Promise<void> {
  assert.equal(
    await runCli(["run", "message", "auth", "worker-1", "--prompt", "continue", "--async"], {
      env,
      stdout: () => undefined,
    }),
    0,
  );
}

test("async run message preserves ownership while a signaled agent remains alive", { skip: process.platform === "win32" }, async () => {
  const processDirectory = mkdtempSync(join(tmpdir(), "headless-async-agent-test-"));
  const agentProcessFile = join(processDirectory, "agent-process.json");
  const signalFile = join(processDirectory, "agent-signal");
  const agentSource = [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.HEADLESS_AGENT_PROCESS, JSON.stringify({",
    "  pid: process.pid,",
    "  ppid: process.ppid,",
    "  ownerMarker: process.env.HEADLESS_ASYNC_MESSAGE_OWNER_PID ?? null,",
    "  workerMarker: process.env.HEADLESS_ASYNC_MESSAGE_WORKER ?? null,",
    "}));",
    "process.on('SIGTERM', () => fs.writeFileSync(process.env.HEADLESS_AGENT_SIGNAL, 'SIGTERM\\n'));",
    "setInterval(() => undefined, 1000);",
    "",
  ].join("\n");
  const { directory, env } = await createFixture(agentSource, {
    HEADLESS_AGENT_PROCESS: agentProcessFile,
    HEADLESS_AGENT_SIGNAL: signalFile,
  });
  let agentPid: number | undefined;
  let cliPid: number | undefined;
  try {
    await startAsyncMessage(env);
    await waitFor(() => existsSync(agentProcessFile));
    const agentProcess = JSON.parse(readFileSync(agentProcessFile, "utf8"));
    ({ pid: agentPid, ppid: cliPid } = agentProcess);
    assert.equal(agentProcess.ownerMarker, null);
    assert.equal(agentProcess.workerMarker, null);
    const lockPath = nodeLockPath(env, "auth", "worker-1");
    const ownerPath = `${lockPath}.owner`;
    await waitFor(() => JSON.parse(readFileSync(ownerPath, "utf8")).processTreeRootPid === cliPid);

    process.kill(cliPid!, "SIGTERM");
    await waitFor(() => existsSync(signalFile));
    await waitFor(() => readRun(env, "auth")?.nodes["worker-1"].status === "failed");
    assert.equal(processAlive(agentPid!), true);
    assert.throws(() => acquireNodeLock(env, "auth", "worker-1"), /node is locked: worker-1/);

    process.kill(agentPid!, "SIGKILL");
    await waitFor(() => !processAlive(agentPid!));
    agentPid = undefined;
    acquireNodeLock(env, "auth", "worker-1")();
  } finally {
    if (agentPid && processAlive(agentPid)) process.kill(agentPid, "SIGKILL");
    if (cliPid && processAlive(cliPid)) process.kill(cliPid, "SIGKILL");
    rmSync(directory, { force: true, recursive: true });
    rmSync(processDirectory, { force: true, recursive: true });
  }
});

test("async run message releases handed-off ownership after normal completion", async () => {
  const agentSource = [
    `#!${process.execPath}`,
    "if (process.env.HEADLESS_ASYNC_MESSAGE_OWNER_PID) process.exit(91);",
    "if (process.env.HEADLESS_ASYNC_MESSAGE_WORKER) process.exit(92);",
    "console.log(JSON.stringify({ type: 'agent_message', text: 'done' }));",
    "",
  ].join("\n");
  const { directory, env } = await createFixture(agentSource);
  try {
    await startAsyncMessage(env);
    await waitFor(() => readRun(env, "auth")?.nodes["worker-1"].status !== "busy");
    const node = readRun(env, "auth")?.nodes["worker-1"];
    assert.equal(node?.status, "idle", readFileSync(node?.logs?.stderr ?? "", "utf8"));
    const lockPath = nodeLockPath(env, "auth", "worker-1");
    await waitFor(() => !existsSync(lockPath) && !existsSync(`${lockPath}.owner`));
    acquireNodeLock(env, "auth", "worker-1")();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("async run message handles a missing agent without leaking its lock", async () => {
  const { directory, env } = await createFixture();
  try {
    await startAsyncMessage(env);
    await waitFor(() => readRun(env, "auth")?.nodes["worker-1"].status === "failed");
    const node = readRun(env, "auth")?.nodes["worker-1"];
    const stderr = readFileSync(node?.logs?.stderr ?? "", "utf8");
    assert.match(stderr, /spawn codex ENOENT/);
    assert.doesNotMatch(stderr, /Unhandled 'error' event|Emitted 'error' event/);
    const lockPath = nodeLockPath(env, "auth", "worker-1");
    await waitFor(() => !existsSync(lockPath) && !existsSync(`${lockPath}.owner`));
    acquireNodeLock(env, "auth", "worker-1")();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("async run message rolls back when its worker cannot spawn the CLI", async () => {
  const { directory, env } = await createFixture();
  env.HEADLESS_CLI_BIN = join(directory, "missing-headless");
  try {
    assert.equal(
      await runCli(["run", "message", "auth", "worker-1", "--prompt", "continue", "--async"], {
        env,
        stderr: () => undefined,
        stdout: () => undefined,
      }),
      2,
    );
    const node = readRun(env, "auth")?.nodes["worker-1"];
    assert.equal(node?.status, "failed");
    assert.match(node?.lastMessage ?? "", /exited before agent startup/);
    const lockPath = nodeLockPath(env, "auth", "worker-1");
    await waitFor(() => !existsSync(lockPath) && !existsSync(`${lockPath}.owner`));
    acquireNodeLock(env, "auth", "worker-1")();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("async run message rolls back busy status when startup logging fails", async () => {
  const { directory, env } = await createFixture();
  try {
    const stdoutLog = readRun(env, "auth")?.nodes["worker-1"].logs?.stdout;
    assert.ok(stdoutLog);
    await mkdir(stdoutLog, { recursive: true });
    const stderr: string[] = [];

    assert.equal(
      await runCli(["run", "message", "auth", "worker-1", "--prompt", "continue", "--async"], {
        env,
        stderr: (text) => stderr.push(text),
        stdout: () => undefined,
      }),
      2,
    );
    const node = readRun(env, "auth")?.nodes["worker-1"];
    assert.equal(node?.status, "failed");
    assert.match(node?.lastMessage ?? "", /EISDIR/);
    assert.match(stderr.join(""), /EISDIR/);
    const lockPath = nodeLockPath(env, "auth", "worker-1");
    await waitFor(() => !existsSync(lockPath) && !existsSync(`${lockPath}.owner`));
    acquireNodeLock(env, "auth", "worker-1")();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("async run message preserves failed status after a partial state write", async () => {
  const { directory, env } = await createFixture();
  try {
    const eventsPath = join(runDirectory(env, "auth"), "events.jsonl");
    rmSync(eventsPath, { force: true });
    await mkdir(eventsPath);
    const stderr: string[] = [];

    assert.equal(
      await runCli(["run", "message", "auth", "worker-1", "--prompt", "continue", "--async"], {
        env,
        stderr: (text) => stderr.push(text),
        stdout: () => undefined,
      }),
      2,
    );
    const node = readRun(env, "auth")?.nodes["worker-1"];
    assert.equal(node?.status, "failed");
    assert.match(node?.lastMessage ?? "", /EISDIR/);
    assert.match(stderr.join(""), /EISDIR/);
    const lockPath = nodeLockPath(env, "auth", "worker-1");
    await waitFor(() => !existsSync(lockPath) && !existsSync(`${lockPath}.owner`));
    acquireNodeLock(env, "auth", "worker-1")();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("prepared async worker repairs busy status when its parent disconnects", async () => {
  const { directory, env } = await createFixture();
  const worker = fork(join(process.cwd(), "src", "async-run-message.ts"), [], {
    env: env as NodeJS.ProcessEnv,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const task: AsyncRunMessageTask = {
      command: { command: process.execPath, args: ["--eval", "process.exit(0)"] },
      runId: "auth",
      nodeId: "worker-1",
    };
    const ready = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.on("message", (message: AsyncRunMessageResponse) => {
        if (message.type === "error") reject(new Error(message.message));
        else if (message.type === "ready") resolve();
      });
    });
    worker.send({ type: "task", task });
    await ready;
    updateNodeStatus(env, "auth", "worker-1", "busy");

    worker.disconnect();
    await once(worker, "exit");

    const node = readRun(env, "auth")?.nodes["worker-1"];
    assert.equal(node?.status, "failed");
    assert.match(node?.lastMessage ?? "", /disconnected before agent startup/);
    const lockPath = nodeLockPath(env, "auth", "worker-1");
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(`${lockPath}.owner`), false);
  } finally {
    if (worker.connected) worker.disconnect();
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    rmSync(directory, { force: true, recursive: true });
  }
});

test("prepared async worker leaves cancellation status repair to its parent", async () => {
  const { directory, env } = await createFixture();
  const worker = fork(join(process.cwd(), "src", "async-run-message.ts"), [], {
    env: env as NodeJS.ProcessEnv,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const task: AsyncRunMessageTask = {
      command: { command: process.execPath, args: ["--eval", "process.exit(0)"] },
      runId: "auth",
      nodeId: "worker-1",
    };
    const ready = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.on("message", (message: AsyncRunMessageResponse) => {
        if (message.type === "error") reject(new Error(message.message));
        else if (message.type === "ready") resolve();
      });
    });
    worker.send({ type: "task", task });
    await ready;
    updateNodeStatus(env, "auth", "worker-1", "busy");

    worker.send({ type: "cancel" });
    await once(worker, "exit");

    const run = readRun(env, "auth");
    assert.equal(run?.nodes["worker-1"].status, "busy");
    assert.equal(run?.events.filter((event) => event.type === "node_failed").length, 0);
    const lockPath = nodeLockPath(env, "auth", "worker-1");
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(`${lockPath}.owner`), false);
  } finally {
    if (worker.connected) worker.disconnect();
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    rmSync(directory, { force: true, recursive: true });
  }
});
