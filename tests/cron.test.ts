import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import {
  cronRoot,
  cronPidPath,
  listCronJobs,
  nextCronRun,
  parseCronSchedule,
  readCronJob,
  recordCronJob,
  runDueCronJobsOnce,
} from "../src/cron.ts";

function testEnv(dir: string): NodeJS.ProcessEnv {
  return {
    HOME: join(dir, "home"),
    HEADLESS_CRON_DIR: join(dir, "cron"),
    HEADLESS_CLI_BIN: join(dir, "fake-headless.js"),
    PATH: process.env.PATH,
  };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
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

function markDaemonRunning(env: NodeJS.ProcessEnv): void {
  mkdirSync(env.HEADLESS_CRON_DIR as string, { recursive: true });
  writeFileSync(cronPidPath(env), `${process.pid}\n`);
}

test("cron schedule parser accepts every durations and five-field cron expressions", () => {
  assert.deepEqual(parseCronSchedule({ every: "30m" }), {
    kind: "every",
    value: "30m",
    intervalMs: 1_800_000,
  });
  assert.deepEqual(parseCronSchedule({ every: "1d" }), {
    kind: "every",
    value: "1d",
    intervalMs: 86_400_000,
  });
  assert.equal(parseCronSchedule({ schedule: "0 */6 * * *" }).kind, "cron");
  assert.equal(
    nextCronRun(parseCronSchedule({ schedule: "0 0 15 * 1" }), new Date(2026, 4, 14, 23, 59)).getTime(),
    new Date(2026, 4, 15, 0, 0).getTime(),
  );
  assert.throws(() => parseCronSchedule({ every: "0m" }), /positive duration/);
  assert.throws(() => parseCronSchedule({ every: "30m", schedule: "* * * * *" }), /use either --every or --schedule/);
  assert.throws(() => parseCronSchedule({ schedule: "* * *" }), /five-field/);
});

test("cron store writes private job files and lists jobs by next run", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const previousUmask = process.umask(0);
  try {
    const env = testEnv(dir);
    const job = recordCronJob(env, {
      agent: "codex",
      command: { args: ["codex", "--prompt", "triage"], workDir: dir },
      id: "inbox-triage",
      schedule: parseCronSchedule({ every: "1h" }),
      now: new Date("2026-05-15T12:00:00.000Z"),
    });

    const root = cronRoot(env);
    assert.equal(modeOf(root), 0o700);
    assert.equal(modeOf(join(root, "jobs")), 0o700);
    assert.equal(modeOf(join(root, "jobs", "inbox-triage.json")), 0o600);
    assert.equal(readCronJob(env, "inbox-triage")?.nextRunAt, "2026-05-15T13:00:00.000Z");
    assert.equal(listCronJobs(env)[0]?.id, job.id);
  } finally {
    process.umask(previousUmask);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron add persists safe detached command options and rejects unsafe tmux/session flags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    markDaemonRunning(env);
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      [
        "cron",
        "add",
        "codex",
        "--name",
        "repo-summary",
        "--every",
        "30m",
        "--prompt",
        "Summarize repository changes",
        "--model",
        "gpt-5.5",
        "--reasoning-effort",
        "high",
        "--allow",
        "read-only",
        "--work-dir",
        dir,
        "--usage",
      ],
      {
        env,
        stdinIsTTY: true,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    assert.equal(code, 0, stderr);
    assert.match(stdout, /added: repo-summary/);
    assert.deepEqual(readCronJob(env, "repo-summary")?.command.args, [
      "codex",
      "--prompt",
      "Summarize repository changes",
      "--model",
      "gpt-5.5",
      "--reasoning-effort",
      "high",
      "--allow",
      "read-only",
      "--work-dir",
      dir,
      "--usage",
    ]);

    stderr = "";
    const badCode = await runCli(
      ["cron", "add", "codex", "--every", "1h", "--prompt", "x", "--tmux"],
      { env, stdinIsTTY: true, stderr: (text) => { stderr += text; } },
    );
    assert.equal(badCode, 2);
    assert.match(stderr, /--tmux cannot be scheduled/);

    stderr = "";
    assert.equal(
      await runCli(
        ["cron", "add", "codex", "--every", "1h", "--prompt", "x", "--docker-image", "headless-local:dev"],
        { env, stderr: (text) => { stderr += text; } },
      ),
      2,
    );
    assert.match(stderr, /require --docker/);

    stderr = "";
    assert.equal(
      await runCli(
        ["cron", "add", "codex", "--every", "1h", "--prompt", "x", "--json", "--usage"],
        { env, stderr: (text) => { stderr += text; } },
      ),
      2,
    );
    assert.match(stderr, /--usage cannot be used with --json/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron lifecycle commands list, view, pause, resume, and refuse active rm without force", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    markDaemonRunning(env);
    await runCli(["cron", "add", "codex", "--name", "docs", "--every", "1h", "--prompt-file", "prompt.md"], {
      env,
      stdinIsTTY: true,
      stdout: () => {},
    });

    let stdout = "";
    assert.equal(await runCli(["cron", "list"], { env, stdout: (text) => { stdout += text; } }), 0);
    assert.match(stdout, /docs\s+codex\s+every 1h\s+active/);

    stdout = "";
    assert.equal(await runCli(["cron", "view", "docs"], { env, stdout: (text) => { stdout += text; } }), 0);
    assert.match(stdout, /prompt file: prompt.md/);
    assert.match(stdout, /warning: prompt file not found/);

    assert.equal(await runCli(["cron", "pause", "docs"], { env, stdout: () => {} }), 0);
    assert.equal(readCronJob(env, "docs")?.status, "paused");
    assert.equal(await runCli(["cron", "resume", "docs"], { env, stdout: () => {} }), 0);
    assert.equal(readCronJob(env, "docs")?.status, "active");
    assert.equal(await runCli(["cron", "kill", "docs"], { env, stdout: () => {} }), 0);
    assert.equal(readCronJob(env, "docs")?.status, "disabled");
    assert.equal(await runCli(["cron", "resume", "docs"], { env, stdout: () => {} }), 0);

    const job = readCronJob(env, "docs");
    assert.ok(job);
    recordCronJob(env, { ...job, activeExecutionId: "exec-active" });

    let stderr = "";
    assert.equal(await runCli(["cron", "rm", "docs"], { env, stderr: (text) => { stderr += text; } }), 2);
    assert.match(stderr, /active execution/);
    assert.equal(await runCli(["cron", "rm", "docs", "--force"], { env, stdout: () => {} }), 0);
    assert.equal(readCronJob(env, "docs"), undefined);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron kill escalates stubborn active executions before returning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  try {
    assert.ok(child.pid);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const env = testEnv(dir);
    const now = new Date("2026-05-15T12:00:00.000Z");
    recordCronJob(env, {
      agent: "codex",
      command: { args: ["codex", "--prompt", "tick"], workDir: dir },
      id: "stubborn",
      schedule: parseCronSchedule({ every: "1h" }),
      now,
    });
    const job = readCronJob(env, "stubborn");
    assert.ok(job);
    recordCronJob(env, { ...job, activeExecutionId: "exec-stubborn" });

    const executionRoot = join(cronRoot(env), "jobs", "stubborn", "executions", "exec-stubborn");
    mkdirSync(executionRoot, { recursive: true });
    writeFileSync(
      join(executionRoot, "result.json"),
      JSON.stringify({
        version: 1,
        jobId: "stubborn",
        executionId: "exec-stubborn",
        status: "running",
        pid: child.pid,
        startedAt: now.toISOString(),
        exitCode: null,
        signal: null,
        stdoutLog: join(executionRoot, "stdout.log"),
        stderrLog: join(executionRoot, "stderr.log"),
      }),
    );

    let stdout = "";
    assert.equal(await runCli(["cron", "kill", "stubborn"], { env, stdout: (text) => { stdout += text; } }), 0);
    assert.match(stdout, /killed: stubborn/);
    await childClosed;
    assert.equal(processAlive(child.pid), false);

    const execution = readFileSync(join(executionRoot, "result.json"), "utf8");
    assert.match(execution, /"status": "killed"/);
    assert.match(execution, /"signal": "SIGKILL"/);
  } finally {
    if (child.pid && processAlive(child.pid)) {
      process.kill(child.pid, "SIGKILL");
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron start is idempotent when the daemon pid is alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    markDaemonRunning(env);

    let stdout = "";
    const code = await runCli(["cron", "start"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
    });
    assert.equal(code, 0);
    assert.match(stdout, /daemon already running/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron start fails when the daemon process cannot be spawned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    let stdout = "";
    let stderr = "";
    const code = await runCli(["cron", "start"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /cron daemon failed to start/);
    assert.equal(existsSync(cronPidPath(env)), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron add rolls back new jobs when the daemon cannot start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    let stderr = "";
    const code = await runCli(
      ["cron", "add", "codex", "--name", "missing-daemon", "--every", "1h", "--prompt", "x"],
      {
        env,
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    assert.equal(code, 2);
    assert.match(stderr, /cron daemon failed to start/);
    assert.equal(readCronJob(env, "missing-daemon"), undefined);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cron daemon tick starts due jobs and collapses overlapping ticks to one pending run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cron-test-"));
  try {
    const env = testEnv(dir);
    writeFileSync(
      env.HEADLESS_CLI_BIN as string,
      [
        "#!/usr/bin/env node",
        "setTimeout(() => {",
        "  console.log(JSON.stringify({type:'agent_message', text:'finished'}));",
        "}, 100);",
      ].join("\n"),
      { mode: 0o755 },
    );
    recordCronJob(env, {
      agent: "codex",
      command: { args: ["codex", "--prompt", "tick"], workDir: dir },
      id: "tick",
      schedule: parseCronSchedule({ every: "1s" }),
      now: new Date("2026-05-15T12:00:00.000Z"),
    });

    await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:02.000Z"));
    const running = readCronJob(env, "tick");
    assert.ok(running?.activeExecutionId);
    await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:03.000Z"));
    await runDueCronJobsOnce(env, new Date("2026-05-15T12:00:04.000Z"));
    assert.equal(readCronJob(env, "tick")?.pending, true);

    await waitFor(() => {
      const job = readCronJob(env, "tick");
      return Boolean(job?.activeExecutionId && job.activeExecutionId !== running.activeExecutionId);
    });
    await waitFor(() => readCronJob(env, "tick")?.activeExecutionId === null);

    const jobRoot = join(cronRoot(env), "jobs", "tick", "executions");
    const executions = existsSync(jobRoot) ? readFileSync(join(jobRoot, readCronJob(env, "tick")?.lastExecutionId ?? "", "result.json"), "utf8") : "";
    assert.match(executions, /"status": "succeeded"/);
    assert.equal(readCronJob(env, "tick")?.pending, false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
