import { MAX_EXECUTION_ATTEMPTS } from "./capacity-retry.js";
import type { BillingFailureReason } from "./billing-events.js";
import type { UsageCostBreakdown, UsageSummary } from "./usage.js";

export type BillingRoute = "subscription" | "openai-api" | "bedrock" | "native";
export interface BillingAttempt {
  route: BillingRoute;
  reason?: BillingFailureReason;
  retryReason?: "model-capacity";
  usage: UsageSummary;
}
export interface BillingUsageReport extends UsageSummary {
  billing: { attempts: BillingAttempt[] };
}

/** Keep incompatible cost valuations separate rather than suggesting an actual API bill. */
export function aggregateBillingUsage(attempts: BillingAttempt[]): BillingUsageReport {
  if (attempts.length < 1 || attempts.length > MAX_EXECUTION_ATTEMPTS) {
    throw new Error(`Billing usage requires one to ${MAX_EXECUTION_ATTEMPTS} attempts`);
  }
  const summaries = attempts.map((attempt) => attempt.usage);
  const last = summaries[summaries.length - 1];
  const complete = summaries.every((summary) => summary.usageStatus === "reported");
  const comparable = complete && summaries.every((summary) =>
    summary.cost !== null && summary.costBasis === last.costBasis &&
    summary.pricingSource === last.pricingSource && summary.pricingStatus === last.pricingStatus);
  const sum = (key: "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens" |
    "reasoningOutputTokens" | "totalTokens") => summaries.reduce((total, summary) => total + summary[key], 0);
  let cost: UsageCostBreakdown | null = null;
  if (comparable) {
    const component = (key: keyof UsageCostBreakdown): number | null => {
      const values = summaries.map((summary) => summary.cost![key]);
      return values.some((value) => value === null) ? null :
        values.reduce<number>((total, value) => total + value!, 0);
    };
    cost = { input: component("input"), cacheRead: component("cacheRead"),
      cacheWrite: component("cacheWrite"), output: component("output"), total: component("total") };
  }
  const { modelBreakdowns: _parts, ...publicLast } = last;
  return {
    ...publicLast,
    inputTokens: sum("inputTokens"), cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"), outputTokens: sum("outputTokens"),
    reasoningOutputTokens: sum("reasoningOutputTokens"), totalTokens: sum("totalTokens"),
    usageStatus: complete ? "reported" : "missing",
    cost,
    costBasis: comparable ? last.costBasis : null,
    pricingSource: comparable ? last.pricingSource : null,
    pricingStatus: comparable ? last.pricingStatus : "missing",
    billing: { attempts: attempts.map((attempt) => ({ ...attempt, usage: { ...attempt.usage } })) },
  };
}
