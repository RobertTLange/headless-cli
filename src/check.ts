import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { listAgents } from "./agents.js";
import { cell, renderTable, type TableColor } from "./table.js";
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
  auth: AuthLabel;
  version: string;
}

interface DockerCheck {
  command: string;
  available: boolean;
  version: string;
  image: string;
  imageAvailable: boolean;
}

type AuthLabel = "-" | "api" | "oauth" | "api+oauth";

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

const commonProviderApiEnvNames = [
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
];

const awsCredentialEnvNames = ["AWS_ACCESS_KEY_ID", "AWS_PROFILE"];

const apiEnvNamesByAgent: Record<AgentName, string[]> = {
  claude: ["ANTHROPIC_API_KEY"],
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
  opencode: commonProviderApiEnvNames,
  pi: ["PI_CODING_AGENT_API_KEY", ...commonProviderApiEnvNames],
};

const oauthEnvNamesByAgent: Record<AgentName, string[]> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN"],
  codex: [],
  cursor: [],
  gemini: [],
  opencode: [],
  pi: [],
};

const oauthPathsByAgent: Record<AgentName, string[]> = {
  claude: [".claude/.credentials.json", ".claude/auth.json"],
  codex: [".codex/auth.json"],
  cursor: [".cursor/cli-config.json"],
  gemini: [".gemini/google_accounts.json"],
  opencode: [".config/opencode"],
  pi: [".pi/agent/auth.json"],
};

function detectAuth(agent: AgentName, env: Env): AuthLabel {
  const hasApi = hasApiAuth(agent, env);
  const hasOauth =
    oauthEnvNamesByAgent[agent].some((name) => Boolean(env[name])) ||
    oauthPathsByAgent[agent].some((relPath) => homePathExists(env, relPath));

  if (hasApi && hasOauth) return "api+oauth";
  if (hasApi) return "api";
  if (hasOauth) return "oauth";
  return "-";
}

function hasApiAuth(agent: AgentName, env: Env): boolean {
  if (apiEnvNamesByAgent[agent].some((name) => Boolean(env[name]))) {
    return true;
  }
  return agent === "pi" && piUsesAwsProvider(env) && awsCredentialEnvNames.some((name) => Boolean(env[name]));
}

function piUsesAwsProvider(env: Env): boolean {
  const model = env.PI_CODING_AGENT_MODEL;
  const slashIndex = model?.indexOf("/") ?? -1;
  const provider = slashIndex > 0 ? model?.slice(0, slashIndex) : env.PI_CODING_AGENT_PROVIDER;
  const normalized = provider?.toLowerCase();
  return normalized === "aws" || normalized?.startsWith("aws-") === true || normalized?.includes("bedrock") === true;
}

function homePathExists(env: Env, relPath: string): boolean {
  if (!env.HOME) {
    return false;
  }
  try {
    statSync(join(env.HOME, relPath));
    return true;
  } catch {
    return false;
  }
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
  const result = await captureCommand(executable, ["--version"], env, versionTimeoutMs);

  if (result.code !== 0) {
    return "unknown";
  }
  const stdoutVersion = normalizeVersion(result.stdout);
  return stdoutVersion === "unknown" ? normalizeVersion(result.stderr) : stdoutVersion;
}

async function captureCommand(
  executable: string,
  args: string[],
  env: Env,
  timeoutMs: number,
): Promise<CaptureResult> {
  return await new Promise<CaptureResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(executable, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: 124, stdout, stderr });
    }, timeoutMs);
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
        auth: detectAuth(agent, env),
        version: executable ? await captureVersion(executable, env) : "-",
      };
    }),
  );
}

export async function checkDocker(env: Env, image: string): Promise<DockerCheck> {
  const command = "docker";
  const executable = findExecutable(command, env);
  if (!executable) {
    return { command, available: false, version: "-", image, imageAvailable: false };
  }

  const version = await captureVersion(executable, env);
  const imageInspect = await captureCommand(executable, ["image", "inspect", image], env, versionTimeoutMs);
  return {
    command,
    available: true,
    version,
    image,
    imageAvailable: imageInspect.code === 0,
  };
}

export function renderAgentChecks(checks: AgentCheck[]): string {
  return renderTable({
    columns: ["Agent", "Status", "Auth", "Version", "Binary"],
    rows: checks.map((check) => [
      check.agent,
      cell(check.available ? "✓" : "✗", check.available ? "green" : "red"),
      cell(check.auth, authColor(check.auth)),
      check.version,
      check.command,
    ]),
  });
}

export function renderDockerCheck(check: DockerCheck): string {
  return renderTable({
    columns: ["Docker", "Status", "Version", "Default image"],
    rows: [[
      check.command,
      cell(check.available ? "✓" : "✗", check.available ? "green" : "red"),
      check.version,
      check.available ? `${check.image} (${check.imageAvailable ? "present" : "missing"})` : check.image,
    ]],
  });
}

function authColor(auth: AuthLabel): TableColor {
  switch (auth) {
    case "api":
      return "cyan";
    case "oauth":
      return "magenta";
    case "api+oauth":
      return "green";
    case "-":
      return "dim";
  }
}
