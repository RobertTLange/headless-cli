import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(assertion(), true);
}

test("CLI --debug streams raw trace and appends extracted final message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const firstChunk = `${JSON.stringify({
      type: "message",
      message: { role: "toolresult", content: [{ type: "text", text: "tool output" }] },
    })}\n`;
    const secondChunk = `${JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    })}\n`;
    await mkdir(binDir);
    const binary = join(binDir, "pi");
    await writeFile(
      binary,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(${JSON.stringify(firstChunk)});`,
        `setTimeout(() => { process.stdout.write(${JSON.stringify(secondChunk)}); }, 500);`,
        "",
      ].join("\n"),
    );
    await chmod(binary, 0o755);

    const stdout: string[] = [];
    let completed = false;
    const result = runCli(["pi", "--prompt", "hello", "--debug"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    }).finally(() => {
      completed = true;
    });

    await waitFor(() => stdout.join("").startsWith(firstChunk) && !completed);

    const code = await result;
    assert.equal(code, 0);
    assert.equal(stdout.join(""), `${firstChunk}${secondChunk}--- final message ---\nfinal answer\n`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --debug separates final message label from traces without trailing newlines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const trace = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    });
    await mkdir(binDir);
    const binary = join(binDir, "pi");
    await writeFile(
      binary,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(${JSON.stringify(trace)});`,
        "",
      ].join("\n"),
    );
    await chmod(binary, 0o755);

    const stdout: string[] = [];
    const code = await runCli(["pi", "--prompt", "hello", "--debug"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.equal(stdout.join(""), `${trace}\n--- final message ---\nfinal answer\n`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI rejects --debug with conflicting output modes", async () => {
  const stderr: string[] = [];
  assert.equal(
    await runCli(["codex", "--prompt", "hello", "--debug", "--json"], {
      stderr: (text) => stderr.push(text),
    }),
    2,
  );
  assert.match(stderr.join(""), /--debug cannot be used with --json/);

  stderr.length = 0;
  assert.equal(
    await runCli(["codex", "--prompt", "hello", "--debug", "--tmux"], {
      stderr: (text) => stderr.push(text),
    }),
    2,
  );
  assert.match(stderr.join(""), /--debug cannot be used with --tmux/);
});
