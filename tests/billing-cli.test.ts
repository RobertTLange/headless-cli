import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { dockerSessionHomePath, ensureDockerSessionHome, ensureDockerSessionStoreDirectory } from "../src/docker.ts";
import { SECURE_SESSION_STORE_ENV, writeStoredSession } from "../src/sessions.ts";

for (const scenario of [
  { name: "resumes through API", mode: "auto", apiKey: "backup-secret", calls: 2, code: 0 },
  { name: "stops under subscription-only billing", mode: "subscription", apiKey: "backup-secret", calls: 1, code: 78 },
  { name: "stops without backup credentials", mode: "auto", apiKey: undefined, calls: 1, code: 78 },
] as const) {
test(`Codex CLI ordinal-date quota ${scenario.name}`, async () => {
  const home = mkdtempSync(join(tmpdir(), "billing-cli-"));
  try {
    mkdirSync(join(home, ".codex"));
    const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "subscription" } });
    writeFileSync(join(home, ".codex/auth.json"), auth);
    writeFileSync(join(home, "codex"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(process.env.HOME,'calls'), JSON.stringify({args:process.argv.slice(2), input, paid:!!process.env.CODEX_API_KEY})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-1234-1234-123456789abc'}));
if (!process.env.CODEX_API_KEY) {
 console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'fixture work',exit_code:0}}));
 const message = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 17th, 2026 5:28 PM.";
 console.log(JSON.stringify({type:'error',message}));
 console.log(JSON.stringify({type:'turn.failed',error:{message}}));
 process.exitCode=1;
} else {
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'finished'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:4,cached_input_tokens:0}}));
}
`, { mode: 0o755 });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["codex", "--billing", scenario.mode, "--prompt", "original task",
      "--model", "gpt-5.6-sol", "--reasoning-effort", "high", "--json"], {
      env: { PATH: `${home}:${process.env.PATH}`, HOME: home,
        ...(scenario.apiKey ? { OPENAI_API_KEY: scenario.apiKey } : {}) },
      stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s),
    });
    assert.equal(code, scenario.code, stderr.join(""));
    const calls = readFileSync(join(home, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, scenario.calls);
    assert.equal(calls[0].paid, false);
    if (scenario.code === 0) {
      assert.equal(calls[1].paid, true);
      assert.ok(calls[1].args.includes("resume"));
      assert.ok(calls[1].args.includes("12345678-1234-1234-1234-123456789abc"));
      assert.equal(calls[1].args[calls[1].args.indexOf("--model") + 1], "gpt-5.6-sol");
      assert.ok(calls[1].args.includes('model_reasoning_effort="high"'));
      assert.notEqual(calls[1].input, "original task");
    }
    assert.equal(readFileSync(join(home, ".codex/auth.json"), "utf8"), auth);
    assert.doesNotMatch(stdout.join("") + stderr.join(""), /backup-secret/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
}

test("explicit API billing without a key returns reserved terminal status", async () => {
  const errors: string[] = [];
  const code = await runCli(["codex", "--billing", "api", "--prompt", "task"], {
    env: { PATH: process.env.PATH }, stdout: () => {}, stderr: (s) => errors.push(s),
  });
  assert.equal(code, 78);
  assert.match(errors.join(""), /API.*key/i);
});

test("unsupported billing is rejected before creating a native session", async () => {
  const home = mkdtempSync(join(tmpdir(), "billing-cursor-"));
  try {
    const errors: string[] = [];
    const code = await runCli(["cursor", "--session", "new", "--billing", "api", "--prompt", "task"], {
      env: { HOME: home, PATH: process.env.PATH, CURSOR_CLI_BIN: join(home, "must-not-run") },
      stdout: () => {}, stderr: (text) => errors.push(text),
    });
    assert.equal(code, 78, errors.join(""));
    assert.match(errors.join(""), /billing selection is supported only/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Docker resumes the stored Codex profile before selecting billing", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "billing-docker-profile-"));
  try {
    const env = { HOME: home, PATH: `${home}:${process.env.PATH}` };
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex/custom.config.toml"), 'model_provider = "custom"\n');
    const sessionHome = ensureDockerSessionHome(dockerSessionHomePath("codex", "work", env)!);
    ensureDockerSessionStoreDirectory(sessionHome);
    const nativeId = "12345678-1234-1234-1234-123456789abc";
    writeStoredSession({ HOME: sessionHome, [SECURE_SESSION_STORE_ENV]: "1" },
      { agent: "codex", alias: "work", profile: "custom", nativeId });
    writeFileSync(join(home, "docker"), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.HOME + '/docker-args', JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
`, { mode: 0o755 });
    const errors: string[] = [];
    const code = await runCli(["codex", "--docker", "--session", "work", "--model", "gpt-5.4", "--prompt", "continue"], {
      env, stdout: () => {}, stderr: (text) => errors.push(text),
    });
    assert.equal(code, 0, errors.join(""));
    const args: string[] = JSON.parse(readFileSync(join(home, "docker-args"), "utf8"));
    assert.equal(args[args.indexOf("--profile") + 1], "custom");
    assert.ok(args.includes("resume") && args.includes(nativeId));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("explicit billing policy rejects interactive tmux execution", async () => {
  const errors: string[] = [];
  const code = await runCli(["codex", "--billing", "subscription", "--tmux", "--prompt", "task"], {
    env: { PATH: process.env.PATH }, stdout: () => {}, stderr: (s) => errors.push(s),
  });
  assert.equal(code, 2);
  assert.match(errors.join(""), /billing.*noninteractive/);
});

test("Docker explicit backend environment cannot override the paid billing route", async () => {
  const output: string[] = [];
  const code = await runCli(["claude", "--billing", "api", "--docker", "--docker-env",
    "CLAUDE_CODE_USE_BEDROCK=0", "--print-command", "--prompt", "task"], {
    env: { PATH: process.env.PATH }, stdout: (s) => output.push(s), stderr: () => {},
  });
  assert.equal(code, 0);
  assert.match(output.join(""), /--env CLAUDE_CODE_USE_BEDROCK/);
  assert.doesNotMatch(output.join(""), /CLAUDE_CODE_USE_BEDROCK=0/);
});

for (const succeeds of [true, false]) {
  test(`anonymous Docker billing home ${succeeds ? "cleans up after success" : "retains failed sessions"}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "billing-docker-test-"));
    let sessionRoot: string | undefined;
    try {
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: "subscription" } }));
      writeFileSync(join(home, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.HOME + '/docker-args', JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
process.exitCode = ${succeeds ? 0 : 1};
`, { mode: 0o755 });
      const errors: string[] = [];
      const code = await runCli(["codex", "--docker", "--prompt", "task", "--json"], {
        env: { HOME: home, PATH: `${home}:${process.env.PATH}` },
        stdout: () => {}, stderr: (s) => errors.push(s),
      });
      assert.equal(code, succeeds ? 0 : 1, errors.join(""));
      const args: string[] = JSON.parse(readFileSync(join(home, "docker-args"), "utf8"));
      const mount = args.find((arg) => arg.includes("headless-billing-") && arg.includes("/codex/home"));
      assert.ok(mount, JSON.stringify(args));
      sessionRoot = mount.match(/(?:src=|source=)?([^,:]*headless-billing-[^/]+)/)?.[1];
      assert.ok(sessionRoot, mount);
      assert.equal(existsSync(sessionRoot), !succeeds);
      if (!succeeds) assert.match(errors.join(""), /retained native session files/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true });
    }
  });
}
