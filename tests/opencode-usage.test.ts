import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUsageSummary, priceUsageSummary } from "../src/output.ts";
import { OpencodeUsageAccumulator } from "../src/opencode-usage.ts";

function step(id: string | undefined, cost: unknown = 1) {
  return {
    type: "step_finish",
    part: {
      id,
      sessionID: "session-1",
      messageID: "message-1",
      type: "step-finish",
      cost,
      tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 20, write: 3 } },
    },
  };
}

function summarize(...records: unknown[]) {
  return extractUsageSummary("opencode", records.map((record) => JSON.stringify(record)).join("\n"), {
    model: "deepseek/deepseek-v4-pro",
  });
}

test("OpenCode sums every completed step including cache and reasoning tokens", () => {
  const second = step("step-2", 2);
  second.part.tokens.input = 200;
  const result = summarize(step("step-1"), second);
  assert.equal(result.cost?.total, 3);
  assert.equal(result.inputTokens, 300);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.reasoningOutputTokens, 10);
  assert.equal(result.cacheReadTokens, 40);
  assert.equal(result.cacheWriteTokens, 6);
  assert.equal(result.totalTokens, 376);
  assert.equal(result.provider, "deepseek");
  assert.equal(result.model, "deepseek-v4-pro");
  assert.equal(result.costBasis, "native-reported");
});

test("OpenCode replaces repeated step snapshots with the latest valid occurrence", () => {
  const first = step("step-1");
  const updated = step("step-1", 2);
  updated.part.tokens.input = 200;
  const invalid = { ...updated, part: { ...updated.part, tokens: { input: "invalid" } } };
  const result = summarize(first, first, step("step-2", 3), updated, invalid);
  assert.equal(result.cost?.total, 5);
  assert.equal(result.inputTokens, 300);
});

test("OpenCode step identities include the message and session", () => {
  const otherMessage = step("same-id", 2);
  otherMessage.part.messageID = "message-2";
  const otherSession = step("same-id", 3);
  otherSession.part.sessionID = "session-2";
  const result = summarize(step("same-id"), otherMessage, otherSession);
  assert.equal(result.cost?.total, 6);
  assert.equal(result.inputTokens, 300);
});

test("OpenCode preserves steps without identifiers", () => {
  const result = summarize(step(undefined), step(undefined));
  assert.equal(result.cost?.total, 2);
  assert.equal(result.inputTokens, 200);
});

test("OpenCode ignores unrelated token records and cumulative message costs", () => {
  const result = summarize(
    step("step-1"),
    { type: "message.updated", info: { cost: 999, tokens: { input: 999 } } },
    { type: "tool_use", part: { cost: 999, tokens: { input: 999 } } },
    { type: "step_start", part: { cost: 999, tokens: { input: 999 } } },
  );
  assert.equal(result.cost?.total, 1);
  assert.equal(result.inputTokens, 100);
});

test("OpenCode preserves explicit zero usage and zero cost", () => {
  const result = summarize({ type: "step_finish", part: { cost: 0, tokens: { input: 0 } } });
  assert.equal(result.cost?.total, 0);
  assert.equal(result.totalTokens, 0);
  assert.equal(result.usageStatus, "reported");
});

for (const cost of [undefined, null, -1, "2"]) {
  test(`OpenCode does not report a partial native total when a step cost is ${String(cost)}`, () => {
    const unpriced = step("step-1", cost);
    unpriced.part.cost = cost;
    const result = summarize(unpriced, step("step-2", 2));
    assert.equal(result.cost, null);
    assert.equal(result.costBasis, null);
    assert.equal(result.pricingStatus, "missing");
    assert.equal(result.inputTokens, 200);
    const priced = priceUsageSummary(result, {
      deepseek: { models: { "deepseek-v4-pro": { cost: { input: 1, output: 1, cache_read: 1, cache_write: 1 } } } },
    });
    assert.equal(priced.costBasis, "api-list-price-estimate");
    assert.equal(priced.inputTokens, 200);
    assert.equal(priced.cost?.output, 0.00003);
    assert.equal(priced.cost?.total, 0.000276);
  });
}

test("OpenCode with no valid completed usage remains missing", () => {
  const result = summarize({ type: "step_finish", part: { tokens: { input: -1, output: "4" } } });
  assert.equal(result.usageStatus, "missing");
  assert.equal(result.cost, null);
});

test("OpenCode retains compact usage and deduplication with oversized identity fields", () => {
  const accumulator = new OpencodeUsageAccumulator();
  const record = step("x".repeat(1024 * 1024));
  record.part.sessionID = "s".repeat(1024 * 1024);
  record.part.messageID = "m".repeat(1024 * 1024);
  accumulator.add(record);
  accumulator.add(record);
  accumulator.add({ ...record, part: { ...record.part, id: "different" } });
  const trace = accumulator.trace();
  assert.ok(Buffer.byteLength(trace) < 1024);
  const summary = extractUsageSummary("opencode", trace);
  assert.equal(summary.cost?.total, 2);
  assert.equal(summary.inputTokens, 200);
});
