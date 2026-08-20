import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchModelsDevPricing } from "../src/output.ts";
import { modelsDevCachePath } from "../src/models-dev.ts";

const pricing = {
  openai: {
    models: {
      "gpt-test": { cost: { input: 1, output: 2 } },
    },
  },
};

test("models.dev pricing fetch aborts at its deadline", async () => {
  await assert.rejects(
    fetchModelsDevPricing({
      timeoutMs: 10,
      fetchImpl: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    }),
    /timed out|aborted/i,
  );
});

test("models.dev pricing fetch rejects oversized responses", async () => {
  await assert.rejects(
    fetchModelsDevPricing({
      fetchImpl: async () => new Response("x".repeat(8 * 1024 * 1024 + 1)),
    }),
    /too large/i,
  );
});

test("models.dev pricing fetch cancels non-success response bodies", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel: () => {
      cancelled = true;
    },
  });

  await assert.rejects(
    fetchModelsDevPricing({ fetchImpl: async () => new Response(body, { status: 503 }) }),
    /503/,
  );
  assert.equal(cancelled, true);
});

test("models.dev pricing fetch rejects malformed model identity", async () => {
  await assert.rejects(
    fetchModelsDevPricing({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ provider: { models: { model: { id: 42, cost: { input: 1 } } } } }),
        ),
    }),
    /invalid/,
  );
});

test("models.dev pricing fetch reuses a fresh persistent cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-models-dev-"));
  const cachePath = join(directory, "pricing.json");
  let fetchCount = 0;
  try {
    const options = {
      cachePath,
      now: () => 1_000,
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify(pricing));
      },
    };

    assert.deepEqual(await fetchModelsDevPricing(options), pricing);
    assert.deepEqual(await fetchModelsDevPricing(options), pricing);
    assert.equal(fetchCount, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("models.dev pricing fetch falls back to stale cache during an outage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-models-dev-"));
  const cachePath = join(directory, "pricing.json");
  try {
    await fetchModelsDevPricing({
      cachePath,
      now: () => 1_000,
      fetchImpl: async () => new Response(JSON.stringify(pricing)),
    });

    const cached = await fetchModelsDevPricing({
      cachePath,
      now: () => 1_000 + 25 * 60 * 60 * 1_000,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });

    assert.deepEqual(cached, pricing);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("models.dev pricing fetch rejects malformed success responses and keeps stale cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-models-dev-"));
  const cachePath = join(directory, "pricing.json");
  try {
    await fetchModelsDevPricing({
      cachePath,
      now: () => 1_000,
      fetchImpl: async () => new Response(JSON.stringify(pricing)),
    });

    const cached = await fetchModelsDevPricing({
      cachePath,
      now: () => 1_000 + 25 * 60 * 60 * 1_000,
      fetchImpl: async () => new Response(JSON.stringify({ error: "temporary failure" })),
    });

    assert.deepEqual(cached, pricing);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("models.dev pricing fetch ignores a group-writable cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-models-dev-"));
  const cachePath = join(directory, "pricing.json");
  let fetchCount = 0;
  try {
    const options = {
      cachePath,
      now: () => 1_000,
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify(pricing));
      },
    };
    await fetchModelsDevPricing(options);
    chmodSync(cachePath, 0o620);
    await fetchModelsDevPricing(options);

    assert.equal(fetchCount, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("models.dev pricing cache path defaults to Headless state and supports opt-out", () => {
  assert.equal(
    modelsDevCachePath({ HOME: "/tmp/test-home" }),
    "/tmp/test-home/.headless/cache/models-dev-pricing.json",
  );
  assert.equal(modelsDevCachePath({ HOME: "/tmp/test-home", HEADLESS_MODELS_DEV_CACHE: "" }), undefined);
});
