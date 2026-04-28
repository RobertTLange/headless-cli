import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { acquireNodeLock, readRun, registerNode } from "../src/runs.ts";
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

    const release = acquireNodeLock(env, "auth", "worker-1");
    assert.throws(() => acquireNodeLock(env, "auth", "worker-1"), /node is locked/);
    release();
    acquireNodeLock(env, "auth", "worker-1")();
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
  assert.match(stdout.join(""), /codex --sandbox read-only --ask-for-approval never exec/);

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
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'orchestrator final' }));",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const env = {
      ...process.env,
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
      { env, stdout: (text) => stdout.push(text) },
    );

    assert.equal(code, 0);
    assert.equal(stdout.join(""), "orchestrator final\n");
    const run = readRun(env, "auth");
    assert.equal(run?.nodes.orchestrator.status, "idle");
    assert.equal(run?.nodes["worker-1"].status, "planned");
    assert.equal(run?.nodes["worker-2"].status, "planned");
    assert.equal(run?.nodes.reviewer.role, "reviewer");
    const prompt = readFileSync(stdinCapture, "utf8");
    assert.match(prompt, /Role: orchestrator/);
    assert.match(prompt, /Coordination commands:/);
    assert.match(prompt, /Run headless --help for full command syntax/);
    assert.match(prompt, /status becomes busy, logs are written/);
    assert.match(prompt, /headless run wait auth/);
    assert.match(prompt, /declared team:/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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

    const stdout: string[] = [];
    assert.equal(await runCli(["run", "list"], { env, stdout: (text) => stdout.push(text) }), 0);
    assert.match(stdout.join(""), /auth\s+session\s+2 nodes/);

    stdout.length = 0;
    assert.equal(await runCli(["run", "view", "auth"], { env, stdout: (text) => stdout.push(text) }), 0);
    assert.match(stdout.join(""), /Graph/);
    assert.match(stdout.join(""), /worker-1 \[planned\] depends: orchestrator/);

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
        "  const runId = args[2]; const nodeId = args[3]; const status = args[5];",
        "  const file = path.join(process.env.HOME, '.headless', 'runs', runId, 'run.json');",
        "  const run = JSON.parse(fs.readFileSync(file, 'utf8'));",
        "  run.nodes[nodeId].status = status; run.nodes[nodeId].updatedAt = new Date().toISOString();",
        "  fs.writeFileSync(file, JSON.stringify(run, null, 2) + '\\n');",
        "  process.exit(0);",
        "}",
        "console.log('async child output');",
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
