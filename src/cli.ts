#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgentCommand,
  buildInteractiveAgentCommand,
  getAgentConfig,
  getAgentHarness,
  isAgentName,
  listAgents,
} from "./agents.js";
import { checkAgents, commandExists, commandForAgent, renderAgentChecks } from "./check.js";
import { extractFinalMessage } from "./output.js";
import { quoteCommand } from "./shell.js";
import type { AgentName, AllowMode, BuiltCommand, Env } from "./types.js";

interface ParsedArgs {
  send: boolean;
  sendSession?: string;
  agent?: AgentName;
  prompt?: string;
  promptFile?: string;
  model?: string;
  allow?: AllowMode;
  workDir?: string;
  json: boolean;
  debug: boolean;
  printCommand: boolean;
  showConfig: boolean;
  check: boolean;
  list: boolean;
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
    "Usage: headless [agent] (--prompt <text> | --prompt-file <path> | --check | --list | --show-config) [options]",
    "       headless send <session-name> (--prompt <text> | --prompt-file <path>) [options]",
    "",
    `Agents: ${listAgents().join(", ")}`,
    "",
    "Options:",
    "  --model <name>        Agent model override.",
    "  --allow <mode>        Permission mode: read-only or yolo.",
    "  --prompt, -p <text>   Prompt text.",
    "  --prompt-file <path>  Read prompt from a file.",
    "  --work-dir, -C <path> Run from this directory.",
    "  --json               Stream raw agent JSON trace output.",
    "  --debug              Stream raw trace and print extracted final message.",
    "  --tmux               Launch an interactive agent in a tmux session.",
    "  send <session-name>  Send a message to an existing headless tmux session.",
    "  --check              Check installed agent binaries and versions.",
    "  --list               List active headless tmux sessions.",
    "  --print-command      Print the command without executing it.",
    "  --show-config        Print harness config paths and auth seed paths.",
    "  -h, --help           Show this help.",
    "",
    "If neither --prompt nor --prompt-file is provided, stdin is used when piped.",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    send: false,
    json: false,
    debug: false,
    printCommand: false,
    showConfig: false,
    check: false,
    list: false,
    tmux: false,
    help: false,
  };
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
  if (first === "send") {
    parsed.send = true;
  } else if (isAgentName(first)) {
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
      case "--allow":
        parsed.allow = parseAllowMode(takeValue(args, arg));
        break;
      case "--work-dir":
      case "-C":
        parsed.workDir = takeValue(args, arg);
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--debug":
        parsed.debug = true;
        break;
      case "--tmux":
        parsed.tmux = true;
        break;
      case "--check":
        parsed.check = true;
        break;
      case "--list":
        parsed.list = true;
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
        if (parsed.send && arg && !arg.startsWith("-") && parsed.sendSession === undefined) {
          parsed.sendSession = arg;
          break;
        }
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

function parseAllowMode(value: string): AllowMode {
  if (value === "read-only" || value === "yolo") {
    return value;
  }
  throw new CliError(`unsupported allow mode: ${value}`);
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
  options: { forceText?: boolean; requireAgent?: boolean } = {},
): Promise<{ prompt: string; promptFile?: string }> {
  if (parsed.prompt && parsed.promptFile) {
    throw new CliError("use either --prompt or --prompt-file, not both");
  }
  if (!parsed.agent && options.requireAgent !== false) {
    throw new CliError("missing agent");
  }

  if (parsed.promptFile) {
    if (!existsSync(parsed.promptFile) || !statSync(parsed.promptFile).isFile()) {
      throw new CliError(`prompt file not found: ${parsed.promptFile}`);
    }
    if (parsed.agent && !options.forceText && getAgentHarness(parsed.agent).promptFileMode === "stdin") {
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

function commandEnv(baseEnv: Env, command: BuiltCommand): Env {
  return command.env ? { ...baseEnv, ...command.env } : baseEnv;
}

interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface TmuxCommands {
  sessionName: string;
  newSession: BuiltCommand;
  postLaunch: TmuxPostLaunchCommand[];
}

interface TmuxSendCommands {
  sessionName: string;
  commands: BuiltCommand[];
}

interface TmuxPostLaunchCommand {
  command: BuiltCommand;
  delayMs: number;
}

interface HeadlessTmuxSession {
  name: string;
  agent: AgentName;
}

type StdoutHandling = "capture" | "stream" | "capture-and-stream";

interface ExecuteCommandOptions {
  stdoutHandling: StdoutHandling;
  stdout: (text: string) => void;
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
  options: ExecuteCommandOptions,
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
        env: commandEnv(env, command) as NodeJS.ProcessEnv,
        stdio,
      });

      if (command.stdinText !== undefined) {
        child.stdin?.end(command.stdinText);
      }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (options.stdoutHandling !== "stream") {
          capturedStdout += chunk;
        }
        if (options.stdoutHandling !== "capture") {
          options.stdout(chunk);
        }
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
  prompt: string,
  cwd: string | undefined,
  env: Env,
): TmuxCommands {
  const sessionName = `headless-${agent}-${process.pid}`;
  const startDir = cwd ?? process.cwd();
  const opencodeWakeDelayMs = parseDelayMs(
    env.HEADLESS_TMUX_OPENCODE_WAKE_DELAY_MS ?? env.HEADLESS_TMUX_OPENCODE_ENTER_DELAY_MS,
    4000,
  );
  const opencodePasteDelayMs = parseDelayMs(env.HEADLESS_TMUX_OPENCODE_PASTE_DELAY_MS, 1000);
  const opencodeSubmitDelayMs = parseDelayMs(env.HEADLESS_TMUX_OPENCODE_SUBMIT_DELAY_MS, 1000);
  const opencodePromptBuffer = `${sessionName}-prompt`;
  return {
    sessionName,
    newSession: {
      command: "tmux",
      args: ["new-session", "-d", "-s", sessionName, "-c", startDir, quoteCommand(command)],
    },
    postLaunch:
      agent === "opencode"
        ? [
            {
              command: { command: "tmux", args: ["send-keys", "-t", sessionName, "Space", "BSpace"] },
              delayMs: opencodeWakeDelayMs,
            },
            {
              command: { command: "tmux", args: ["set-buffer", "-b", opencodePromptBuffer, prompt] },
              delayMs: opencodePasteDelayMs,
            },
            {
              command: { command: "tmux", args: ["paste-buffer", "-d", "-b", opencodePromptBuffer, "-t", sessionName] },
              delayMs: 0,
            },
            {
              command: { command: "tmux", args: ["send-keys", "-t", sessionName, "Enter"] },
              delayMs: opencodeSubmitDelayMs,
            },
          ]
        : [],
  };
}

function parseDelayMs(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function captureSimpleCommand(
  command: BuiltCommand,
  cwd: string | undefined,
  env: Env,
): Promise<CaptureResult> {
  return await new Promise<CaptureResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command.command, command.args, {
      cwd,
      env: commandEnv(env, command) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
      resolve({ code: 127, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      resolve({ code: signal ? 1 : (code ?? 1), stdout, stderr });
    });
  });
}

function parseHeadlessTmuxSession(name: string): HeadlessTmuxSession | undefined {
  const match = /^headless-([a-z]+)-\d+$/.exec(name);
  if (!match) {
    return undefined;
  }
  const agent = match[1];
  if (!isAgentName(agent)) {
    return undefined;
  }
  return { name, agent };
}

function renderHeadlessTmuxSessions(sessions: HeadlessTmuxSession[]): string {
  if (sessions.length === 0) {
    return "No active headless tmux sessions\n";
  }
  return sessions
    .map((session) => `${session.name}\t${session.agent}\ttmux attach-session -t ${session.name}`)
    .join("\n")
    .concat("\n");
}

function buildTmuxSendCommands(sessionName: string, prompt: string): TmuxSendCommands {
  const promptBuffer = `${sessionName}-send`;
  return {
    sessionName,
    commands: [
      { command: "tmux", args: ["set-buffer", "-b", promptBuffer, prompt] },
      { command: "tmux", args: ["paste-buffer", "-d", "-b", promptBuffer, "-t", sessionName] },
      { command: "tmux", args: ["send-keys", "-t", sessionName, "Enter"] },
    ],
  };
}

function validateHeadlessTmuxSessionName(sessionName: string | undefined): string {
  if (!sessionName) {
    throw new CliError("missing tmux session");
  }
  if (!parseHeadlessTmuxSession(sessionName)) {
    throw new CliError(`not a headless tmux session: ${sessionName}`);
  }
  return sessionName;
}

async function listHeadlessTmuxSessions(agent: AgentName | undefined, env: Env): Promise<string> {
  const result = await captureSimpleCommand(
    { command: "tmux", args: ["list-sessions", "-F", "#{session_name}"] },
    undefined,
    env,
  );

  if (result.code !== 0) {
    if (result.stderr.includes("no server running")) {
      return renderHeadlessTmuxSessions([]);
    }
    throw new CliError(result.stderr.trim() || "could not list tmux sessions");
  }

  const sessions = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseHeadlessTmuxSession)
    .filter((session): session is HeadlessTmuxSession => Boolean(session))
    .filter((session) => agent === undefined || session.agent === agent);

  return renderHeadlessTmuxSessions(sessions);
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
      env: commandEnv(env, command) as NodeJS.ProcessEnv,
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

async function waitForDelay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeTmuxCommands(
  commands: TmuxCommands,
  cwd: string | undefined,
  env: Env,
  stderr: (text: string) => void,
): Promise<number> {
  const launchCode = await executeSimpleCommand(commands.newSession, cwd, env, stderr);
  if (launchCode !== 0) {
    return launchCode;
  }

  for (const postLaunch of commands.postLaunch) {
    await waitForDelay(postLaunch.delayMs);
    const code = await executeSimpleCommand(postLaunch.command, cwd, env, stderr);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}

async function executeTmuxSendCommands(
  commands: TmuxSendCommands,
  env: Env,
  stderr: (text: string) => void,
): Promise<number> {
  for (const command of commands.commands) {
    const code = await executeSimpleCommand(command, undefined, env, stderr);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
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
    if (parsed.send) {
      if (parsed.tmux) {
        throw new CliError("--tmux cannot be used with send");
      }
      if (parsed.json) {
        throw new CliError("--json cannot be used with send");
      }
      if (parsed.debug) {
        throw new CliError("--debug cannot be used with send");
      }

      const sessionName = validateHeadlessTmuxSessionName(parsed.sendSession);
      const prompt = await resolvePrompt(parsed, deps, { forceText: true, requireAgent: false });
      const tmuxCommands = buildTmuxSendCommands(sessionName, prompt.prompt);

      if (parsed.printCommand) {
        for (const command of tmuxCommands.commands) {
          stdout(`${quoteCommand(command)}\n`);
        }
        return 0;
      }

      const code = await executeTmuxSendCommands(tmuxCommands, env, stderr);
      if (code === 0) {
        stdout(`sent: ${tmuxCommands.sessionName}\n`);
      }
      return code;
    }
    if (parsed.check) {
      stdout(renderAgentChecks(await checkAgents(env)));
      return 0;
    }
    if (parsed.list) {
      stdout(await listHeadlessTmuxSessions(parsed.agent, env));
      return 0;
    }
    if (!parsed.agent) {
      parsed.agent = selectDefaultAgent(env);
    }
    if (parsed.tmux && parsed.json) {
      throw new CliError("--json cannot be used with --tmux");
    }
    if (parsed.debug && parsed.json) {
      throw new CliError("--debug cannot be used with --json");
    }
    if (parsed.debug && parsed.tmux) {
      throw new CliError("--debug cannot be used with --tmux");
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
          allow: parsed.allow,
        },
        env,
      );
      const tmuxCommands = buildTmuxCommands(parsed.agent, tmuxCommand, prompt.prompt, cwd, env);

      if (parsed.printCommand) {
        stdout(`${quoteCommand(tmuxCommands.newSession)}\n`);
        for (const postLaunch of tmuxCommands.postLaunch) {
          stdout(`${quoteCommand(postLaunch.command)}\n`);
        }
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
        allow: parsed.allow,
      },
      env,
    );

    if (parsed.printCommand) {
      stdout(`${quoteCommand(command)}\n`);
      return 0;
    }

    const stdoutHandling: StdoutHandling = parsed.json
      ? "stream"
      : parsed.debug
        ? "capture-and-stream"
        : "capture";
    const result = await executeCommand(parsed.agent, command, cwd, env, stderr, {
      stdout,
      stdoutHandling,
    });
    if (parsed.json) {
      return result.code;
    }

    const finalMessage = extractFinalMessage(parsed.agent, result.stdout);
    if (finalMessage) {
      if (parsed.debug) {
        if (!result.stdout.endsWith("\n")) {
          stdout("\n");
        }
        stdout(`--- final message ---\n${finalMessage}\n`);
      } else {
        stdout(`${finalMessage}\n`);
      }
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
