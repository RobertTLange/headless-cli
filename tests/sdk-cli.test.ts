import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";

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

test("legacy arguments after the option terminator do not request SDK output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sdk-terminator-test-"));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["codex", "--work-dir", join(dir, "missing"), "--", "--sdk-format"],
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
    );

    assert.equal(code, 2);
    assert.equal(stdout.join(""), "");
    assert.match(stderr.join(""), /work dir not found/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
