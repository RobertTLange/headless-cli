import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

test("Windows CI runs every run-storage process test", () => {
  const windowsJob = workflow.match(/\n  windows-run-storage:\n[\s\S]*?(?=\n  [\w-]+:\n|$)/)?.[0];

  assert.ok(windowsJob);
  assert.match(windowsJob, /run: node --import tsx --test /);
  assert.match(windowsJob, /tests\/run-storage\.test\.ts/);
  assert.match(windowsJob, /tests\/run-storage-process\.test\.ts/);
});
