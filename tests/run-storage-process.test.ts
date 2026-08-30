import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireNodeStoreLock,
  macosProcessStartIdentity,
  processTreeAliveFromProbes,
  windowsProcessStartIdentity,
  windowsProcessTreeAlive,
} from "../src/run-storage.ts";

function withTemporaryDirectory(callback: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "headless-run-storage-process-"));
  try {
    callback(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function agePath(path: string): void {
  const stale = new Date(Date.now() - 30_000);
  utimesSync(path, stale, stale);
}

async function captureLockOwnerWithIdentity(
  lockPath: string,
  processTreeRootPid: number,
): Promise<Record<string, unknown> & { processStartIdentity: string }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const release = acquireNodeStoreLock(lockPath, "worker-1", { processTreeRootPid });
    let owner: Record<string, unknown>;
    try {
      owner = JSON.parse(readFileSync(`${lockPath}.owner`, "utf8")) as Record<string, unknown>;
    } finally {
      release();
    }
    if (typeof owner.processStartIdentity === "string") {
      return { ...owner, processStartIdentity: owner.processStartIdentity };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("process start identity was not observable");
}

async function stopChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  const exited = once(child, "exit");
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await exited;
}

async function waitForChildReady(child: ReturnType<typeof spawn>): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(child, "message").then(([message]) => assert.equal(message, "ready")),
      once(child, "exit").then(([code, signal]) => {
        throw new Error(`child exited before ready: code=${code}, signal=${signal}`);
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("child readiness timed out")), 5_000);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test("node store lock preserves a live owner beyond the identity lifetime", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    const ownerPath = `${lockPath}.owner`;
    const releaseOwner = acquireNodeStoreLock(lockPath, "worker-1", { processTreeRootPid: process.pid });
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    owner.createdAtMs = 0;
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
    rmSync(lockPath, { recursive: true });

    try {
      assert.throws(() => acquireNodeStoreLock(lockPath, "worker-1"), /node is locked: worker-1/);
      assert.equal(existsSync(ownerPath), true);
    } finally {
      releaseOwner();
    }
  });
});

test("node store lock recovers when a live PID has a different start identity", async () => {
  const reusedProcess = spawn(
    process.execPath,
    ["-e", "process.send?.('ready'); setInterval(() => {}, 60_000)"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const reusedPid = reusedProcess.pid;
  assert.ok(reusedPid);
  try {
    await waitForChildReady(reusedProcess);
    const directory = mkdtempSync(join(tmpdir(), "headless-run-storage-process-"));
    try {
      const lockPath = join(directory, "session.lock");
      const ownerPath = `${lockPath}.owner`;
      const owner = await captureLockOwnerWithIdentity(lockPath, reusedPid);
      owner.processStartIdentity = `${owner.processStartIdentity}-reused`;
      writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
      let releaseReplacement: (() => void) | undefined;

      try {
        releaseReplacement = acquireNodeStoreLock(lockPath, "worker-1");
        releaseReplacement();
        releaseReplacement = undefined;
        assert.equal(existsSync(ownerPath), false);
      } finally {
        if (releaseReplacement) releaseReplacement();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  } finally {
    await stopChildProcess(reusedProcess);
  }
});

test("node store lock preserves an old identity-less live owner", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    mkdirSync(lockPath);
    writeFileSync(`${lockPath}.owner`, `${JSON.stringify({
      createdAtMs: 0,
      processTreeRootPid: process.pid,
    })}\n`);
    agePath(lockPath);

    assert.throws(() => acquireNodeStoreLock(lockPath, "worker-1"), /node is locked: worker-1/);
  });
});

test("node store lock recovers an old owner after its process tree exits", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    mkdirSync(lockPath);
    writeFileSync(`${lockPath}.owner`, `${JSON.stringify({
      createdAtMs: 0,
      processTreeRootPid: 99_999_999,
    })}\n`);
    agePath(lockPath);

    const release = acquireNodeStoreLock(lockPath, "worker-1");

    release();
    assert.equal(existsSync(`${lockPath}.owner`), false);
  });
});

test("node store lock rejects an out-of-range owner PID", () => {
  withTemporaryDirectory((directory) => {
    const lockPath = join(directory, "session.lock");
    mkdirSync(lockPath);
    writeFileSync(`${lockPath}.owner`, `${JSON.stringify({
      createdAtMs: Date.now(),
      processTreeRootPid: Number.MAX_SAFE_INTEGER,
    })}\n`);
    agePath(lockPath);

    const release = acquireNodeStoreLock(lockPath, "worker-1");

    release();
    assert.equal(existsSync(`${lockPath}.owner`), false);
  });
});

test("Windows process-tree probe releases only an explicit dead result", () => {
  const probe = (output: string) => windowsProcessTreeAlive(123, {
    execute: () => output,
    systemRoot: "C:\\Windows",
  });

  assert.equal(probe("HEADLESS_PROCESS_TREE_DEAD\r\n"), false);
  assert.equal(probe("HEADLESS_PROCESS_TREE_ALIVE\r\n"), true);
  assert.equal(probe(""), true);
  assert.equal(probe("0\r\n"), true);
  assert.equal(probe("warning\r\nHEADLESS_PROCESS_TREE_DEAD\r\n"), true);
});

test("Windows process-tree probe fails closed on execution errors", () => {
  assert.equal(windowsProcessTreeAlive(123, {
    execute: () => {
      throw new Error("CIM unavailable");
    },
  }), true);
});

test("Windows process-tree probe makes CIM failures terminating", () => {
  let command = "";
  windowsProcessTreeAlive(123, {
    execute: (_path, args) => {
      command = args.join(" ");
      return "HEADLESS_PROCESS_TREE_DEAD\n";
    },
  });

  assert.match(command, /ErrorActionPreference.*Stop/);
  assert.match(command, /rootPid = \[uint32\]123/);
  assert.match(command, /ProcessId -ne \$PID/);
  assert.doesNotMatch(command, /\$args/);
});

test("Windows process-start probe accepts only an explicit identity", () => {
  let command = "";
  const probe = (output: string) => windowsProcessStartIdentity(123, {
    execute: (_path, args) => {
      command = args.join(" ");
      return output;
    },
  });

  assert.equal(probe("HEADLESS_PROCESS_START:638920627920000000\r\n"), "win32:638920627920000000");
  assert.match(command, /rootPid = \[uint32\]123/);
  assert.doesNotMatch(command, /\$args/);
  assert.equal(probe(""), undefined);
  assert.equal(probe("638920627920000000\r\n"), undefined);
  assert.equal(probe("warning\r\nHEADLESS_PROCESS_START:638920627920000000\r\n"), undefined);
});

test("Windows process-start probe ignores execution errors", () => {
  assert.equal(windowsProcessStartIdentity(123, {
    execute: () => {
      throw new Error("CIM unavailable");
    },
  }), undefined);
});

test("macOS process-start probe canonicalizes timezone and locale", () => {
  let probeEnv: NodeJS.ProcessEnv | undefined;
  const identity = macosProcessStartIdentity(123, {
    env: { LC_ALL: "de_DE.UTF-8", TZ: "Pacific/Honolulu" },
    execute: (_command, _args, options) => {
      probeEnv = options.env;
      return "Sat Aug 29 17:00:00 2026\n";
    },
  });

  assert.equal(identity, "darwin:Sat Aug 29 17:00:00 2026");
  assert.equal(probeEnv?.LC_ALL, "C");
  assert.equal(probeEnv?.TZ, "UTC");
});

test("Windows probes descendants when a live root PID has been reused", () => {
  let probes = 0;
  const descendantsAlive = () => {
    probes += 1;
    return true;
  };

  assert.equal(processTreeAliveFromProbes("win32", true, true, descendantsAlive), true);
  assert.equal(probes, 1);
  assert.equal(processTreeAliveFromProbes("win32", true, true, () => false), false);
  assert.equal(processTreeAliveFromProbes("linux", true, true, descendantsAlive), false);
  assert.equal(probes, 1);
});
