import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const modelsDevPricingUrl = "https://models.dev/api.json";
const defaultTimeoutMs = 5_000;
const maxPricingBytes = 8 * 1024 * 1024;
const pricingCacheTtlMs = 24 * 60 * 60 * 1_000;

export type ModelsDevPricingData = Record<
  string,
  {
    models?: Record<
      string,
      {
        id?: string;
        name?: string;
        cost?: {
          input?: number;
          output?: number;
          cache_read?: number;
          cache_write?: number;
        };
      }
    >;
  }
>;

export interface ModelsDevPricingOptions {
  cachePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

type PricingEnv = Record<string, string | undefined>;

interface PricingCache {
  fetchedAt: number;
  pricing: ModelsDevPricingData;
  version: 1;
}

interface CachedPricing {
  fresh: boolean;
  pricing: ModelsDevPricingData;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasValidCost(cost: Record<string, unknown>): boolean {
  return ["input", "output", "cache_read", "cache_write"].every((field) => {
    const rate = cost[field];
    return rate === undefined || (typeof rate === "number" && Number.isFinite(rate) && rate >= 0);
  });
}

function pricingData(value: unknown): ModelsDevPricingData | undefined {
  const providers = record(value);
  if (!providers || Object.keys(providers).length === 0) return undefined;

  let hasRate = false;
  for (const providerValue of Object.values(providers)) {
    const provider = record(providerValue);
    const models = record(provider?.models);
    if (!provider || !models) return undefined;
    for (const modelValue of Object.values(models)) {
      const model = record(modelValue);
      if (!model) return undefined;
      if (
        (model.id !== undefined && typeof model.id !== "string") ||
        (model.name !== undefined && typeof model.name !== "string")
      ) {
        return undefined;
      }
      if (model.cost === undefined) continue;
      const cost = record(model.cost);
      if (!cost || !hasValidCost(cost)) return undefined;
      hasRate ||= ["input", "output", "cache_read", "cache_write"].some(
        (field) => cost[field] !== undefined,
      );
    }
  }
  return hasRate ? (value as ModelsDevPricingData) : undefined;
}

async function boundedCacheText(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxPricingBytes + 1 - totalBytes));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, totalBytes);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maxPricingBytes) throw new Error("models.dev pricing cache is too large");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function readPricingCache(cachePath: string, now: number): Promise<CachedPricing | undefined> {
  let handle;
  try {
    handle = await open(
      cachePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxPricingBytes) return undefined;
    const currentUid = process.getuid?.();
    if ((currentUid !== undefined && metadata.uid !== currentUid) || (metadata.mode & 0o022) !== 0) {
      return undefined;
    }
    const parsed = JSON.parse(await boundedCacheText(handle)) as Partial<PricingCache>;
    const pricing = pricingData(parsed.pricing);
    if (parsed.version !== 1 || !Number.isFinite(parsed.fetchedAt) || !pricing) return undefined;
    const age = now - (parsed.fetchedAt as number);
    return { pricing, fresh: age >= 0 && age <= pricingCacheTtlMs };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function modelsDevCachePath(env: PricingEnv): string | undefined {
  if (env.HEADLESS_MODELS_DEV_CACHE !== undefined) {
    return env.HEADLESS_MODELS_DEV_CACHE.trim() || undefined;
  }
  const cacheRoot = env.XDG_CACHE_HOME?.trim();
  if (cacheRoot) return join(cacheRoot, "headless", "models-dev-pricing.json");
  const home = env.HOME?.trim();
  return home ? join(home, ".headless", "cache", "models-dev-pricing.json") : undefined;
}

async function writePricingCache(cachePath: string, cache: PricingCache): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
  const temporary = `${cachePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, cachePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxPricingBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("models.dev pricing response is too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxPricingBytes) {
      await reader.cancel();
      throw new Error("models.dev pricing response is too large");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function requestModelsDevPricing(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ModelsDevPricingData> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("models.dev pricing request timed out")),
    timeoutMs,
  );
  try {
    const response = await fetchImpl(modelsDevPricingUrl, { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`models.dev pricing request failed: ${response.status}`);
    }
    const pricing = pricingData(JSON.parse(await boundedResponseText(response)));
    if (!pricing) throw new Error("models.dev pricing response is invalid");
    return pricing;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchModelsDevPricing(
  options: ModelsDevPricingOptions = {},
): Promise<ModelsDevPricingData> {
  const now = options.now?.() ?? Date.now();
  const cached = options.cachePath ? await readPricingCache(options.cachePath, now) : undefined;
  if (cached?.fresh) return cached.pricing;

  try {
    const pricing = await requestModelsDevPricing(
      options.fetchImpl ?? globalThis.fetch,
      options.timeoutMs ?? defaultTimeoutMs,
    );
    if (options.cachePath) {
      await writePricingCache(options.cachePath, { version: 1, fetchedAt: now, pricing }).catch(
        () => undefined,
      );
    }
    return pricing;
  } catch (error) {
    if (cached) return cached.pricing;
    throw error;
  }
}
