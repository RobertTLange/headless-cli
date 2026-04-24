#!/usr/bin/env node

import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgentCommand,
  buildInteractiveAgentCommand,
  getAgentConfig,
  getAgentHarness,
  isAgentName,
  listAgents,
} from "./agents.js";
import { extractFinalMessage } from "./output.js";
import { quoteCommand } from "./shell.js";
import type { AgentName, BuiltCommand, Env } from "./types.js";

interface ParsedArgs {
  agent?: AgentName;
  prompt?: string;
  promptFile?: string;
  model?: string;
  workDir?: string;
  json: boolean;
  printCommand: boolean;
  showConfig: boolean;
  tmux: boolean;
  help: boolean;
}

interface CliDeps {
  env?: Env;
  stdin?: string;
  stdinIsTTY?: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function usage(): string {
  return [
    "Usage: headless [agent] (--prompt <text> | --prompt-file <path>) [options]",
    "",
    `Agents: ${listAgents().join(", ")}`,
    "",
    "Options:",
    "  --model <name>        Agent model override.",
    "  --prompt, -p <text>   Prompt text.",
    "  --prompt-file <path>  Read prompt from a file.",
    "  --work-dir, -C <path> Run from this directory.",
    "  --json               Print raw agent JSON trace output.",
    "  --tmux               Launch an interactive agent in a tmux session.",
    "  --print-command      Print the command without executing it.",
    "  --show-config        Print harness config paths and auth seed paths.",
    "  -h, --help           Show this help.",
    "",
    "If neither --prompt nor --prompt-file is provided, stdin is used when piped.",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, printCommand: false, showConfig: false, tmux: false, help: false };
  const args = [...argv];

  if (args.length === 0) {
    parsed.help = true;
    return parsed;
  }

  const first = args.shift();
  if (first === "-h" || first === "--help") {
    parsed.help = true;
    return parsed;
  }
  if (first === undefined) {
    parsed.help = true;
    return parsed;
  }
  if (isAgentName(first)) {
    parsed.agent = first;
  } else if (first.startsWith("-")) {
    args.unshift(first);
  } else {
    throw new CliError(`unsupported agent: ${first ?? ""}`);
  }

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--prompt":
      case "-p":
        parsed.prompt = takeValue(args, arg);
        break;
      case "--prompt-file":
        parsed.promptFile = takeValue(args, arg);
        break;
      case "--model":
      case "--agent-model":
        parsed.model = takeValue(args, arg);
        break;
      case "--work-dir":
      case "-C":
        parsed.workDir = takeValue(args, arg);
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--tmux":
        parsed.tmux = true;
        break;
      case "--print-command":
        parsed.printCommand = true;
        break;
      case "--show-config":
        parsed.showConfig = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--":
        if (args.length > 0) {
          parsed.prompt = args.join(" ");
          args.length = 0;
        }
        break;
      default:
        throw new CliError(`unknown argument: ${arg ?? ""}`);
    }
  }

  return parsed;
}

function takeValue(args: string[], flag: string | undefined): string {
  const value = args.shift();
  if (value === undefined) {
    throw new CliError(`${flag} requires a value`);
  }
  return value;
}

function renderConfig(agent: AgentName): string {
  const config = getAgentConfig(agent);
  return [
    `name=${config.name}`,
    `config_rel_dir=${config.configRelDir}`,
    `workspace_config_rel_dir=${config.workspaceConfigRelDir}`,
    "seed_paths:",
    ...config.seedPaths.map((path) => `  ${path}`),
    "",
  ].join("\n");
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}

async function resolvePrompt(
  parsed: ParsedArgs,
  deps: CliDeps,
  options: { forceText?: boolean } = {},
): Promise<{ prompt: string; promptFile?: string }> {
  if (parsed.prompt && parsed.promptFile) {
    throw new CliError("use either --prompt or --prompt-file, not both");
  }
  if (!parsed.agent) {
    throw new CliError("missing agent");
  }

  const harness = getAgentHarness(parsed.agent);

  if (parsed.promptFile) {
    if (!existsSync(parsed.promptFile) || !statSync(parsed.promptFile).isFile()) {
      throw new CliError(`prompt file not found: ${parsed.promptFile}`);
    }
    if (!options.forceText && harness.promptFileMode === "stdin") {
      return { prompt: "", promptFile: parsed.promptFile };
    }
    return { prompt: readFileSync(parsed.promptFile, "utf8") };
  }

  if (parsed.prompt !== undefined) {
    return { prompt: parsed.prompt };
  }

  const stdinIsTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!stdinIsTTY) {
    return { prompt: deps.stdin ?? (await readStdin()) };
  }

  throw new CliError("missing prompt; use --prompt, --prompt-file, or piped stdin");
}

function validateWorkDir(workDir: string | undefined): string | undefined {
  if (!workDir) {
    return undefined;
  }
  if (!existsSync(workDir) || !statSync(workDir).isDirectory()) {
    throw new CliError(`work dir not found: ${workDir}`);
  }
  return workDir;
}

const autoAgentPreference: AgentName[] = ["codex", "claude", "pi", "opencode", "gemini", "cursor"];

function commandForAgent(agent: AgentName, env: Env): string {
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

function commandExists(command: string, env: Env): boolean {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutable(command);
  }

  const extensions = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      if (isExecutable(join(dir, `${command}${extension}`))) {
        return true;
      }
    }
  }
  return false;
}

function selectDefaultAgent(env: Env): AgentName {
  for (const agent of autoAgentPreference) {
    if (commandExists(commandForAgent(agent, env), env)) {
      return agent;
    }
  }
  throw new CliError(`no supported agent found on PATH; checked: ${autoAgentPreference.join(", ")}`);
}

interface ExecuteResult {
  code: number;
  stdout: string;
}

interface TmuxCommands {
  sessionName: string;
  newSession: BuiltCommand;
}

function suppressKnownStderr(agent: AgentName, text: string): string {
  if (agent !== "gemini") {
    return text;
  }

  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.includes("[DEP0040] DeprecationWarning: The `punycode` module is deprecated")) return false;
      if (trimmed.includes("Use `node --trace-deprecation ...` to show where the warning was created")) return false;
      if (trimmed === "YOLO mode is enabled. All tool calls will be automatically approved.") return false;
      if (trimmed === "Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.") return false;
      return true;
    })
    .map((line) => `${line}\n`)
    .join("");
}

async function executeCommand(
  agent: AgentName,
  command: BuiltCommand,
  cwd: string | undefined,
  env: Env,
  stderr: (text: string) => void,
): Promise<ExecuteResult> {
  let stdinFd: number | undefined;
  const stdio: ["ignore" | "pipe" | number, "pipe", "pipe"] = [
    command.stdinText !== undefined ? "pipe" : "ignore",
    "pipe",
    "pipe",
  ];

  if (command.stdinFile) {
    stdinFd = openSync(command.stdinFile, "r");
    stdio[0] = stdinFd;
  }

  try {
    return await new Promise<ExecuteResult>((resolve) => {
      let capturedStdout = "";
      const child = spawn(command.command, command.args, {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio,
      });

      if (command.stdinText !== undefined) {
        child.stdin?.end(command.stdinText);
      }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        capturedStdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        const filtered = suppressKnownStderr(agent, chunk);
        if (filtered) {
          stderr(filtered);
        }
      });
      child.on("error", (error) => {
        stderr(`${error.message}\n`);
        resolve({ code: 127, stdout: capturedStdout });
      });
      child.on("close", (code, signal) => {
        if (signal) {
          resolve({ code: 1, stdout: capturedStdout });
          return;
        }
        resolve({ code: code ?? 1, stdout: capturedStdout });
      });
    });
  } finally {
    if (stdinFd !== undefined) {
      closeSync(stdinFd);
    }
  }
}

function buildTmuxCommands(
  agent: AgentName,
  command: BuiltCommand,
  cwd: string | undefined,
): TmuxCommands {
  const sessionName = `headless-${agent}-${process.pid}`;
  const startDir = cwd ?? process.cwd();
  return {
    sessionName,
    newSession: {
      command: "tmux",
      args: ["new-session", "-d", "-s", sessionName, "-c", startDir, quoteCommand(command)],
    },
  };
}

function trustClaudeWorkspace(cwd: string | undefined, env: Env): void {
  const homeDir = env.HOME;
  if (!homeDir) {
    throw new CliError("HOME is required to trust Claude workspace");
  }

  const workspace = realpathSync(cwd ?? process.cwd());
  const configPath = join(homeDir, ".claude.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const projects =
    config.projects && typeof config.projects === "object" && !Array.isArray(config.projects) ? config.projects : {};
  const project =
    projects[workspace] && typeof projects[workspace] === "object" && !Array.isArray(projects[workspace])
      ? projects[workspace]
      : {};

  projects[workspace] = { ...project, hasTrustDialogAccepted: true };
  config.projects = projects;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function cursorProjectKey(workspace: string): string {
  return workspace.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function trustCursorWorkspace(cwd: string | undefined, env: Env): void {
  const homeDir = env.HOME;
  if (!homeDir) {
    throw new CliError("HOME is required to trust Cursor workspace");
  }

  const workspace = realpathSync(cwd ?? process.cwd());
  const projectDir = join(homeDir, ".cursor", "projects", cursorProjectKey(workspace));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, ".workspace-trusted"),
    `${JSON.stringify({ trustedAt: new Date().toISOString(), workspacePath: workspace }, null, 2)}\n`,
  );
}

async function executeSimpleCommand(
  command: BuiltCommand,
  cwd: string | undefined,
  env: Env,
  stderr: (text: string) => void,
): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", () => undefined);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => stderr(chunk));
    child.on("error", (error) => {
      stderr(`${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

async function executeTmuxCommands(
  commands: TmuxCommands,
  cwd: string | undefined,
  env: Env,
  stderr: (text: string) => void,
): Promise<number> {
  return await executeSimpleCommand(commands.newSession, cwd, env, stderr);
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const env = deps.env ?? process.env;

  try {
    const parsed = parseArgs(argv);

    if (parsed.help) {
      stdout(usage());
      return 0;
    }
    if (!parsed.agent) {
      parsed.agent = selectDefaultAgent(env);
    }
    if (parsed.tmux && parsed.json) {
      throw new CliError("--json cannot be used with --tmux");
    }
    if (parsed.showConfig) {
      stdout(renderConfig(parsed.agent));
      return 0;
    }

    const cwd = validateWorkDir(parsed.workDir);
    const prompt = await resolvePrompt(parsed, deps, { forceText: parsed.tmux });

    if (parsed.tmux) {
      const tmuxCommand = buildInteractiveAgentCommand(
        parsed.agent,
        {
          prompt: prompt.prompt,
          model: parsed.model,
        },
        env,
      );
      const tmuxCommands = buildTmuxCommands(parsed.agent, tmuxCommand, cwd);

      if (parsed.printCommand) {
        stdout(`${quoteCommand(tmuxCommands.newSession)}\n`);
        return 0;
      }

      if (parsed.agent === "claude") {
        trustClaudeWorkspace(cwd, env);
      }
      if (parsed.agent === "cursor") {
        trustCursorWorkspace(cwd, env);
      }

      const code = await executeTmuxCommands(tmuxCommands, cwd, env, stderr);
      if (code === 0) {
        stdout(`tmux session: ${tmuxCommands.sessionName}\n`);
        stdout(`attach: tmux attach-session -t ${tmuxCommands.sessionName}\n`);
      }
      return code;
    }

    const command = buildAgentCommand(
      parsed.agent,
      {
        prompt: prompt.prompt,
        promptFile: prompt.promptFile,
        model: parsed.model,
      },
      env,
    );

    if (parsed.printCommand) {
      stdout(`${quoteCommand(command)}\n`);
      return 0;
    }

    const result = await executeCommand(parsed.agent, command, cwd, env, stderr);
    if (parsed.json) {
      stdout(result.stdout);
      return result.code;
    }

    const finalMessage = extractFinalMessage(parsed.agent, result.stdout);
    if (finalMessage) {
      stdout(`${finalMessage}\n`);
      return result.code;
    }
    if (result.code === 0) {
      stderr("headless: could not extract final message; rerun with --json for raw trace\n");
      return 1;
    }
    return result.code;
  } catch (error) {
    if (error instanceof CliError) {
      stderr(`headless: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function isCliEntrypoint(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) {
    return false;
  }
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
}

if (isCliEntrypoint()) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
