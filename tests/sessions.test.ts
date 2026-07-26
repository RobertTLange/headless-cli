import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readStoredSession,
  SECURE_SESSION_STORE_ENV,
  writeStoredSession,
} from "../src/sessions.ts";

test("secure session stores reject symlinks and oversized files", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sessions-test-"));
  try {
    const storeDir = join(dir, ".headless");
    const storePath = join(storeDir, "sessions.json");
    const external = join(dir, "external.json");
    const env = { HOME: dir, [SECURE_SESSION_STORE_ENV]: "1" };
    mkdirSync(storeDir);
    writeFileSync(external, "{}\n");
    symlinkSync(external, storePath);

    assert.throws(() => readStoredSession(env, "codex", "work"), /ELOOP/);
    assert.equal(readFileSync(external, "utf8"), "{}\n");

    rmSync(storePath);
    const fifo = spawnSync("mkfifo", [storePath], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);
    assert.throws(() => readStoredSession(env, "codex", "work"), /bounded regular file/);
    rmSync(storePath);
    writeFileSync(storePath, "");
    truncateSync(storePath, 1024 * 1024 + 1);
    assert.throws(() => readStoredSession(env, "codex", "work"), /bounded regular file/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("secure session stores validate records and write private files atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-sessions-test-"));
  try {
    const storeDir = join(dir, ".headless");
    const storePath = join(storeDir, "sessions.json");
    const env = { HOME: dir, [SECURE_SESSION_STORE_ENV]: "1" };
    mkdirSync(storeDir);
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        agents: {
          codex: {
            work: {
              agent: "codex",
              alias: "different",
              nativeId: "untrusted",
              createdAt: "now",
              updatedAt: "now",
            },
          },
        },
      }),
    );
    assert.equal(readStoredSession(env, "codex", "work"), undefined);

    writeStoredSession(env, {
      agent: "codex",
      alias: "work",
      nativeId: "trusted",
      workDir: dir,
    });
    assert.equal(readStoredSession(env, "codex", "work")?.nativeId, "trusted");
    assert.equal(statSync(storePath).mode & 0o777, 0o600);

    const longAlias = "a".repeat(300);
    writeStoredSession(env, {
      agent: "codex",
      alias: longAlias,
      nativeId: "long-session",
      workDir: dir,
    });
    assert.equal(readStoredSession(env, "codex", longAlias)?.nativeId, "long-session");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
