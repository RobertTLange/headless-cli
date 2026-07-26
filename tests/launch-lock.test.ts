import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { acquireDockerSessionLock, acquireLaunchLock, dockerSessionLockPath, launchLockPath } from "../src/launch-lock.ts";

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

test("Docker session lock paths derive from the canonical durable home", () => {
  withHome((home) => {
    const persistentHome = join(home, "sessions", "codex", "work");
    const dottedAliasHome = join(home, "sessions", "codex", "work.lock");
    mkdirSync(persistentHome, { recursive: true });
    mkdirSync(dottedAliasHome);
    const path = dockerSessionLockPath(persistentHome);

    assert.ok(path.startsWith(join(realpathSync(join(home, "sessions")), ".headless-session-locks")));
    assert.ok(path.endsWith(".lock"));
    assert.notEqual(path, realpathSync(dottedAliasHome));
  });
});

test("Docker session locks recover stale crash remnants", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-lock-"));
  try {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    const lockPath = dockerSessionLockPath(persistentHome);
    mkdirSync(lockPath, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lockPath, stale, stale);

    const lock = await acquireDockerSessionLock(persistentHome);
    assert.equal(existsSync(lockPath), true);
    await lock.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("Docker session locks do not steal a stale lease from a live local owner", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-lock-"));
  const originalTimezone = process.env.TZ;
  try {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    process.env.TZ = "UTC";
    const first = await acquireDockerSessionLock(persistentHome);
    if (process.platform === "linux") {
      const owner = JSON.parse(readFileSync(`${dockerSessionLockPath(persistentHome)}.owner`, "utf8"));
      assert.match(owner.startIdentity, /^linux:[0-9a-f-]{36}:\d+$/);
    }
    const stale = new Date(Date.now() - 120_000);
    utimesSync(dockerSessionLockPath(persistentHome), stale, stale);
    process.env.TZ = "Pacific/Honolulu";
    let secondAcquired = false;
    const secondPromise = acquireDockerSessionLock(persistentHome).then((lock) => {
      secondAcquired = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(secondAcquired, false);
    assert.equal(await first.release(), undefined);
    const second = await secondPromise;
    assert.equal(secondAcquired, true);
    assert.equal(await second.release(), undefined);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    rmSync(home, { force: true, recursive: true });
  }
});

test("Docker session locks recover when a stale owner PID has been reused", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-lock-"));
  try {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    const lockPath = dockerSessionLockPath(persistentHome);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      `${lockPath}.owner`,
      `${JSON.stringify({
        hostname: hostname(),
        pid: process.pid,
        startIdentity: "different process birth",
        token: "00000000-0000-4000-8000-000000000000",
      })}\n`,
    );
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lockPath, stale, stale);

    const lock = await acquireDockerSessionLock(persistentHome);
    assert.equal(await lock.release(), undefined);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("Docker session lock release remains non-throwing after external removal", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-lock-"));
  try {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    const lock = await acquireDockerSessionLock(persistentHome);
    rmSync(dockerSessionLockPath(persistentHome), { force: true, recursive: true });

    await assert.doesNotReject(lock.release());
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("Docker session lock release reports permission failures without rejecting", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-lock-"));
  const persistentHome = join(home, "sessions", "codex", "work");
  let lockPath = "";
  try {
    mkdirSync(persistentHome, { recursive: true });
    const lock = await acquireDockerSessionLock(persistentHome);
    lockPath = dockerSessionLockPath(persistentHome);
    chmodSync(dirname(lockPath), 0o500);

    assert.match((await lock.release())?.message ?? "", /permission|EACCES/i);
  } finally {
    if (lockPath) chmodSync(dirname(lockPath), 0o700);
    rmSync(home, { force: true, recursive: true });
  }
});

test("Docker session locks do not retry permanent namespace errors", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-lock-"));
  try {
    const persistentHome = join(home, "sessions", "codex", "work");
    mkdirSync(persistentHome, { recursive: true });
    writeFileSync(join(home, "sessions", ".headless-session-locks"), "not a directory");

    await assert.rejects(acquireDockerSessionLock(persistentHome), /EEXIST|not a directory|ENOTDIR/);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
