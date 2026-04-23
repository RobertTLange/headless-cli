import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentName } from "../src/types.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agents: AgentName[] = ["codex", "claude", "pi", "gemini"];
const expected = "smoke-ok";

for (const agent of agents) {
  test(`real ${agent} smoke prompt through headless`, { timeout: 120_000 }, (t) => {
    if (process.env.HEADLESS_AGENT_SMOKE !== "1") {
      t.skip("set HEADLESS_AGENT_SMOKE=1 to run real-agent smoke tests");
      return;
    }

    const workDir = mkdtempSync(join(tmpdir(), `headless-${agent}-smoke-`));
    try {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(repoRoot, "src", "cli.ts"),
          agent,
          "--prompt",
          `Do not inspect or edit files. Reply with exactly this token and no other text: ${expected}`,
          "--work-dir",
          workDir,
        ],
        {
          encoding: "utf8",
          timeout: 110_000,
        },
      );

      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.match(run.stdout.trim(), new RegExp(`^${expected}$`, "i"));
    } finally {
      rmSync(workDir, { force: true, recursive: true });
    }
  });
}
