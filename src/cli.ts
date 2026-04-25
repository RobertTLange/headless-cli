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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgentCommand,
  buildInteractiveAgentCommand,
  getAgentConfig,
  getAgentHarness,
  isAgentName,
  listAgents,
} from "./agents.js";
import { checkAgents, checkDocker, commandExists, commandForAgent, renderAgentChecks, renderDockerCheck } from "./check.js";
import {
  buildDockerAgentCommand,
  DEFAULT_DOCKER_IMAGE,
  LOCAL_DOCKER_IMAGE,
  detectDockerHostUser,
} from "./docker.js";
import {
  buildModalRunSummary,
  DEFAULT_MODAL_APP,
  DEFAULT_MODAL_CPU,
  DEFAULT_MODAL_IMAGE,
  DEFAULT_MODAL_MEMORY_MIB,
  DEFAULT_MODAL_TIMEOUT_SECONDS,
  executeModalAgent,
} from "./modal.js";
import { extractFinalMessage } from "./output.js";
import { quoteCommand } from "./shell.js";
import type { AgentName, AllowMode, BuiltCommand, Env } from "./types.js";

interface ParsedArgs {
  send: boolean;
  sendSession?: string;
  rename: boolean;
  renameSession?: string;
  renameName?: string;
  dockerCommand?: "build" | "doctor";
  agent?: AgentName;
  prompt?: string;
  promptFile?: string;
  model?: string;
  allow?: AllowMode;
  workDir?: string;
  tmuxName?: string;
  docker: boolean;
  dockerImage?: string;
  dockerArgs: string[];
  dockerEnv: string[];
  modal: boolean;
  modalApp?: string;
  modalCpu?: number;
  modalEnv: string[];
  modalImage?: string;
  modalImageSecret?: string;
  modalIncludeGit: boolean;
  modalMemoryMiB?: number;
  modalSecrets: string[];
  modalTimeoutSeconds?: number;
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
    "       headless docker doctor [options]",
    "       headless docker build [options]",
    "       headless send <session-name> (--prompt <text> | --prompt-file <path>) [options]",
    "       headless rename <session-name> <new-name> [options]",
    "",
    `Agents: ${listAgents().join(", ")}`,
    "",
    "Options:",
    "  --model <name>        Agent model override.",
    "  --allow <mode>        Permission mode: read-only or yolo.",
    "  --prompt, -p <text>   Prompt text.",
    "  --prompt-file <path>  Read prompt from a file.",
    "  --work-dir, -C <path> Run from this directory.",
    "  --docker             Run the agent inside Docker.",
    "  --docker-image <img> Docker image. Defaults to ghcr.io/roberttlange/headless:latest.",
    "  --docker-arg <arg>   Extra docker run argument. Repeat for multiple args.",
    "  --docker-env <env>   Pass env into Docker as NAME or NAME=value. Repeatable.",
    "  --modal              Run the agent in a Modal CPU sandbox.",
    "  --modal-image <img>  Modal sandbox image. Defaults to ghcr.io/roberttlange/headless:latest.",
    "  --modal-image-secret <nm> Modal Secret for private registry image pulls.",
    "  --modal-secret <nm>  Inject a named Modal Secret. Repeatable.",
    "  --modal-env <env>    Pass env into Modal as NAME or NAME=value. Repeatable.",
    "  --json               Stream raw agent JSON trace output.",
    "  --debug              Stream raw trace and print extracted final message.",
    "  --tmux               Launch an interactive agent in a tmux session.",
    "  --name <name>        Use a managed tmux session name with --tmux.",
    "  send <session-name>  Send a message to an existing headless tmux session.",
    "  rename <session> <name> Rename an existing headless tmux session.",
    "  docker doctor       Check Docker setup and image availability.",
    "  docker build        Build the local Docker image tag headless-local:dev.",
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
    rename: false,
    docker: false,
    dockerArgs: [],
    dockerEnv: [],
    modal: false,
    modalEnv: [],
    modalIncludeGit: false,
    modalSecrets: [],
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
  } else if (first === "rename") {
    parsed.rename = true;
  } else if (first === "docker") {
    parsed.dockerCommand = parseDockerCommand(args.shift());
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
      case "--docker":
        parsed.docker = true;
        break;
      case "--docker-image":
        parsed.dockerImage = takeValue(args, arg);
        break;
      case "--docker-arg":
        parsed.dockerArgs.push(takeValue(args, arg));
        break;
      case "--docker-env":
        parsed.dockerEnv.push(parseDockerEnv(takeValue(args, arg)));
        break;
      case "--modal":
        parsed.modal = true;
        break;
      case "--modal-app":
        parsed.modalApp = takeValue(args, arg);
        break;
      case "--modal-cpu":
        parsed.modalCpu = parsePositiveNumber(takeValue(args, arg), arg);
        break;
      case "--modal-env":
        parsed.modalEnv.push(parseModalEnv(takeValue(args, arg)));
        break;
      case "--modal-image":
        parsed.modalImage = takeValue(args, arg);
        break;
      case "--modal-image-secret":
        parsed.modalImageSecret = parseModalSecret(takeValue(args, arg));
        break;
      case "--modal-include-git":
        parsed.modalIncludeGit = true;
        break;
      case "--modal-memory":
        parsed.modalMemoryMiB = parsePositiveInteger(takeValue(args, arg), arg);
        break;
      case "--modal-secret":
        parsed.modalSecrets.push(parseModalSecret(takeValue(args, arg)));
        break;
      case "--modal-timeout":
        parsed.modalTimeoutSeconds = parsePositiveInteger(takeValue(args, arg), arg);
        break;
      case "--name":
        parsed.tmuxName = takeValue(args, arg);
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
        if (parsed.rename && arg && !arg.startsWith("-")) {
          if (parsed.renameSession === undefined) {
            parsed.renameSession = arg;
            break;
          }
          if (parsed.renameName === undefined) {
            parsed.renameName = arg;
            break;
          }
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

function parseDockerEnv(value: string): string {
  return parseForwardedEnv(value, "docker");
}

function parseModalEnv(value: string): string {
  return parseForwardedEnv(value, "modal");
}

function parseForwardedEnv(value: string, label: string): string {
  const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new CliError(`invalid ${label} env: ${value}`);
  }
  return value;
}

function parseModalSecret(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new CliError(`invalid modal secret: ${value}`);
  }
  return value;
}

function parsePositiveNumber(value: string, flag: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive number`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, flag: string | undefined): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new CliError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseDockerCommand(value: string | undefined): "build" | "doctor" {
  if (value === "build" || value === "doctor") {
    return value;
  }
  throw new CliError("missing docker command; use docker doctor or docker build");
}

function hasModalOptions(parsed: ParsedArgs): boolean {
  return (
    parsed.modalApp !== undefined ||
    parsed.modalCpu !== undefined ||
    parsed.modalEnv.length > 0 ||
    parsed.modalImage !== undefined ||
    parsed.modalImageSecret !== undefined ||
    parsed.modalIncludeGit ||
    parsed.modalMemoryMiB !== undefined ||
    parsed.modalSecrets.length > 0 ||
    parsed.modalTimeoutSeconds !== undefined
  );
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

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function dockerfilePath(): string {
  return join(packageRoot(), "Dockerfile");
}

function buildDockerImageCommand(image: string): BuiltCommand {
  return { command: "docker", args: ["build", "-t", image, "-f", dockerfilePath(), packageRoot()] };
}

function renderDockerDoctor(check: Awaited<ReturnType<typeof checkDocker>>, image: string): string {
  const lines = [
    renderDockerCheck(check).trimEnd(),
    "",
    `Default run image: ${DEFAULT_DOCKER_IMAGE}`,
    `Local build image: ${LOCAL_DOCKER_IMAGE}`,
    `Dockerfile: ${dockerfilePath()}`,
  ];
  if (!check.available) {
    lines.push("", "Docker is not on PATH. Install/start Docker, then rerun `headless docker doctor`.");
  } else if (!check.imageAvailable) {
    lines.push(
      "",
      `Image not present locally: ${image}`,
      "Plain `headless --docker` will let Docker pull the default image automatically.",
      `For local development, run: headless docker build`,
      `Then run with: headless codex --docker --docker-image ${LOCAL_DOCKER_IMAGE} --prompt "..."`,
    );
  } else {
    lines.push("", "Docker is ready.");
  }
  return `${lines.join("\n")}\n`;
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

interface TmuxRenameCommand {
  sourceName: string;
  targetName: string;
  command: BuiltCommand;
}

interface TmuxPostLaunchCommand {
  command: BuiltCommand;
  delayMs: number;
}

interface HeadlessTmuxSession {
  name: string;
  agent: AgentName;
}

type HeadlessTmuxSessionState = "running" | "waiting" | "dead";

interface HeadlessTmuxSessionDetails extends HeadlessTmuxSession {
  state: HeadlessTmuxSessionState;
  createdAt: string;
  lastActivityAt: string;
}

type StdoutHandling = "capture" | "stream" | "capture-and-stream";

interface ExecuteCommandOptions {
  stdoutHandling: StdoutHandling;
  stdout: (text: string) => void;
}

function suppressKnownStderr(agent: AgentName, text: string): string {
  if (agent === "codex") {
    return text
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (/ERROR codex_core::session: failed to record rollout items: thread .* not found$/.test(trimmed)) {
          return false;
        }
        return true;
      })
      .map((line) => `${line}\n`)
      .join("");
  }
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
  customName: string | undefined,
): TmuxCommands {
  const sessionName = buildHeadlessTmuxSessionName(agent, customName ?? String(process.pid));
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

function validateTmuxNamePart(name: string | undefined): string {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new CliError("invalid tmux session name; use letters, numbers, dots, dashes, or underscores");
  }
  return name;
}

function buildHeadlessTmuxSessionName(agent: AgentName, name: string): string {
  return `headless-${agent}-${validateTmuxNamePart(name)}`;
}

function parseHeadlessTmuxSession(name: string): HeadlessTmuxSession | undefined {
  const match = /^headless-([a-z]+)-([A-Za-z0-9_.-]+)$/.exec(name);
  if (!match) {
    return undefined;
  }
  const agent = match[1];
  if (!isAgentName(agent)) {
    return undefined;
  }
  return { name, agent };
}

function formatEpochSeconds(value: number): string {
  return new Date(value * 1000).toISOString();
}

function parseEpochSeconds(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseWaitingAfterMs(env: Env): number {
  const parsed = Number.parseInt(env.HEADLESS_LIST_WAITING_AFTER_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
}

function inferHeadlessTmuxSessionState(
  paneDead: string,
  lastActivitySeconds: number,
  waitingAfterMs: number,
): HeadlessTmuxSessionState {
  if (paneDead === "1") {
    return "dead";
  }
  return Date.now() - lastActivitySeconds * 1000 <= waitingAfterMs ? "running" : "waiting";
}

function parseHeadlessTmuxSessionDetails(
  line: string,
  waitingAfterMs: number,
): HeadlessTmuxSessionDetails | undefined {
  const [name, createdRaw, activityRaw, paneDead = "0"] = line.split("\t");
  const session = parseHeadlessTmuxSession(name?.trim() ?? "");
  const createdSeconds = parseEpochSeconds(createdRaw ?? "");
  const activitySeconds = parseEpochSeconds(activityRaw ?? "");
  if (!session || createdSeconds === undefined || activitySeconds === undefined) {
    return undefined;
  }
  return {
    ...session,
    state: inferHeadlessTmuxSessionState(paneDead.trim(), activitySeconds, waitingAfterMs),
    createdAt: formatEpochSeconds(createdSeconds),
    lastActivityAt: formatEpochSeconds(activitySeconds),
  };
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)].join("\n").concat("\n");
}

function renderHeadlessTmuxSessions(sessions: HeadlessTmuxSessionDetails[]): string {
  if (sessions.length === 0) {
    return "No active headless tmux sessions\n";
  }
  return renderTable(
    ["NAME", "AGENT", "STATE", "CREATED", "LAST_ACTIVITY", "ATTACH"],
    sessions.map((session) => [
      session.name,
      session.agent,
      session.state,
      session.createdAt,
      session.lastActivityAt,
      `tmux attach-session -t ${session.name}`,
    ]),
  );
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

function buildTmuxRenameCommand(session: HeadlessTmuxSession, targetName: string): TmuxRenameCommand {
  const targetSessionName = buildHeadlessTmuxSessionName(session.agent, targetName);
  return {
    sourceName: session.name,
    targetName: targetSessionName,
    command: { command: "tmux", args: ["rename-session", "-t", session.name, targetSessionName] },
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

function validateHeadlessTmuxSession(sessionName: string | undefined): HeadlessTmuxSession {
  const name = validateHeadlessTmuxSessionName(sessionName);
  return parseHeadlessTmuxSession(name) as HeadlessTmuxSession;
}

async function listHeadlessTmuxSessions(agent: AgentName | undefined, env: Env): Promise<string> {
  const result = await captureSimpleCommand(
    {
      command: "tmux",
      args: ["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{window_activity}\t#{pane_dead}"],
    },
    undefined,
    env,
  );

  if (result.code !== 0) {
    if (result.stderr.includes("no server running")) {
      return renderHeadlessTmuxSessions([]);
    }
    throw new CliError(result.stderr.trim() || "could not list tmux sessions");
  }

  const waitingAfterMs = parseWaitingAfterMs(env);
  const sessions = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseHeadlessTmuxSessionDetails(line, waitingAfterMs))
    .filter((session): session is HeadlessTmuxSessionDetails => Boolean(session))
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
  stdout?: (text: string) => void,
): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd,
      env: commandEnv(env, command) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout?.(chunk));
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

async function executeTmuxRenameCommand(
  command: TmuxRenameCommand,
  env: Env,
  stderr: (text: string) => void,
): Promise<number> {
  return await executeSimpleCommand(command.command, undefined, env, stderr);
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
    if (parsed.dockerCommand) {
      if (parsed.prompt !== undefined || parsed.promptFile !== undefined) {
        throw new CliError(`--prompt and --prompt-file cannot be used with docker ${parsed.dockerCommand}`);
      }
      if (parsed.docker || parsed.dockerArgs.length > 0 || parsed.dockerEnv.length > 0) {
        throw new CliError(`--docker, --docker-arg, and --docker-env cannot be used with docker ${parsed.dockerCommand}`);
      }
      if (parsed.modal || hasModalOptions(parsed)) {
        throw new CliError(`--modal and --modal-* cannot be used with docker ${parsed.dockerCommand}`);
      }
      if (parsed.tmux || parsed.json || parsed.debug || parsed.list || parsed.check || parsed.showConfig) {
        throw new CliError(`unsupported option for docker ${parsed.dockerCommand}`);
      }
      if (parsed.dockerCommand === "doctor") {
        const image = parsed.dockerImage ?? DEFAULT_DOCKER_IMAGE;
        stdout(renderDockerDoctor(await checkDocker(env, image), image));
        return 0;
      }

      const image = parsed.dockerImage ?? LOCAL_DOCKER_IMAGE;
      const command = buildDockerImageCommand(image);
      if (!existsSync(dockerfilePath())) {
        throw new CliError(`Dockerfile not found: ${dockerfilePath()}`);
      }
      if (parsed.printCommand) {
        stdout(`${quoteCommand(command)}\n`);
        return 0;
      }
      if (!commandExists("docker", env)) {
        throw new CliError("docker not found on PATH");
      }
      return await executeSimpleCommand(command, undefined, env, stderr, stdout);
    }
    if (parsed.rename) {
      if (parsed.docker) {
        throw new CliError("--docker cannot be used with rename");
      }
      if (parsed.modal) {
        throw new CliError("--modal cannot be used with rename");
      }
      if (parsed.tmux) {
        throw new CliError("--tmux cannot be used with rename");
      }
      if (parsed.json) {
        throw new CliError("--json cannot be used with rename");
      }
      if (parsed.debug) {
        throw new CliError("--debug cannot be used with rename");
      }
      if (parsed.tmuxName !== undefined) {
        throw new CliError("--name cannot be used with rename");
      }

      const session = validateHeadlessTmuxSession(parsed.renameSession);
      if (!parsed.renameName) {
        throw new CliError("missing new tmux session name");
      }
      const tmuxCommand = buildTmuxRenameCommand(session, parsed.renameName);

      if (parsed.printCommand) {
        stdout(`${quoteCommand(tmuxCommand.command)}\n`);
        return 0;
      }

      const code = await executeTmuxRenameCommand(tmuxCommand, env, stderr);
      if (code === 0) {
        stdout(`renamed: ${tmuxCommand.sourceName} -> ${tmuxCommand.targetName}\n`);
      }
      return code;
    }
    if (parsed.send) {
      if (parsed.docker) {
        throw new CliError("--docker cannot be used with send");
      }
      if (parsed.modal) {
        throw new CliError("--modal cannot be used with send");
      }
      if (parsed.tmux) {
        throw new CliError("--tmux cannot be used with send");
      }
      if (parsed.json) {
        throw new CliError("--json cannot be used with send");
      }
      if (parsed.debug) {
        throw new CliError("--debug cannot be used with send");
      }
      if (parsed.tmuxName !== undefined) {
        throw new CliError("--name cannot be used with send");
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
      stdout(renderDockerCheck(await checkDocker(env, parsed.dockerImage ?? DEFAULT_DOCKER_IMAGE)));
      return 0;
    }
    if (parsed.list && parsed.docker) {
      throw new CliError("--docker cannot be used with --list");
    }
    if (parsed.list && parsed.modal) {
      throw new CliError("--modal cannot be used with --list");
    }
    if (parsed.list) {
      stdout(await listHeadlessTmuxSessions(parsed.agent, env));
      return 0;
    }
    if (
      !parsed.docker &&
      (parsed.dockerImage !== undefined || parsed.dockerArgs.length > 0 || parsed.dockerEnv.length > 0)
    ) {
      throw new CliError("--docker-image, --docker-arg, and --docker-env require --docker");
    }
    if (!parsed.modal && hasModalOptions(parsed)) {
      throw new CliError("--modal-* options require --modal");
    }
    if (parsed.docker && parsed.modal) {
      throw new CliError("--docker cannot be used with --modal");
    }
    if (!parsed.agent) {
      parsed.agent = parsed.docker || parsed.modal ? autoAgentPreference[0] : selectDefaultAgent(env);
    }
    if (parsed.tmux && parsed.docker) {
      throw new CliError("--docker cannot be used with --tmux");
    }
    if (parsed.tmux && parsed.modal) {
      throw new CliError("--modal cannot be used with --tmux");
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
    if (parsed.tmuxName !== undefined && !parsed.tmux) {
      throw new CliError("--name can only be used with --tmux");
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
      const tmuxCommands = buildTmuxCommands(parsed.agent, tmuxCommand, prompt.prompt, cwd, env, parsed.tmuxName);

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

    let command = buildAgentCommand(
      parsed.agent,
      {
        prompt: prompt.prompt,
        promptFile: prompt.promptFile,
        model: parsed.model,
        allow: parsed.allow,
      },
      env,
    );
    if (parsed.docker) {
      command = buildDockerAgentCommand({
        agent: parsed.agent,
        command,
        dockerArgs: parsed.dockerArgs,
        dockerEnv: parsed.dockerEnv,
        env,
        hostUser: detectDockerHostUser(),
        image: parsed.dockerImage ?? DEFAULT_DOCKER_IMAGE,
        workDir: cwd ?? process.cwd(),
      });
    }

    if (parsed.printCommand) {
      const printableCommand = parsed.modal
        ? buildModalRunSummary({
            appName: parsed.modalApp ?? DEFAULT_MODAL_APP,
            command,
            cpu: parsed.modalCpu ?? DEFAULT_MODAL_CPU,
            image: parsed.modalImage ?? DEFAULT_MODAL_IMAGE,
            imageSecret: parsed.modalImageSecret,
            memoryMiB: parsed.modalMemoryMiB ?? DEFAULT_MODAL_MEMORY_MIB,
            modalSecrets: parsed.modalSecrets,
            timeoutSeconds: parsed.modalTimeoutSeconds ?? DEFAULT_MODAL_TIMEOUT_SECONDS,
            workDir: cwd ?? process.cwd(),
          })
        : command;
      stdout(`${quoteCommand(printableCommand)}\n`);
      return 0;
    }
    if (parsed.docker && !commandExists("docker", env)) {
      throw new CliError("docker not found on PATH");
    }

    const stdoutHandling: StdoutHandling = parsed.json
      ? "stream"
      : parsed.debug
        ? "capture-and-stream"
        : "capture";
    const result = parsed.modal
      ? await executeModalAgent({
          agent: parsed.agent,
          appName: parsed.modalApp ?? DEFAULT_MODAL_APP,
          command,
          cpu: parsed.modalCpu ?? DEFAULT_MODAL_CPU,
          env,
          image: parsed.modalImage ?? DEFAULT_MODAL_IMAGE,
          imageSecret: parsed.modalImageSecret,
          includeGit: parsed.modalIncludeGit,
          memoryMiB: parsed.modalMemoryMiB ?? DEFAULT_MODAL_MEMORY_MIB,
          modalEnv: parsed.modalEnv,
          modalSecrets: parsed.modalSecrets,
          stderr: (text) => {
            const filtered = suppressKnownStderr(parsed.agent as AgentName, text);
            if (filtered) {
              stderr(filtered);
            }
          },
          stdout,
          stdoutHandling,
          timeoutSeconds: parsed.modalTimeoutSeconds ?? DEFAULT_MODAL_TIMEOUT_SECONDS,
          workDir: cwd ?? process.cwd(),
        })
      : await executeCommand(parsed.agent, command, cwd, env, stderr, {
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
