import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { NativeTranscript } from "./runs.js";
import type { AgentName } from "./types.js";

export type NativeActivityStatus = "running" | "waiting_input" | "idle";

export interface NativeTranscriptActivity {
  status: NativeActivityStatus;
  reason: "pending_tool_use_fresh" | "explicit_wait_marker_fresh" | "terminal_done" | "recent_activity_fresh" | "stale_timeout" | "no_active_signal";
  message?: string;
  updatedAtMs: number;
}

export interface NativeTranscriptActivityOptions {
  nowMs?: number;
  runningTtlMs?: number;
  waitingTtlMs?: number;
}

interface NativeActivityEvent {
  kind: "assistant" | "user" | "tool_use" | "tool_result" | "system" | "meta";
  rawType: string;
  raw: Record<string, unknown>;
  text: string[];
  toolUseId?: string;
  timestampMs: number | null;
}

interface NativeActivityDecision {
  status: NativeActivityStatus;
  reason: NativeTranscriptActivity["reason"];
  message?: string;
}

const defaultRunningTtlMs = 20_000;
const defaultWaitingTtlMs = 1_800_000;
const waitingInputPattern =
  /\b(?:await(?:ing)?\s+(?:user|input)|waiting\s+for\s+(?:user|input|approval)|user\s+input\s+required|needs?\s+user\s+input|permission\s+required|approval\s+required|confirm(?:ation)?\s+(?:required|needed)|press\s+enter\s+to\s+continue)\b/i;
const waitingPromptPattern =
  /\b(?:do\s+you\s+want(?:\s+me)?|would\s+you\s+like(?:\s+me)?|should\s+i\b|can\s+you\s+confirm|please\s+confirm|let\s+me\s+know\s+if\s+you(?:'d)?\s+like|which\s+(?:option|approach)|choose\s+(?:one|an?\s+option)|pick\s+(?:one|an?\s+option)|approve(?:\s+this)?|permission\s+to)\b/i;

export function deriveNativeTranscriptActivity(
  agent: AgentName,
  transcript: NativeTranscript | undefined,
  options: NativeTranscriptActivityOptions = {},
): NativeTranscriptActivity | undefined {
  if (!transcript || !existsSync(transcript.path)) return undefined;
  const events =
    transcript.kind === "sqlite"
      ? readOpenCodeActivityEvents(transcript)
      : parseActivityEvents(agent, readTranscriptSlice(transcript));
  if (events.length === 0) return undefined;

  const fallbackUpdatedAtMs = statSync(transcript.path).mtimeMs;
  const updatedAtMs = Math.max(fallbackUpdatedAtMs, ...events.map((event) => event.timestampMs ?? 0));
  const nowMsValue = options.nowMs ?? Date.now();
  const decision = deriveActivityDecision(agent, events, updatedAtMs, nowMsValue, {
    runningTtlMs: options.runningTtlMs ?? defaultRunningTtlMs,
    waitingTtlMs: options.waitingTtlMs ?? defaultWaitingTtlMs,
  });
  return { ...decision, updatedAtMs };
}

function readTranscriptSlice(transcript: NativeTranscript): string {
  const bytes = readFileSync(transcript.path);
  const start = transcript.startOffset ?? 0;
  const end = transcript.endOffset ?? bytes.length;
  return bytes.subarray(start, end).toString("utf8");
}

function readOpenCodeActivityEvents(transcript: NativeTranscript): NativeActivityEvent[] {
  if (!transcript.sessionId || !/^[A-Za-z0-9_.:-]+$/.test(transcript.sessionId)) return [];
  const sqlite = spawnSync(
    "sqlite3",
    [
      "-json",
      transcript.path,
      [
        "select json_extract(message.data, '$.role') as role, part.data as part_data, part.time_updated as time_updated, part.time_created as time_created",
        "from part",
        "join message on message.id = part.message_id",
        `where part.session_id = '${transcript.sessionId.replaceAll("'", "''")}'`,
        "order by part.time_created asc;",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  if (sqlite.status !== 0 || !sqlite.stdout.trim()) return [];
  try {
    const rows = JSON.parse(sqlite.stdout) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      const record = asJsonRecord(row);
      const part = asJsonRecord(parseJson(asString(record.part_data)));
      const role = normalizeRole(record.role);
      return [
        toActivityEvent("opencode", {
          type: part.type,
          role,
          part,
          message: { role },
          timestamp: epochMsFromUnknown(record.time_updated) ?? epochMsFromUnknown(record.time_created),
        }),
      ];
    });
  } catch {
    return [];
  }
}

function parseActivityEvents(agent: AgentName, text: string): NativeActivityEvent[] {
  const events: NativeActivityEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(toActivityEvent(agent, asJsonRecord(JSON.parse(trimmed) as unknown)));
    } catch {
      // Native logs may include non-JSON warnings. They do not carry activity state.
    }
  }
  return events;
}

function toActivityEvent(agent: AgentName, raw: Record<string, unknown>): NativeActivityEvent {
  const payload = asJsonRecord(raw.payload);
  const message = asJsonRecord(raw.message);
  const part = asJsonRecord(raw.part);
  const record = Object.keys(payload).length > 0 && asString(raw.type).toLowerCase() === "response_item" ? payload : raw;
  const rawType = normalizeMarkerText(record.type || raw.type);
  const role = normalizeRole(record.role) || normalizeRole(message.role) || roleFromRawType(agent, rawType);
  const kind = eventKindFromRecord(rawType, role, record);
  const toolUseId =
    kind === "tool_use" || kind === "tool_result"
      ? asString(record.call_id) || asString(record.id) || asString(record.tool_use_id) || asString(part.id)
      : undefined;
  return {
    kind,
    rawType,
    raw,
    text: collectText(record).concat(collectText(message), collectText(part)),
    toolUseId,
    timestampMs: timestampMsFromRecord(raw),
  };
}

function deriveActivityDecision(
  agent: AgentName,
  events: NativeActivityEvent[],
  updatedAtMs: number,
  nowMsValue: number,
  ttl: { runningTtlMs: number; waitingTtlMs: number },
): NativeActivityDecision {
  const unmatchedToolUses = countUnmatchedToolUses(events);
  if (unmatchedToolUses > 0) {
    return applyFreshness({ status: "running", reason: "pending_tool_use_fresh" }, updatedAtMs, nowMsValue, ttl.runningTtlMs);
  }

  const waitEvent = findPendingWaitSignalEvent(events);
  if (waitEvent) {
    return applyFreshness(
      { status: "waiting_input", reason: "explicit_wait_marker_fresh", message: latestMessage(waitEvent) },
      updatedAtMs,
      nowMsValue,
      ttl.waitingTtlMs,
    );
  }

  const terminalEvent = findLatestTerminalDoneEvent(agent, events);
  if (terminalEvent) {
    return { status: "idle", reason: "terminal_done", message: latestMessage(terminalEvent) || latestAssistantMessage(events) };
  }

  if (updatedAtMs > 0 && nowMsValue - updatedAtMs <= Math.max(0, ttl.runningTtlMs)) {
    return { status: "running", reason: "recent_activity_fresh" };
  }

  return { status: "idle", reason: "no_active_signal", message: latestAssistantMessage(events) };
}

function applyFreshness(
  decision: NativeActivityDecision,
  updatedAtMs: number,
  nowMsValue: number,
  ttlMs: number,
): NativeActivityDecision {
  if (updatedAtMs <= 0 || nowMsValue - updatedAtMs > Math.max(0, ttlMs)) {
    return { status: "idle", reason: "stale_timeout", message: decision.message };
  }
  return decision;
}

function countUnmatchedToolUses(events: NativeActivityEvent[]): number {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const event of events) {
    if (!event.toolUseId) continue;
    if (event.kind === "tool_use") uses.add(event.toolUseId);
    if (event.kind === "tool_result") results.add(event.toolUseId);
  }
  let unmatched = 0;
  for (const id of uses) {
    if (!results.has(id)) unmatched += 1;
  }
  return unmatched;
}

function findPendingWaitSignalEvent(events: NativeActivityEvent[]): NativeActivityEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.kind === "user" || event.kind === "tool_use" || event.kind === "tool_result") return undefined;
    if (hasWaitingSignal(event)) return event;
    if (isPassiveActivityEvent(event)) continue;
    if (event.kind === "assistant" && event.text.length > 0) return undefined;
  }
  return undefined;
}

function findLatestTerminalDoneEvent(agent: AgentName, events: NativeActivityEvent[]): NativeActivityEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (isPassiveActivityEvent(event)) continue;
    if (isTerminalDoneEvent(agent, event)) return event;
    return undefined;
  }
  return undefined;
}

function isTerminalDoneEvent(agent: AgentName, event: NativeActivityEvent): boolean {
  const raw = event.raw;
  const payload = asJsonRecord(raw.payload);
  const message = asJsonRecord(raw.message);
  const part = asJsonRecord(raw.part);
  const rawType = normalizeMarkerText(raw.type || event.rawType);
  const payloadType = normalizeMarkerText(payload.type);
  const partType = normalizeMarkerText(part.type);
  const stopReason = normalizeMarkerText(message.stop_reason || message.stopReason || raw.stop_reason || raw.stopReason);
  const partReason = normalizeMarkerText(part.reason);

  if (payloadType === "task complete") return true;
  if (rawType === "assistant" && stopReason === "end turn") return true;
  if (event.kind === "assistant" && stopReason === "stop") return true;
  if (partType === "step finish" && partReason === "stop") return true;
  if (hasFinalAnswerMarker(raw) || hasFinalAnswerMarker(part)) return true;
  if ((agent === "gemini" || agent === "cursor") && event.kind === "assistant" && event.text.length > 0) return true;
  return false;
}

function hasWaitingSignal(event: NativeActivityEvent): boolean {
  const raw = event.raw;
  const payload = asJsonRecord(raw.payload);
  const part = asJsonRecord(raw.part);
  const partState = asJsonRecord(part.state);
  const message = asJsonRecord(raw.message);
  const candidates = [
    event.rawType,
    raw.type,
    raw.subtype,
    raw.status,
    raw.state,
    raw.phase,
    raw.reason,
    payload.type,
    payload.subtype,
    payload.status,
    payload.state,
    payload.phase,
    payload.reason,
    part.type,
    part.status,
    part.state,
    part.phase,
    part.reason,
    partState.status,
    partState.state,
    partState.phase,
    partState.reason,
    message.status,
    message.state,
    message.phase,
  ];
  if (candidates.some(isStructuredWaitingValue)) return true;
  const text = [event.rawType, ...event.text].join(" ");
  return waitingInputPattern.test(text) || waitingPromptPattern.test(text);
}

function isPassiveActivityEvent(event: NativeActivityEvent): boolean {
  const raw = event.raw;
  const payload = asJsonRecord(raw.payload);
  const part = asJsonRecord(raw.part);
  const rawType = normalizeMarkerText(raw.type || event.rawType);
  const payloadType = normalizeMarkerText(payload.type);
  const partType = normalizeMarkerText(part.type);

  if (rawType === "token count" || payloadType === "token count") return true;
  if (rawType === "last prompt" || rawType === "last-prompt" || rawType === "ai title" || rawType === "permission mode") return true;
  if (rawType === "attachment" || rawType === "file history snapshot" || rawType === "queue operation") return true;
  if (rawType === "model change" || rawType === "thinking level change") return true;
  if (rawType === "info" || rawType === "session" || rawType === "session meta" || rawType === "session diff meta") return true;
  if (partType === "snapshot" || partType === "patch" || partType === "file") return true;
  if (Object.prototype.hasOwnProperty.call(raw, "$set")) return true;
  if (event.kind === "system" && event.text.length === 0) return true;
  if (event.kind === "meta" && !payloadType && !partType && event.text.length === 0) return true;
  return false;
}

function hasFinalAnswerMarker(record: Record<string, unknown>): boolean {
  const metadata = asJsonRecord(record.metadata);
  const openai = asJsonRecord(metadata.openai);
  if (normalizeMarkerText(metadata.phase) === "final answer") return true;
  if (normalizeMarkerText(openai.phase) === "final answer") return true;
  for (const item of asArray(record.content)) {
    const itemRecord = asJsonRecord(item);
    if (normalizeMarkerText(itemRecord.phase) === "final answer") return true;
    const signature = asString(itemRecord.textSignature);
    if (signature && normalizeMarkerText(asJsonRecord(parseJson(signature)).phase) === "final answer") return true;
  }
  return false;
}

function eventKindFromRecord(rawType: string, role: string, record: Record<string, unknown>): NativeActivityEvent["kind"] {
  if (rawType === "function call" || rawType === "tool call" || rawType === "tool use") return "tool_use";
  if (rawType === "function call output" || rawType === "tool result") return "tool_result";
  if (rawType === "tool") {
    const state = normalizeMarkerText(asJsonRecord(record.state).status || record.status);
    return state === "completed" || state === "error" ? "tool_result" : "tool_use";
  }
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "meta";
}

function roleFromRawType(agent: AgentName, rawType: string): string {
  if (rawType === "assistant" || rawType === "model" || rawType === "gemini") return "assistant";
  if (rawType === "user") return "user";
  if (agent === "gemini" && rawType === "system") return "system";
  return "";
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) return value.flatMap(collectText);
  const record = asJsonRecord(value);
  if (Object.keys(record).length === 0) return [];
  const type = normalizeMarkerText(record.type);
  if (type === "tool use" || type === "tool result" || type === "function call" || type === "function call output") return [];
  return [
    asString(record.text),
    asString(record.content),
    asString(record.result),
    asString(record.response),
    ...collectText(record.content),
    ...collectText(record.parts),
  ]
    .map((text) => text.trim())
    .filter(Boolean);
}

function latestMessage(event: NativeActivityEvent): string | undefined {
  return event.text.at(-1)?.trim() || undefined;
}

function latestAssistantMessage(events: NativeActivityEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== "assistant") continue;
    const message = latestMessage(event);
    if (message) return message;
  }
  return undefined;
}

function timestampMsFromRecord(record: Record<string, unknown>): number | null {
  const candidates = [
    record.timestamp,
    record.time,
    record.updatedAt,
    asJsonRecord(record.time).updated,
    asJsonRecord(record.time).completed,
    asJsonRecord(record.time).end,
    asJsonRecord(record.time).created,
  ];
  for (const candidate of candidates) {
    const parsed = epochMsFromUnknown(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function epochMsFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = asString(value).trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function isStructuredWaitingValue(value: unknown): boolean {
  const normalized = normalizeMarkerText(value);
  if (!normalized) return false;
  if (normalized === "waiting") return true;
  if (normalized.includes("awaiting") && (normalized.includes("user") || normalized.includes("input"))) return true;
  if (normalized.includes("waiting for") && (normalized.includes("user") || normalized.includes("input"))) return true;
  if ((normalized.includes("needs") || normalized.includes("requires")) && normalized.includes("input")) return true;
  if (normalized.includes("approval required") || normalized.includes("permission required")) return true;
  if (normalized.includes("confirmation required") || normalized.includes("confirmation needed")) return true;
  if (normalized.includes("press enter to continue")) return true;
  return false;
}

function normalizeRole(value: unknown): string {
  const role = normalizeMarkerText(value);
  return role === "model" || role === "gemini" ? "assistant" : role;
}

function normalizeMarkerText(value: unknown): string {
  return asString(value)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
