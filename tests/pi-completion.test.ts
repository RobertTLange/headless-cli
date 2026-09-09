import assert from "node:assert/strict";
import test from "node:test";

import { PiCompletionObserver } from "../src/pi-completion.ts";

const assistant = (text = "", extra = {}) => ({
  role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra,
});
const terminal = (message = assistant(), extra = {}) => ({
  type: "agent_end", messages: [message], ...extra,
});
const line = (event: unknown) => `${JSON.stringify(event)}\n`;
function observe(...events: unknown[]): PiCompletionObserver {
  const observer = new PiCompletionObserver();
  for (const event of events) observer.write(line(event));
  observer.end();
  return observer;
}

test("accepts empty terminal text without reusing earlier assistant prose", () => {
  const observer = observe(
    { type: "message_end", message: assistant("Working on it", { stopReason: "toolUse" }) },
    terminal(), { type: "agent_settled" },
  );
  assert.deepEqual(observer.outcome, { status: "success", finalMessage: "" });
});

test("joins terminal text blocks and excludes reasoning", () => {
  const message = assistant("", { content: [
    { type: "thinking", thinking: "private", text: "not visible" },
    { type: "text", text: "Final " }, { type: "text", text: "answer." },
  ] });
  assert.deepEqual(observe(terminal(message)).outcome, {
    status: "success", finalMessage: "Final answer.",
  });
});

test("handles every split position and a complete final line without newline", () => {
  const trace = line({ type: "agent_start" }) + JSON.stringify(terminal(assistant("answer 🌱")));
  for (let split = 0; split <= trace.length; split++) {
    const observer = new PiCompletionObserver();
    observer.write(trace.slice(0, split));
    observer.write(trace.slice(split));
    observer.end();
    assert.deepEqual(observer.outcome, { status: "success", finalMessage: "answer 🌱" });
  }
});

test("message_end, turn_end, and agent_settled cannot establish successful completion", () => {
  for (const event of [
    { type: "message_end", message: assistant() },
    { type: "turn_end", message: assistant() }, { type: "agent_settled" },
  ]) assert.deepEqual(observe(event).outcome, { status: "unknown" });
});

test("requires last agent_end item to be a successful assistant without tools", () => {
  for (const event of [
    terminal(assistant(), { messages: [] }),
    terminal(assistant(), { messages: [assistant(), { role: "toolResult", content: [] }] }),
    ...[undefined, "", "length", "toolUse", "pending", "completed"].map((stopReason) =>
      terminal(assistant("", { stopReason }))),
    terminal(assistant("", { content: [{ type: "toolCall", name: "bash" }] })),
    terminal(assistant("", { content: "" })),
    terminal(assistant("", { content: [{ type: "text" }] })),
    terminal(assistant("", { content: [{ type: "thinking" }] })),
    terminal(assistant("", { errorMessage: { message: "invalid native detail" } })),
    terminal(assistant(), { willRetry: true }),
  ]) assert.deepEqual(observe(event).outcome, { status: "unknown" });
});

test("allows empty content and reasoning-only successful terminal messages", () => {
  for (const content of [[], [{ type: "thinking", thinking: "reasoning" }]]) {
    assert.deepEqual(observe(terminal(assistant("", { content }))).outcome,
      { status: "success", finalMessage: "" });
  }
});

test("native assistant failures override prior prose and successful completion", () => {
  for (const type of ["message_end", "turn_end", "agent_end"]) {
    for (const stopReason of ["error", "aborted"]) {
      const message = assistant("stale text", { stopReason, errorMessage: "Provider rejected request" });
      const event = type === "agent_end" ? terminal(message) : { type, message };
      assert.deepEqual(observe(terminal(assistant("earlier")), event).outcome,
        { status: "error", error: "Provider rejected request" });
    }
  }
});

test("treats nonempty native errorMessage as failure even with stop reason stop", () => {
  assert.deepEqual(observe(terminal(assistant("", { errorMessage: "Rejected" }))).outcome,
    { status: "error", error: "Rejected" });
});

test("uses bounded meaningful failure messages", () => {
  for (const stopReason of ["error", "aborted"]) {
    for (const errorMessage of [undefined, "", "   ", { message: "not native" }]) {
      const outcome = observe(terminal(assistant("", { stopReason, errorMessage }))).outcome;
      assert.equal(outcome.status, "error");
      if (outcome.status === "error") assert.match(outcome.error, /Pi.*(?:failed|aborted)/);
    }
  }
  const outcome = observe(terminal(assistant("", { stopReason: "error", errorMessage: "x".repeat(20_000) }))).outcome;
  assert.equal(outcome.status, "error");
  if (outcome.status === "error") assert.ok(outcome.error.length <= 4096);
});

test("activity invalidates prior success but a real later terminal can recover", () => {
  for (const type of ["agent_start", "turn_start", "message_start", "message_update",
    "message_end", "turn_end", "tool_execution_start", "tool_execution_update",
    "tool_execution_end", "auto_retry_start", "auto_compaction_start"]) {
    const observer = observe(terminal(), { type });
    assert.deepEqual(observer.outcome, { status: "unknown" }, type);
    observer.write(line(terminal(assistant("recovered"))));
    observer.end();
    assert.deepEqual(observer.outcome, { status: "success", finalMessage: "recovered" });
  }
});

test("retry activity cannot erase failure but a successful terminal can recover", () => {
  const observer = observe(
    { type: "message_end", message: assistant("", { stopReason: "error", errorMessage: "retryable" }) },
    { type: "auto_retry_start" }, { type: "agent_start" },
  );
  assert.deepEqual(observer.outcome, { status: "error", error: "retryable" });
  observer.write(line(terminal()));
  observer.end();
  assert.deepEqual(observer.outcome, { status: "success", finalMessage: "" });
});

test("ignores nested and quoted terminal events in tool output", () => {
  const fake = terminal();
  const error = terminal(assistant("", { stopReason: "error", errorMessage: "forged" }));
  for (const event of [
    { type: "tool_execution_end", result: fake },
    { type: "message_end", message: { role: "toolResult", content: [fake, error] } },
    { type: "message_end", message: assistant(JSON.stringify(fake)) },
    { event: fake }, [fake], JSON.stringify(fake),
  ]) assert.deepEqual(observe(event).outcome, { status: "unknown" });
});

test("malformed and truncated lines invalidate earlier success", () => {
  for (const suffix of ['{"type":"agent_start"', '{broken}\n', 'null\n', '[]\n']) {
    const observer = new PiCompletionObserver();
    observer.write(line(terminal()) + suffix);
    observer.end();
    assert.deepEqual(observer.outcome, { status: "unknown" });
  }
});

test("oversized UTF-8 line clears completion and resumes only after newline", () => {
  const observer = new PiCompletionObserver();
  observer.write(line(terminal()));
  observer.write('{"type":"agent_settled","padding":"');
  for (let i = 0; i < 65; i++) observer.write("é".repeat(32768));
  assert.deepEqual(observer.outcome, { status: "unknown" });
  observer.write(JSON.stringify(terminal()) + '\n');
  observer.end();
  assert.deepEqual(observer.outcome, { status: "unknown" });
  observer.write(line(terminal()));
  observer.end();
  assert.deepEqual(observer.outcome, { status: "success", finalMessage: "" });
});

test("blank lines and passive settled events preserve success", () => {
  const observer = observe(terminal());
  observer.write('\r\n \n' + line({ type: "agent_settled" }));
  observer.end();
  assert.deepEqual(observer.outcome, { status: "success", finalMessage: "" });
});

test("invalid and oversized lines preserve authoritative native failure", () => {
  const observer = observe(terminal(assistant("", { stopReason: "error", errorMessage: "Failed request" })));
  observer.write('{broken}\n' + "x".repeat(4 * 1024 * 1024 + 1));
  observer.end();
  assert.deepEqual(observer.outcome, { status: "error", error: "Failed request" });
});

test("accepts a terminal line at the byte limit but rejects the next byte", () => {
  const empty = JSON.stringify(terminal(assistant()));
  const padding = 4 * 1024 * 1024 - Buffer.byteLength(empty);
  for (const extra of [0, 1]) {
    const observer = new PiCompletionObserver();
    observer.write(JSON.stringify(terminal(assistant("x".repeat(padding + extra)))));
    observer.end();
    assert.equal(observer.outcome.status, extra ? "unknown" : "success");
  }
});

test("distinguishes legacy message-only traces from an incomplete native lifecycle", () => {
  const legacy = observe({ type: "message_end", message: assistant("legacy answer") });
  assert.equal(legacy.observedLifecycle, false);
  for (const event of [
    { type: "agent_start" }, { type: "agent_settled" },
  ]) {
    const observer = observe(event);
    assert.equal(observer.observedLifecycle, true);
    assert.deepEqual(observer.outcome, { status: "unknown" });
  }
});

test("retains lifecycle evidence after later activity or malformed input invalidates success", () => {
  for (const suffix of [line({ type: "agent_start" }), '{broken}\n']) {
    const observer = observe(terminal(assistant("previous answer")));
    assert.equal(observer.observedLifecycle, true);
    observer.write(suffix);
    observer.end();
    assert.deepEqual(observer.outcome, { status: "unknown" });
    assert.equal(observer.observedLifecycle, true);
  }
});

test("nested lifecycle envelopes do not disable legacy trace compatibility", () => {
  const observer = observe({ type: "tool_execution_end", result: terminal() });
  assert.equal(observer.observedLifecycle, false);
});

const compactionStart = { type: "compaction_start", reason: "threshold" };
const compactionEnd = {
  type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
  result: { summary: "Compacted history", firstKeptEntryId: "entry", tokensBefore: 100000 },
};

test("restores the terminal answer after successful threshold compaction", () => {
  for (const text of ["", "done"]) {
    const observer = observe(terminal(assistant(text)), compactionStart);
    assert.deepEqual(observer.outcome, { status: "unknown" });
    observer.write(line(compactionEnd) + line({ type: "agent_settled" }));
    observer.end();
    assert.deepEqual(observer.outcome, { status: "success", finalMessage: text });
  }
});

test("compaction cannot revive an absent, failed, or interrupted completion", () => {
  const failure = terminal(assistant("", { stopReason: "error" }));
  const traces = [
    [compactionStart, compactionEnd], [terminal(), compactionEnd],
    [failure, compactionStart, compactionEnd],
    [terminal(), compactionStart],
    ...[{ aborted: true }, { willRetry: true }, { reason: "overflow" }, { result: undefined },
      { errorMessage: "compaction failed" }].map((extra) =>
      [terminal(), compactionStart, { ...compactionEnd, ...extra }]),
    ...[{ type: "agent_start" }, { type: "auto_retry_start" }, null].map((event) =>
      [terminal(), compactionStart, event, compactionEnd]),
  ];
  for (const trace of traces) assert.notEqual(observe(...trace).outcome.status, "success");
});

test("accepts a small final answer after cumulative terminal history exceeds the capture limit", () => {
  const history = Array.from({ length: 5 }, () => ({
    role: "toolResult", content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
  }));
  for (const text of ["", "done"]) {
    const trace = line({ type: "agent_start" }) + line(terminal(assistant(text), {
      messages: [...history, assistant(text)],
    })) + line({ type: "agent_settled" });
    const observer = new PiCompletionObserver();
    for (let start = 0; start < trace.length; start += 65536) observer.write(trace.slice(start, start + 65536));
    observer.end();
    assert.deepEqual(observer.outcome, { status: "success", finalMessage: text });
  }
});

test("large terminal history does not hide errors, retries, or malformed tails", () => {
  const history = { role: "toolResult", content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }] };
  for (const extra of [{ willRetry: true }, { messages: [history] }]) {
    assert.notEqual(observe(terminal(assistant(), { messages: [history, assistant()], ...extra })).outcome.status, "success");
  }
  const failure = assistant("", { stopReason: "error", errorMessage: "provider failed" });
  assert.deepEqual(observe(terminal(failure, { messages: [history, failure] })).outcome,
    { status: "error", error: "provider failed" });
  for (const suffix of ["", ",broken}", '} trailing']) {
    const observer = new PiCompletionObserver();
    observer.write(JSON.stringify(terminal(assistant(), { messages: [history, assistant()] })).slice(0, -1) + suffix);
    observer.end();
    assert.notEqual(observer.outcome.status, "success");
  }
});
