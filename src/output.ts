import type { AgentName } from "./types.js";

type JsonRecord = Record<string, unknown>;

const textItemTypes = new Set(["text", "input_text", "output_text"]);
const skippedItemTypes = new Set([
  "thinking",
  "reasoning",
  "redacted_thinking",
  "tool_use",
  "tool_result",
  "toolcall",
  "function_call",
  "function_call_output",
]);

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeRole(value: unknown): string {
  const role = asString(value).trim().toLowerCase();
  if (role === "model" || role === "gemini") return "assistant";
  return role;
}

function parseJsonValues(stdout: string): unknown[] {
  const values: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Agent CLIs sometimes emit warnings before JSON. Ignore non-JSON lines.
    }
  }
  if (values.length > 0) return values;

  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function extractText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractText(item));
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) return [];

  const itemType = asString(record.type).trim().toLowerCase();
  if (skippedItemTypes.has(itemType)) return [];

  if (textItemTypes.has(itemType)) {
    return extractText(record.text);
  }

  const directText = asString(record.text).trim();
  if (directText) return [directText];

  const parts = extractText(record.parts);
  if (parts.length > 0) return parts;

  const content = extractText(record.content);
  if (content.length > 0) return content;

  const nestedMessage = extractText(asRecord(record.message).content);
  if (nestedMessage.length > 0) return nestedMessage;

  return [];
}

function joinText(value: unknown): string {
  return extractText(value).join("\n").trim();
}

function roleFromRecord(record: JsonRecord): string {
  const directRole = normalizeRole(record.role);
  if (directRole) return directRole;
  const messageRole = normalizeRole(asRecord(record.message).role);
  if (messageRole) return messageRole;
  const type = asString(record.type).trim().toLowerCase();
  if (type === "assistant" || type === "model" || type === "gemini") return "assistant";
  return "";
}

function candidateFromRecord(record: JsonRecord, agent: AgentName): string {
  const rowType = asString(record.type).trim().toLowerCase();
  const payload = asRecord(record.payload);
  if (rowType === "response_item" && Object.keys(payload).length > 0) {
    return candidateFromRecord(payload, agent);
  }

  const item = asRecord(record.item);
  if (rowType.startsWith("item.") && Object.keys(item).length > 0) {
    return candidateFromRecord(item, agent);
  }

  if (agent === "codex" && rowType === "agent_message") {
    const text = asString(record.text).trim();
    if (text) return text;
  }

  if (agent === "opencode" && rowType === "text") {
    const text = joinText(record.part || record.text);
    if (text) return text;
  }

  const message = asRecord(record.message);
  if (Object.keys(message).length > 0) {
    const messageRole = roleFromRecord(message) || roleFromRecord(record);
    if (messageRole === "assistant") {
      return joinText(message.content || message.parts || message.text || message);
    }
  }

  const role = roleFromRecord(record);
  const payloadType = asString(record.type).trim().toLowerCase();
  if (role === "assistant" && !skippedItemTypes.has(payloadType)) {
    const contentText = joinText(record.content || record.parts || record.text);
    if (contentText) return contentText;
  }

  if (agent === "gemini" && (payloadType === "model" || payloadType === "gemini")) {
    const contentText = joinText(record.content || record.parts || record.text);
    if (contentText) return contentText;
  }

  if (agent === "codex" && role === "assistant" && payloadType === "message") {
    const contentText = joinText(record.content);
    if (contentText) return contentText;
  }

  for (const field of ["result", "response", "final_message", "finalMessage", "final_answer", "finalAnswer", "output"]) {
    const text = asString(record[field]).trim();
    if (
      text &&
      (role === "assistant" ||
        rowType === "result" ||
        rowType === "final" ||
        rowType === "assistant" ||
        (agent === "gemini" && field === "response"))
    ) {
      return text;
    }
  }

  return "";
}

function collectCandidates(value: unknown, agent: AgentName): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCandidates(item, agent));
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) return [];

  const candidates: string[] = [];
  const candidate = candidateFromRecord(record, agent);
  if (candidate) candidates.push(candidate);

  const response = asRecord(record.response);
  const candidatesArray = asArray(response.candidates);
  for (const geminiCandidate of candidatesArray) {
    const contentText = joinText(asRecord(geminiCandidate).content);
    if (contentText) candidates.push(contentText);
  }

  const messages = asArray(record.messages);
  if (messages.length > 0) {
    candidates.push(...messages.flatMap((message) => collectCandidates(message, agent)));
  }

  return candidates;
}

function flattenRecords(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenRecords(item));
  }
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? [record] : [];
}

function formatErrorRecord(record: JsonRecord): string {
  const error = asRecord(record.error);
  const source = Object.keys(error).length > 0 ? error : record;
  const name = asString(source.name).trim() || asString(record.type).trim();
  const data = asRecord(source.data);
  const message =
    asString(source.message).trim() ||
    asString(data.message).trim() ||
    asString(record.message).trim() ||
    asString(record.text).trim();

  if (name && message) return `${name}: ${message}`;
  return message || name;
}

export function extractAgentError(agent: AgentName, stdout: string): string {
  const records = parseJsonValues(stdout).flatMap(flattenRecords);
  for (const record of records) {
    const rowType = asString(record.type).trim().toLowerCase();
    if (rowType !== "error" && Object.keys(asRecord(record.error)).length === 0) {
      continue;
    }

    const error = formatErrorRecord(record);
    if (error) return `${agent} error: ${error}`;
  }
  return "";
}

function extractGeminiDeltaMessage(values: unknown[]): string {
  let current = "";
  let latest = "";

  for (const record of values.flatMap(flattenRecords)) {
    if (roleFromRecord(record) !== "assistant" || !record.delta) {
      continue;
    }

    const text = candidateFromRecord(record, "gemini");
    if (!text) continue;
    current += text;
    latest = current;
  }

  return latest.trim();
}

export function extractFinalMessage(agent: AgentName, stdout: string): string {
  const values = parseJsonValues(stdout);
  if (agent === "gemini") {
    const deltaMessage = extractGeminiDeltaMessage(values);
    if (deltaMessage) return deltaMessage;
  }

  const candidates = values.flatMap((value) => collectCandidates(value, agent));
  return candidates.at(-1)?.trim() ?? "";
}

export function extractNativeSessionId(agent: AgentName, stdout: string): string {
  const records = parseJsonValues(stdout).flatMap(flattenRecords);
  for (const record of records) {
    if (agent === "codex") {
      const threadId = asString(record.thread_id).trim();
      if (asString(record.type).trim().toLowerCase() === "thread.started" && threadId) {
        return threadId;
      }
    }

    if (agent === "opencode") {
      const sessionId = asString(record.sessionID).trim() || asString(record.sessionId).trim();
      if (sessionId) return sessionId;
    }

    const sessionId = asString(record.session_id).trim() || asString(record.sessionId).trim();
    if (sessionId) return sessionId;
  }
  return "";
}

export { extractUsageSummary, fetchModelsDevPricing, priceUsageSummary } from "./usage.js";
export type { UsageCostBreakdown, UsageSummary } from "./usage.js";
