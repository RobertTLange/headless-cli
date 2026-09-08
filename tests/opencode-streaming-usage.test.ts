import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";

test("CLI --json --usage retains distinct OpenCode steps across long streamed output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-opencode-stream-"));
  try {
    const binary = join(dir, "opencode");
    writeFileSync(
      binary,
      [
        "#!/usr/bin/env node",
        "function step(id, input, cost) {",
        "  return { type: 'step_finish', sessionID: 'session-1', part: {",
        "    id, sessionID: 'session-1', messageID: 'message-1', type: 'step-finish',",
        "    tokens: { input, output: 0 }, cost,",
        "  } };",
        "}",
        "const first = step('step-1', 100, 1);",
        "console.log(JSON.stringify(first));",
        "console.log(JSON.stringify(first));",
        "for (let i = 0; i < 3000; i++) {",
        "  console.log(JSON.stringify({ type: 'text', part: { text: 'x'.repeat(150) } }));",
        "}",
        "const last = step('step-2', 200, 2);",
        "console.log(JSON.stringify(last));",
        "console.log(JSON.stringify(last));",
        "",
      ].join("\n"),
    );
    chmodSync(binary, 0o755);

    const stdout: string[] = [];
    const code = await runCli(["opencode", "--prompt", "hello", "--json", "--usage"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const output = stdout.join("");
    assert.ok(Buffer.byteLength(output) > 256 * 1024);
    const { usage } = JSON.parse(output.trim().split("\n").at(-1)!);
    assert.equal(usage.cost.total, 3);
    assert.equal(usage.inputTokens, 300);
    assert.equal(usage.totalTokens, 300);
    assert.equal(usage.costBasis, "native-reported");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
