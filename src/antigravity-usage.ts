import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { quoteArg } from "./shell.js";
import type { Env } from "./types.js";

interface StatusLineConfig {
  type?: string;
  command?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

interface AntigravitySettings {
  statusLine?: StatusLineConfig;
  [key: string]: unknown;
}

export interface AntigravityUsageCapture {
  commandEnv: Env;
  read(): string;
  cleanup(): void;
}

const captureScript = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const value = JSON.parse(input);
  const model = value?.model && typeof value.model === "object" ? value.model : {};
  const contextWindow = value?.context_window && typeof value.context_window === "object" ? value.context_window : {};
  const usage = contextWindow.current_usage && typeof contextWindow.current_usage === "object"
    ? contextWindow.current_usage
    : {};
  const record = {
    type: "headless.antigravity.usage",
    conversation_id: typeof value?.conversation_id === "string" ? value.conversation_id : "",
    model: {
      id: typeof model.id === "string" ? model.id : "",
      display_name: typeof model.display_name === "string" ? model.display_name : "",
    },
    context_window: {
      current_usage: {
        input_tokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
        output_tokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
        cache_creation_input_tokens: Number.isFinite(usage.cache_creation_input_tokens)
          ? usage.cache_creation_input_tokens
          : 0,
        cache_read_input_tokens: Number.isFinite(usage.cache_read_input_tokens)
          ? usage.cache_read_input_tokens
          : 0,
      },
    },
  };
  appendFileSync(process.env.HEADLESS_ANTIGRAVITY_USAGE_FILE, JSON.stringify(record) + "\\n", { mode: 0o600 });
} catch {
  // Usage collection must never interfere with the agent run.
}

let originalCommand = "";
try {
  originalCommand = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "status-command"), "utf8");
} catch {
  // The user's status command is optional.
}
if (originalCommand) {
  const child = spawnSync("/bin/sh", ["-c", originalCommand], { input, encoding: "utf8" });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
}
`;

function linkChildren(source: string, target: string, excluded: Set<string>): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source)) {
    if (excluded.has(entry)) continue;
    symlinkSync(join(source, entry), join(target, entry));
  }
}

function readSettings(path: string): AntigravitySettings {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Antigravity settings must contain a JSON object");
  }
  return value as AntigravitySettings;
}

export function prepareAntigravityUsageCapture(env: Env): AntigravityUsageCapture | undefined {
  const realHome = env.HOME;
  if (!realHome) return undefined;

  const realGeminiDir = join(realHome, ".gemini");
  const realAppDir = join(realGeminiDir, "antigravity-cli");
  if (!existsSync(realAppDir)) return undefined;

  const root = mkdtempSync(join(tmpdir(), "headless-antigravity-usage-"));
  try {
    const overlayHome = join(root, "home");
    const overlayGeminiDir = join(overlayHome, ".gemini");
    const overlayAppDir = join(overlayGeminiDir, "antigravity-cli");
    const capturePath = join(root, "usage.jsonl");
    const scriptPath = join(root, "capture.mjs");
    const statusCommandPath = join(root, "status-command");

    for (const stateRoot of ["brain", "cache"]) {
      mkdirSync(join(realAppDir, stateRoot), { recursive: true, mode: 0o700 });
    }

    linkChildren(realHome, overlayHome, new Set([".gemini"]));
    linkChildren(realGeminiDir, overlayGeminiDir, new Set(["antigravity-cli"]));
    linkChildren(realAppDir, overlayAppDir, new Set(["settings.json"]));

    const settingsPath = join(realAppDir, "settings.json");
    const settings = readSettings(settingsPath);
    const originalStatusLine = settings.statusLine;
    const originalCommand =
      originalStatusLine?.type === "command" && originalStatusLine.enabled !== false
        ? originalStatusLine.command?.trim()
        : undefined;

    writeFileSync(capturePath, "", { mode: 0o600 });
    writeFileSync(statusCommandPath, originalCommand ?? "", { mode: 0o600 });
    writeFileSync(scriptPath, captureScript, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);
    writeFileSync(
      join(overlayAppDir, "settings.json"),
      `${JSON.stringify(
        {
          ...settings,
          statusLine: {
            ...originalStatusLine,
            type: "command",
            command: quoteArg(scriptPath),
            enabled: true,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    return {
      commandEnv: {
        HOME: overlayHome,
        HEADLESS_ANTIGRAVITY_USAGE_FILE: capturePath,
        HEADLESS_ANTIGRAVITY_STATUS_COMMAND: undefined,
      },
      read: () => {
        try {
          return readFileSync(capturePath, "utf8");
        } catch {
          return "";
        }
      },
      cleanup: () => {
        try {
          rmSync(root, { force: true, recursive: true });
        } catch {
          // Cleanup failure must not replace the agent's result.
        }
      },
    };
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}
