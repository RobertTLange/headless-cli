import assert from "node:assert/strict";
import test from "node:test";
import { aggregateBillingUsage, type BillingAttempt } from "../src/billing-usage.ts";
import type { UsageSummary } from "../src/usage.ts";

function usage(values: Partial<UsageSummary> = {}): UsageSummary {
  return { agent: "codex", provider: "openai", model: "gpt-test", inputTokens: 10,
    cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 4, reasoningOutputTokens: 2,
    totalTokens: 17, usageStatus: "reported", cost: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, total: 10 },
    costBasis: "api-list-price-estimate", pricingSource: "models.dev", pricingStatus: "priced", ...values };
}

test("aggregates usage and retains attempt route without changing last model", () => {
  const attempts: BillingAttempt[] = [
    { route: "subscription", usage: usage() },
    { route: "openai-api", reason: "subscription-quota", usage: usage({ model: "final-model" }) },
  ];
  const result = aggregateBillingUsage(attempts);
  assert.equal(result.totalTokens, 34);
  assert.equal(result.inputTokens, 20);
  assert.equal(result.cost?.total, 20);
  assert.equal(result.model, "final-model");
  assert.deepEqual(result.billing.attempts, attempts);
});

test("missing usage and costs remain missing while known attempt is retained", () => {
  const result = aggregateBillingUsage([
    { route: "subscription", usage: usage({ cost: null, usageStatus: "missing", pricingStatus: "missing" }) },
    { route: "bedrock", usage: usage({ agent: "claude", provider: "amazon-bedrock" }) },
  ]);
  assert.equal(result.cost, null);
  assert.equal(result.usageStatus, "missing");
  assert.equal(result.pricingStatus, "missing");
  assert.equal(result.billing.attempts[1].usage.cost?.total, 10);
});

test("mixed subscription native valuation and API estimates are not billed total", () => {
  const result = aggregateBillingUsage([
    { route: "subscription", usage: usage({ costBasis: "native-reported", pricingSource: "native", pricingStatus: "native" }) },
    { route: "bedrock", usage: usage() },
  ]);
  assert.equal(result.cost, null);
  assert.equal(result.costBasis, null);
  assert.equal(result.billing.attempts[0].usage.cost?.total, 10);
});

test("partial cost components stay null; enforce bounded attempts", () => {
  const attempt: BillingAttempt = { route: "native", usage: usage({ cost: { input: null, cacheRead: null, cacheWrite: null, output: null, total: 10 } }) };
  assert.equal(aggregateBillingUsage([attempt, attempt]).cost?.input, null);
  assert.equal(aggregateBillingUsage([attempt, attempt]).cost?.total, 20);
  assert.throws(() => aggregateBillingUsage([]));
  assert.throws(() => aggregateBillingUsage([attempt, attempt, attempt]));
});
