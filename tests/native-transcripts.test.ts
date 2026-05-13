import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  deriveNativeTranscriptActivity,
  indexNativeAssistantCompletion,
  resolveLatestNativeTranscript,
  resolveNativeTranscript,
} from "../src/native-transcripts.ts";

test("resolves native transcript files for jsonl-backed agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    mkdirSync(workDir, { recursive: true });
    const realWorkDir = realpathSync(workDir);
    const claudePath = join(home, ".claude", "projects", realWorkDir.replace(/\//g, "-"), "claude-session.jsonl");
    const codexPath = join(home, ".codex", "sessions", "2026", "05", "13", "rollout-2026-05-13T11-12-33-codex-thread.jsonl");
    const cursorPath = join(
      home,
      ".cursor",
      "projects",
      realWorkDir.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-"),
      "agent-transcripts",
      "cursor-session",
      "cursor-session.jsonl",
    );
    const geminiPath = join(home, ".gemini", "tmp", "gemini-7", "chats", "session-2026-05-13T09-12-gemini-s.jsonl");
    const piPath = join(home, ".pi", "agent", "sessions", "--work--", "pi-session.jsonl");
    for (const path of [claudePath, codexPath, cursorPath, geminiPath, piPath]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ type: "assistant", content: "done" })}\n`);
    }
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "projects.json"), `${JSON.stringify({ [workDir]: "gemini-7" })}\n`);

    assert.deepEqual(resolveNativeTranscript("claude", "claude-session", workDir, { HOME: home })?.path, claudePath);
    assert.deepEqual(resolveNativeTranscript("codex", "codex-thread", workDir, { HOME: home })?.path, codexPath);
    assert.deepEqual(resolveNativeTranscript("cursor", "cursor-session", workDir, { HOME: home })?.path, cursorPath);
    assert.deepEqual(resolveNativeTranscript("gemini", "gemini-session", workDir, { HOME: home })?.path, geminiPath);
    assert.deepEqual(resolveNativeTranscript("pi", piPath, workDir, { HOME: home })?.path, piPath);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolves gemini transcripts from nested projects config", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    mkdirSync(workDir, { recursive: true });
    const realWorkDir = realpathSync(workDir);
    const geminiPath = join(home, ".gemini", "tmp", "gemini-3", "chats", "session-2026-05-13T09-38-8b04386a.jsonl");
    mkdirSync(dirname(geminiPath), { recursive: true });
    writeFileSync(geminiPath, `${JSON.stringify({ type: "gemini", content: "done" })}\n`);
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "projects.json"), `${JSON.stringify({ projects: { [realWorkDir]: "gemini-3" } })}\n`);

    assert.deepEqual(
      resolveNativeTranscript("gemini", "8b04386a-4c08-41ab-ba34-e7c7db908091", workDir, { HOME: home })?.path,
      geminiPath,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolves the latest native transcript for a workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    const otherWorkDir = join(dir, "other");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(otherWorkDir, { recursive: true });
    const realWorkDir = realpathSync(workDir);
    const nativeDir = join(home, ".codex", "sessions", "2026", "05", "13");
    const olderPath = join(nativeDir, "rollout-older-thread.jsonl");
    const latestPath = join(nativeDir, "rollout-latest-thread.jsonl");
    const otherPath = join(nativeDir, "rollout-other-thread.jsonl");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(
      olderPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "older-thread", cwd: realWorkDir } })}\n`,
    );
    writeFileSync(
      latestPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "latest-thread", cwd: realWorkDir } })}\n`,
    );
    writeFileSync(
      otherPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "other-thread", cwd: realpathSync(otherWorkDir) } })}\n`,
    );
    utimesSync(olderPath, new Date("2026-05-13T10:00:00.000Z"), new Date("2026-05-13T10:00:00.000Z"));
    utimesSync(latestPath, new Date("2026-05-13T10:01:00.000Z"), new Date("2026-05-13T10:01:00.000Z"));
    utimesSync(otherPath, new Date("2026-05-13T10:02:00.000Z"), new Date("2026-05-13T10:02:00.000Z"));

    assert.equal(resolveLatestNativeTranscript("codex", workDir, { HOME: home })?.path, latestPath);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolves latest native transcripts after a start time", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "work");
    mkdirSync(workDir, { recursive: true });
    const realWorkDir = realpathSync(workDir);
    const nativeDir = join(home, ".codex", "sessions", "2026", "05", "13");
    const oldPath = join(nativeDir, "rollout-old-thread.jsonl");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(oldPath, `${JSON.stringify({ type: "session_meta", payload: { id: "old-thread", cwd: realWorkDir } })}\n`);
    const afterOldFile = new Date(Date.now() + 10_000).toISOString();

    assert.equal(resolveLatestNativeTranscript("codex", workDir, { HOME: home }, { startedAt: afterOldFile }), undefined);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("indexes the latest assistant completion from a native transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const path = join(dir, "transcript.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "older" }] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "latest" }] } }),
        "",
      ].join("\n"),
    );

    assert.deepEqual(indexNativeAssistantCompletion("claude", { kind: "jsonl", path }), {
      message: "latest",
      source: "native-transcript",
      path,
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test(
  "indexes an opencode assistant completion from sqlite",
  { skip: spawnSync("sqlite3", ["--version"]).status !== 0 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
    try {
      const path = join(dir, "opencode.db");
      const sessionId = "ses_test";
      const sql = `
create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
insert into message values ('user_msg', '${sessionId}', 1, 1, '{"role":"user"}');
insert into part values ('user_part', 'user_msg', '${sessionId}', 1, 1, '{"type":"text","text":"prompt"}');
insert into message values ('assistant_msg', '${sessionId}', 2, 2, '{"role":"assistant"}');
insert into part values ('assistant_part', 'assistant_msg', '${sessionId}', 3, 3, '{"type":"text","text":"native final","metadata":{"openai":{"phase":"final_answer"}}}');
`;
      const created = spawnSync("sqlite3", [path, sql], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);

      assert.deepEqual(indexNativeAssistantCompletion("opencode", { kind: "sqlite", path, sessionId }), {
        message: "native final",
        source: "native-transcript",
        path,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
);

test("derives idle from native terminal markers for jsonl-backed agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const cases = [
      {
        agent: "codex" as const,
        records: [
          { timestamp: "2026-02-12T10:00:00.000Z", type: "session_meta", payload: { id: "codex-complete" } },
          {
            timestamp: "2026-02-12T10:00:01.000Z",
            type: "response_item",
            payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
          },
          { timestamp: "2026-02-12T10:00:02.000Z", type: "event_msg", payload: { type: "task_complete" } },
        ],
      },
      {
        agent: "claude" as const,
        records: [
          {
            timestamp: "2026-02-12T10:00:00.000Z",
            type: "assistant",
            message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
          },
          { type: "last-prompt" },
        ],
      },
      {
        agent: "pi" as const,
        records: [
          {
            timestamp: "2026-02-12T10:00:00.000Z",
            type: "message",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Done.", textSignature: "{\"phase\":\"final_answer\"}" }],
            },
          },
        ],
      },
      {
        agent: "gemini" as const,
        records: [
          { timestamp: "2026-02-12T10:00:00.000Z", type: "gemini", content: "Done." },
          { $set: { lastUpdated: "2026-02-12T10:00:00.000Z" } },
        ],
      },
      {
        agent: "cursor" as const,
        records: [{ role: "assistant", message: { content: [{ type: "text", text: "Done." }] } }],
      },
    ];

    for (const item of cases) {
      const path = join(dir, `${item.agent}.jsonl`);
      writeFileSync(path, `${item.records.map((record) => JSON.stringify(record)).join("\n")}\n`);

      assert.deepEqual(deriveNativeTranscriptActivity(item.agent, { kind: "jsonl", path }, { nowMs: Date.now() })?.status, "idle");
      assert.equal(deriveNativeTranscriptActivity(item.agent, { kind: "jsonl", path }, { nowMs: Date.now() })?.reason, "terminal_done");
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("derives waiting input before terminal idle when assistant asks for confirmation", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const path = join(dir, "codex-waiting.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-02-12T10:00:00.000Z", type: "session_meta", payload: { id: "waiting" } }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Would you like me to run the full gate now?" }],
          },
        }),
        JSON.stringify({ timestamp: "2026-02-12T10:00:02.000Z", type: "event_msg", payload: { type: "task_complete" } }),
      ].join("\n"),
    );

    const activity = deriveNativeTranscriptActivity("codex", { kind: "jsonl", path }, { nowMs: Date.now() });

    assert.equal(activity?.status, "waiting_input");
    assert.equal(activity?.reason, "explicit_wait_marker_fresh");
    assert.equal(activity?.message, "Would you like me to run the full gate now?");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("derives running from unmatched native tool calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
  try {
    const path = join(dir, "codex-running.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "response_item",
        payload: { type: "function_call", call_id: "call_1", name: "run_command", arguments: "{}" },
      })}\n`,
    );

    const activity = deriveNativeTranscriptActivity("codex", { kind: "jsonl", path }, { nowMs: Date.now() });

    assert.equal(activity?.status, "running");
    assert.equal(activity?.reason, "pending_tool_use_fresh");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test(
  "derives opencode idle from sqlite step-finish stop",
  { skip: spawnSync("sqlite3", ["--version"]).status !== 0 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-native-transcripts-test-"));
    try {
      const path = join(dir, "opencode.db");
      const sessionId = "ses_activity";
      const sql = `
create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
insert into message values ('assistant_msg', '${sessionId}', 1, 3, '{"role":"assistant"}');
insert into part values ('text_part', 'assistant_msg', '${sessionId}', 2, 2, '{"type":"text","text":"done","metadata":{"openai":{"phase":"final_answer"}}}');
insert into part values ('finish_part', 'assistant_msg', '${sessionId}', 3, 3, '{"type":"step-finish","reason":"stop"}');
`;
      const created = spawnSync("sqlite3", [path, sql], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);

      const activity = deriveNativeTranscriptActivity("opencode", { kind: "sqlite", path, sessionId }, { nowMs: Date.now() });

      assert.equal(activity?.status, "idle");
      assert.equal(activity?.reason, "terminal_done");
      assert.equal(activity?.message, "done");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
);
