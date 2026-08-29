import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  acquireNodeStoreLock,
  acquireRunStoreLock,
  isRunStoreLockSignalListener,
  removeRunStoreLockSignalListeners,
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

    assert.equal(statSync(ownerPath).mode & 0o777, 0o600);
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
