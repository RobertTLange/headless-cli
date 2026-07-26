import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { readStoredSession } from "../src/sessions.ts";
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
      ["codex", "--prompt", "hello", "--session", "large", "--sdk-format", "ndjson"],
      {
        env: {
          ...process.env,
          HOME: join(dir, "home"),
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
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
    assert.equal(
      readStoredSession({ HOME: join(dir, "home") }, "codex", "large")?.nativeId,
      "thread-large",
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
