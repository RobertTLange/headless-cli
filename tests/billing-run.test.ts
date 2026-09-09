import assert from "node:assert/strict";
import test from "node:test";
import { runWithBilling } from "../src/billing-run.ts";

const env = { CLAUDE_CODE_OAUTH_TOKEN: "subscription", AWS_ACCESS_KEY_ID: "aws", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1" };
const quota = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } });
const init = JSON.stringify({ type: "system", subtype: "init", session_id: "12345678-1234-1234-1234-123456789abc" });

test("quota retry resumes the same session with Bedrock and remaining deadline", async () => {
  const attempts: any[] = [];
  let clock = 1000;
  const outcome = await runWithBilling({
    agent: "claude", mode: "auto", env, options: { prompt: "original", model: "claude-opus-5", reasoningEffort: "high" },
    timeoutSeconds: 60, now: () => clock,
    execute: async (attempt) => {
      attempts.push(attempt);
      if (attempts.length === 1) {
        attempt.observe(init + "\n" + JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }) + "\n" + quota + "\n");
        clock += 10_000;
        return { code: 1, stdout: quota };
      }
      return { code: 0, stdout: "done" };
    },
  });
  assert.equal(outcome.result.code, 0);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].route, "subscription");
  assert.equal(attempts[0].env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(attempts[1].route, "bedrock");
  assert.equal(attempts[1].env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(attempts[1].options.sessionMode, "resume");
  assert.equal(attempts[1].options.sessionId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(attempts[1].options.reasoningEffort, "high");
  assert.notEqual(attempts[1].options.prompt, "original");
  assert.equal(attempts[1].timeoutSeconds, 50);
});

for (const code of [124, 130, 137, 143]) {
  test(`never retries terminated execution ${code}`, async () => {
    let calls = 0;
    const outcome = await runWithBilling({ agent: "claude", mode: "auto", env, options: { prompt: "task" },
      execute: async ({ observe }) => { calls++; observe(quota + "\n"); return { code, stdout: quota }; },
    });
    assert.equal(calls, 1);
    assert.equal(outcome.result.code, code);
  });
}

test("partial work without a session is retained without replay", async () => {
  let calls = 0;
  const outcome = await runWithBilling({ agent: "claude", mode: "auto", env, options: { prompt: "task" },
    execute: async ({ observe }) => {
      calls++;
      observe(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }) + "\n" + quota + "\n");
      return { code: 1, stdout: "retained transcript" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.result.code, 78);
  assert.match(outcome.error ?? "", /resume/i);
  assert.equal(outcome.result.stdout, "retained transcript");
});

test("missing backup returns terminal billing status instead of another subscription attempt", async () => {
  const outcome = await runWithBilling({ agent: "claude", mode: "auto", env: { CLAUDE_CODE_OAUTH_TOKEN: "subscription" }, options: { prompt: "task" },
    execute: async ({ observe }) => { observe(quota + "\n"); return { code: 1, stdout: quota }; },
  });
  assert.equal(outcome.result.code, 78);
  assert.match(outcome.error ?? "", /Bedrock|AWS/);
});

test("subscription-only quota returns terminal status and never pays", async () => {
  let calls = 0;
  const outcome = await runWithBilling({ agent: "claude", mode: "subscription", env, options: { prompt: "task" },
    execute: async ({ observe }) => { calls++; observe(quota + "\n"); return { code: 1, stdout: quota }; },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.result.code, 78);
});
