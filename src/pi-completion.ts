export type PiCompletionOutcome =
  | { status: "unknown" }
  | { status: "success"; finalMessage: string }
  | { status: "error"; error: string };

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_CHARS = 4096;
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord : undefined;
}

function assistantFailure(message: JsonRecord): string | undefined {
  const detail = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (detail) return detail.slice(0, MAX_ERROR_CHARS);
  if (message.stopReason === "error") return "Pi assistant request failed.";
  if (message.stopReason === "aborted") return "Pi assistant request aborted.";
  return undefined;
}

function finalText(message: JsonRecord): string | undefined {
  if (message.stopReason !== "stop" || !Array.isArray(message.content)) return undefined;
  if (message.errorMessage !== undefined && typeof message.errorMessage !== "string") return undefined;
  const text: string[] = [];
  for (const value of message.content) {
    const block = record(value);
    if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (block?.type !== "thinking" || typeof block.thinking !== "string") return undefined;
  }
  return text.join("").trim();
}

/** Native JSONL completion only: never recursively inspect tool results or assistant prose. */
export class PiCompletionObserver {
  outcome: PiCompletionOutcome = { status: "unknown" };
  private pending = "";
  private pendingBytes = 0;
  private skipping = false;
  private lifecycleSeen = false;
  private compactionCompletion?: Extract<PiCompletionOutcome, { status: "success" }>;

  get observedLifecycle(): boolean {
    return this.lifecycleSeen;
  }

  write(chunk: string): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.skipping) {
        const segment = chunk.slice(start, end);
        this.pendingBytes += Buffer.byteLength(segment);
        if (this.pendingBytes > MAX_LINE_BYTES) {
          this.pending = "";
          this.skipping = true;
          this.invalidateSuccess();
        } else {
          this.pending += segment;
        }
      }
      if (newline < 0) break;
      if (!this.skipping) this.consume(this.pending);
      this.resetLine();
      start = newline + 1;
    }
  }

  end(): void {
    if (!this.skipping && this.pending) this.consume(this.pending);
    this.resetLine();
  }

  private resetLine(): void {
    this.pending = "";
    this.pendingBytes = 0;
    this.skipping = false;
  }

  private invalidateSuccess(): void {
    this.compactionCompletion = undefined;
    if (this.outcome.status === "success") this.outcome = { status: "unknown" };
  }

  private observeCompaction(event: JsonRecord): boolean {
    if (event.type === "compaction_start" && event.reason === "threshold" && this.outcome.status === "success") {
      const completion = this.outcome;
      this.invalidateSuccess();
      this.compactionCompletion = completion;
      return true;
    }
    if (event.type !== "compaction_end" || !this.compactionCompletion) return false;
    const completion = this.compactionCompletion;
    this.invalidateSuccess();
    if (event.reason === "threshold" && event.aborted === false && event.willRetry === false
      && record(event.result) && event.errorMessage === undefined) {
      this.outcome = completion;
    }
    return true;
  }

  private consume(line: string): void {
    if (!line.trim()) return;
    let event: JsonRecord | undefined;
    try { event = record(JSON.parse(line)); } catch { /* Incomplete native evidence cannot preserve success. */ }
    if (!event || typeof event.type !== "string") {
      this.invalidateSuccess();
      return;
    }
    if (["agent_start", "agent_end", "agent_settled"].includes(event.type)) this.lifecycleSeen = true;
    if (event.type === "agent_settled") return;
    if (this.observeCompaction(event)) return;
    this.invalidateSuccess();
    let message: JsonRecord | undefined;
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      message = record(event.messages.at(-1));
    } else if (event.type === "message_end" || event.type === "turn_end") {
      message = record(event.message);
    }
    if (message?.role !== "assistant") return;
    const error = assistantFailure(message);
    if (error) {
      this.outcome = { status: "error", error };
      return;
    }
    if (event.type !== "agent_end" || (event.willRetry !== undefined && event.willRetry !== false)) return;
    const finalMessage = finalText(message);
    if (finalMessage !== undefined) this.outcome = { status: "success", finalMessage };
  }
}
