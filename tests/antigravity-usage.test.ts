import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareAntigravityUsageCapture } from "../src/antigravity-usage.ts";

test("Antigravity usage capture overlays settings and preserves the real home", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-antigravity-capture-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    mkdirSync(join(appDir, "brain"), { recursive: true });
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test\n");
    writeFileSync(
      join(appDir, "settings.json"),
      `${JSON.stringify({
        enableTelemetry: false,
        statusLine: { type: "command", command: "printf original", enabled: true },
      })}\n`,
    );

    const capture = prepareAntigravityUsageCapture({ HOME: home });
    assert.ok(capture);
    const overlayHome = capture.commandEnv.HOME ?? "";
    assert.notEqual(overlayHome, home);
    assert.equal(realpathSync(join(overlayHome, ".gitconfig")), realpathSync(join(home, ".gitconfig")));
    assert.equal(
      realpathSync(join(overlayHome, ".gemini", "antigravity-cli", "brain")),
      realpathSync(join(appDir, "brain")),
    );

    const overlaySettings = JSON.parse(
      readFileSync(join(overlayHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    );
    const payload = {
      email: "private@example.com",
      plan_tier: "Pro",
      conversation_id: "conversation-1",
      model: { id: "Gemini 3.5 Flash (Low)", display_name: "Gemini 3.5 Flash (Low)" },
      context_window: {
        current_usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
        },
      },
    };
    const status = spawnSync("/bin/sh", ["-c", overlaySettings.statusLine.command], {
      encoding: "utf8",
      env: { ...process.env, ...capture.commandEnv },
      input: JSON.stringify(payload),
    });

    assert.equal(status.status, 0);
    assert.equal(status.stdout, "original");
    const records = capture
      .read()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(records, [
      {
        type: "headless.antigravity.usage",
        conversation_id: "conversation-1",
        model: { id: "Gemini 3.5 Flash (Low)", display_name: "Gemini 3.5 Flash (Low)" },
        context_window: {
          current_usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
          },
        },
      },
    ]);
    assert.doesNotMatch(capture.read(), /private@example\.com|plan_tier/);
    assert.deepEqual(JSON.parse(readFileSync(join(appDir, "settings.json"), "utf8")), {
      enableTelemetry: false,
      statusLine: { type: "command", command: "printf original", enabled: true },
    });

    capture.cleanup();
    assert.equal(existsSync(overlayHome), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
