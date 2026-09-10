import { setTimeout } from "node:timers/promises";
import type { Env } from "./types.js";

export const MAX_CAPACITY_RETRIES = 3;
export const MAX_EXECUTION_ATTEMPTS = MAX_CAPACITY_RETRIES + 2;
export const CODEX_CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";
export const CAPACITY_CONTINUATION = "Continue from where you left off. Your previous turn was interrupted by temporary model capacity exhaustion. Preserve completed work and do not repeat completed commands.";

export interface CapacityRetryEvent {
  type: "capacity_retry";
  retry: number;
  delayMs: number;
  reason: "model-capacity";
}

export function resolveCapacityRetries(env: Env): number {
  const value = env.HEADLESS_CAPACITY_RETRIES;
  if (value === undefined) return MAX_CAPACITY_RETRIES;
  if (!/^[0-3]$/.test(value)) {
    throw new Error("HEADLESS_CAPACITY_RETRIES must be 0, 1, 2, or 3");
  }
  return Number(value);
}

export function capacityRetryDelay(retry: number, random: () => number): number {
  return Math.round(30_000 * 2 ** (retry - 1) * (0.8 + 0.4 * random()));
}

export async function waitForCapacityRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  await setTimeout(delayMs, undefined, { signal });
}

export function cancellationCode(signal?: AbortSignal): number | undefined {
  if (!signal?.aborted) return undefined;
  return Number.isInteger(signal.reason) && signal.reason > 0 && signal.reason <= 255
    ? signal.reason as number : 130;
}
