import { extractUsageSummary } from "./output.js";
import type { RunNodeMetrics } from "./runs.js";
import type { AgentName } from "./types.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonValues(stdout: string): unknown[] {
  const values: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Agent CLIs may emit non-JSON warnings before or between trace rows.
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

function flattenRecords(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenRecords(item));
  }
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? [record] : [];
}

function latestNumber(records: JsonRecord[], field: string): number | undefined {
  return records.map((record) => asNumber(record[field])).filter((value): value is number => value !== undefined).at(-1);
}

export function extractRunNodeMetrics(
  agent: AgentName,
  stdout: string,
  context: { provider?: string; model?: string } = {},
): RunNodeMetrics | undefined {
  const records = parseJsonValues(stdout).flatMap(flattenRecords);
  const usage = extractUsageSummary(agent, stdout, context);
  const metrics: RunNodeMetrics = {
    turns: latestNumber(records, "num_turns"),
    durationMs: latestNumber(records, "duration_ms"),
    apiDurationMs: latestNumber(records, "duration_api_ms"),
    totalCostUsd: usage.cost?.total ?? latestNumber(records, "total_cost_usd"),
    inputTokens: usage.inputTokens || undefined,
    cacheReadTokens: usage.cacheReadTokens || undefined,
    cacheWriteTokens: usage.cacheWriteTokens || undefined,
    outputTokens: usage.outputTokens || undefined,
    reasoningOutputTokens: usage.reasoningOutputTokens || undefined,
    totalTokens: usage.totalTokens || undefined,
  };
  const present = Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== undefined)) as RunNodeMetrics;
  return Object.keys(present).length > 0 ? present : undefined;
}
