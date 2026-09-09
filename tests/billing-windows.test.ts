import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

for (const scenario of [
  { name: "cleans after success", paidCode: 0, initCode: 0, cleanupCode: 0 },
  { name: "retains after failure", paidCode: 1, initCode: 0, cleanupCode: 0 },
  { name: "reports failed cleanup", paidCode: 0, initCode: 0, cleanupCode: 1 },
  { name: "preserves initialization timeout", paidCode: 0, initCode: 124, cleanupCode: 0 },
]) {
  test(`Windows anonymous Docker billing ${scenario.name}`, { skip: process.platform === "win32" }, () => {
    const home = mkdtempSync(join(tmpdir(), "headless-windows-billing-"));
    try {
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: "subscription" } }));
      writeFileSync(join(home, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + '/calls', JSON.stringify(args) + '\\n');
if (args.includes('--entrypoint')) process.exit(${scenario.initCode});
if (args[0] === 'volume') process.exit(${scenario.cleanupCode});
console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-1234-1234-123456789abc'}));
if (!process.env.CODEX_API_KEY) {
  console.log(JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit. Try again later."}}));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'finished'}}));
  process.exitCode = ${scenario.paidCode};
}
`, { mode: 0o755 });
      const runner = join(home, "runner.mjs");
      writeFileSync(runner, `
Object.defineProperty(process, 'platform', {value:'win32'});
const {runCli} = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "src/cli.ts")).href)});
process.exitCode = await runCli(['codex','--docker','--prompt','task','--json']);
`);
      const result = spawnSync(process.execPath, ["--import", "tsx", runner], {
        encoding: "utf8", env: { HOME: home, PATH: `${home}:${process.env.PATH}`, PATHEXT: ";", OPENAI_API_KEY: "backup" },
      });
      assert.equal(result.status, scenario.initCode || scenario.paidCode, result.stderr);
      const calls: string[][] = readFileSync(join(home, "calls"), "utf8").trim().split("\n").map(JSON.parse);
      const initializers = calls.filter((args) => args.includes("--entrypoint"));
      assert.equal(initializers.length, 1);
      assert.equal(initializers[0][initializers[0].indexOf("--user") + 1], "0");
      const attempts = calls.filter((args) => args[0] === "run" && !args.includes("--entrypoint"));
      if (scenario.initCode) {
        assert.equal(attempts.length, 0);
        assert.match(result.stderr, /could not initialize Docker billing volume/);
        assert.equal(calls.length, 1);
        return;
      }
      assert.equal(attempts.length, 2);
      const mount = attempts[0][attempts[0].indexOf("--volume") + 1];
      assert.match(mount, /^headless-billing-[a-f0-9-]+:\/headless-home:rw$/);
      assert.ok(attempts[1].includes(mount));
      assert.ok(attempts[1].includes("resume"));
      const volume = mount.split(":")[0];
      const removals = calls.filter((args) => args[0] === "volume");
      if (scenario.paidCode === 0) assert.deepEqual(removals, [["volume", "rm", volume]]);
      else {
        assert.deepEqual(removals, []);
        assert.ok(result.stderr.includes(volume));
      }
      if (scenario.cleanupCode) assert.ok(result.stderr.includes(volume));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
