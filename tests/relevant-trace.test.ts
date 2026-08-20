import assert from "node:assert/strict";
import test from "node:test";

import { compactOversizedTraceLine } from "../src/relevant-trace.ts";

test("oversized trace compaction preserves only valid top-level usage", () => {
  assert.equal(compactOversizedTraceLine("claude", '{"type":"result","usage":'), "");

  const compacted = compactOversizedTraceLine(
    "claude",
    JSON.stringify({
      type: "tool",
      payload: { usage: { input_tokens: 999 }, total_cost_usd: 99 },
      result: "x".repeat(300_000),
    }),
  );

  assert.deepEqual(JSON.parse(compacted), { type: "tool" });
});

test("oversized Pi trace compaction preserves assistant usage identity", () => {
  const compacted = compactOversizedTraceLine(
    "pi",
    JSON.stringify({
      type: "message_end",
      result: "x".repeat(300_000),
      message: {
        role: "assistant",
        model: "gpt-test",
        provider: "openai",
        usage: { input: 10, cacheRead: 3, cacheWrite: 0, output: 2 },
      },
    }),
  );

  assert.equal(JSON.parse(compacted).message.role, "assistant");
});
