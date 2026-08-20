import type { AgentName } from "./types.js";

type JsonRecord = Record<string, unknown>;

const directNumericFields = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "input",
  "cacheRead",
  "cacheWrite",
  "cached",
  "output",
  "reasoning",
  "read",
  "write",
] as const;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function copyNumber(record: JsonRecord, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function copyString(record: JsonRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 16 * 1024 ? value : undefined;
}

function numericProjection(record: JsonRecord): JsonRecord {
  const projection: JsonRecord = {};
  for (const field of directNumericFields) {
    const value = copyNumber(record, field);
    if (value !== undefined) projection[field] = value;
  }
  return projection;
}

function geminiStatsProjection(record: JsonRecord): JsonRecord {
  const projection = numericProjection(record);
  const models = asRecord(record.models);
  const projectedModels: JsonRecord = {};
  let modelCount = 0;
  for (const model in models) {
    if (!Object.hasOwn(models, model) || Buffer.byteLength(model, "utf8") > 512) continue;
    const usage = numericProjection(asRecord(models[model]));
    if (Object.keys(usage).length === 0) continue;
    projectedModels[model] = usage;
    modelCount += 1;
    if (modelCount === 100) break;
  }
  if (modelCount > 0) projection.models = projectedModels;
  return projection;
}

function opencodePartProjection(record: JsonRecord): JsonRecord {
  const projection: JsonRecord = {};
  const cost = copyNumber(record, "cost");
  if (cost !== undefined) projection.cost = cost;
  const tokens = numericProjection(asRecord(record.tokens));
  const cache = numericProjection(asRecord(asRecord(record.tokens).cache));
  if (Object.keys(cache).length > 0) tokens.cache = cache;
  if (Object.keys(tokens).length > 0) projection.tokens = tokens;
  return projection;
}

function piMessageProjection(record: JsonRecord): JsonRecord {
  const projection: JsonRecord = {};
  for (const field of ["role", "model", "provider"]) {
    const value = copyString(record, field);
    if (value !== undefined) projection[field] = value;
  }
  const sourceUsage = asRecord(record.usage);
  const usage = numericProjection(sourceUsage);
  const cost = numericProjection(asRecord(sourceUsage.cost));
  const total = copyNumber(asRecord(sourceUsage.cost), "total");
  if (total !== undefined) cost.total = total;
  if (Object.keys(cost).length > 0) usage.cost = cost;
  if (Object.keys(usage).length > 0) projection.usage = usage;
  return projection;
}

export function compactOversizedTraceLine(agent: AgentName, line: string): string {
  let record: JsonRecord;
  try {
    record = asRecord(JSON.parse(line) as unknown);
  } catch {
    return "";
  }
  if (Object.keys(record).length === 0) return "";

  const projection: JsonRecord = {};
  for (const field of [
    "type",
    "role",
    "thread_id",
    "session_id",
    "sessionId",
    "sessionID",
    "model",
    "provider",
  ]) {
    const value = copyString(record, field);
    if (value !== undefined) projection[field] = value;
  }
  for (const field of ["num_turns", "duration_ms", "duration_api_ms", "total_cost_usd"]) {
    const value = copyNumber(record, field);
    if (value !== undefined) projection[field] = value;
  }

  if (agent === "gemini") {
    const stats = geminiStatsProjection(asRecord(record.stats));
    if (Object.keys(stats).length > 0) projection.stats = stats;
  } else if (agent === "opencode") {
    const part = opencodePartProjection(asRecord(record.part));
    if (Object.keys(part).length > 0) projection.part = part;
  } else if (agent === "pi") {
    const message = piMessageProjection(asRecord(record.message));
    if (Object.keys(message).length > 0) projection.message = message;
  } else {
    const usage = numericProjection(asRecord(record.usage));
    if (Object.keys(usage).length > 0) projection.usage = usage;
  }

  const modelUsage = asRecord(record.modelUsage);
  const firstModel = Object.keys(modelUsage).find((model) => Buffer.byteLength(model, "utf8") <= 512);
  if (firstModel) projection.modelUsage = { [firstModel]: {} };

  return Object.keys(projection).length > 0 ? JSON.stringify(projection) : "";
}
