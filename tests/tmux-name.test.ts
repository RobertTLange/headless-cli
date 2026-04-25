import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";

async function installFakeTmux(binDir: string, source?: string): Promise<void> {
  await import("node:fs/promises").then(async ({ chmod, mkdir, writeFile }) => {
    await mkdir(binDir);
    const tmux = join(binDir, "tmux");
    await writeFile(
      tmux,
      source ??
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

test("CLI --tmux --name launches a managed named session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
    await installFakeTmux(binDir);

    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--work-dir", dir, "--tmux", "--name", "work"], {
      env: { ...process.env, HEADLESS_TMUX_CAPTURE: captureFile, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.deepEqual(readTmuxCalls(captureFile)[0].slice(0, 6), [
      "new-session",
      "-d",
      "-s",
      "headless-codex-work",
      "-c",
      dir,
    ]);
    assert.match(stdout.join(""), /tmux session: headless-codex-work/);
    assert.match(stdout.join(""), /tmux attach-session -t headless-codex-work/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --tmux rejects unsafe custom session names", async () => {
  const stderr: string[] = [];
  const code = await runCli(["codex", "--prompt", "hello", "--tmux", "--name", "bad/name"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /invalid tmux session name/);
});

test("CLI rename renames a managed session while preserving the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
    await installFakeTmux(binDir);

    const stdout: string[] = [];
    const code = await runCli(["rename", "headless-codex-123", "work"], {
      env: { ...process.env, HEADLESS_TMUX_CAPTURE: captureFile, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.deepEqual(readTmuxCalls(captureFile), [
      ["rename-session", "-t", "headless-codex-123", "headless-codex-work"],
    ]);
    assert.equal(stdout.join(""), "renamed: headless-codex-123 -> headless-codex-work\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI rename --print-command prints the tmux rename command", async () => {
  const stdout: string[] = [];
  const code = await runCli(["rename", "headless-opencode-old", "next", "--print-command"], {
    stdout: (text) => stdout.push(text),
  });

  assert.equal(code, 0);
  assert.equal(stdout.join(""), "tmux rename-session -t headless-opencode-old headless-opencode-next\n");
});

test("CLI rename rejects unsafe names", async () => {
  const stderr: string[] = [];
  const code = await runCli(["rename", "headless-codex-123", "bad/name"], {
    stderr: (text) => stderr.push(text),
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /invalid tmux session name/);
});

test("CLI list includes named headless tmux sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    await installFakeTmux(
      binDir,
      [
        "#!/usr/bin/env node",
        "if (process.argv.slice(2).join(' ') !== 'list-sessions -F #{session_name}') process.exit(2);",
        "process.stdout.write('headless-codex-work\\nheadless-opencode-review.1\\nother\\n');",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["--list"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(
      stdout.join(""),
      [
        "headless-codex-work\tcodex\ttmux attach-session -t headless-codex-work",
        "headless-opencode-review.1\topencode\ttmux attach-session -t headless-opencode-review.1",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI send accepts named headless tmux sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "tmux.jsonl");
    await installFakeTmux(binDir);

    const code = await runCli(["send", "headless-codex-work", "--prompt", "hello"], {
      env: { ...process.env, HEADLESS_TMUX_CAPTURE: captureFile, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: () => undefined,
    });

    assert.equal(code, 0);
    assert.deepEqual(readTmuxCalls(captureFile)[0], ["set-buffer", "-b", "headless-codex-work-send", "hello"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
