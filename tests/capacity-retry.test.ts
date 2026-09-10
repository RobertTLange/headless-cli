import assert from "node:assert/strict";
import test from "node:test";
import { BillingEventCollector } from "../src/billing-events.ts";
import { runWithBilling, type BillingRunOptions } from "../src/billing-run.ts";
import { resolveCapacityRetries, waitForCapacityRetry } from "../src/capacity-retry.ts";

const message = "Selected model is at capacity. Please try a different model.";
const record = (value: unknown) => `${JSON.stringify(value)}\n`;
const capacity = record({ type: "turn.failed", error: { message } });
const thread = record({ type: "thread.started", thread_id: "thread-123" });
const work = record({ type: "item.completed", item: { type: "command_execution" } });
const quota = record({ type: "turn.failed", error: { type: "usage_limit_reached" } });
const base: Pick<BillingRunOptions, "agent" | "mode" | "env" | "options"> = {
  agent: "codex", mode: "subscription", env: {},
  options: { prompt: "original", model: "gpt-test", reasoningEffort: "high" },
};

function collect(trace: string) {
  const events = new BillingEventCollector("codex");
  for (const chunk of [trace.slice(0, 11), trace.slice(11)]) events.write(chunk);
  events.end();
  return events;
}

test("capacity classification requires the exact native terminal failure", () => {
  assert.equal(collect(capacity).capacityFailure, true);
  for (const trace of [
    record({ type: "error", message }),
    record({ type: "turn.failed", error: { message: `${message} extra` } }),
    record({ type: "item.completed", item: { type: "agent_message", text: capacity } }),
    record({ type: "item.completed", item: { type: "command_execution", aggregated_output: capacity } }),
    capacity + record({ type: "turn.completed" }),
    capacity + record({ type: "turn.failed", error: { message: "other failure" } }),
  ]) assert.equal(collect(trace).capacityFailure, false, trace);
  const claude = new BillingEventCollector("claude");
  claude.write(capacity);
  assert.equal(claude.capacityFailure, false);
});

test("retry configuration is bounded and defaults to three", () => {
  assert.equal(resolveCapacityRetries({}), 3);
  for (let count = 0; count <= 3; count++) {
    assert.equal(resolveCapacityRetries({ HEADLESS_CAPACITY_RETRIES: String(count) }), count);
  }
  for (const value of ["", "4", "-1", "1.5", "03", " 1", "yes"]) {
    assert.throws(() => resolveCapacityRetries({ HEADLESS_CAPACITY_RETRIES: value }), /HEADLESS_CAPACITY_RETRIES/);
  }
});

test("capacity retry preserves routing and resumes with remaining deadline", async () => {
  let now = 0;
  const attempts: Parameters<BillingRunOptions["execute"]>[0][] = [];
  const transitions: unknown[] = [];
  const outcome = await runWithBilling({ ...base, timeoutSeconds: 100,
    now: () => now, random: () => 0.5,
    sleep: async (delay) => { assert.equal(delay, 30_000); now += delay; },
    onCapacityRetry: (event) => transitions.push(event),
    execute: async (attempt) => {
      attempts.push(attempt);
      if (attempts.length === 1) {
        attempt.observe(thread + work + capacity);
        now += 10_000;
        return { code: 1, stdout: "first" };
      }
      return { code: 0, stdout: "done" };
    },
  });
  assert.equal(outcome.result.code, 0);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].timeoutSeconds, 60);
  assert.equal(attempts[1].route, attempts[0].route);
  assert.deepEqual(attempts[1].env, attempts[0].env);
  assert.equal(attempts[1].options.model, base.options.model);
  assert.equal(attempts[1].options.reasoningEffort, "high");
  assert.equal(attempts[1].options.sessionId, "thread-123");
  assert.equal(attempts[1].options.sessionMode, "resume");
  assert.match(attempts[1].options.prompt, /capacity/);
  assert.equal(attempts[1].options.promptFile, undefined);
  assert.deepEqual(transitions, [{ type: "capacity_retry", retry: 1, delayMs: 30_000, reason: "model-capacity" }]);
});

test("three capacity retries exhaust with bounded exponential jitter", async () => {
  let calls = 0;
  const delays: number[] = [];
  const outcome = await runWithBilling({ ...base, random: () => 0,
    sleep: async (delay) => { delays.push(delay); },
    execute: async ({ observe }) => { calls++; observe(capacity); return { code: 1, stdout: "failed" }; },
  });
  assert.equal(calls, 4);
  assert.deepEqual(delays, [24_000, 48_000, 96_000]);
  assert.equal(outcome.result.code, 1);
  assert.match(outcome.error ?? "", /capacity.*exhausted/);
});

for (const retries of [0, 1, 2]) {
  test(`configured capacity retry limit ${retries}`, async () => {
    let calls = 0;
    await runWithBilling({ ...base, env: { HEADLESS_CAPACITY_RETRIES: String(retries) },
      sleep: async () => {},
      execute: async ({ observe }) => { calls++; observe(capacity); return { code: 1, stdout: "" }; },
    });
    assert.equal(calls, retries + 1);
  });
}

test("no-work retry can replay prompt, but partial work without a session cannot", async () => {
  for (const trace of [capacity, work + capacity]) {
    let calls = 0;
    const outcome = await runWithBilling({ ...base, sleep: async () => {},
      execute: async ({ observe, options }) => {
        calls++;
        assert.equal(options.prompt, "original");
        if (calls === 1) { observe(trace); return { code: 1, stdout: "retained" }; }
        return { code: 0, stdout: "done" };
      },
    });
    assert.equal(calls, trace === capacity ? 2 : 1);
    if (trace !== capacity) {
      assert.equal(outcome.result.stdout, "retained");
      assert.match(outcome.error ?? "", /cannot safely resume/);
    }
  }
});

test("successful native recovery and ordinary failures never trigger capacity retry", async () => {
  for (const trace of [record({ type: "error", message }) + record({ type: "turn.completed" }),
    record({ type: "turn.failed", error: { message: "bad input" } }), ""]) {
    let calls = 0;
    await runWithBilling({ ...base, sleep: async () => { assert.fail("unexpected wait"); },
      execute: async ({ observe }) => { calls++; observe(trace); return { code: 1, stdout: "" }; },
    });
    assert.equal(calls, 1);
  }
});

test("remaining deadline bounds waiting and prevents another launch", async () => {
  let now = 0;
  let calls = 0;
  const outcome = await runWithBilling({ ...base, timeoutSeconds: 5, now: () => now,
    sleep: async (delay) => { assert.equal(delay, 5_000); now += delay; },
    execute: async ({ observe }) => { calls++; observe(capacity); return { code: 1, stdout: "retained" }; },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.result.code, 124);
});

for (const code of [124, 129, 130, 131, 137, 143, 149]) {
  test(`terminated execution ${code} never retries capacity`, async () => {
    const outcome = await runWithBilling({ ...base,
      sleep: async () => { assert.fail("unexpected sleep"); },
      execute: async ({ observe }) => { observe(capacity); return { code, stdout: "" }; },
    });
    assert.equal(outcome.result.code, code);
  });
}

test("cancellation during backoff preserves the signal status and transcript", async () => {
  const controller = new AbortController();
  let calls = 0;
  const outcome = await runWithBilling({ ...base, signal: controller.signal,
    sleep: async () => { controller.abort(143); throw new Error("aborted"); },
    execute: async ({ observe }) => { calls++; observe(capacity); return { code: 1, stdout: "retained" }; },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.result.code, 143);
  assert.equal(outcome.result.stdout, "retained");
});

test("already cancelled invocations do not launch", async () => {
  const outcome = await runWithBilling({ ...base, signal: AbortSignal.abort(),
    execute: async () => { assert.fail("unexpected launch"); },
  });
  assert.equal(outcome.result.code, 130);
});

test("default backoff timer can be interrupted", async () => {
  await waitForCapacityRetry(1);
  const controller = new AbortController();
  const waiting = waitForCapacityRetry(120_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("billing transition and capacity budgets are independent and usage is counted once", async () => {
  let calls = 0;
  let transitions = 0;
  const routes: string[] = [];
  const outcome = await runWithBilling({ ...base, mode: "auto",
    env: { CODEX_ACCESS_TOKEN: "subscription", OPENAI_API_KEY: "test" }, sleep: async () => {},
    onTransition: () => { transitions++; },
    execute: async ({ observe, route }) => {
      calls++; routes.push(route);
      observe(thread + (calls === 2 ? quota : capacity));
      return { code: 1, stdout: String(calls) };
    },
    reportUsage: async (trace) => ({ agent: "codex", inputTokens: Number(trace), cacheReadTokens: 0,
      cacheWriteTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: Number(trace),
      usageStatus: "reported", cost: null, costBasis: null, pricingSource: null, pricingStatus: "missing" }),
  });
  assert.equal(calls, 5);
  assert.equal(transitions, 1);
  assert.deepEqual(routes, ["subscription", "subscription", "openai-api", "openai-api", "openai-api"]);
  assert.equal(outcome.usage?.inputTokens, 15);
  assert.equal(outcome.usage?.billing.attempts.length, 5);
  assert.equal(outcome.usage?.billing.attempts[1].retryReason, "model-capacity");
  assert.equal(outcome.usage?.billing.attempts[2].reason, "subscription-quota");
  assert.equal(outcome.usage?.billing.attempts[3].reason, undefined);
});

test("subscription-only quota remains terminal after a capacity retry", async () => {
  let calls = 0;
  const outcome = await runWithBilling({ ...base, env: { OPENAI_API_KEY: "unused" }, sleep: async () => {},
    execute: async ({ observe, route }) => {
      calls++; assert.equal(route, "subscription");
      observe(thread + (calls === 1 ? capacity : quota));
      return { code: 1, stdout: "" };
    },
  });
  assert.equal(calls, 2);
  assert.equal(outcome.result.code, 78);
});

test("native termination signal after capacity failure never retries", async () => {
  const outcome = await runWithBilling({ ...base,
    sleep: async () => { assert.fail("terminated execution must not retry"); },
    execute: async ({ observe }) => {
      observe(capacity);
      return { code: 1, stdout: "retained", terminationSignal: "SIGTERM" };
    },
  });
  assert.equal(outcome.result.code, 1);
});
