import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { cronRoot, recordCronJob } from "../src/cron.ts";
import { registerNode } from "../src/runs.ts";
import { SdkTraceWriter } from "../src/sdk.ts";

interface SdkEnvelope {
  protocolVersion: number;
  type: "error" | "result" | "trace";
  command: string;
  exitCode?: number;
  data?: Record<string, unknown>;
  error?: { message: string };
}

function parseEnvelope(output: string): SdkEnvelope {
  return JSON.parse(output) as SdkEnvelope;
}

function parseEnvelopes(output: string): SdkEnvelope[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => parseEnvelope(line));
}

async function writeExecutable(path: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf8");
  chmodSync(path, 0o755);
}

test("SDK version output uses a versioned result envelope", async () => {
  const stdout: string[] = [];

  const code = await runCli(["--sdk-format", "json", "--version"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.deepEqual(parseEnvelope(stdout.join("")), {
    protocolVersion: 1,
    type: "result",
    command: "version",
    exitCode: 0,
    data: { version: "0.4.0" },
  });
});

test("SDK version output accepts the conventional version-first flag order", async () => {
  const stdout: string[] = [];

  const code = await runCli(["--version", "--sdk-format", "json"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.equal(parseEnvelope(stdout.join("")).command, "version");
});

test("plain version keeps ignoring trailing arguments for compatibility", async () => {
  const stdout: string[] = [];

  const code = await runCli(["--version", "--unknown"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.equal(stdout.join(""), "0.4.0\n");
});

test("SDK capabilities report the supported protocol and command families", async () => {
  const stdout: string[] = [];

  const code = await runCli(["capabilities", "--sdk-format", "json"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  const envelope = parseEnvelope(stdout.join(""));
  assert.equal(envelope.protocolVersion, 1);
  assert.equal(envelope.command, "capabilities");
  assert.deepEqual(envelope.data?.sdkFormats, ["json", "ndjson"]);
  assert.ok((envelope.data?.commands as string[]).includes("capabilities"));
  assert.deepEqual(envelope.data?.agents, [
    "acp",
    "antigravity",
    "claude",
    "codex",
    "cursor",
    "gemini",
    "opencode",
    "pi",
  ]);
});

test("SDK operation errors identify the requested command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-error-test-"));
  try {
    const stdout: string[] = [];

    const code = await runCli(["run", "view", "missing", "--sdk-format", "json"], {
      env: { ...process.env, HOME: join(dir, "home") },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 2);
    assert.equal(parseEnvelope(stdout.join("")).command, "runs.view");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK validation failures use an error envelope", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runCli(["codex", "--prompt", "hello", "--sdk-format", "json", "--json"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.equal(stderr.join(""), "");
  assert.deepEqual(parseEnvelope(stdout.join("")), {
    protocolVersion: 1,
    type: "error",
    command: "cli",
    exitCode: 2,
    error: { message: "--json cannot be used with --sdk-format" },
  });
});

test("SDK invalid format requests still return machine-readable errors", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runCli(["--sdk-format", "xml", "--version"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.equal(stderr.join(""), "");
  assert.equal(parseEnvelope(stdout.join("")).error?.message, "unsupported SDK format: xml");
});

test("legacy option values named --sdk-format keep legacy errors", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runCli(["codex", "--prompt", "--sdk-format", "--tmux", "--json"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /--json cannot be used with --tmux/);
});

test("SDK trace writer bounds a complete oversized row received in one chunk", () => {
  const stdout: string[] = [];
  const writer = new SdkTraceWriter("codex", (text) => stdout.push(text));

  writer.write(`${"x".repeat(5 * 1024 * 1024)}\n`);

  const fragments = parseEnvelopes(stdout.join(""));
  assert.equal(fragments.length, 2);
  assert.equal(fragments[0]?.data?.partial, true);
  assert.equal(fragments[1]?.data?.partial, false);
  assert.ok(
    fragments.every(
      (fragment) =>
        Buffer.byteLength(fragment.data?.raw as string, "utf8") <= 4 * 1024 * 1024,
    ),
  );
});

test("SDK JSON returns a structured one-shot result and usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'finished' }));",
        "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }));",
        "",
      ].join("\n"),
    );
    const stdout: string[] = [];

    const code = await runCli(
      ["codex", "--prompt", "hello", "--sdk-format", "json", "--usage"],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 0);
    const envelope = parseEnvelope(stdout.join(""));
    assert.equal(envelope.command, "invoke");
    assert.equal(envelope.exitCode, 0);
    assert.equal(envelope.data?.agent, "codex");
    assert.equal(envelope.data?.finalMessage, "finished");
    assert.equal((envelope.data?.usage as { totalTokens?: number }).totalTokens, 6);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK NDJSON wraps native trace rows and terminates with a result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'streamed' }));",
        "",
      ].join("\n"),
    );
    const stdout: string[] = [];

    const code = await runCli(
      ["codex", "--prompt", "hello", "--sdk-format", "ndjson"],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 0);
    const envelopes = parseEnvelopes(stdout.join(""));
    assert.equal(envelopes[0]?.type, "trace");
    assert.deepEqual(envelopes[0]?.data?.value, { type: "agent_message", text: "streamed" });
    assert.equal(envelopes.at(-1)?.type, "result");
    assert.equal(envelopes.at(-1)?.data?.finalMessage, "streamed");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK JSON reports a successful trace without a final message as an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "codex"),
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'thread.started' }));\n",
    );
    const stdout: string[] = [];

    const code = await runCli(
      ["codex", "--prompt", "hello", "--sdk-format", "json"],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 1);
    const envelope = parseEnvelope(stdout.join(""));
    assert.equal(envelope.type, "error");
    assert.equal(envelope.exitCode, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK JSON prefers a later final message over an earlier error event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'error', message: 'transient warning' }));",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'recovered' }));",
        "",
      ].join("\n"),
    );
    const stdout: string[] = [];

    const code = await runCli(
      ["codex", "--prompt", "hello", "--sdk-format", "json"],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 0);
    const envelope = parseEnvelope(stdout.join(""));
    assert.equal(envelope.type, "result");
    assert.equal(envelope.data?.finalMessage, "recovered");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK JSON preserves a final message and nonzero agent exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'partial result' }));",
        "process.exitCode = 7;",
        "",
      ].join("\n"),
    );
    const stdout: string[] = [];

    const code = await runCli(
      ["codex", "--prompt", "hello", "--sdk-format", "json"],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 7);
    const envelope = parseEnvelope(stdout.join(""));
    assert.equal(envelope.type, "result");
    assert.equal(envelope.exitCode, 7);
    assert.equal(envelope.data?.finalMessage, "partial result");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK formats preserve structured final messages larger than 64 KiB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'x'.repeat(128 * 1024) }));",
        "",
      ].join("\n"),
    );

    for (const format of ["json", "ndjson"] as const) {
      const stdout: string[] = [];
      const code = await runCli(
        ["codex", "--prompt", "hello", "--sdk-format", format],
        {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
          stdout: (text) => stdout.push(text),
        },
      );

      assert.equal(code, 0);
      const result = parseEnvelopes(stdout.join("")).at(-1);
      assert.equal((result?.data?.finalMessage as string).length, 128 * 1024);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK reports an explicit limit error for final records larger than 4 MiB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'x'.repeat(5 * 1024 * 1024) }));",
        "",
      ].join("\n"),
    );
    const stdout: string[] = [];

    const code = await runCli(
      ["codex", "--prompt", "hello", "--sdk-format", "json"],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 1);
    const result = parseEnvelope(stdout.join(""));
    assert.equal(result.type, "error");
    assert.match(result.error?.message ?? "", /exceeded the 4194304-byte SDK limit/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK aggregates Gemini deltas and Antigravity multiline output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "gemini"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello', delta: true }));",
        "console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'world', delta: true }));",
        "",
      ].join("\n"),
    );
    await writeExecutable(
      join(binDir, "agy"),
      "#!/usr/bin/env node\nconsole.log('first line');\nconsole.log('second line');\n",
    );

    for (const format of ["json", "ndjson"] as const) {
      const geminiStdout: string[] = [];
      assert.equal(
        await runCli(["gemini", "--prompt", "hello", "--sdk-format", format], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
          stdout: (text) => geminiStdout.push(text),
        }),
        0,
      );
      assert.equal(
        parseEnvelopes(geminiStdout.join("")).at(-1)?.data?.finalMessage,
        "Helloworld",
      );

      const antigravityStdout: string[] = [];
      assert.equal(
        await runCli(["antigravity", "--prompt", "hello", "--sdk-format", format], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
          stdout: (text) => antigravityStdout.push(text),
        }),
        0,
      );
      assert.equal(
        parseEnvelopes(antigravityStdout.join("")).at(-1)?.data?.finalMessage,
        "first line\nsecond line",
      );
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SDK trace capture retains identity and bounds oversized NDJSON rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-large' }));",
        "process.stdout.write('x'.repeat(5 * 1024 * 1024));",
        "process.stdout.write('\\n');",
        "console.log(JSON.stringify({ type: 'agent_message', text: 'finished' }));",
        "",
      ].join("\n"),
    );
    const stdout: string[] = [];

    const code = await runCli(
      ["codex", "--prompt", "hello", "--sdk-format", "ndjson"],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: (text) => stdout.push(text),
      },
    );

    assert.equal(code, 0);
    const envelopes = parseEnvelopes(stdout.join(""));
    const fragments = envelopes.filter(
      (envelope) => envelope.type === "trace" && envelope.data?.sequence !== undefined,
    );
    assert.equal(fragments.length, 2);
    assert.equal(fragments[0]?.data?.partial, true);
    assert.equal(fragments[1]?.data?.partial, false);
    assert.ok(
      fragments.every(
        (fragment) =>
          Buffer.byteLength(fragment.data?.raw as string, "utf8") <= 4 * 1024 * 1024,
      ),
    );
    const result = envelopes.at(-1);
    assert.equal(result?.data?.nativeSessionId, "thread-large");
    assert.equal(result?.data?.finalMessage, "finished");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

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

  const code = await runCli(["codex", "--show-config", "--sdk-format", "json"], {
    env: { CODEX_MODEL: "gpt-custom" },
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  const envelope = parseEnvelope(stdout.join(""));
  assert.equal(envelope.command, "config.show");
  assert.equal(envelope.data?.agent, "codex");
  assert.equal(envelope.data?.model, "gpt-custom");
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

test("SDK mode rejects interactive tmux execution", async () => {
  const stdout: string[] = [];

  const code = await runCli(
    ["codex", "--prompt", "hello", "--tmux", "--sdk-format", "json"],
    { stdout: (text) => stdout.push(text) },
  );

  assert.equal(code, 2);
  assert.equal(parseEnvelope(stdout.join("")).error?.message, "--sdk-format cannot be used with --tmux");
});
