import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { acquireNodeLock, readRun, registerNode, updateNodeStatus } from "../src/runs.ts";
import { expandTeamSpecs, parseTeamSpec } from "../src/teams.ts";

async function writeExecutable(path: string, source: string): Promise<void> {
  await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source);
    await chmod(path, 0o755);
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(assertion(), true);
}

async function runStatusUpdater(env: NodeJS.ProcessEnv, runId: string, nodeId: string, barrierFile: string): Promise<number> {
  return await new Promise((resolve) => {
    const source = [
      "import { existsSync } from 'node:fs';",
      "import { updateNodeStatus } from './src/runs.ts';",
      "while (!existsSync(process.env.HEADLESS_BARRIER_FILE)) {",
      "  await new Promise((resolve) => setTimeout(resolve, 5));",
      "}",
      "updateNodeStatus(process.env, process.env.HEADLESS_TEST_RUN_ID, process.env.HEADLESS_TEST_NODE_ID, 'idle');",
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: process.cwd(),
      env: {
        ...env,
        HEADLESS_BARRIER_FILE: barrierFile,
        HEADLESS_TEST_NODE_ID: nodeId,
        HEADLESS_TEST_RUN_ID: runId,
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

test("parses team specs and generated node names", () => {
  assert.deepEqual(parseTeamSpec("worker=2"), { agent: undefined, role: "worker", count: 2 });
  assert.deepEqual(parseTeamSpec("claude/reviewer"), { agent: "claude", role: "reviewer", count: 1 });
  assert.deepEqual(
    expandTeamSpecs("codex", ["worker=2", "claude/reviewer", "codex/reviewer"]),
    [
      { agent: "codex", role: "worker", nodeId: "worker-1", planned: true },
      { agent: "codex", role: "worker", nodeId: "worker-2", planned: true },
      { agent: "claude", role: "reviewer", nodeId: "reviewer-claude", planned: true },
      { agent: "codex", role: "reviewer", nodeId: "reviewer-codex", planned: true },
    ],
  );
  assert.throws(() => parseTeamSpec("worker=0"), /team count must be positive/);
  assert.throws(() => parseTeamSpec("unknown/worker"), /unsupported team agent/);
});

test("run store registers nodes, records dependencies, and rejects concurrent locks", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const env = { HOME: join(dir, "home") };
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "session",
      status: "planned",
      dependsOn: ["explorer"],
      planned: true,
      sessionAlias: "worker-1",
    });
    const run = readRun(env, "auth");
    assert.equal(run?.nodes["worker-1"].dependsOn[0], "explorer");
    assert.equal(run?.nodes["worker-1"].logs?.stdout.endsWith("latest.stdout.log"), true);
    assert.equal(existsSync(join(env.HOME, ".headless", "runs", "auth", "run.json")), true);
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "session",
      status: "busy",
      planned: true,
    });
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "session",
      status: "starting",
      planned: true,
    });
    assert.equal(readRun(env, "auth")?.nodes["worker-1"].status, "busy");

    const release = acquireNodeLock(env, "auth", "worker-1");
    assert.throws(() => acquireNodeLock(env, "auth", "worker-1"), /node is locked/);
    release();
    acquireNodeLock(env, "auth", "worker-1")();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run store preserves concurrent status updates from async children", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const env = { ...process.env, HOME: join(dir, "home") };
    const runId = "race";
    const nodeCount = 32;
    const barrierFile = join(dir, "release-workers");
    for (let index = 0; index < nodeCount; index += 1) {
      registerNode(env, {
        runId,
        nodeId: `worker-${index}`,
        role: "worker",
        agent: "codex",
        coordination: "oneshot",
        status: "busy",
        planned: true,
      });
    }

    const updaters = Array.from({ length: nodeCount }, (_, index) =>
      runStatusUpdater(env, runId, `worker-${index}`, barrierFile),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(barrierFile, "go\n");

    assert.deepEqual(await Promise.all(updaters), Array(nodeCount).fill(0));
    const run = readRun(env, runId);
    const idle = Object.values(run?.nodes ?? {}).filter((node) => node.status === "idle").length;
    assert.equal(idle, nodeCount);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("role defaults apply only when --allow is absent", async () => {
  const stdout: string[] = [];
  assert.equal(
    await runCli(["codex", "--role", "explorer", "--prompt", "hello", "--print-command"], {
      stdout: (text) => stdout.push(text),
    }),
    0,
  );
  assert.match(stdout.join(""), /codex --sandbox read-only --ask-for-approval never --search exec/);

  stdout.length = 0;
  assert.equal(
    await runCli(["codex", "--role", "explorer", "--allow", "yolo", "--prompt", "hello", "--print-command"], {
      stdout: (text) => stdout.push(text),
    }),
    0,
  );
  assert.match(stdout.join(""), /codex --dangerously-bypass-approvals-and-sandbox exec/);

  stdout.length = 0;
  assert.equal(
    await runCli(["codex", "--role", "worker", "--prompt", "hello", "--print-command"], {
      stdout: (text) => stdout.push(text),
    }),
    0,
  );
  assert.match(stdout.join(""), /codex --dangerously-bypass-approvals-and-sandbox exec/);
});

test("orchestrator run registers declared team and injects run context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const stdinCapture = join(dir, "stdin.txt");
    mkdirSync(home);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.HEADLESS_STDIN_CAPTURE, fs.readFileSync(0, 'utf8'));",
        "const runFile = process.env.HOME + '/.headless/runs/auth/run.json';",
        "const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));",
        "run.nodes['worker-1'].status = 'idle';",
        "run.nodes.reviewer.status = 'idle';",
        "fs.writeFileSync(runFile, JSON.stringify(run, null, 2) + '\\n');",
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));",
        "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100, reasoning_output_tokens: 25 } }));",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'orchestrator final' }));",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const stderr: string[] = [];
    const env = {
      ...process.env,
      HEADLESS_RUN_STATUS_INTERVAL_MS: "1",
      HEADLESS_STDIN_CAPTURE: stdinCapture,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const code = await runCli(
      [
        "codex",
        "--role",
        "orchestrator",
        "--run",
        "auth",
        "--node",
        "orchestrator",
        "--team",
        "worker=2",
        "--team",
        "claude/reviewer",
        "--prompt",
        "Build auth",
      ],
      { env, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    );

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "orchestrator final\n");
    assert.match(stderr.join(""), /^\d{2}:\d{2}:\d{2} INFO  auth started orchestrator \(4 nodes,/m);
    assert.match(stderr.join(""), /^\d{2}:\d{2}:\d{2} INFO  auth orchestrator starting -> busy/m);
    assert.match(stderr.join(""), /^\d{2}:\d{2}:\d{2} OK    auth idle \(0 active;/m);
    const run = readRun(env, "auth");
    assert.equal(run?.nodes.orchestrator.status, "done");
    assert.deepEqual(
      run?.events.filter((event) => event.nodeId === "orchestrator" && event.type === "status_changed").map((event) => event.status),
      ["busy"],
    );
    assert.equal(run?.nodes.orchestrator.metrics?.totalTokens, 1100);
    assert.equal(run?.nodes.orchestrator.metrics?.outputTokens, 100);
    assert.equal(run?.nodes["worker-1"].status, "done");
    assert.equal(run?.nodes["worker-2"].status, "planned");
    assert.equal(run?.nodes.reviewer.status, "done");
    assert.equal(run?.nodes.reviewer.role, "reviewer");
    const orchestratorLog = readFileSync(run?.nodes.orchestrator.logs?.stdout ?? "", "utf8");
    assert.match(orchestratorLog, /node invocation/);
    assert.match(orchestratorLog, /orchestrator final/);
    const prompt = readFileSync(stdinCapture, "utf8");
    assert.match(prompt, /Role: orchestrator/);
    assert.match(prompt, /launch each planned child/);
    assert.match(prompt, /Coordination commands:/);
    assert.match(prompt, /Run headless --help for full command syntax/);
    assert.match(prompt, /status becomes busy, logs are written/);
    assert.match(prompt, /headless run wait auth/);
    assert.match(prompt, /declared team:/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("orchestrator run status reporter stays off for json runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    mkdirSync(home);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'orchestrator final' }));",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HEADLESS_RUN_STATUS_INTERVAL_MS: "1",
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const stderr: string[] = [];
    const stdout: string[] = [];

    const code = await runCli(
      ["codex", "--role", "orchestrator", "--run", "json-run", "--coordination", "oneshot", "--prompt", "Build auth", "--json"],
      {
        env,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
    );
    assert.equal(code, 0, stderr.join(""));
    assert.doesNotMatch(stderr.join(""), /headless run json-run/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("orchestrator run rejects read-only mode because it must update run state", async () => {
  const stderr: string[] = [];
  const code = await runCli(
    ["codex", "--role", "orchestrator", "--run", "auth", "--allow", "read-only", "--prompt", "hello"],
    { stderr: (text) => stderr.push(text) },
  );

  assert.equal(code, 2);
  assert.match(stderr.join(""), /orchestrator with --run cannot use --allow read-only/);
});

test("run list, view, mark, and wait operate on local run state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const env = { ...process.env, HOME: join(dir, "home"), HEADLESS_RUN_WAIT_INTERVAL_MS: "1" };
    registerNode(env, {
      runId: "auth",
      nodeId: "orchestrator",
      role: "orchestrator",
      agent: "codex",
      coordination: "session",
      status: "idle",
      planned: true,
    });
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "session",
      status: "planned",
      dependsOn: ["orchestrator"],
      planned: true,
    });
    updateNodeStatus(env, "auth", "orchestrator", "idle", "ready", {
      turns: 3,
      durationMs: 123456,
      apiDurationMs: 100000,
      totalCostUsd: 0.42,
      inputTokens: 600,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 25,
      totalTokens: 1100,
    });

    const stdout: string[] = [];
    assert.equal(await runCli(["run", "list"], { env, stdout: (text) => stdout.push(text) }), 0);
    assert.match(stdout.join(""), /^\+[-+]+\+$/m);
    assert.match(stdout.join(""), /^\| auth\s+\| session\s+\| 2 nodes\s+\| 0 active\s+\| 1 idle, 1 planned\s+\|/m);
    assert.match(stdout.join(""), /UPDATED/);
    assert.match(stdout.join(""), /AGE/);

    stdout.length = 0;
    assert.equal(await runCli(["run", "view", "auth"], { env, stdout: (text) => stdout.push(text) }), 0);
    const view = stdout.join("");
    assert.match(view, /Summary/);
    assert.match(view, /^\| Status\s+\| 1 idle, 1 planned\s+\|$/m);
    assert.match(view, /^\| Created\s+\| .* \|$/m);
    assert.match(view, /Graph/);
    assert.match(view, /orchestrator \[idle .* ago\] last: ready/);
    assert.match(view, /worker-1 \[planned .* ago\] depends: orchestrator/);
    assert.match(view, /Node details/);
    assert.match(view, /^\| NODE\s+\| ROLE\s+\| AGENT\s+\| STATUS\s+\| UPDATED\s+\| AGE\s+\| LAST\s+\|$/m);
    assert.doesNotMatch(view, /TURNS|DURATION|COST|TOKENS/);
    assert.match(view, /^\| orchestrator\s+\| orchestrator\s+\| codex\s+\| idle\s+\| .* \| .* \| ready\s+\|$/m);
    assert.match(view, /^\| worker-1\s+\| worker\s+\| codex\s+\| planned\s+\| .* \| .* \| -\s+\|$/m);

    stdout.length = 0;
    assert.equal(
      await runCli(["run", "mark", "auth", "worker-1", "--status", "done"], {
        env,
        stdout: (text) => stdout.push(text),
      }),
      0,
    );
    assert.equal(readRun(env, "auth")?.nodes["worker-1"].status, "done");

    stdout.length = 0;
    assert.equal(await runCli(["run", "wait", "auth"], { env, stdout: (text) => stdout.push(text) }), 0);
    assert.equal(stdout.join(""), "run idle: auth\n");

    registerNode(env, {
      runId: "self-wait",
      nodeId: "orchestrator",
      role: "orchestrator",
      agent: "codex",
      coordination: "session",
      status: "starting",
      planned: true,
    });
    stdout.length = 0;
    assert.equal(
      await runCli(["run", "wait", "self-wait"], {
        env: { ...env, HEADLESS_RUN_NODE: "orchestrator" },
        stdout: (text) => stdout.push(text),
      }),
      0,
    );
    assert.equal(stdout.join(""), "run idle: self-wait\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run message resumes stored session nodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "codex-args.jsonl");
    mkdirSync(home);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify(args) + '\\n');",
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));",
        "console.log(JSON.stringify({ type: 'agent_message', text: args.includes('resume') ? 'resumed final' : 'started final' }));",
        "",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      HEADLESS_CAPTURE: captureFile,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    assert.equal(
      await runCli(
        ["codex", "--role", "worker", "--run", "auth", "--node", "worker-1", "--coordination", "session", "--prompt", "start"],
        { env, stdout: () => undefined },
      ),
      0,
    );

    const stdout: string[] = [];
    assert.equal(
      await runCli(["run", "message", "auth", "worker-1", "--prompt", "continue"], {
        env,
        stdout: (text) => stdout.push(text),
      }),
      0,
    );
    assert.equal(stdout.join(""), "resumed final\n");
    const run = readRun(env, "auth");
    const workerLog = readFileSync(run?.nodes["worker-1"].logs?.stdout ?? "", "utf8");
    assert.match(workerLog, /started final/);
    assert.match(workerLog, /resumed final/);
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls[1].includes("resume"), true);
    assert.equal(calls[1].includes("thread-1"), true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run message routes tmux nodes through tmux buffers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
    await writeExecutable(
      join(binDir, "tmux"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');",
        "",
      ].join("\n"),
    );
    const env = { ...process.env, HEADLESS_TMUX_CAPTURE: captureFile, HOME: join(dir, "home"), PATH: `${binDir}:${process.env.PATH ?? ""}` };
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "tmux",
      status: "busy",
      planned: true,
      tmuxSessionName: "headless-codex-worker-1",
    });

    assert.equal(
      await runCli(["run", "message", "auth", "worker-1", "--prompt", "continue"], {
        env,
        stdout: () => undefined,
      }),
      0,
    );
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ["set-buffer", "-b", "headless-codex-worker-1-send", "continue"]);
    const run = readRun(env, "auth");
    assert.equal(run?.events.filter((event) => event.type === "message_sent").length, 1);
    assert.equal(run?.events.find((event) => event.type === "message_sent")?.targetNodeId, "worker-1");
    assert.equal(run?.nodes["worker-1"].lastMessage, "continue");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("tmux run launch failure marks the node failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    mkdirSync(home);
    await writeExecutable(
      join(binDir, "tmux"),
      [
        "#!/usr/bin/env node",
        "process.stderr.write('tmux launch failed\\n');",
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    const env = { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const stderr: string[] = [];

    const code = await runCli(
      ["codex", "--tmux", "--role", "worker", "--run", "auth", "--node", "worker-1", "--prompt", "hello"],
      { env, stdout: () => undefined, stderr: (text) => stderr.push(text) },
    );

    assert.equal(code, 1);
    assert.match(stderr.join(""), /tmux launch failed/);
    assert.equal(readRun(env, "auth")?.nodes["worker-1"].status, "failed");
    assert.match(readRun(env, "auth")?.nodes["worker-1"].lastMessage ?? "", /tmux command exited with code 1/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run message --print-command does not execute or mutate session nodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "codex-args.jsonl");
    mkdirSync(home);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'executed' }));",
        "",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      HEADLESS_CAPTURE: captureFile,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "session",
      status: "idle",
      lastMessage: undefined,
      planned: true,
      sessionAlias: "worker-1",
    });
    const before = readRun(env, "auth")?.nodes["worker-1"];

    const stdout: string[] = [];
    assert.equal(
      await runCli(["run", "message", "auth", "worker-1", "--prompt", "continue", "--print-command"], {
        env,
        stdout: (text) => stdout.push(text),
      }),
      0,
    );

    assert.match(stdout.join(""), /^headless codex --role worker --coordination session --run auth --node worker-1 --prompt continue/);
    const after = readRun(env, "auth")?.nodes["worker-1"];
    assert.equal(after?.status, before?.status);
    assert.equal(after?.lastMessage, before?.lastMessage);
    assert.equal(existsSync(captureFile), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run message --async records busy status, logs output, and marks completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const fakeHeadless = join(binDir, "headless");
    const captureFile = join(dir, "headless-args.jsonl");
    mkdirSync(home);
    await writeExecutable(
      fakeHeadless,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify(args) + '\\n');",
        "if (args[0] === 'run' && args[1] === 'mark') {",
        "  console.log('marked fake');",
        "  const runId = args[2]; const nodeId = args[3]; const status = args[5];",
        "  const file = path.join(process.env.HOME, '.headless', 'runs', runId, 'run.json');",
        "  const run = JSON.parse(fs.readFileSync(file, 'utf8'));",
        "  run.nodes[nodeId].status = status; run.nodes[nodeId].updatedAt = new Date().toISOString();",
        "  fs.writeFileSync(file, JSON.stringify(run, null, 2) + '\\n');",
        "  process.exit(0);",
        "}",
        "const runIndex = args.indexOf('--run'); const nodeIndex = args.indexOf('--node');",
        "if (runIndex !== -1 && nodeIndex !== -1) {",
        "  const runId = args[runIndex + 1]; const nodeId = args[nodeIndex + 1];",
        "  const dir = path.join(process.env.HOME, '.headless', 'runs', runId, 'nodes', nodeId);",
        "  fs.mkdirSync(dir, { recursive: true });",
        "  fs.appendFileSync(path.join(dir, 'latest.stdout.log'), 'async child output\\n');",
        "}",
        "console.log('async child output should not be wrapper-redirected');",
        "",
      ].join("\n"),
    );
    const env = { ...process.env, HEADLESS_CAPTURE: captureFile, HEADLESS_CLI_BIN: fakeHeadless, HOME: home };
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "pi",
      coordination: "oneshot",
      status: "idle",
      planned: true,
    });
    const initialStdoutLog = readRun(env, "auth")?.nodes["worker-1"].logs?.stdout ?? "";
    writeFileSync(initialStdoutLog, "previous output\\n");

    assert.equal(
      await runCli(["run", "message", "auth", "worker-1", "--prompt", "continue", "--async"], {
        env,
        stdout: () => undefined,
      }),
      0,
    );
    assert.equal(readRun(env, "auth")?.nodes["worker-1"].status, "busy");
    await waitFor(() => readRun(env, "auth")?.nodes["worker-1"].status === "idle");
    const stdoutLog = readRun(env, "auth")?.nodes["worker-1"].logs?.stdout ?? "";
    await waitFor(() => existsSync(stdoutLog) && readFileSync(stdoutLog, "utf8").includes("async child output"));
    const stdoutText = readFileSync(stdoutLog, "utf8");
    assert.match(stdoutText, /previous output/);
    assert.doesNotMatch(stdoutText, /marked fake/);
    assert.doesNotMatch(stdoutText, /wrapper-redirected/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run message --async uses HEADLESS_BIN for detached child invocations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const fakeHeadless = join(binDir, "headless-under-test");
    const captureFile = join(dir, "headless-args.jsonl");
    mkdirSync(home);
    await writeExecutable(
      fakeHeadless,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(process.env.HEADLESS_CAPTURE, JSON.stringify(args) + '\\n');",
        "if (args[0] === 'run' && args[1] === 'mark') {",
        "  const runId = args[2]; const nodeId = args[3]; const status = args[5];",
        "  const file = path.join(process.env.HOME, '.headless', 'runs', runId, 'run.json');",
        "  const run = JSON.parse(fs.readFileSync(file, 'utf8'));",
        "  run.nodes[nodeId].status = status; run.nodes[nodeId].updatedAt = new Date().toISOString();",
        "  fs.writeFileSync(file, JSON.stringify(run, null, 2) + '\\n');",
        "}",
        "",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      HEADLESS_BIN: fakeHeadless,
      HEADLESS_CAPTURE: captureFile,
      HEADLESS_CLI_BIN: undefined,
      HOME: home,
      PATH: `${dirname(process.execPath)}:/bin:/usr/bin`,
    };
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "pi",
      coordination: "oneshot",
      status: "idle",
      planned: true,
    });

    assert.equal(
      await runCli(["run", "message", "auth", "worker-1", "--prompt", "continue", "--async"], {
        env,
        stdout: () => undefined,
      }),
      0,
    );
    await waitFor(() => readRun(env, "auth")?.nodes["worker-1"].status === "idle");
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0].slice(0, 7), ["pi", "--role", "worker", "--coordination", "oneshot", "--run", "auth"]);
    assert.deepEqual(calls.at(-1), ["run", "mark", "auth", "worker-1", "--status", "idle"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run message --async print-command uses a non-login shell to preserve PATH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const env = { ...process.env, HOME: join(dir, "home") };
    const stdout: string[] = [];
    registerNode(env, {
      runId: "auth",
      nodeId: "explorer-1",
      role: "explorer",
      agent: "claude",
      coordination: "session",
      status: "idle",
      planned: true,
      sessionAlias: "explorer-1",
    });

    assert.equal(
      await runCli(["run", "message", "auth", "explorer-1", "--prompt", "continue", "--async", "--print-command"], {
        env,
        stdout: (text) => stdout.push(text),
      }),
      0,
    );
    const output = stdout.join("");
    assert.match(output, /^sh -c /);
    assert.doesNotMatch(output, /^sh -lc /);
    assert.equal(readRun(env, "auth")?.nodes["explorer-1"].status, "idle");
    assert.equal(readRun(env, "auth")?.nodes["explorer-1"].lastMessage, undefined);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Docker run coordination mounts the host run directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-test-"));
  try {
    const env = { ...process.env, HOME: join(dir, "home") };
    const stdout: string[] = [];
    assert.equal(
      await runCli(
        [
          "codex",
          "--role",
          "orchestrator",
          "--run",
          "auth",
          "--node",
          "orchestrator",
          "--prompt",
          "hello",
          "--docker",
          "--print-command",
        ],
        { env, stdout: (text) => stdout.push(text) },
      ),
      0,
    );
    assert.match(stdout.join(""), /--volume .*\/\.headless\/runs\/auth:\/headless-runs\/auth/);
    assert.match(stdout.join(""), /--env HEADLESS_RUN_DIR=\/headless-runs\/auth/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
