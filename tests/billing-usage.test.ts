import assert from "node:assert/strict";
import test from "node:test";
import { aggregateBillingUsage, type BillingAttempt } from "../src/billing-usage.ts";
import { extractUsageSummary, priceUsageSummary, type UsageSummary } from "../src/usage.ts";

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
  assert.equal(aggregateBillingUsage(Array(5).fill(attempt)).totalTokens, 85);
  assert.throws(() => aggregateBillingUsage(Array(6).fill(attempt)));
});

const claudeResult = {
  type: "result", usage: { input_tokens: 1000, output_tokens: 100 },
};
const bedrockContext = { provider: "amazon-bedrock", model: "claude-test" };
const anthropicPricing = { models: { "claude-test": { cost: { input: 1, output: 2 } } } };

test("Bedrock native usage retains its provider through the billing report", () => {
  const summary = priceUsageSummary(extractUsageSummary("claude",
    JSON.stringify({ ...claudeResult, total_cost_usd: 0.25 }), bedrockContext), {});
  const result = aggregateBillingUsage([{ route: "bedrock", usage: summary }]);
  assert.equal(result.provider, "amazon-bedrock");
  assert.equal(result.billing.attempts[0].usage.provider, "amazon-bedrock");
  assert.equal(result.cost?.total, 0.25);
  assert.equal(result.costBasis, "native-reported");
});

test("Bedrock estimates use its provider's prices", () => {
  const summary = priceUsageSummary(extractUsageSummary("claude", JSON.stringify(claudeResult), bedrockContext), {
    anthropic: anthropicPricing,
    "amazon-bedrock": { models: { "claude-test": { cost: { input: 5, output: 10 } } } },
  });
  assert.equal(summary.provider, "amazon-bedrock");
  assert.equal(summary.cost?.total, 0.006);
});

test("missing Bedrock prices cannot fall back to another provider", () => {
  const summary = priceUsageSummary(extractUsageSummary("claude", JSON.stringify(claudeResult), bedrockContext), {
    anthropic: anthropicPricing,
  });
  assert.equal(summary.provider, "amazon-bedrock");
  assert.equal(summary.cost, null);
  assert.equal(summary.pricingStatus, "missing");
});
