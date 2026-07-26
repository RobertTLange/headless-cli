import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveLatestNativeTranscript } from "../src/native-transcripts.ts";

test("rejects Gemini project slots that escape the transcript root", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    mkdirSync(workDir);
    writeFileSync(
      join(home, ".gemini", "projects.json"),
      `${JSON.stringify({ [realpathSync(workDir)]: "../../outside" })}\n`,
    );

    assert.equal(
      resolveLatestNativeTranscript("gemini", workDir, { HOME: home }, {}, { dockerSessionRoot: home }),
      undefined,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("does not canonicalize Gemini project keys supplied by Docker state", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    const workAlias = join(dir, "work-alias");
    const transcript = join(home, ".gemini", "tmp", "gemini-1", "chats", "session-now-id.jsonl");
    mkdirSync(dirname(transcript), { recursive: true });
    mkdirSync(workDir);
    symlinkSync(workDir, workAlias);
    writeFileSync(join(home, ".gemini", "projects.json"), `${JSON.stringify({ [workAlias]: "gemini-1" })}\n`);
    writeFileSync(transcript, "{}\n");

    assert.equal(resolveLatestNativeTranscript("gemini", workDir, { HOME: home })?.path, transcript);
    assert.equal(
      resolveLatestNativeTranscript("gemini", workDir, { HOME: home }, {}, { dockerSessionRoot: home }),
      undefined,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects symlinked Antigravity transcripts in Docker session homes", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    const external = join(dir, "external.jsonl");
    const transcript = join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      "conversation",
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    mkdirSync(dirname(transcript), { recursive: true });
    mkdirSync(workDir);
    writeFileSync(external, "{}\n");
    symlinkSync(external, transcript);

    assert.throws(
      () => resolveLatestNativeTranscript(
        "antigravity",
        workDir,
        { HOME: home },
        {},
        { dockerSessionRoot: home },
      ),
      /unsafe Docker transcript state path/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects symlinked Pi transcript trees in Docker session homes", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    mkdirSync(workDir);
    const projectRoot = join(
      home,
      ".pi",
      "agent",
      "sessions",
      `--${realpathSync(workDir).replace(/^\/+/, "").replace(/[\\/]+/g, "-")}--`,
    );
    mkdirSync(dirname(projectRoot), { recursive: true });
    symlinkSync(dir, projectRoot);

    assert.throws(
      () => resolveLatestNativeTranscript("pi", workDir, { HOME: home }, {}, { dockerSessionRoot: home }),
      /unsafe Docker transcript state path/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects oversized OpenCode databases in Docker session homes", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    const database = join(home, ".local", "share", "opencode", "opencode.db");
    mkdirSync(dirname(database), { recursive: true });
    mkdirSync(workDir);
    writeFileSync(database, "");
    truncateSync(database, 256 * 1024 * 1024 + 1);

    assert.throws(
      () => resolveLatestNativeTranscript("opencode", workDir, { HOME: home }, {}, { dockerSessionRoot: home }),
      /unsafe Docker transcript state path/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects symlinked OpenCode database sidecars in Docker session homes", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    const database = join(home, ".local", "share", "opencode", "opencode.db");
    const external = join(dir, "external-wal");
    mkdirSync(dirname(database), { recursive: true });
    mkdirSync(workDir);
    writeFileSync(database, "");
    writeFileSync(external, "");
    symlinkSync(external, `${database}-wal`);

    assert.throws(
      () => resolveLatestNativeTranscript("opencode", workDir, { HOME: home }, {}, { dockerSessionRoot: home }),
      /unsafe Docker transcript state path/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test(
  "reads valid OpenCode session IDs from Docker databases in safe read-only mode",
  { skip: spawnSync("sqlite3", ["--version"]).status !== 0 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
    try {
      const home = join(dir, "home");
      const workDir = join(dir, "work");
      const database = join(home, ".local", "share", "opencode", "opencode.db");
      mkdirSync(dirname(database), { recursive: true });
      mkdirSync(workDir);
      const sql = [
        "create table session (id text, directory text, time_updated integer);",
        `insert into session values ('ses_valid-1', '${realpathSync(workDir).replaceAll("'", "''")}', 1);`,
      ].join("\n");
      const created = spawnSync("sqlite3", [database, sql], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
      assert.equal(
        resolveLatestNativeTranscript(
          "opencode",
          workDir,
          { HOME: home },
          {},
          { dockerSessionRoot: home },
        )?.sessionId,
        "ses_valid-1",
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
);

test(
  "rejects oversized OpenCode session IDs from Docker databases",
  { skip: spawnSync("sqlite3", ["--version"]).status !== 0 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
    try {
      const home = join(dir, "home");
      const workDir = join(dir, "work");
      const database = join(home, ".local", "share", "opencode", "opencode.db");
      mkdirSync(dirname(database), { recursive: true });
      mkdirSync(workDir);
      const sql = [
        "create table session (id text, directory text, time_updated integer);",
        `insert into session values ('${"a".repeat(300)}', '${realpathSync(workDir).replaceAll("'", "''")}', 1);`,
      ].join("\n");
      const created = spawnSync("sqlite3", [database, sql], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
      assert.equal(
        resolveLatestNativeTranscript(
          "opencode",
          workDir,
          { HOME: home },
          {},
          { dockerSessionRoot: home },
        ),
        undefined,
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
);

test("bounds Antigravity Docker transcript scans and ignores harmless brain metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    const workAlias = join(dir, "work-alias");
    const root = join(home, ".gemini", "antigravity-cli");
    const transcript = join(root, "brain", "conversation", "transcript.jsonl");
    mkdirSync(dirname(transcript), { recursive: true });
    mkdirSync(join(root, "cache"));
    mkdirSync(workDir);
    symlinkSync(workDir, workAlias);
    writeFileSync(join(root, "brain", ".DS_Store"), "metadata");
    writeFileSync(
      join(root, "cache", "last_conversations.json"),
      `${JSON.stringify({ [workAlias]: "conversation" })}\n`,
      { flag: "w" },
    );
    writeFileSync(transcript, `${JSON.stringify({ cwd: workAlias })}\n${"\n".repeat(1024 * 1024)}`);

    assert.equal(resolveLatestNativeTranscript("antigravity", workDir, { HOME: home })?.path, transcript);
    assert.equal(
      resolveLatestNativeTranscript("antigravity", workDir, { HOME: home }, {}, { dockerSessionRoot: home }),
      undefined,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
