import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("pre-push hook builds and runs integration tests through the repo CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-hook-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "npm-args.jsonl");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "npm"),
      [
        "#!/bin/sh",
        "printf '%s\\t%s\\n' \"$*\" \"${HEADLESS_BIN:-}\" >> \"$HEADLESS_HOOK_CAPTURE\"",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(".githooks/pre-push", {
      cwd: repoRoot,
      env: {
        HEADLESS_HOOK_CAPTURE: captureFile,
        PATH: `${binDir}:/bin:/usr/bin`,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => line.split("\t"));
    assert.deepEqual(calls, [
      ["run build", ""],
      ["run test:integration:local", join(repoRoot, "dist", "cli.js")],
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
