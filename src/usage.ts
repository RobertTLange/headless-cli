import type { AgentName } from "./types.js";

type JsonRecord = Record<string, unknown>;
type PricingData = Record<string, { models?: Record<string, PricingModel> }>;

interface PricingModel {
  id?: string;
  name?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

interface UsagePart {
  provider?: string;
  model?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface UsageCostBreakdown {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  total: number | null;
}

export interface UsageSummary {
  agent: AgentName;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cost: UsageCostBreakdown | null;
  pricingSource: "native" | "models.dev" | null;
  pricingStatus: "native" | "priced" | "missing";
  modelBreakdowns?: UsagePart[];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function flattenRecords(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenRecords(item));
  }
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? [record] : [];
}

function latestRecordWith(records: JsonRecord[], predicate: (record: JsonRecord) => boolean): JsonRecord | undefined {
  return records.filter(predicate).at(-1);
}

function requestedProviderModel(context: { provider?: string; model?: string } = {}): { provider?: string; model?: string } {
  if (!context.model) {
    return { provider: context.provider, model: context.model };
  }
  const slashIndex = context.model.indexOf("/");
  if (slashIndex > 0) {
    return {
      provider: context.provider ?? context.model.slice(0, slashIndex),
      model: context.model.slice(slashIndex + 1),
    };
  }
  return context;
}

function defaultProvider(agent: AgentName): string | undefined {
  if (agent === "codex") return "openai";
  if (agent === "claude") return "anthropic";
  if (agent === "gemini") return "google";
  return undefined;
}

function nativeCost(total: number, cost: Partial<UsageCostBreakdown> = {}): UsageCostBreakdown {
  return {
    input: cost.input ?? null,
    cacheRead: cost.cacheRead ?? null,
    cacheWrite: cost.cacheWrite ?? null,
    output: cost.output ?? null,
    total,
  };
}

function summarizeUsage(options: {
  agent: AgentName;
  provider?: string;
  model?: string;
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  cost?: UsageCostBreakdown | null;
  pricingSource?: UsageSummary["pricingSource"];
  pricingStatus?: UsageSummary["pricingStatus"];
  modelBreakdowns?: UsagePart[];
}): UsageSummary {
  const cacheReadTokens = options.cacheReadTokens ?? 0;
  const cacheWriteTokens = options.cacheWriteTokens ?? 0;
  const reasoningOutputTokens = options.reasoningOutputTokens ?? 0;
  return {
    agent: options.agent,
    provider: options.provider ?? defaultProvider(options.agent) ?? null,
    model: options.model ?? null,
    inputTokens: options.inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: options.outputTokens,
    reasoningOutputTokens,
    totalTokens: options.inputTokens + options.outputTokens,
    cost: options.cost ?? null,
    pricingSource: options.pricingSource ?? null,
    pricingStatus: options.pricingStatus ?? "missing",
    ...(options.modelBreakdowns ? { modelBreakdowns: options.modelBreakdowns } : {}),
  };
}

function firstModelFromUsage(record: JsonRecord): string | undefined {
  const modelUsage = asRecord(record.modelUsage);
  return Object.keys(modelUsage).at(0);
}

function extractModel(records: JsonRecord[], context: { provider?: string; model?: string }): string | undefined {
  const requested = requestedProviderModel(context);
  if (requested.model) return requested.model;

  for (const record of records) {
    const model = asString(record.model).trim();
    if (model) return model;
    const messageModel = asString(asRecord(record.message).model).trim();
    if (messageModel) return messageModel;
  }
  return undefined;
}

function extractProvider(records: JsonRecord[], context: { provider?: string; model?: string }, agent: AgentName): string | undefined {
  const requested = requestedProviderModel(context);
  if (requested.provider) return requested.provider;
  for (const record of records) {
    const provider = asString(record.provider).trim();
    if (provider) return provider;
    const messageProvider = asString(asRecord(record.message).provider).trim();
    if (messageProvider) return messageProvider;
  }
  return defaultProvider(agent);
}

function extractClaudeUsage(records: JsonRecord[], context: { provider?: string; model?: string }): UsageSummary | undefined {
  const record = latestRecordWith(records, (item) => Object.keys(asRecord(item.usage)).length > 0);
  if (!record) return undefined;
  const usage = asRecord(record.usage);
  const model = extractModel(records, context) ?? firstModelFromUsage(record);
  const totalCost = asNumber(record.total_cost_usd);
  return summarizeUsage({
    agent: "claude",
    provider: "anthropic",
    model,
    inputTokens: asNumber(usage.input_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheWriteTokens: asNumber(usage.cache_creation_input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cost: totalCost > 0 ? nativeCost(totalCost) : null,
    pricingSource: totalCost > 0 ? "native" : null,
    pricingStatus: totalCost > 0 ? "native" : "missing",
  });
}

function extractCodexUsage(records: JsonRecord[], context: { provider?: string; model?: string }): UsageSummary | undefined {
  const record = latestRecordWith(records, (item) => Object.keys(asRecord(item.usage)).length > 0);
  if (!record) return undefined;
  const usage = asRecord(record.usage);
  const requested = requestedProviderModel(context);
  return summarizeUsage({
    agent: "codex",
    provider: requested.provider ?? "openai",
    model: extractModel(records, context),
    inputTokens: asNumber(usage.input_tokens),
    cacheReadTokens: asNumber(usage.cached_input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    reasoningOutputTokens: asNumber(usage.reasoning_output_tokens),
  });
}

function extractCursorUsage(records: JsonRecord[], context: { provider?: string; model?: string }): UsageSummary | undefined {
  const record = latestRecordWith(records, (item) => Object.keys(asRecord(item.usage)).length > 0);
  if (!record) return undefined;
  const usage = asRecord(record.usage);
  return summarizeUsage({
    agent: "cursor",
    provider: extractProvider(records, context, "cursor"),
    model: extractModel(records, context),
    inputTokens: asNumber(usage.inputTokens),
    cacheReadTokens: asNumber(usage.cacheReadTokens),
    cacheWriteTokens: asNumber(usage.cacheWriteTokens),
    outputTokens: asNumber(usage.outputTokens),
  });
}

function extractGeminiUsage(records: JsonRecord[], context: { provider?: string; model?: string }): UsageSummary | undefined {
  const record = latestRecordWith(records, (item) => Object.keys(asRecord(item.stats)).length > 0);
  if (!record) return undefined;
  const stats = asRecord(record.stats);
  const models = asRecord(stats.models);
  const modelEntries = Object.entries(models)
    .map(([model, value]) => {
      const usage = asRecord(value);
      return {
        provider: "google",
        model,
        inputTokens: asNumber(usage.input_tokens),
        cacheReadTokens: asNumber(usage.cached),
        cacheWriteTokens: 0,
        outputTokens: asNumber(usage.output_tokens),
      };
    })
    .filter((part) => part.inputTokens + part.cacheReadTokens + part.outputTokens > 0);

  if (modelEntries.length > 0) {
    return summarizeUsage({
      agent: "gemini",
      provider: "google",
      model: modelEntries.length === 1 ? modelEntries[0]?.model : "mixed",
      inputTokens: modelEntries.reduce((sum, part) => sum + part.inputTokens, 0),
      cacheReadTokens: modelEntries.reduce((sum, part) => sum + part.cacheReadTokens, 0),
      outputTokens: modelEntries.reduce((sum, part) => sum + part.outputTokens, 0),
      modelBreakdowns: modelEntries,
    });
  }

  return summarizeUsage({
    agent: "gemini",
    provider: "google",
    model: extractModel(records, context),
    inputTokens: asNumber(stats.input_tokens ?? stats.input),
    cacheReadTokens: asNumber(stats.cached),
    outputTokens: asNumber(stats.output_tokens),
  });
}

function extractOpencodeUsage(records: JsonRecord[], context: { provider?: string; model?: string }): UsageSummary | undefined {
  const record = latestRecordWith(records, (item) => Object.keys(asRecord(asRecord(item.part).tokens)).length > 0);
  if (!record) return undefined;
  const part = asRecord(record.part);
  const tokens = asRecord(part.tokens);
  const cache = asRecord(tokens.cache);
  const requested = requestedProviderModel(context);
  const totalCost = asNumber(part.cost);
  return summarizeUsage({
    agent: "opencode",
    provider: requested.provider,
    model: extractModel(records, context),
    inputTokens: asNumber(tokens.input),
    cacheReadTokens: asNumber(cache.read),
    cacheWriteTokens: asNumber(cache.write),
    outputTokens: asNumber(tokens.output),
    reasoningOutputTokens: asNumber(tokens.reasoning),
    cost: totalCost > 0 ? nativeCost(totalCost) : null,
    pricingSource: totalCost > 0 ? "native" : null,
    pricingStatus: totalCost > 0 ? "native" : "missing",
  });
}

function extractPiUsage(records: JsonRecord[], context: { provider?: string; model?: string }): UsageSummary | undefined {
  const record = latestRecordWith(records, (item) => Object.keys(asRecord(asRecord(item.message).usage)).length > 0);
  if (!record) return undefined;
  const message = asRecord(record.message);
  const usage = asRecord(message.usage);
  const cost = asRecord(usage.cost);
  const totalCost = asNumber(cost.total);
  return summarizeUsage({
    agent: "pi",
    provider: asString(message.provider).trim() || extractProvider(records, context, "pi"),
    model: asString(message.model).trim() || extractModel(records, context),
    inputTokens: asNumber(usage.input),
    cacheReadTokens: asNumber(usage.cacheRead),
    cacheWriteTokens: asNumber(usage.cacheWrite),
    outputTokens: asNumber(usage.output),
    cost:
      totalCost > 0
        ? nativeCost(totalCost, {
            input: asNumber(cost.input),
            cacheRead: asNumber(cost.cacheRead),
            cacheWrite: asNumber(cost.cacheWrite),
            output: asNumber(cost.output),
          })
        : null,
    pricingSource: totalCost > 0 ? "native" : null,
    pricingStatus: totalCost > 0 ? "native" : "missing",
  });
}

export function extractUsageSummary(
  agent: AgentName,
  stdout: string,
  context: { provider?: string; model?: string } = {},
): UsageSummary {
  const records = parseJsonValues(stdout).flatMap(flattenRecords);
  const summary =
    agent === "claude"
      ? extractClaudeUsage(records, context)
      : agent === "codex"
        ? extractCodexUsage(records, context)
        : agent === "cursor"
          ? extractCursorUsage(records, context)
          : agent === "gemini"
            ? extractGeminiUsage(records, context)
            : agent === "opencode"
              ? extractOpencodeUsage(records, context)
              : extractPiUsage(records, context);

  return (
    summary ??
    summarizeUsage({
      agent,
      provider: extractProvider(records, context, agent),
      model: extractModel(records, context),
      inputTokens: 0,
      outputTokens: 0,
    })
  );
}

function findPricingModel(
  pricingData: PricingData,
  provider: string | null,
  model: string | null,
): { provider: string; model: PricingModel } | undefined {
  if (!model) return undefined;
  const normalizedModel = model.toLowerCase();
  if (provider) {
    const providerModels = pricingData[provider]?.models;
    const direct = providerModels?.[model];
    if (direct) return { provider, model: direct };
  }
  for (const [providerId, providerData] of Object.entries(pricingData)) {
    for (const [modelId, modelData] of Object.entries(providerData.models ?? {})) {
      if (
        modelId.toLowerCase() === normalizedModel ||
        modelData.id?.toLowerCase() === normalizedModel ||
        modelData.name?.toLowerCase() === normalizedModel
      ) {
        return { provider: providerId, model: modelData };
      }
    }
  }
  return undefined;
}

function priceTokens(tokens: number, rate: number | undefined): number | undefined {
  if (tokens === 0) return 0;
  if (rate === undefined) return undefined;
  return (tokens * rate) / 1_000_000;
}

function roundCost(value: number): number {
  return Number(value.toFixed(12));
}

function addCost(left: UsageCostBreakdown, right: UsageCostBreakdown): UsageCostBreakdown {
  return {
    input: left.input !== null && right.input !== null ? roundCost(left.input + right.input) : null,
    cacheRead: left.cacheRead !== null && right.cacheRead !== null ? roundCost(left.cacheRead + right.cacheRead) : null,
    cacheWrite: left.cacheWrite !== null && right.cacheWrite !== null ? roundCost(left.cacheWrite + right.cacheWrite) : null,
    output: left.output !== null && right.output !== null ? roundCost(left.output + right.output) : null,
    total: left.total !== null && right.total !== null ? roundCost(left.total + right.total) : null,
  };
}

function priceUsagePart(part: UsagePart, pricingData: PricingData): UsageCostBreakdown | undefined {
  const pricing = findPricingModel(pricingData, part.provider ?? null, part.model ?? null);
  const cost = pricing?.model.cost;
  if (!cost) return undefined;
  const input = priceTokens(part.inputTokens, cost.input);
  const cacheRead = priceTokens(part.cacheReadTokens, cost.cache_read);
  const cacheWrite = priceTokens(part.cacheWriteTokens, cost.cache_write);
  const output = priceTokens(part.outputTokens, cost.output);
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined || output === undefined) {
    return undefined;
  }
  return {
    input: roundCost(input),
    cacheRead: roundCost(cacheRead),
    cacheWrite: roundCost(cacheWrite),
    output: roundCost(output),
    total: roundCost(input + cacheRead + cacheWrite + output),
  };
}

export function priceUsageSummary(summary: UsageSummary, pricingData: PricingData): UsageSummary {
  const { modelBreakdowns: _modelBreakdowns, ...publicSummary } = summary;
  if (summary.pricingStatus === "native") {
    return publicSummary;
  }

  const parts =
    summary.modelBreakdowns ??
    [
      {
        provider: summary.provider ?? undefined,
        model: summary.model ?? undefined,
        inputTokens: summary.inputTokens,
        cacheReadTokens: summary.cacheReadTokens,
        cacheWriteTokens: summary.cacheWriteTokens,
        outputTokens: summary.outputTokens,
      },
    ];
  const pricedParts = parts.map((part) => priceUsagePart(part, pricingData));
  if (pricedParts.some((part) => part === undefined)) {
    return { ...publicSummary, cost: null, pricingSource: null, pricingStatus: "missing" };
  }
  const cost = (pricedParts as UsageCostBreakdown[]).reduce(
    (sum, part) => addCost(sum, part),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
  );
  return { ...publicSummary, cost, pricingSource: "models.dev", pricingStatus: "priced" };
}

export async function fetchModelsDevPricing(): Promise<PricingData> {
  const response = await fetch("https://models.dev/api.json");
  if (!response.ok) {
    throw new Error(`models.dev pricing request failed: ${response.status}`);
  }
  return (await response.json()) as PricingData;
}
