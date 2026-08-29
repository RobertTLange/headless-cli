import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  acquireNodeStoreLock,
  acquireRunStoreLock,
  isRunStoreLockSignalListener,
  removeRunStoreLockSignalListeners,
  replaceRunStateFile,
} from "../src/run-storage.ts";

function withTemporaryDirectory(callback: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "headless-run-storage-"));
  try {
    callback(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function agePath(path: string, milliseconds = 20_000): void {
  const stale = new Date(Date.now() - milliseconds);
  utimesSync(path, stale, stale);
}

test("run store lock recovers a legacy lock owned by a dead process", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "run.lock");
    writeFileSync(lockPath, "99999999\n");

    const release = acquireRunStoreLock(lockPath, "auth");

    assert.equal(statSync(lockPath).isDirectory(), true);
    release();
    assert.equal(existsSync(lockPath), false);
  });
});

test("node store lock preserves a fresh malformed legacy lock", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    writeFileSync(lockPath, "");

    assert.throws(() => acquireNodeStoreLock(lockPath, "worker-1"), /node is locked: worker-1/);
    assert.equal(readFileSync(lockPath, "utf8"), "");
  });
});

test("node store lock recovers an aged malformed legacy lock", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    writeFileSync(lockPath, "not-a-pid\n");
    agePath(lockPath);

    const release = acquireNodeStoreLock(lockPath, "worker-1");

    assert.equal(statSync(lockPath).isDirectory(), true);
    release();
  });
});

test("node store lock recovers an aged legacy lock with an unsafe PID", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    writeFileSync(lockPath, "999999999999999999999999\n");
    agePath(lockPath);

    const release = acquireNodeStoreLock(lockPath, "worker-1");

    assert.equal(statSync(lockPath).isDirectory(), true);
    release();
  });
});

test("node store lock preserves a legacy lock owned by a live process", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    writeFileSync(lockPath, `${process.pid}\n`);
    agePath(lockPath);

    assert.throws(() => acquireNodeStoreLock(lockPath, "worker-1"), /node is locked: worker-1/);
  });
});

test("node store lock excludes a live holder and supports reacquisition", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    const releaseFirst = acquireNodeStoreLock(lockPath, "worker-1");

    assert.throws(() => acquireNodeStoreLock(lockPath, "worker-1"), /node is locked: worker-1/);
    releaseFirst();

    const releaseSecond = acquireNodeStoreLock(lockPath, "worker-1");
    releaseSecond();
    assert.equal(existsSync(lockPath), false);
  });
});

test("node store lock persists private owner identity while its process is alive", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    const ownerPath = `${lockPath}.owner`;
    const release = acquireNodeStoreLock(lockPath, "worker-1", { processTreeRootPid: process.pid });

    if (process.platform !== "win32") assert.equal(statSync(ownerPath).mode & 0o777, 0o600);
    assert.throws(() => acquireNodeStoreLock(lockPath, "worker-1"), /node is locked: worker-1/);
    release();
    assert.equal(existsSync(ownerPath), false);
  });
});

test("node store lock does not remove an unexpected lock directory", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    mkdirSync(lockPath);

    assert.throws(() => acquireNodeStoreLock(lockPath, "worker-1"), /node is locked: worker-1/);
    assert.equal(statSync(lockPath).isDirectory(), true);
  });
});

test("node store lock recovers a stale lease directory", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    mkdirSync(lockPath);
    agePath(lockPath);

    const release = acquireNodeStoreLock(lockPath, "worker-1");

    assert.equal(statSync(lockPath).isDirectory(), true);
    release();
    assert.equal(existsSync(lockPath), false);
  });
});

test("node store lock does not trust an expired owner identity", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    mkdirSync(lockPath);
    writeFileSync(`${lockPath}.owner`, `${JSON.stringify({
      createdAtMs: 0,
      processTreeRootPid: process.pid,
    })}\n`);
    agePath(lockPath);

    const release = acquireNodeStoreLock(lockPath, "worker-1");

    release();
    assert.equal(existsSync(`${lockPath}.owner`), false);
  });
});

test("node store lock does not trust an invalid owner PID", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    mkdirSync(lockPath);
    writeFileSync(`${lockPath}.owner`, `${JSON.stringify({
      createdAtMs: Date.now(),
      processTreeRootPid: 0,
    })}\n`);
    agePath(lockPath);

    const release = acquireNodeStoreLock(lockPath, "worker-1");

    release();
  });
});

test("node store lock recovers a stale lease with malformed owner identity", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    mkdirSync(lockPath);
    writeFileSync(`${lockPath}.owner`, "not-json\n");
    agePath(lockPath);

    const release = acquireNodeStoreLock(lockPath, "worker-1");

    release();
  });
});

test("node store lock recovers an aged lock owned by a dead process", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    writeFileSync(lockPath, "99999999\n");
    agePath(lockPath);

    const release = acquireNodeStoreLock(lockPath, "worker-1");

    assert.equal(statSync(lockPath).isDirectory(), true);
    release();
  });
});

test("node store lock blocks stale takeover while the owner's process group is alive", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-run-storage-"));
  let processGroupId: number | undefined;
  try {
    const lockPath = join(directory, "session.lock");
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "run-storage.ts")).href;
    const script = [
      `import { spawn } from "node:child_process";`,
      `import { acquireNodeStoreLock } from ${JSON.stringify(moduleUrl)};`,
      `acquireNodeStoreLock(${JSON.stringify(lockPath)}, "worker-1", { processTreeRootPid: process.pid });`,
      `spawn(process.execPath, ["--eval", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });`,
      `process.stdout.write("ready\\n");`,
      `setInterval(() => undefined, 1000);`,
    ].join("\n");
    const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    processGroupId = owner.pid;
    await once(owner.stdout, "data");
    owner.kill("SIGKILL");
    await once(owner, "exit");
    agePath(lockPath);

    assert.throws(() => acquireNodeStoreLock(lockPath, "worker-1"), /node is locked: worker-1/);

    process.kill(-processGroupId!, "SIGKILL");
    await waitForProcessGroupExit(processGroupId!);
    processGroupId = undefined;
    const release = acquireNodeStoreLock(lockPath, "worker-1");
    release();
  } finally {
    if (processGroupId) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // Process group already exited.
      }
    }
    rmSync(directory, { force: true, recursive: true });
  }
});

test("run store lock excludes a live holder and supports reacquisition", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "run.lock");
    const releaseFirst = acquireRunStoreLock(lockPath, "auth");

    assert.equal(statSync(lockPath).isDirectory(), true);
    releaseFirst();

    const releaseSecond = acquireRunStoreLock(lockPath, "auth");
    releaseSecond();
    assert.equal(existsSync(lockPath), false);
  });
});

test("run store lock recovers a stale lease directory", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "run.lock");
    mkdirSync(lockPath);
    agePath(lockPath, 120_000);

    const release = acquireRunStoreLock(lockPath, "auth");

    release();
    assert.equal(existsSync(lockPath), false);
  });
});

test("run store lock recovers after its owner crashes", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-run-storage-"));
  try {
    const lockPath = join(directory, "run.lock");
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "run-storage.ts")).href;
    const script = [
      `import { acquireRunStoreLock } from ${JSON.stringify(moduleUrl)};`,
      `acquireRunStoreLock(${JSON.stringify(lockPath)}, "auth");`,
      `process.stdout.write("ready\\n");`,
      `setInterval(() => undefined, 1000);`,
    ].join("\n");
    const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await once(owner.stdout, "data");
    owner.kill("SIGKILL");
    await once(owner, "exit");

    const startedAt = Date.now();
    const release = acquireRunStoreLock(lockPath, "auth");

    assert.ok(Date.now() - startedAt < 10_000);
    release();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("run store identifies signal listeners installed by its lock dependency", () => {
  withTemporaryDirectory((directory) => {
    const release = acquireNodeStoreLock(join(directory, "session.lock"), "worker-1");
    release();

    assert.equal(
      managedTestSignals().some((signal) => process.listeners(signal).some(isRunStoreLockSignalListener)),
      true,
    );
    removeRunStoreLockSignalListeners();
    assert.equal(
      managedTestSignals().some((signal) => process.listeners(signal).some(isRunStoreLockSignalListener)),
      false,
    );
  });
});

function managedTestSignals(): NodeJS.Signals[] {
  return process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];
}

test("run state replacement retries transient Windows rename failures", () => {
  const attempts: number[] = [];
  const delays: number[] = [];

  replaceRunStateFile("run.tmp", "run.json", {
    platform: "win32",
    rename: () => {
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) throw Object.assign(new Error("busy"), { code: "EPERM" });
    },
    sleep: (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [25, 25]);
});

test("run state replacement uses the native rename defaults", () => {
  withTemporaryDirectory((directory) => {
    const source = join(directory, "run.tmp");
    const destination = join(directory, "run.json");
    writeFileSync(source, "state\n");

    replaceRunStateFile(source, destination);

    assert.equal(readFileSync(destination, "utf8"), "state\n");
    assert.equal(existsSync(source), false);
  });
});

test("run state replacement does not retry non-Windows rename failures", () => {
  let attempts = 0;
  const failure = Object.assign(new Error("busy"), { code: "EPERM" });

  assert.throws(
    () => replaceRunStateFile("run.tmp", "run.json", {
      platform: "linux",
      rename: () => {
        attempts += 1;
        throw failure;
      },
      sleep: () => assert.fail("unexpected retry"),
    }),
    failure,
  );
  assert.equal(attempts, 1);
});

test("run state replacement does not retry permanent Windows rename failures", () => {
  let attempts = 0;
  const failure = Object.assign(new Error("missing"), { code: "ENOENT" });

  assert.throws(
    () => replaceRunStateFile("run.tmp", "run.json", {
      platform: "win32",
      rename: () => {
        attempts += 1;
        throw failure;
      },
      sleep: () => assert.fail("unexpected retry"),
    }),
    failure,
  );
  assert.equal(attempts, 1);
});

test("run state replacement does not retry Windows errors without a code", () => {
  let attempts = 0;

  assert.throws(() => replaceRunStateFile("run.tmp", "run.json", {
    platform: "win32",
    rename: () => {
      attempts += 1;
      throw new Error("unknown");
    },
    sleep: () => assert.fail("unexpected retry"),
  }), /unknown/);
  assert.equal(attempts, 1);
});

test("run state replacement bounds Windows retries", () => {
  let attempts = 0;
  const failure = Object.assign(new Error("busy"), { code: "EBUSY" });

  assert.throws(
    () => replaceRunStateFile("run.tmp", "run.json", {
      platform: "win32",
      rename: () => {
        attempts += 1;
        throw failure;
      },
      sleep: () => undefined,
    }),
    failure,
  );
  assert.equal(attempts, 20);
});

test("run state replacement waits for a native Windows sharing lock", { skip: process.platform !== "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-run-storage-"));
  try {
    const source = join(directory, "run.tmp");
    const destination = join(directory, "run.json");
    writeFileSync(source, "new\n");
    writeFileSync(destination, "old\n");
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = [
      "$path = $env:HEADLESS_TEST_LOCK_PATH",
      "$stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
      "[Console]::Out.WriteLine('ready')",
      "Start-Sleep -Milliseconds 200",
      "$stream.Dispose()",
    ].join("; ");
    const locker = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, HEADLESS_TEST_LOCK_PATH: destination },
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    const lockerExit = once(locker, "exit");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        locker.stdout.off("data", onReady);
        locker.off("error", onError);
        locker.off("exit", onEarlyExit);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onEarlyExit = (code: number | null) => {
        cleanup();
        reject(new Error(`PowerShell lock holder exited before ready: ${code ?? "unknown"}`));
      };
      locker.stdout.once("data", onReady);
      locker.once("error", onError);
      locker.once("exit", onEarlyExit);
    });

    let replacementError: unknown;
    try {
      replaceRunStateFile(source, destination);
    } catch (error) {
      replacementError = error;
    }
    await lockerExit;
    if (replacementError) throw replacementError;

    assert.equal(readFileSync(destination, "utf8"), "new\n");
    assert.equal(existsSync(source), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

async function waitForProcessGroupExit(processGroupId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process group did not exit: ${processGroupId}`);
}
