import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numbers(record: JsonRecord, fields: string[]): JsonRecord {
  const result: JsonRecord = {};
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[field] = value;
  }
  return result;
}

// Retain only compact usage for each completed step, independently of text trace eviction.
export class OpencodeUsageAccumulator {
  private readonly steps = new Map<string | number, JsonRecord>();
  private anonymousSteps = 0;

  add(value: unknown): boolean {
    const record = asRecord(value);
    if (record.type !== "step_finish") return false;
    const part = asRecord(record.part);
    const sourceTokens = asRecord(part.tokens);
    const tokens = numbers(sourceTokens, ["input", "output", "reasoning"]);
    const cache = numbers(asRecord(sourceTokens.cache), ["read", "write"]);
    if (Object.keys(tokens).length === 0 && Object.keys(cache).length === 0) return false;
    if (Object.keys(cache).length > 0) tokens.cache = cache;
    const id = asString(part.id);
    const sessionID = asString(part.sessionID) || asString(record.sessionID);
    const messageID = asString(part.messageID);
    const key = id
      ? createHash("sha256").update(JSON.stringify([sessionID, messageID, id])).digest("hex")
      : this.anonymousSteps++;
    this.steps.set(key, {
      id: typeof key === "string" ? key : "",
      sessionID: Buffer.byteLength(sessionID, "utf8") <= 16 * 1024 ? sessionID : "",
      messageID: Buffer.byteLength(messageID, "utf8") <= 16 * 1024 ? messageID : "",
      tokens,
      ...numbers(part, ["cost"]),
    });
    return true;
  }

  addLine(line: string): boolean {
    try {
      return this.add(JSON.parse(line) as unknown);
    } catch {
      return false;
    }
  }

  parts(): JsonRecord[] {
    return [...this.steps.values()];
  }

  trace(): string {
    return this.parts().map((part) => JSON.stringify({
      type: "step_finish", sessionID: part.sessionID, part,
    }) + "\n").join("");
  }
}
