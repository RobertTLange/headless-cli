import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { listAgents } from "./agents.js";
import type { AgentName, Env } from "./types.js";

interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface AgentCheck {
  agent: AgentName;
  command: string;
  available: boolean;
  version: string;
}

export function commandForAgent(agent: AgentName, env: Env): string {
  if (agent === "cursor") {
    return env.CURSOR_CLI_BIN || "agent";
  }
  if (agent === "pi") {
    return env.PI_CODING_AGENT_BIN || "pi";
  }
  return agent;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findExecutable(command: string, env: Env): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? command : undefined;
  }

  const extensions = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function commandExists(command: string, env: Env): boolean {
  return findExecutable(command, env) !== undefined;
}

const versionTimeoutMs = 5000;

async function captureVersion(executable: string, env: Env): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const version = await captureVersionOnce(executable, env);
    if (version !== "unknown") {
      return version;
    }
  }
  return "unknown";
}

async function captureVersionOnce(executable: string, env: Env): Promise<string> {
  const result = await new Promise<CaptureResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(executable, ["--version"], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: 124, stdout, stderr });
    }, versionTimeoutMs);
    const finish = (result: CaptureResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      finish({ code: 127, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      finish({ code: signal ? 1 : (code ?? 1), stdout, stderr });
    });
  });

  if (result.code !== 0) {
    return "unknown";
  }
  const stdoutVersion = normalizeVersion(result.stdout);
  return stdoutVersion === "unknown" ? normalizeVersion(result.stderr) : stdoutVersion;
}

function normalizeVersion(output: string): string {
  if (!output.trim()) {
    return "unknown";
  }
  const dotted = Array.from(output.matchAll(/\d+(?:\.\d+)+/g)).map((match) => match[0]);
  if (dotted.length > 0) {
    return dotted[dotted.length - 1];
  }
  const numeric = Array.from(output.matchAll(/\d+(?:[._-]\d+)+/g)).map((match) => match[0]);
  return numeric[numeric.length - 1] ?? "unknown";
}

export async function checkAgents(env: Env): Promise<AgentCheck[]> {
  return await Promise.all(
    listAgents().map(async (agent) => {
      const command = commandForAgent(agent, env);
      const executable = findExecutable(command, env);
      return {
        agent,
        command,
        available: executable !== undefined,
        version: executable ? await captureVersion(executable, env) : "-",
      };
    }),
  );
}

export function renderAgentChecks(checks: AgentCheck[]): string {
  const rows = [
    ["Agent", "Status", "Version", "Binary"],
    ...checks.map((check) => [
      check.agent,
      check.available ? "✓" : "✗",
      check.version,
      check.command,
    ]),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd())
    .join("\n")
    .concat("\n");
}
