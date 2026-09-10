import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";

function fixture(binary = "codex") {
  const home = mkdtempSync(join(tmpdir(), "capacity-cli-"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: "subscription" } }));
  writeFileSync(join(home, binary), `#!/usr/bin/env node
const fs = require('node:fs');
const callsFile = process.env.HOME + '/calls';
const previous = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(callsFile, JSON.stringify({args: process.argv.slice(2), paid: !!process.env.CODEX_API_KEY}) + '\\n');
console.log(JSON.stringify({type:'thread.started', thread_id:'12345678-1234-1234-1234-123456789abc'}));
if (previous === 0) {
  console.log(JSON.stringify({type:'turn.failed', error:{message:'Selected model is at capacity. Please try a different model.'}}));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'finished'}}));
  console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:12, output_tokens:4, cached_input_tokens:0}}));
}
`, { mode: 0o755 });
  return {
    home,
    env: { HOME: home, PATH: `${home}:${process.env.PATH}` },
    calls: (): Array<{ args: string[]; paid: boolean }> => existsSync(join(home, "calls"))
      ? readFileSync(join(home, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("Codex capacity retry resumes and emits a structured retry without changing billing", async () => {
  const run = fixture();
  try {
    const output: string[] = [];
    const errors: string[] = [];
    const delays: number[] = [];
    const code = await runCli(["codex", "--prompt", "task", "--json"], {
      env: run.env, stdout: (text) => output.push(text), stderr: (text) => errors.push(text),
      capacityRetryRandom: () => 0.5,
      capacityRetrySleep: async (delay) => { delays.push(delay); },
    });
    assert.equal(code, 0, errors.join(""));
    assert.deepEqual(delays, [30000]);
    assert.equal(run.calls().length, 2);
    assert.ok(run.calls()[1].args.includes("resume"));
    assert.ok(run.calls().every((call) => !call.paid));
    const retry = output.join("").trim().split("\n").map((line) => JSON.parse(line))
      .find((event) => event.type === "capacity_retry");
    assert.deepEqual(retry, { type: "capacity_retry", retry: 1, delayMs: 30000, reason: "model-capacity" });
    assert.match(errors.join(""), /capacity.*retry/i);
  } finally { run.cleanup(); }
});

test("disabled capacity retries return the native failure after one execution", async () => {
  const run = fixture();
  try {
    const code = await runCli(["codex", "--prompt", "task", "--json"], {
      env: { ...run.env, HEADLESS_CAPACITY_RETRIES: "0" }, stdout: () => {}, stderr: () => {},
      capacityRetrySleep: async () => { assert.fail("retry disabled"); },
    });
    assert.equal(code, 1);
    assert.equal(run.calls().length, 1);
  } finally { run.cleanup(); }
});

test("invalid capacity configuration fails before agent launch", async () => {
  const run = fixture();
  try {
    const errors: string[] = [];
    const code = await runCli(["codex", "--prompt", "task"], {
      env: { ...run.env, HEADLESS_CAPACITY_RETRIES: "4" }, stdout: () => {}, stderr: (text) => errors.push(text),
    });
    assert.equal(code, 2);
    assert.match(errors.join(""), /HEADLESS_CAPACITY_RETRIES/);
    assert.equal(run.calls().length, 0);
  } finally { run.cleanup(); }
});

test("SIGTERM during capacity backoff stops promptly without another launch or leaked handler", async () => {
  const run = fixture();
  const listeners = process.listeners("SIGTERM");
  try {
    const code = await runCli(["codex", "--prompt", "task", "--json"], {
      env: run.env, stdout: () => {}, stderr: () => {},
      capacityRetrySleep: async (_delay, signal) => {
        process.emit("SIGTERM");
        assert.equal(signal?.aborted, true);
        assert.equal(signal?.reason, 143);
        signal?.throwIfAborted();
      },
    });
    assert.equal(code, 143);
    assert.equal(run.calls().length, 1);
    assert.deepEqual(process.listeners("SIGTERM"), listeners);
  } finally { run.cleanup(); }
});

for (const billing of ["subscription", "api", "native"] as const) {
  test(`unnamed Docker ${billing} capacity retries preserve one home and clean it after success`, async () => {
    const run = fixture("docker");
    let sessionRoot: string | undefined;
    try {
      const errors: string[] = [];
      if (billing === "native") writeFileSync(join(run.home, ".codex/custom.config.toml"), 'model_provider = "custom"\n');
      const route = billing === "native" ? ["--profile", "custom"] : ["--billing", billing];
      const code = await runCli(["codex", "--docker", ...route, "--prompt", "task", "--json"], {
        env: { ...run.env, OPENAI_API_KEY: "test-api" }, stdout: () => {}, stderr: (text) => errors.push(text),
        capacityRetrySleep: async () => {},
      });
      assert.equal(code, 0, errors.join(""));
      const calls = run.calls();
      assert.equal(calls.length, 2);
      const mounts = calls.map((call) => call.args.find((arg) => arg.includes("headless-billing-") && arg.includes("/codex/home")));
      assert.ok(mounts[0]);
      assert.equal(mounts[0], mounts[1]);
      sessionRoot = mounts[0].match(/(?:src=|source=)?([^,:]*headless-billing-[^/]+)/)?.[1];
      assert.ok(sessionRoot);
      assert.equal(existsSync(sessionRoot), false);
      assert.ok(calls[1].args.includes("resume"));
    } finally {
      run.cleanup();
      if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true });
    }
  });
}

test("disabled capacity retries do not create an anonymous subscription Docker home", async () => {
  const run = fixture("docker");
  try {
    const code = await runCli(["codex", "--docker", "--billing", "subscription", "--prompt", "task", "--json"], {
      env: { ...run.env, HEADLESS_CAPACITY_RETRIES: "0" }, stdout: () => {}, stderr: () => {},
    });
    assert.equal(code, 1);
    assert.equal(run.calls().length, 1);
    assert.ok(run.calls()[0].args.every((arg) => !arg.includes("headless-billing-")));
  } finally { run.cleanup(); }
});

test("a signal-terminated Codex process does not retry its preceding capacity failure", { skip: process.platform === "win32" }, async () => {
  const run = fixture();
  try {
    const binary = join(run.home, "codex");
    writeFileSync(binary, readFileSync(binary, "utf8").replace("process.exitCode = 1;",
      "process.stdout.write('', () => process.kill(process.pid, 'SIGTERM'));"));
    let delays = 0;
    const code = await runCli(["codex", "--prompt", "task", "--json"], {
      env: run.env, stdout: () => {}, stderr: () => {},
      capacityRetrySleep: async () => { delays++; },
    });
    assert.notEqual(code, 0);
    assert.equal(run.calls().length, 1);
    assert.equal(delays, 0);
  } finally { run.cleanup(); }
});

test("embedded parent cancellation stays terminal when Codex catches SIGTERM and exits one", { skip: process.platform === "win32" }, async () => {
  const run = fixture();
  const inheritedListener = () => {};
  process.on("SIGTERM", inheritedListener);
  try {
    const binary = join(run.home, "codex");
    writeFileSync(binary, readFileSync(binary, "utf8")
      .replace("const fs = require('node:fs');", "const fs = require('node:fs');\nprocess.on('SIGTERM', () => process.exit(1));")
      .replace("process.exitCode = 1;", "setInterval(() => {}, 1000);"));
    let signalled = false;
    let delays = 0;
    const code = await runCli(["codex", "--prompt", "task", "--json", "--timeout", "5"], {
      env: run.env, stderr: () => {},
      stdout: (text) => {
        if (!signalled && text.includes('"turn.failed"')) {
          signalled = true;
          process.emit("SIGTERM");
        }
      },
      capacityRetrySleep: async () => { delays++; },
    });
    assert.equal(signalled, true);
    assert.equal(code, 1);
    assert.equal(run.calls().length, 1);
    assert.equal(delays, 0);
    assert.ok(process.listeners("SIGTERM").includes(inheritedListener));
  } finally {
    process.off("SIGTERM", inheritedListener);
    run.cleanup();
  }
});
