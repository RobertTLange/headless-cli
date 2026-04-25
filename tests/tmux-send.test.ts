import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";

async function installFakeTmux(binDir: string): Promise<void> {
  await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
    await mkdir(binDir);
    const tmux = join(binDir, "tmux");
    await writeFile(
      tmux,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.HEADLESS_TMUX_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');",
        "",
      ].join("\n"),
    );
    await chmod(tmux, 0o755);
  });
}

function readTmuxCalls(captureFile: string): string[][] {
  return readFileSync(captureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("CLI send pastes a prompt into an existing headless tmux session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
    await installFakeTmux(binDir);

    const stdout: string[] = [];
    const code = await runCli(["send", "headless-codex-123", "--prompt", "hello world"], {
      env: { ...process.env, HEADLESS_TMUX_CAPTURE: captureFile, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.deepEqual(readTmuxCalls(captureFile), [
      ["set-buffer", "-b", "headless-codex-123-send", "hello world"],
      ["paste-buffer", "-d", "-b", "headless-codex-123-send", "-t", "headless-codex-123"],
      ["send-keys", "-t", "headless-codex-123", "Enter"],
    ]);
    assert.equal(stdout.join(""), "sent: headless-codex-123\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI send preserves multiline prompt-file text through the tmux buffer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "line one\nline two");
    await installFakeTmux(binDir);

    const code = await runCli(["send", "headless-claude-456", "--prompt-file", promptFile], {
      env: { ...process.env, HEADLESS_TMUX_CAPTURE: captureFile, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: () => undefined,
    });

    assert.equal(code, 0);
    assert.deepEqual(readTmuxCalls(captureFile)[0], [
      "set-buffer",
      "-b",
      "headless-claude-456-send",
      "line one\nline two",
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI send reads prompt from piped stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
    await installFakeTmux(binDir);

    const code = await runCli(["send", "headless-pi-789"], {
      env: { ...process.env, HEADLESS_TMUX_CAPTURE: captureFile, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdin: "from stdin",
      stdinIsTTY: false,
      stdout: () => undefined,
    });

    assert.equal(code, 0);
    assert.deepEqual(readTmuxCalls(captureFile)[0], ["set-buffer", "-b", "headless-pi-789-send", "from stdin"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI send --print-command prints tmux commands without executing them", async () => {
  const stdout: string[] = [];
  const code = await runCli(["send", "headless-opencode-321", "--prompt", "hello world", "--print-command"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.equal(
    stdout.join(""),
    [
      "tmux set-buffer -b headless-opencode-321-send 'hello world'",
      "tmux paste-buffer -d -b headless-opencode-321-send -t headless-opencode-321",
      "tmux send-keys -t headless-opencode-321 Enter",
      "",
    ].join("\n"),
  );
});

test("CLI send rejects missing session name", async () => {
  const stderr: string[] = [];
  const code = await runCli(["send", "--prompt", "hello"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /missing tmux session/);
});

test("CLI send rejects non-headless session names", async () => {
  const stderr: string[] = [];
  const code = await runCli(["send", "other-session", "--prompt", "hello"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /not a headless tmux session/);
});

test("CLI send requires a prompt", async () => {
  const stderr: string[] = [];
  const code = await runCli(["send", "headless-codex-123"], {
    stderr: (text) => stderr.push(text),
    stdinIsTTY: true,
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /missing prompt/);
});
