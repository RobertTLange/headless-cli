import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("pre-push hook defaults local integration tests to Codex only", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-hook-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "npm-args.jsonl");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "npm"),
      [
        "#!/bin/sh",
        "printf '%s\\t%s\\t%s\\t%s\\n' \"$*\" \"${HEADLESS_BIN:-}\" \"${HEADLESS_INTEGRATION_AGENTS:-}\" \"${HEADLESS_INTEGRATION_FULL_SWEEP:-}\" >> \"$HEADLESS_HOOK_CAPTURE\"",
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
      ["run build", "", "", ""],
      ["run test:integration:local", join(repoRoot, "dist", "cli.js"), "codex", "0"],
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("pre-push hook can opt into all local integration agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-hook-test-"));
  try {
    const binDir = join(dir, "bin");
    const captureFile = join(dir, "npm-args.jsonl");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "npm"),
      [
        "#!/bin/sh",
        "printf '%s\\t%s\\t%s\\t%s\\n' \"$*\" \"${HEADLESS_BIN:-}\" \"${HEADLESS_INTEGRATION_AGENTS:-}\" \"${HEADLESS_INTEGRATION_FULL_SWEEP:-}\" >> \"$HEADLESS_HOOK_CAPTURE\"",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(".githooks/pre-push", {
      cwd: repoRoot,
      env: {
        HEADLESS_HOOK_ALL_AGENTS: "1",
        HEADLESS_HOOK_CAPTURE: captureFile,
        PATH: `${binDir}:/bin:/usr/bin`,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(captureFile, "utf8").trim().split("\n").map((line) => line.split("\t"));
    assert.deepEqual(calls, [
      ["run build", "", "", ""],
      ["run test:integration:local", join(repoRoot, "dist", "cli.js"), "all", "1"],
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
