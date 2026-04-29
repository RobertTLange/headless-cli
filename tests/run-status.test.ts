import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRunStatusReporter, parseRunStatusIntervalMs } from "../src/run-status.ts";
import { recordMessage, registerNode, updateNodeStatus } from "../src/runs.ts";

test("run status reporter emits initial summary and status transitions once", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-status-test-"));
  try {
    const env = { HOME: join(dir, "home") };
    registerNode(env, {
      runId: "auth",
      nodeId: "orchestrator",
      role: "orchestrator",
      agent: "codex",
      coordination: "session",
      status: "starting",
      planned: true,
    });
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "session",
      status: "planned",
      planned: true,
    });

    const lines: string[] = [];
    const reporter = createRunStatusReporter({
      now: () => new Date("2026-04-29T12:00:00.000Z"),
      env,
      intervalMs: 1000,
      runId: "auth",
      write: (text) => lines.push(text),
    });

    reporter.poll();
    updateNodeStatus(env, "auth", "orchestrator", "busy");
    reporter.poll();
    reporter.poll();

    assert.equal(lines.filter((line) => line.includes("INFO  headless run auth started orchestrator")).length, 1);
    assert.equal(lines.filter((line) => line.includes("INFO  headless run auth orchestrator starting -> busy")).length, 1);
    assert.match(lines.join(""), /^2026-04-29T12:00:00\.000Z INFO  headless run auth/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run status reporter emits message routes without prompt text", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-status-test-"));
  try {
    const env = { HOME: join(dir, "home") };
    registerNode(env, {
      runId: "auth",
      nodeId: "orchestrator",
      role: "orchestrator",
      agent: "codex",
      coordination: "session",
      status: "busy",
      planned: true,
    });
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "session",
      status: "planned",
      planned: true,
    });

    const lines: string[] = [];
    const reporter = createRunStatusReporter({
      now: () => new Date("2026-04-29T12:00:00.000Z"),
      env,
      intervalMs: 1000,
      runId: "auth",
      write: (text) => lines.push(text),
    });

    reporter.poll();
    recordMessage(env, "auth", "orchestrator", "worker-1", "secret prompt text");
    reporter.poll();

    assert.match(lines.join(""), /2026-04-29T12:00:00\.000Z INFO  headless run auth message orchestrator -> worker-1/);
    assert.doesNotMatch(lines.join(""), /secret prompt text/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run status reporter emits final idle summary on stop", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-status-test-"));
  try {
    const env = { HOME: join(dir, "home") };
    registerNode(env, {
      runId: "auth",
      nodeId: "orchestrator",
      role: "orchestrator",
      agent: "codex",
      coordination: "session",
      status: "busy",
      planned: true,
    });
    registerNode(env, {
      runId: "auth",
      nodeId: "worker-1",
      role: "worker",
      agent: "codex",
      coordination: "session",
      status: "idle",
      planned: true,
    });

    const lines: string[] = [];
    const reporter = createRunStatusReporter({
      now: () => new Date("2026-04-29T12:00:00.000Z"),
      env,
      intervalMs: 1000,
      runId: "auth",
      write: (text) => lines.push(text),
    });

    reporter.poll();
    updateNodeStatus(env, "auth", "orchestrator", "idle");
    reporter.stop();

    assert.match(lines.join(""), /2026-04-29T12:00:00\.000Z OK    headless run auth idle \(0 active; 2 idle\)/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run status reporter colors log levels and statuses when enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-status-test-"));
  try {
    const env = { HOME: join(dir, "home") };
    registerNode(env, {
      runId: "auth",
      nodeId: "orchestrator",
      role: "orchestrator",
      agent: "codex",
      coordination: "session",
      status: "starting",
      planned: true,
    });

    const lines: string[] = [];
    const reporter = createRunStatusReporter({
      color: true,
      now: () => new Date("2026-04-29T12:00:00.000Z"),
      env,
      intervalMs: 1000,
      runId: "auth",
      write: (text) => lines.push(text),
    });

    reporter.poll();
    updateNodeStatus(env, "auth", "orchestrator", "busy");
    reporter.poll();

    assert.match(lines.join(""), /\x1b\[36mINFO\x1b\[0m/);
    assert.match(lines.join(""), /\x1b\[33mstarting\x1b\[0m -> \x1b\[33mbusy\x1b\[0m/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("NO_COLOR disables run status colors", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-run-status-test-"));
  try {
    const env = { HOME: join(dir, "home"), NO_COLOR: "1" };
    registerNode(env, {
      runId: "auth",
      nodeId: "orchestrator",
      role: "orchestrator",
      agent: "codex",
      coordination: "session",
      status: "starting",
      planned: true,
    });

    const lines: string[] = [];
    const reporter = createRunStatusReporter({
      color: true,
      now: () => new Date("2026-04-29T12:00:00.000Z"),
      env,
      intervalMs: 1000,
      runId: "auth",
      write: (text) => lines.push(text),
    });

    reporter.poll();

    assert.doesNotMatch(lines.join(""), /\x1b\[/);
    assert.match(lines.join(""), /2026-04-29T12:00:00\.000Z INFO  headless run auth started orchestrator/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run status interval parser falls back for invalid values", () => {
  assert.equal(parseRunStatusIntervalMs(undefined), 1000);
  assert.equal(parseRunStatusIntervalMs("25"), 25);
  assert.equal(parseRunStatusIntervalMs("-1"), 1000);
  assert.equal(parseRunStatusIntervalMs("bad"), 1000);
});
