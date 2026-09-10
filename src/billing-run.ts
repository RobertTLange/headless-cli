import { prepareBillingAttempt, type BillingRoute } from "./billing.js";
import { BillingEventCollector, type BillingFailureReason } from "./billing-events.js";
import { aggregateBillingUsage, type BillingUsageReport } from "./billing-usage.js";
import type { AgentName, BillingMode, BuildOptions, Env } from "./types.js";
import type { UsageSummary } from "./usage.js";
import { CAPACITY_CONTINUATION, MAX_EXECUTION_ATTEMPTS, cancellationCode, capacityRetryDelay,
  resolveCapacityRetries, waitForCapacityRetry, type CapacityRetryEvent } from "./capacity-retry.js";

export interface BillingExecutionResult {
  code: number;
  stdout: string;
  usageTrace?: string;
  finalMessageTrace?: string;
  stdoutReceived?: boolean;
  stdoutEndsWithNewline?: boolean;
}

export interface BillingExecutionAttempt {
  route: BillingRoute;
  env: Env;
  options: BuildOptions;
  timeoutSeconds?: number;
  observe: (chunk: string) => void;
}

export interface BillingRunOptions {
  agent: AgentName;
  mode: BillingMode;
  env: Env;
  options: BuildOptions;
  timeoutSeconds?: number;
  execute: (attempt: BillingExecutionAttempt) => Promise<BillingExecutionResult>;
  reportUsage?: (trace: string, route: BillingRoute) => Promise<UsageSummary>;
  onTransition?: (event: { type: "billing_transition"; from: BillingRoute; to: BillingRoute; reason: BillingFailureReason }) => void;
  now?: () => number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onCapacityRetry?: (event: CapacityRetryEvent) => void;
}

export interface BillingRunResult {
  result: BillingExecutionResult;
  usage?: BillingUsageReport;
  nativeSessionId?: string;
  error?: string;
}

const terminated = new Set([124, 130, 137, 143]);
const continuation = "Continue from where you left off. Your previous turn was interrupted by a subscription usage limit. Preserve completed work and do not repeat completed commands.";

/** Capacity retries and one billing transition share a deadline and native transcript. */
export async function runWithBilling(input: BillingRunOptions): Promise<BillingRunResult> {
  const now = input.now ?? Date.now;
  const capacityLimit = input.agent === "codex" ? resolveCapacityRetries(input.env) : 0;
  const sleep = input.sleep ?? waitForCapacityRetry;
  let capacityRetries = 0;
  let billingTransitioned = false;
  let hasWork = false;
  let retryReason: "model-capacity" | undefined;
  const deadline = input.timeoutSeconds === undefined ? undefined : now() + input.timeoutSeconds * 1000;
  let options = input.options;
  let attempt = prepareBillingAttempt(input.agent, options, input.env, input.mode);
  const reports: Parameters<typeof aggregateBillingUsage>[0] = [];
  let reason: BillingFailureReason | undefined;
  let nativeSessionId: string | undefined;
  let error: string | undefined;
  let result: BillingExecutionResult = { code: 124, stdout: "" };

  for (let index = 0; index < MAX_EXECUTION_ATTEMPTS; index++) {
    const cancelled = cancellationCode(input.signal);
    if (cancelled !== undefined) {
      result = { ...result, code: cancelled };
      break;
    }
    const remaining = deadline === undefined ? undefined : (deadline - now()) / 1000;
    if (remaining !== undefined && remaining <= 0) {
      result = { ...result, code: 124 };
      break;
    }
    const events = new BillingEventCollector(input.agent);
    result = await input.execute({ ...attempt, options, timeoutSeconds: remaining, observe: (chunk) => events.write(chunk) });
    events.end();
    nativeSessionId = events.nativeSessionId ?? nativeSessionId;
    hasWork ||= events.hasWork;
    if (input.reportUsage) {
      const trace = result.usageTrace || result.stdout || result.finalMessageTrace || "";
      reports.push({ route: attempt.route, reason, ...(retryReason ? { retryReason } : {}),
        usage: await input.reportUsage(trace, attempt.route) });
    }
    reason = undefined;
    retryReason = undefined;
    const cancelledAfterExecution = cancellationCode(input.signal);
    if (cancelledAfterExecution !== undefined) {
      result = { ...result, code: cancelledAfterExecution };
      break;
    }
    if (terminated.has(result.code)) break;
    if (events.failed && result.code === 0) result = { ...result, code: 1 };
    if (events.capacityFailure && !events.failureReason) {
      if (capacityRetries >= capacityLimit) {
        error = `model capacity retries exhausted (${capacityRetries} retries)`;
        break;
      }
      const resumeId = nativeSessionId ?? options.sessionId;
      if (hasWork && !resumeId) {
        error = "capacity retry cannot safely resume partial work: native session ID unavailable";
        break;
      }
      const remainingMs = deadline === undefined ? Infinity : deadline - now();
      if (remainingMs <= 0) {
        result = { ...result, code: 124 };
        break;
      }
      capacityRetries++;
      const delayMs = Math.min(capacityRetryDelay(capacityRetries, input.random ?? Math.random), remainingMs);
      input.onCapacityRetry?.({ type: "capacity_retry", retry: capacityRetries, delayMs, reason: "model-capacity" });
      try {
        await sleep(delayMs, input.signal);
      } catch (failure) {
        const code = cancellationCode(input.signal);
        if (code === undefined) throw failure;
        result = { ...result, code };
        break;
      }
      retryReason = "model-capacity";
      if (resumeId) {
        options = { ...options, prompt: CAPACITY_CONTINUATION, promptFile: undefined,
          sessionMode: "resume", sessionId: resumeId };
      }
      continue;
    }
    if (!events.failureReason) break;
    // Explicit subscription-only policy and exhausted paid routes are terminal.
    if (input.mode !== "auto" || attempt.route !== "subscription" || billingTransitioned) {
      result = { ...result, code: 78 };
      error = `billing unavailable: ${events.failureReason}; no further billing fallback`;
      break;
    }
    if (deadline !== undefined && now() >= deadline) {
      result = { ...result, code: 124 };
      break;
    }
    const resumeId = nativeSessionId ?? options.sessionId;
    if (hasWork && !resumeId) {
      result = { ...result, code: 78 };
      error = "billing fallback cannot safely resume partial work: native session ID unavailable";
      break;
    }
    try {
      const next = prepareBillingAttempt(input.agent, options, input.env, "api");
      reason = events.failureReason;
      input.onTransition?.({ type: "billing_transition", from: attempt.route, to: next.route, reason });
      attempt = next;
      billingTransitioned = true;
      if (resumeId) {
        options = { ...options, prompt: continuation, promptFile: undefined, sessionMode: "resume", sessionId: resumeId };
      }
    } catch (failure) {
      result = { ...result, code: 78 };
      error = failure instanceof Error ? failure.message : "billing fallback unavailable";
      break;
    }
  }
  return { result, nativeSessionId, error, ...(reports.length ? { usage: aggregateBillingUsage(reports) } : {}) };
}
