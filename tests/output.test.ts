import assert from "node:assert/strict";
import test from "node:test";

import { extractAgentError, extractFinalMessage, extractUsageSummary, priceUsageSummary } from "../src/output.ts";

test("extracts final Codex assistant message from JSONL trace", () => {
  const trace = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "older answer" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "final codex answer" }],
      },
    }),
  ].join("\n");

  assert.equal(extractFinalMessage("codex", trace), "final codex answer");
});

test("extracts final Codex agent_message from item.completed trace", () => {
  const trace = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: "final codex agent message",
      },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");

  assert.equal(extractFinalMessage("codex", trace), "final codex agent message");
});

test("extracts final Claude assistant message from stream JSON trace", () => {
  const trace = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "final claude answer" }],
    },
  });

  assert.equal(extractFinalMessage("claude", trace), "final claude answer");
});

test("extracts final Claude assistant message from result JSON trace", () => {
  const trace = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "final claude result answer",
  });

  assert.equal(extractFinalMessage("claude", trace), "final claude result answer");
});

test("extracts final Cursor assistant message from stream JSON trace", () => {
  const trace = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "final cursor answer" }],
    },
  });

  assert.equal(extractFinalMessage("cursor", trace), "final cursor answer");
});

test("extracts final Gemini assistant message from JSON object trace", () => {
  const trace = JSON.stringify({
    type: "model",
    content: {
      parts: [{ text: "final gemini answer" }],
    },
  });

  assert.equal(extractFinalMessage("gemini", trace), "final gemini answer");
});

test("extracts final Gemini assistant message from response JSON trace", () => {
  const trace = JSON.stringify({
    response: "final gemini response answer",
  });

  assert.equal(extractFinalMessage("gemini", trace), "final gemini response answer");
});

test("concatenates Gemini assistant delta messages", () => {
  const trace = [
    JSON.stringify({ type: "message", role: "assistant", content: "Hello! I", delta: true }),
    JSON.stringify({
      type: "message",
      role: "assistant",
      content: "'m ready to help.",
      delta: true,
    }),
    JSON.stringify({ type: "result", status: "success" }),
  ].join("\n");

  assert.equal(extractFinalMessage("gemini", trace), "Hello! I'm ready to help.");
});

test("extracts final OpenCode assistant message from JSON event trace", () => {
  const trace = JSON.stringify({
    role: "assistant",
    parts: [{ type: "text", text: "final opencode answer" }],
  });

  assert.equal(extractFinalMessage("opencode", trace), "final opencode answer");
});

test("extracts final OpenCode text part event", () => {
  const trace = JSON.stringify({
    type: "text",
    part: {
      type: "text",
      text: "final opencode text part",
    },
  });

  assert.equal(extractFinalMessage("opencode", trace), "final opencode text part");
});

test("extracts OpenCode provider error events", () => {
  const trace = JSON.stringify({
    type: "error",
    error: {
      name: "ProviderAuthError",
      data: {
        providerID: "gemini",
        message:
          "Google Generative AI API key is missing. Pass it using the 'apiKey' parameter or the GOOGLE_GENERATIVE_AI_API_KEY environment variable.",
      },
    },
  });

  assert.equal(
    extractAgentError("opencode", trace),
    "opencode error: ProviderAuthError: Google Generative AI API key is missing. Pass it using the 'apiKey' parameter or the GOOGLE_GENERATIVE_AI_API_KEY environment variable.",
  );
});

test("extracts final Pi assistant message from JSONL trace", () => {
  const trace = JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "final pi answer" }],
    },
  });

  assert.equal(extractFinalMessage("pi", trace), "final pi answer");
});

test("ignores tool results and returns empty string when no assistant text exists", () => {
  const trace = JSON.stringify({
    type: "message",
    message: {
      role: "toolresult",
      content: [{ type: "text", text: "tool output only" }],
    },
  });

  assert.equal(extractFinalMessage("pi", trace), "");
});

test("extracts Codex usage from turn completed trace and prices with models.dev data", () => {
  const trace = JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 400,
      output_tokens: 100,
      reasoning_output_tokens: 25,
    },
  });

  const summary = priceUsageSummary(
    extractUsageSummary("codex", trace, { provider: "openai", model: "gpt-5" }),
    pricingFixture(),
  );

  assert.deepEqual(summary, {
    agent: "codex",
    provider: "openai",
    model: "gpt-5",
    inputTokens: 600,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 25,
    totalTokens: 1100,
    cost: {
      input: 0.00075,
      cacheRead: 0.00005,
      cacheWrite: 0,
      output: 0.001,
      total: 0.0018,
    },
    pricingSource: "models.dev",
    pricingStatus: "priced",
  });
});

test("extracts Claude usage and preserves native cost", () => {
  const trace = JSON.stringify({
    type: "result",
    total_cost_usd: 0.18331675,
    usage: {
      input_tokens: 3,
      cache_creation_input_tokens: 29231,
      cache_read_input_tokens: 0,
      output_tokens: 8,
    },
    modelUsage: {
      "claude-opus-4-6": {
        inputTokens: 3,
        outputTokens: 8,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 29231,
        costUSD: 0.18331675,
      },
    },
  });

  assert.deepEqual(extractUsageSummary("claude", trace), {
    agent: "claude",
    provider: "anthropic",
    model: "claude-opus-4-6",
    inputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 29231,
    outputTokens: 8,
    reasoningOutputTokens: 0,
    totalTokens: 29242,
    cost: {
      input: null,
      cacheRead: null,
      cacheWrite: null,
      output: null,
      total: 0.18331675,
    },
    pricingSource: "native",
    pricingStatus: "native",
  });
});

test("extracts Claude usage with requested model when modelUsage includes sidecars", () => {
  const trace = JSON.stringify({
    type: "result",
    total_cost_usd: 0.0930365,
    usage: {
      input_tokens: 3,
      cache_creation_input_tokens: 13246,
      cache_read_input_tokens: 15130,
      output_tokens: 90,
    },
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 353,
        outputTokens: 11,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.000408,
      },
      "claude-opus-4-6": {
        inputTokens: 3,
        outputTokens: 90,
        cacheReadInputTokens: 15130,
        cacheCreationInputTokens: 13246,
        costUSD: 0.0926285,
      },
    },
  });

  const summary = extractUsageSummary("claude", trace, { provider: "anthropic", model: "claude-opus-4-6" });

  assert.equal(summary.model, "claude-opus-4-6");
  assert.equal(summary.cost?.total, 0.0930365);
  assert.equal(summary.pricingStatus, "native");
});

test("extracts Cursor usage and returns null cost when model pricing is missing", () => {
  const trace = JSON.stringify({
    type: "result",
    usage: {
      inputTokens: 3705,
      outputTokens: 43,
      cacheReadTokens: 5216,
      cacheWriteTokens: 0,
    },
    model: "Composer 2 Fast",
  });

  const summary = priceUsageSummary(extractUsageSummary("cursor", trace), pricingFixture());

  assert.equal(summary.inputTokens, 3705);
  assert.equal(summary.cacheReadTokens, 5216);
  assert.equal(summary.outputTokens, 43);
  assert.equal(summary.model, "Composer 2 Fast");
  assert.equal(summary.cost, null);
  assert.equal(summary.pricingStatus, "missing");
});

test("prices Cursor effort model variants with base model rates", () => {
  const trace = JSON.stringify({
    type: "result",
    usage: {
      inputTokens: 1000,
      outputTokens: 20,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    },
  });

  const summary = priceUsageSummary(
    extractUsageSummary("cursor", trace, { model: "gpt-5.5-extra-high" }),
    {
      openai: {
        models: {
          "gpt-5.5": {
            cost: {
              input: 2,
              cache_read: 0.2,
              output: 20,
            },
          },
        },
      },
    },
  );

  assert.equal(summary.model, "gpt-5.5-extra-high");
  assert.deepEqual(summary.cost, {
    input: 0.002,
    cacheRead: 0.00008,
    cacheWrite: 0,
    output: 0.0004,
    total: 0.00248,
  });
  assert.equal(summary.pricingStatus, "priced");
});

test("extracts Gemini multi-model usage and sums priced costs", () => {
  const trace = JSON.stringify({
    type: "result",
    stats: {
      models: {
        "gemini-2.5-flash-lite": {
          input_tokens: 1000,
          output_tokens: 40,
          cached: 200,
        },
        "gemini-3-flash-preview": {
          input_tokens: 2000,
          output_tokens: 4,
          cached: 0,
        },
      },
    },
  });

  const summary = priceUsageSummary(extractUsageSummary("gemini", trace), pricingFixture());

  assert.equal(summary.inputTokens, 2800);
  assert.equal(summary.cacheReadTokens, 200);
  assert.equal(summary.outputTokens, 44);
  assert.equal(summary.provider, "google");
  assert.equal(summary.model, "mixed");
  assert.deepEqual(summary.cost, {
    input: 0.00108,
    cacheRead: 0.000005,
    cacheWrite: 0,
    output: 0.000028,
    total: 0.001113,
  });
  assert.equal(summary.pricingStatus, "priced");
});

test("extracts OpenCode native usage cost", () => {
  const trace = JSON.stringify({
    type: "step_finish",
    part: {
      tokens: {
        input: 15777,
        output: 24,
        reasoning: 192,
        cache: { read: 0, write: 0 },
      },
      cost: 0.00087525,
    },
  });

  const summary = extractUsageSummary("opencode", trace, { provider: "openai", model: "gpt-5-nano" });

  assert.equal(summary.inputTokens, 15777);
  assert.equal(summary.outputTokens, 24);
  assert.equal(summary.reasoningOutputTokens, 192);
  assert.equal(summary.totalTokens, 15993);
  assert.deepEqual(summary.cost, {
    input: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    total: 0.00087525,
  });
  assert.equal(summary.pricingStatus, "native");
});

test("extracts Pi usage and native cost", () => {
  const trace = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "amazon-bedrock",
      model: "global.anthropic.claude-opus-4-6-v1",
      usage: {
        input: 2310,
        output: 7,
        cacheRead: 10,
        cacheWrite: 20,
        cost: {
          input: 0.01155,
          output: 0.000175,
          cacheRead: 0.000005,
          cacheWrite: 0.000125,
          total: 0.011855,
        },
      },
    },
  });

  assert.deepEqual(extractUsageSummary("pi", trace), {
    agent: "pi",
    provider: "amazon-bedrock",
    model: "global.anthropic.claude-opus-4-6-v1",
    inputTokens: 2310,
    cacheReadTokens: 10,
    cacheWriteTokens: 20,
    outputTokens: 7,
    reasoningOutputTokens: 0,
    totalTokens: 2347,
    cost: {
      input: 0.01155,
      output: 0.000175,
      cacheRead: 0.000005,
      cacheWrite: 0.000125,
      total: 0.011855,
    },
    pricingSource: "native",
    pricingStatus: "native",
  });
});

function pricingFixture() {
  return {
    openai: {
      models: {
        "gpt-5": {
          cost: {
            input: 1.25,
            cache_read: 0.125,
            output: 10,
          },
        },
      },
    },
    google: {
      models: {
        "gemini-2.5-flash-lite": {
          cost: {
            input: 0.1,
            cache_read: 0.025,
            output: 0.4,
          },
        },
        "gemini-3-flash-preview": {
          cost: {
            input: 0.5,
            cache_read: 0.05,
            output: 3,
          },
        },
      },
    },
  };
}
