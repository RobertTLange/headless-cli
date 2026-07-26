import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { cronRoot, recordCronJob } from "../src/cron.ts";
import { registerNode } from "../src/runs.ts";

interface SdkEnvelope {
  command: string;
  data?: Record<string, unknown>;
  error?: { message: string };
}

function parseEnvelope(output: string): SdkEnvelope {
  return JSON.parse(output) as SdkEnvelope;
}

async function writeExecutable(path: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf8");
  chmodSync(path, 0o755);
}

test("SDK run list and view return persisted run records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-run-test-"));
  try {
    const env = { ...process.env, HOME: join(dir, "home") };
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "session",
      status: "idle",
      planned: true,
      workDir: "/private/repository",
    });

    const listStdout: string[] = [];
    assert.equal(
      await runCli(["run", "list", "--sdk-format", "json"], {
        env,
        stdout: (text) => listStdout.push(text),
      }),
      0,
    );
    const list = parseEnvelope(listStdout.join(""));
    assert.equal((list.data?.runs as Array<{ runId: string }>)[0]?.runId, "auth");

    const viewStdout: string[] = [];
    assert.equal(
      await runCli(["run", "view", "auth", "--sdk-format", "json"], {
        env,
        stdout: (text) => viewStdout.push(text),
      }),
      0,
    );
    const view = parseEnvelope(viewStdout.join(""));
    assert.equal((view.data?.run as { runId: string }).runId, "auth");
    assert.doesNotMatch(viewStdout.join(""), /private\/repository|latest\.stdout\.log/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK cron list and view return persisted job records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-cron-test-"));
  try {
    const env = { ...process.env, HOME: join(dir, "home") };
    recordCronJob(env, {
      id: "triage",
      agent: "codex",
      schedule: { kind: "every", value: "1h", intervalMs: 3_600_000 },
      command: {
        args: [
          "codex",
          "--prompt",
          "sensitive prompt",
          "--prompt-file",
          "/private/prompts/triage.md",
          "--work-dir",
          "/private/repository",
          "--docker-env",
          "API_TOKEN=sentinel-secret",
        ],
        workDir: dir,
      },
    });
    const executionDir = join(
      cronRoot(env),
      "jobs",
      "triage",
      "executions",
      "execution-1",
    );
    mkdirSync(executionDir, { recursive: true });
    writeFileSync(
      join(executionDir, "result.json"),
      JSON.stringify({
        version: 1,
        jobId: "triage",
        executionId: "execution-1",
        status: "succeeded",
        pid: 12345,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        exitCode: 0,
        signal: null,
        finalMessage: `finished ${"detail ".repeat(100)}`,
        stdoutLog: "/private/logs/stdout.log",
        stderrLog: "/private/logs/stderr.log",
      }),
    );

    const listStdout: string[] = [];
    assert.equal(
      await runCli(["cron", "list", "--sdk-format", "json"], {
        env,
        stdout: (text) => listStdout.push(text),
      }),
      0,
    );
    const list = parseEnvelope(listStdout.join(""));
    assert.equal((list.data?.jobs as Array<{ id: string }>)[0]?.id, "triage");
    assert.doesNotMatch(listStdout.join(""), /sentinel-secret|sensitive prompt/);

    const viewStdout: string[] = [];
    assert.equal(
      await runCli(["cron", "view", "triage", "--sdk-format", "json"], {
        env,
        stdout: (text) => viewStdout.push(text),
      }),
      0,
    );
    const view = parseEnvelope(viewStdout.join(""));
    assert.equal((view.data?.job as { id: string }).id, "triage");
    const executions = view.data?.executions as Array<Record<string, unknown>>;
    assert.equal(executions[0]?.executionId, "execution-1");
    assert.equal((executions[0]?.finalMessage as string).length, 200);
    assert.doesNotMatch(
      viewStdout.join(""),
      /sentinel-secret|sensitive prompt|private\/prompts|private\/repository/,
    );
    assert.doesNotMatch(viewStdout.join(""), /12345|private\/logs|headless-sdk-cron-test/);
    assert.match(viewStdout.join(""), /<redacted>/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK cron view preserves safe actionable errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-cron-error-test-"));
  try {
    const stdout: string[] = [];

    const code = await runCli(["cron", "view", "missing", "--sdk-format", "json"], {
      env: { ...process.env, HOME: join(dir, "home") },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 2);
    const envelope = parseEnvelope(stdout.join(""));
    assert.equal(envelope.command, "cron.view");
    assert.equal(envelope.error?.message, "unknown cron job: missing");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK check output exposes agent and Docker checks without terminal tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-check-test-"));
  try {
    const stdout: string[] = [];

    const code = await runCli(["--check", "--sdk-format", "json"], {
      env: { HOME: join(dir, "home"), PATH: join(dir, "bin") },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const envelope = parseEnvelope(stdout.join(""));
    assert.equal((envelope.data?.agents as unknown[]).length, 8);
    assert.equal((envelope.data?.docker as { available: boolean }).available, false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK show-config output exposes resolved harness configuration", async () => {
  const stdout: string[] = [];

  const code = await runCli(
    ["codex", "--show-config", "--allow", "yolo", "--sdk-format", "json"],
    {
      env: { CODEX_MODEL: "gpt-custom" },
      stdout: (text) => stdout.push(text),
    },
  );

  assert.equal(code, 0);
  const envelope = parseEnvelope(stdout.join(""));
  assert.equal(envelope.command, "config.show");
  assert.equal(envelope.data?.agent, "codex");
  assert.equal(envelope.data?.model, "gpt-custom");
  assert.equal(envelope.data?.allow, "yolo");
  assert.deepEqual(envelope.data?.seedPaths, [".codex/auth.json", ".codex/config.toml"]);
});

test("SDK session list returns structured tmux session details", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-session-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "tmux"),
      [
        "#!/bin/sh",
        "printf 'headless-codex-review\\t1700000000\\t1700000001\\t0\\t/repo\\n'",
        "",
      ].join("\n"),
    );
    const stdout: string[] = [];

    const code = await runCli(["--list", "--sdk-format", "json"], {
      env: {
        HEADLESS_LIST_WAITING_AFTER_MS: "1000000000",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const envelope = parseEnvelope(stdout.join(""));
    const sessions = envelope.data?.sessions as Array<{ name: string; agent: string }>;
    assert.deepEqual(sessions.map(({ name, agent }) => ({ name, agent })), [
      { name: "headless-codex-review", agent: "codex" },
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK session list errors do not expose tmux stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-session-error-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "tmux"),
      [
        "#!/bin/sh",
        "printf 'sentinel-private-socket\\n' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    const stdout: string[] = [];

    const code = await runCli(["--list", "--sdk-format", "json"], {
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 2);
    const message = parseEnvelope(stdout.join("")).error?.message;
    assert.equal(message, "could not list tmux sessions");
    assert.doesNotMatch(message, /sentinel-private-socket/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK mode rejects interactive tmux execution", async () => {
  const stdout: string[] = [];

  const code = await runCli(
    ["codex", "--prompt", "hello", "--tmux", "--sdk-format", "json"],
    { stdout: (text) => stdout.push(text) },
  );

  assert.equal(code, 2);
  assert.equal(parseEnvelope(stdout.join("")).error?.message, "--sdk-format cannot be used with --tmux");
});
