import { StringDecoder } from "node:string_decoder";
import { CODEX_CAPACITY_MESSAGE } from "./capacity-retry.js";
import type { AgentName } from "./types.js";

export type BillingFailureReason = "subscription-quota" | "subscription-model-unsupported";
export const MAX_BILLING_EVENT_BYTES = 1024 * 1024;
type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
}

function sessionId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

// Display strings and reset-time format from the installed Codex 0.153.4 binary.
const codexQuotaPrefixes = [
  "You've hit your usage limit.",
  "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),",
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
  "You've hit your usage limit. To get more access now, send a request to your admin",
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits",
];
const codexResetSuffix = /^(?: Try again| or try again) (?:later|at (?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [1-3]?\d, \d{4} )?(?:[1-9]|1[0-2]):[0-5]\d [AP]M)\.$/;

function codexQuotaMessage(value: string): boolean {
  if (value.length > 512) return false;
  return codexQuotaPrefixes.some((prefix) => value.startsWith(prefix) &&
    (value === prefix || codexResetSuffix.test(value.slice(prefix.length))));
}

function codexFailure(value: unknown): BillingFailureReason | undefined {
  let error = object(value);
  if (typeof value === "string") {
    if (codexQuotaMessage(value)) return "subscription-quota";
    try { error = object(JSON.parse(value)); } catch { return undefined; }
  }
  const detail = object(error.error);
  if (error.type === "usage_limit_reached" || detail.type === "usage_limit_reached" ||
      error.code === "usage_limit_reached" || detail.code === "usage_limit_reached") {
    return "subscription-quota";
  }
  if (error.status === 400 && detail.type === "invalid_request_error" &&
      typeof detail.message === "string" &&
      /^The '[A-Za-z0-9._-]+' model is not supported when using Codex with a ChatGPT account\.$/.test(detail.message)) {
    return "subscription-model-unsupported";
  }
  return undefined;
}

/** Observes native envelope fields only; tool output and assistant prose are never errors. */
export class BillingEventCollector {
  failureReason: BillingFailureReason | undefined;
  nativeSessionId: string | undefined;
  hasWork = false;
  failed = false;
  capacityFailure = false;
  private pending = "";
  private pendingBytes = 0;
  private skipping = false;
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly agent: AgentName) {}

  write(chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      const segment = text.slice(start, end);
      if (!this.skipping) {
        this.pendingBytes += Buffer.byteLength(segment);
        if (this.pendingBytes > MAX_BILLING_EVENT_BYTES) {
          this.pending = "";
          this.skipping = true;
          // Lost work evidence must prevent a blind replay without a native session.
          this.hasWork = true;
        } else {
          this.pending += segment;
        }
      }
      if (newline < 0) break;
      if (!this.skipping) this.consume(this.pending);
      this.pending = "";
      this.pendingBytes = 0;
      this.skipping = false;
      start = newline + 1;
    }
  }

  end(): void {
    this.write(this.decoder.end());
    if (!this.skipping && this.pending) this.consume(this.pending);
    this.pending = "";
    this.pendingBytes = 0;
  }

  private consume(line: string): void {
    let event: RecordValue;
    try { event = object(JSON.parse(line)); } catch { return; }
    if (this.agent === "codex") this.consumeCodex(event);
    if (this.agent === "claude") this.consumeClaude(event);
  }

  private consumeCodex(event: RecordValue): void {
    if (event.type === "turn.completed") {
      this.failed = false;
      this.capacityFailure = false;
      this.failureReason = undefined;
    }
    if (event.type === "thread.started") {
      this.nativeSessionId ??= sessionId(event.thread_id);
    }
    if (event.type === "item.started" || event.type === "item.completed" || event.type === "item.updated") {
      const item = object(event.item);
      if (typeof item.type === "string" && item.type !== "error") this.hasWork = true;
    }
    if (event.type === "turn.failed") {
      this.capacityFailure = object(event.error).message === CODEX_CAPACITY_MESSAGE;
    }
    if (event.type === "error" || event.type === "turn.failed") {
      this.failureReason ??= codexFailure(event.error) ?? codexFailure(event.message) ??
        codexFailure(object(event.error).message) ?? codexFailure(event);
      // Codex also emits recoverable error notices; the native terminal is authoritative.
      if (event.type === "turn.failed" || this.failureReason) this.failed = true;
    }
  }

  private consumeClaude(event: RecordValue): void {
    if (event.type === "system" && event.subtype === "init") {
      this.nativeSessionId ??= sessionId(event.session_id);
    }
    if (event.type === "rate_limit_event") {
      const limit = object(event.rate_limit_info);
      if (limit.status === "rejected" &&
          ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"].includes(String(limit.rateLimitType))) {
        this.failureReason = "subscription-quota";
        this.failed = true;
      }
    }
    if (event.type === "assistant") {
      const message = object(event.message);
      if (message.model !== "<synthetic>" && Array.isArray(message.content) && message.content.length) {
        this.hasWork = true;
      }
    }
    if (event.type === "result") {
      this.nativeSessionId ??= sessionId(event.session_id);
      if (event.is_error === true || event.terminal_reason === "api_error" ||
          (typeof event.subtype === "string" && event.subtype.startsWith("error_"))) this.failed = true;
      else if (event.is_error === false && event.subtype === "success") {
        this.failed = false;
        this.failureReason = undefined;
      }
    }
  }
}
