import { prepareBillingAttempt, type BillingRoute } from "./billing.js";
import { BillingEventCollector, type BillingFailureReason } from "./billing-events.js";
import { aggregateBillingUsage, type BillingUsageReport } from "./billing-usage.js";
import type { AgentName, BillingMode, BuildOptions, Env } from "./types.js";
import type { UsageSummary } from "./usage.js";

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
}

export interface BillingRunResult {
  result: BillingExecutionResult;
  usage?: BillingUsageReport;
  nativeSessionId?: string;
  error?: string;
}

const terminated = new Set([124, 130, 137, 143]);
const continuation = "Continue from where you left off. Your previous turn was interrupted by a subscription usage limit. Preserve completed work and do not repeat completed commands.";

/** One billing transition, sharing the invocation's deadline and native transcript. */
export async function runWithBilling(input: BillingRunOptions): Promise<BillingRunResult> {
  const now = input.now ?? Date.now;
  const deadline = input.timeoutSeconds === undefined ? undefined : now() + input.timeoutSeconds * 1000;
  let options = input.options;
  let attempt = prepareBillingAttempt(input.agent, options, input.env, input.mode);
  const reports: Parameters<typeof aggregateBillingUsage>[0] = [];
  let reason: BillingFailureReason | undefined;
  let nativeSessionId: string | undefined;
  let error: string | undefined;
  let result: BillingExecutionResult = { code: 124, stdout: "" };

  for (let index = 0; index < 2; index++) {
    const remaining = deadline === undefined ? undefined : (deadline - now()) / 1000;
    if (remaining !== undefined && remaining <= 0) {
      result = { ...result, code: 124 };
      break;
    }
    const events = new BillingEventCollector(input.agent);
    result = await input.execute({ ...attempt, options, timeoutSeconds: remaining, observe: (chunk) => events.write(chunk) });
    events.end();
    nativeSessionId = events.nativeSessionId ?? nativeSessionId;
    if (input.reportUsage) {
      const trace = result.usageTrace || result.stdout || result.finalMessageTrace || "";
      reports.push({ route: attempt.route, reason, usage: await input.reportUsage(trace, attempt.route) });
    }
    if (terminated.has(result.code)) break;
    if (events.failed && result.code === 0) result = { ...result, code: 1 };
    if (!events.failureReason) break;
    // Explicit subscription-only policy and exhausted paid routes are terminal.
    if (input.mode !== "auto" || attempt.route !== "subscription" || index !== 0) {
      result = { ...result, code: 78 };
      error = `billing unavailable: ${events.failureReason}; no further billing fallback`;
      break;
    }
    if (deadline !== undefined && now() >= deadline) {
      result = { ...result, code: 124 };
      break;
    }
    const resumeId = nativeSessionId ?? options.sessionId;
    if (events.hasWork && !resumeId) {
      result = { ...result, code: 78 };
      error = "billing fallback cannot safely resume partial work: native session ID unavailable";
      break;
    }
    try {
      const next = prepareBillingAttempt(input.agent, options, input.env, "api");
      reason = events.failureReason;
      input.onTransition?.({ type: "billing_transition", from: attempt.route, to: next.route, reason });
      attempt = next;
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
