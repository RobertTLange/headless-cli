import assert from "node:assert/strict";
import test from "node:test";

import { extractFinalMessage } from "../src/output.ts";

test("extracts final Codex assistant message from JSONL trace", () => {
  const trace = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "older answer" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "final codex answer" }],
      },
    }),
  ].join("\n");

  assert.equal(extractFinalMessage("codex", trace), "final codex answer");
});

test("extracts final Codex agent_message from item.completed trace", () => {
  const trace = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: "final codex agent message",
      },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");

  assert.equal(extractFinalMessage("codex", trace), "final codex agent message");
});

test("extracts final Claude assistant message from stream JSON trace", () => {
  const trace = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "final claude answer" }],
    },
  });

  assert.equal(extractFinalMessage("claude", trace), "final claude answer");
});

test("extracts final Claude assistant message from result JSON trace", () => {
  const trace = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "final claude result answer",
  });

  assert.equal(extractFinalMessage("claude", trace), "final claude result answer");
});

test("extracts final Cursor assistant message from stream JSON trace", () => {
  const trace = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "final cursor answer" }],
    },
  });

  assert.equal(extractFinalMessage("cursor", trace), "final cursor answer");
});

test("extracts final Gemini assistant message from JSON object trace", () => {
  const trace = JSON.stringify({
    type: "model",
    content: {
      parts: [{ text: "final gemini answer" }],
    },
  });

  assert.equal(extractFinalMessage("gemini", trace), "final gemini answer");
});

test("extracts final Gemini assistant message from response JSON trace", () => {
  const trace = JSON.stringify({
    response: "final gemini response answer",
  });

  assert.equal(extractFinalMessage("gemini", trace), "final gemini response answer");
});

test("concatenates Gemini assistant delta messages", () => {
  const trace = [
    JSON.stringify({ type: "message", role: "assistant", content: "Hello! I", delta: true }),
    JSON.stringify({
      type: "message",
      role: "assistant",
      content: "'m ready to help.",
      delta: true,
    }),
    JSON.stringify({ type: "result", status: "success" }),
  ].join("\n");

  assert.equal(extractFinalMessage("gemini", trace), "Hello! I'm ready to help.");
});

test("extracts final OpenCode assistant message from JSON event trace", () => {
  const trace = JSON.stringify({
    role: "assistant",
    parts: [{ type: "text", text: "final opencode answer" }],
  });

  assert.equal(extractFinalMessage("opencode", trace), "final opencode answer");
});

test("extracts final Pi assistant message from JSONL trace", () => {
  const trace = JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "final pi answer" }],
    },
  });

  assert.equal(extractFinalMessage("pi", trace), "final pi answer");
});

test("ignores tool results and returns empty string when no assistant text exists", () => {
  const trace = JSON.stringify({
    type: "message",
    message: {
      role: "toolresult",
      content: [{ type: "text", text: "tool output only" }],
    },
  });

  assert.equal(extractFinalMessage("pi", trace), "");
});
