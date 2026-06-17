import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { acquireLaunchLock, launchLockPath } from "../src/launch-lock.ts";

function withHome<T>(callback: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "headless-lock-"));
  try {
    return callback(home);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

test("launch lock creates and releases a per-(agent, workspace) lock file", () => {
  withHome((home) => {
    const env = { HOME: home };
    const path = launchLockPath(env, "codex", "/repo/a");
    assert.ok(path);
    const lock = acquireLaunchLock(env, "codex", "/repo/a");
    assert.ok(existsSync(path!));
    assert.equal(readFileSync(path!, "utf8").trim(), String(process.pid));
    lock.release();
    assert.ok(!existsSync(path!));
  });
});

test("launch lock keys are distinct per agent and per workspace", () => {
  withHome((home) => {
    const env = { HOME: home };
    const a = acquireLaunchLock(env, "codex", "/repo/a");
    const b = acquireLaunchLock(env, "codex", "/repo/b");
    const c = acquireLaunchLock(env, "gemini", "/repo/a");
    // Different workspace and different agent never contend, so all three hold.
    assert.ok(existsSync(launchLockPath(env, "codex", "/repo/a")!));
    assert.ok(existsSync(launchLockPath(env, "codex", "/repo/b")!));
    assert.ok(existsSync(launchLockPath(env, "gemini", "/repo/a")!));
    a.release();
    b.release();
    c.release();
  });
});

test("launch lock reaps a lock held by a dead process", () => {
  withHome((home) => {
    const env = { HOME: home };
    const path = launchLockPath(env, "codex", "/repo/a")!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "999999\n"); // pid that does not exist
    const lock = acquireLaunchLock(env, "codex", "/repo/a");
    assert.equal(readFileSync(path, "utf8").trim(), String(process.pid));
    lock.release();
  });
});

test("launch lock blocks against a live holder until released", () => {
  withHome((home) => {
    const env = { HOME: home };
    const path = launchLockPath(env, "codex", "/repo/a")!;
    const first = acquireLaunchLock(env, "codex", "/repo/a");

    assert.throws(
      () => acquireLaunchLock(env, "codex", "/repo/a", { timeoutMs: 80 }),
      /timed out acquiring launch lock/,
    );
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, "utf8").trim(), String(process.pid));

    first.release();
    assert.ok(!existsSync(path));

    const acquiredAfterRelease = acquireLaunchLock(env, "codex", "/repo/a");
    assert.ok(existsSync(path));
    acquiredAfterRelease.release();
  });
});

test("launch lock is a no-op without HOME", () => {
  const lock = acquireLaunchLock({}, "codex", "/repo/a");
  lock.release(); // must not throw
});
