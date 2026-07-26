import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

test("Antigravity capture preserves state created by a fresh profile and hides the original command env", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-antigravity-fresh-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "settings.json"),
      `${JSON.stringify({ statusLine: { type: "command", command: "printf original", enabled: true } })}\n`,
    );

    const capture = prepareAntigravityUsageCapture({
      HOME: home,
      HEADLESS_ANTIGRAVITY_STATUS_COMMAND: "secret-from-agent-env",
    });
    assert.ok(capture);
    const overlayHome = capture.commandEnv.HOME ?? "";
    for (const stateRoot of ["brain", "cache"]) {
      assert.equal(existsSync(join(home, ".gemini", "antigravity-cli", stateRoot)), true);
      assert.equal(
        realpathSync(join(overlayHome, ".gemini", "antigravity-cli", stateRoot)),
        realpathSync(join(home, ".gemini", "antigravity-cli", stateRoot)),
      );
    }
    assert.equal(capture.commandEnv.HEADLESS_ANTIGRAVITY_STATUS_COMMAND, undefined);

    const overlaySettings = JSON.parse(
      readFileSync(join(overlayHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    );
    const status = spawnSync("/bin/sh", ["-c", overlaySettings.statusLine.command], {
      encoding: "utf8",
      env: { ...process.env, HEADLESS_ANTIGRAVITY_STATUS_COMMAND: "secret-from-agent-env", ...capture.commandEnv },
      input: "{}",
    });
    assert.equal(status.status, 0);
    assert.equal(status.stdout, "original");

    const createdState = join(overlayHome, ".gemini", "antigravity-cli", "brain", "conversation.json");
    writeFileSync(createdState, "persisted\n");
    capture.cleanup();
    assert.equal(readFileSync(join(home, ".gemini", "antigravity-cli", "brain", "conversation.json"), "utf8"), "persisted\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Antigravity usage capture honors configured profile roots", () => {
  for (const variable of ["ANTIGRAVITY_HOME", "AGY_HOME"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "headless-antigravity-profile-test-"));
    try {
      const home = join(dir, "home");
      const workDir = join(dir, "work");
      const appDir = variable === "AGY_HOME" ? join(workDir, "custom-profile") : join(dir, "custom-profile");
      const configuredAppDir = variable === "AGY_HOME" ? relative(workDir, appDir) : appDir;
      mkdirSync(join(appDir, "brain"), { recursive: true });
      writeFileSync(join(appDir, "settings.json"), `${JSON.stringify({ enableTelemetry: false })}\n`);

      const capture = prepareAntigravityUsageCapture({ HOME: home, [variable]: configuredAppDir }, workDir);
      assert.ok(capture);
      const overlayAppDir = capture.commandEnv[variable] ?? "";
      assert.notEqual(overlayAppDir, appDir);
      assert.equal(realpathSync(join(overlayAppDir, "brain")), realpathSync(join(appDir, "brain")));
      assert.equal(
        JSON.parse(readFileSync(join(overlayAppDir, "settings.json"), "utf8")).statusLine.enabled,
        true,
      );

      capture.cleanup();
      assert.equal(existsSync(overlayAppDir), false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("Antigravity usage capture ignores empty preferred profile roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-antigravity-empty-profile-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(dir, "legacy-profile");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "settings.json"), "{}\n");

    const capture = prepareAntigravityUsageCapture({
      HOME: home,
      ANTIGRAVITY_HOME: " ",
      AGY_HOME: appDir,
    });
    assert.ok(capture);
    assert.equal(realpathSync(capture.commandEnv.AGY_HOME ?? ""), realpathSync(capture.commandEnv.ANTIGRAVITY_HOME ?? ""));
    assert.equal(existsSync(join(process.cwd(), "brain")), false);
    assert.equal(existsSync(join(process.cwd(), "cache")), false);
    capture.cleanup();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Antigravity usage capture preserves whitespace in non-empty profile roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-antigravity-spaced-profile-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(dir, "profile ");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "settings.json"), "{}\n");

    const capture = prepareAntigravityUsageCapture({ HOME: home, ANTIGRAVITY_HOME: appDir });
    assert.ok(capture);
    assert.equal(
      realpathSync(join(capture.commandEnv.ANTIGRAVITY_HOME ?? "", "brain")),
      realpathSync(join(appDir, "brain")),
    );
    capture.cleanup();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Antigravity usage capture preserves the original status command environment and exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-antigravity-status-command-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(dir, "profile");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "settings.json"),
      `${JSON.stringify({
        statusLine: {
          type: "command",
          command: "printf '%s|%s|%s' \"$HOME\" \"$ANTIGRAVITY_HOME\" \"$AGY_HOME\"; exit 23",
          enabled: true,
        },
      })}\n`,
    );
    const originalEnv = {
      HOME: home,
      ANTIGRAVITY_HOME: appDir,
      AGY_HOME: appDir,
    };
    const capture = prepareAntigravityUsageCapture(originalEnv);
    assert.ok(capture);
    const overlaySettings = JSON.parse(
      readFileSync(join(capture.commandEnv.ANTIGRAVITY_HOME ?? "", "settings.json"), "utf8"),
    );
    const status = spawnSync("/bin/sh", ["-c", overlaySettings.statusLine.command], {
      encoding: "utf8",
      env: { ...process.env, ...originalEnv, ...capture.commandEnv },
      input: "{}",
    });

    assert.equal(status.status, 23);
    assert.equal(status.stdout, `${home}|${appDir}|${appDir}`);
    assert.equal(capture.read().trim().length > 0, true);
    capture.cleanup();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Antigravity usage capture preserves original status command signals", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-antigravity-status-signal-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "settings.json"),
      `${JSON.stringify({
        statusLine: { type: "command", command: "kill -TERM $$", enabled: true },
      })}\n`,
    );
    const capture = prepareAntigravityUsageCapture({ HOME: home });
    assert.ok(capture);
    const overlaySettings = JSON.parse(
      readFileSync(join(capture.commandEnv.HOME ?? "", ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    );
    const status = spawnSync("/bin/sh", ["-c", overlaySettings.statusLine.command], {
      encoding: "utf8",
      env: { ...process.env, ...capture.commandEnv },
      input: "{}",
    });

    const terminatedBySigterm = status.signal === "SIGTERM" || status.status === 128 + 15;
    assert.equal(terminatedBySigterm, true);
    assert.equal(capture.read().trim().length > 0, true);
    capture.cleanup();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Antigravity usage capture keeps only one bounded latest record", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-antigravity-bounded-capture-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "settings.json"), "{}\n");
    const capture = prepareAntigravityUsageCapture({ HOME: home });
    assert.ok(capture);
    const overlaySettings = JSON.parse(
      readFileSync(join(capture.commandEnv.HOME ?? "", ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    );

    for (const index of [1, 2, 3]) {
      const status = spawnSync("/bin/sh", ["-c", overlaySettings.statusLine.command], {
        encoding: "utf8",
        env: { ...process.env, ...capture.commandEnv },
        input: JSON.stringify({
          conversation_id: `conversation-${index}`,
          model: { id: index === 3 ? "x".repeat(100_000) : `model-${index}` },
          context_window: { current_usage: { input_tokens: index } },
        }),
      });
      assert.equal(status.status, 0);
    }

    const content = capture.read();
    const records = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].conversation_id, "conversation-3");
    assert.equal(Buffer.byteLength(content, "utf8") < 64 * 1024, true);
    capture.cleanup();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Antigravity usage capture removes temporary files after replacement failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-antigravity-capture-failure-test-"));
  try {
    const home = join(dir, "home");
    const appDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "settings.json"), "{}\n");
    const capture = prepareAntigravityUsageCapture({ HOME: home });
    assert.ok(capture);
    const overlaySettings = JSON.parse(
      readFileSync(join(capture.commandEnv.HOME ?? "", ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    );
    const capturePath = capture.commandEnv.HEADLESS_ANTIGRAVITY_USAGE_FILE ?? "";
    rmSync(capturePath);
    mkdirSync(capturePath);

    const status = spawnSync("/bin/sh", ["-c", overlaySettings.statusLine.command], {
      encoding: "utf8",
      env: { ...process.env, ...capture.commandEnv },
      input: "{}",
    });

    assert.equal(status.status, 0);
    assert.equal(existsSync(`${capturePath}.${status.pid}.tmp`), false);
    capture.cleanup();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
