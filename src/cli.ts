#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { runAcpClient, runAcpStdioAgent } from "./acp.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgentCommand,
  buildInteractiveAgentCommand,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENCODE_MODEL,
  DEFAULT_PI_MODEL,
  cursorModel,
  piModelSpec,
  getAgentConfig,
  getAgentHarness,
  isAgentName,
  listAgents,
} from "./agents.js";
import { checkAgents, checkDocker, commandExists, commandForAgent, renderAgentChecks, renderDockerCheck } from "./check.js";
import {
  BUILTIN_AGENT_DEFAULTS,
  loadHeadlessConfig,
  resolveInvocationDefaults,
  type HeadlessConfig,
  type InvocationDefaults,
} from "./config.js";
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
import {
  extractAgentError,
  extractFinalMessage,
  extractNativeSessionId,
  extractUsageSummary,
  fetchModelsDevPricing,
  priceUsageSummary,
} from "./output.js";
import { handleRunCommand as handleRunCommandImpl } from "./run-commands.js";
import { extractRunNodeMetrics } from "./run-metrics.js";
import { createRunStatusReporter, parseRunStatusIntervalMs } from "./run-status.js";
import {
  appendNodeLog,
  completeIdleRunNodes,
  readRun,
  registerNode,
  runDirectory,
  updateNodeStatus,
  validateRunId,
  type RunNode,
} from "./runs.js";
import { readStoredSession, sessionStorePath, writeStoredSession } from "./sessions.js";
import { quoteCommand } from "./shell.js";
import { cell, renderTable as renderBoxTable, type TableCell } from "./table.js";
import {
  composeRolePrompt,
  isCoordinationMode,
  isRole,
  isRunStatus,
  nodeIdForRole,
  roleDefaultAllow,
  type CoordinationMode,
  type Role,
  type RunStatus,
} from "./roles.js";
import { expandTeamSpecs } from "./teams.js";
import type { AgentName, AllowMode, BuiltCommand, Env, ReasoningEffort } from "./types.js";

interface ParsedArgs {
  attach: boolean;
  attachSession?: string;
  attachAll: boolean;
  send: boolean;
  sendSession?: string;
  rename: boolean;
  renameSession?: string;
  renameName?: string;
  runCommand?: "list" | "view" | "mark" | "message" | "wait";
  runCommandRunId?: string;
  runCommandNodeId?: string;
  runCommandStatus?: RunStatus;
  runCommandAsync: boolean;
  dockerCommand?: "build" | "doctor";
  agent?: AgentName;
  role?: Role;
  coordination?: CoordinationMode;
  runId?: string;
  nodeId?: string;
  dependsOn: string[];
  teamSpecs: string[];
  prompt?: string;
  promptFile?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  allow?: AllowMode;
  acpAgent?: string;
  acpCommand?: string;
  acpRegistryFile?: string;
  acpRegistryUrl?: string;
  workDir?: string;
  tmuxName?: string;
  sessionAlias?: string;
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
  usage: boolean;
  printCommand: boolean;
  showConfig: boolean;
  check: boolean;
  list: boolean;
  tmux: boolean;
  help: boolean;
  version: boolean;
}

interface CliDeps {
  env?: Env;
  stdin?: string;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
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
    "       headless attach [session-name] [--all]",
    "       headless send <session-name> (--prompt <text> | --prompt-file <path>) [options]",
    "       headless rename <session-name> <new-name> [options]",
    "       headless run <list|view|mark|message|wait> [args] [options]",
    "",
    "Headless gives coding-agent CLIs one shared interface for prompts, models, reasoning effort, output modes, sessions, and work directories.",
    "It runs supported agents locally, in tmux, in Docker, or in Modal while preserving each backend's native execution behavior.",
    "Use it to launch one-off tasks, resume named sessions, or coordinate multi-agent runs from scripts and terminals.",
    "",
    `Agents: ${listAgents().join(", ")}`,
    "",
    "Options:",
    "  --model <name>        Agent model override.",
    "  --reasoning-effort, --effort <level> Reasoning effort: low, medium, high, or xhigh.",
    "  --allow <mode>        Permission mode: read-only or yolo.",
    "  --acp-agent <id>      With acp, resolve an ACP server from the registry by id or name.",
    "  --acp-command <cmd>   With acp, run a custom ACP server command, e.g. 'atlas alta agent run'.",
    "  --acp-registry <url>  With --acp-agent, use a custom ACP registry URL.",
    "  --acp-registry-file <path> With --acp-agent, read registry JSON from a local file.",
    "  --role <role>         Role: orchestrator, explorer, worker, or reviewer.",
    "  --coordination <mode> Coordination: session, tmux, or oneshot.",
    "  --run <run>           Register this invocation in a local run.",
    "  --node <node>         Node name inside --run. Defaults to the role name.",
    "  --depends-on <node>   Record a dependency edge. Repeatable.",
    "  --team <spec>         Declare orchestrator team nodes, e.g. worker=2 or codex/worker=3.",
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
    "  --modal-app <name>   Modal app name. Defaults to headless-cli.",
    "  --modal-cpu <n>      Modal CPU reservation. Defaults to 2.",
    "  --modal-memory <mb>  Modal memory reservation in MiB. Defaults to 4096.",
    "  --modal-timeout <s>  Modal sandbox and command timeout. Defaults to 3600.",
    "  --modal-secret <nm>  Inject a named Modal Secret. Repeatable.",
    "  --modal-env <env>    Pass env into Modal as NAME or NAME=value. Repeatable.",
    "  --modal-include-git Include .git metadata in Modal uploads.",
    "  --json               Stream raw agent JSON trace output.",
    "  --debug              Stream raw trace and print extracted final message.",
    "  --usage              Print final message plus normalized token and cost JSON.",
    "  --tmux               Launch an interactive agent in a tmux session.",
    "  --name <name>        Use a managed tmux session name with --tmux.",
    "  --session <name>     Start or resume a named Headless session.",
    "  attach [session]     Attach to one or all active headless tmux sessions.",
    "  --all                With attach, tile all active headless tmux sessions.",
    "  send <session-name>  Send a message to an existing headless tmux session.",
    "  rename <session> <name> Rename an existing headless tmux session.",
    "  run list            List local coordinated runs.",
    "  run view <run>      Show run graph, recent messages, and exact node commands.",
    "  run mark <run> <node> --status <status> Update node status.",
    "  run message <run> <node> --prompt <text> [--async] Route a message to a node.",
    "  run wait <run>      Wait until no nodes are busy.",
    "  docker doctor       Check Docker setup and image availability.",
    "  docker build        Build the local Docker image tag headless-local:dev.",
    "  --check              Check agents, versions, auth, configured models/effort, and Docker.",
    "  --list               List active headless tmux sessions.",
    "  --print-command      Print the command without executing it. Combine with --json for identity metadata.",
    "  --show-config        Print harness config paths and auth seed paths.",
    "  -v, --version        Print the Headless CLI version.",
    "  -h, --help           Show this help.",
    "",
    "If neither --prompt nor --prompt-file is provided, stdin is used when piped.",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    attach: false,
    attachAll: false,
    send: false,
    rename: false,
    runCommandAsync: false,
    dependsOn: [],
    teamSpecs: [],
    docker: false,
    dockerArgs: [],
    dockerEnv: [],
    modal: false,
    modalEnv: [],
    modalIncludeGit: false,
    modalSecrets: [],
    json: false,
    debug: false,
    usage: false,
    printCommand: false,
    showConfig: false,
    check: false,
    list: false,
    tmux: false,
    help: false,
    version: false,
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
  if (first === "-v" || first === "--version") {
    parsed.version = true;
    return parsed;
  }
  if (first === undefined) {
    parsed.help = true;
    return parsed;
  }
  if (first === "attach") {
    parsed.attach = true;
  } else if (first === "send") {
    parsed.send = true;
  } else if (first === "rename") {
    parsed.rename = true;
  } else if (first === "run") {
    parsed.runCommand = parseRunCommand(args.shift());
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
      case "--reasoning-effort":
      case "--effort":
        parsed.reasoningEffort = parseReasoningEffort(takeValue(args, arg));
        break;
      case "--allow":
        parsed.allow = parseAllowMode(takeValue(args, arg));
        break;
      case "--acp-agent":
        parsed.acpAgent = takeValue(args, arg);
        break;
      case "--acp-command":
        parsed.acpCommand = takeValue(args, arg);
        break;
      case "--acp-registry":
        parsed.acpRegistryUrl = takeValue(args, arg);
        break;
      case "--acp-registry-file":
        parsed.acpRegistryFile = takeValue(args, arg);
        break;
      case "--role":
        parsed.role = parseRole(takeValue(args, arg));
        break;
      case "--coordination":
        parsed.coordination = parseCoordinationMode(takeValue(args, arg));
        break;
      case "--run":
        parsed.runId = validateSafeName(takeValue(args, arg), "run");
        break;
      case "--node":
        parsed.nodeId = validateSafeName(takeValue(args, arg), "node");
        break;
      case "--depends-on":
        parsed.dependsOn.push(validateSafeName(takeValue(args, arg), "dependency"));
        break;
      case "--team":
        parsed.teamSpecs.push(takeValue(args, arg));
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
      case "--session":
        parsed.sessionAlias = takeValue(args, arg);
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--debug":
        parsed.debug = true;
        break;
      case "--usage":
        parsed.usage = true;
        break;
      case "--tmux":
        parsed.tmux = true;
        break;
      case "--all":
        parsed.attachAll = true;
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
      case "--status":
        parsed.runCommandStatus = parseRunStatus(takeValue(args, arg));
        break;
      case "--async":
        parsed.runCommandAsync = true;
        break;
      case "--show-config":
        parsed.showConfig = true;
        break;
      case "-v":
      case "--version":
        parsed.version = true;
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
        if (parsed.attach && arg && !arg.startsWith("-") && parsed.attachSession === undefined) {
          parsed.attachSession = arg;
          break;
        }
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
        if (parsed.runCommand && arg && !arg.startsWith("-")) {
          if (parsed.runCommandRunId === undefined) {
            parsed.runCommandRunId = validateSafeName(arg, "run");
            break;
          }
          if (
            (parsed.runCommand === "mark" || parsed.runCommand === "message") &&
            parsed.runCommandNodeId === undefined
          ) {
            parsed.runCommandNodeId = validateSafeName(arg, "node");
            break;
          }
        }
        throw new CliError(`unknown argument: ${arg ?? ""}`);
    }
  }

  return parsed;
}

function parseRunCommand(value: string | undefined): "list" | "view" | "mark" | "message" | "wait" {
  if (value === "list" || value === "view" || value === "mark" || value === "message" || value === "wait") {
    return value;
  }
  throw new CliError("missing run command; use run list, view, mark, message, or wait");
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

function parseRole(value: string): Role {
  if (isRole(value)) {
    return value;
  }
  throw new CliError(`unsupported role: ${value}`);
}

function parseCoordinationMode(value: string): CoordinationMode {
  if (isCoordinationMode(value)) {
    return value;
  }
  throw new CliError(`unsupported coordination mode: ${value}`);
}

function parseRunStatus(value: string): RunStatus {
  if (isRunStatus(value)) {
    return value;
  }
  throw new CliError(`unsupported run status: ${value}`);
}

function validateSafeName(value: string | undefined, label: string): string {
  try {
    return validateRunId(value, label);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
}

function parseReasoningEffort(value: string): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new CliError(`unsupported reasoning effort: ${value}`);
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

function unsupportedReasoningEffortWarning(
  agent: AgentName,
  effort: ReasoningEffort | undefined,
  mode: "headless" | "tmux",
): string | undefined {
  if (!effort) {
    return undefined;
  }
  if (mode === "tmux" && agent === "opencode") {
    return "headless: reasoning effort is not supported by opencode in tmux mode and was ignored\n";
  }
  if (agent === "gemini") {
    return `headless: reasoning effort is not supported by ${agent} and was ignored\n`;
  }
  return undefined;
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

function hasDockerOptions(parsed: ParsedArgs): boolean {
  return parsed.dockerImage !== undefined || parsed.dockerArgs.length > 0 || parsed.dockerEnv.length > 0;
}

function shouldStreamRunStatus(parsed: ParsedArgs): boolean {
  return (
    parsed.runId !== undefined &&
    parsed.role === "orchestrator" &&
    !parsed.printCommand &&
    !parsed.json &&
    !parsed.tmux &&
    !parsed.modal
  );
}

function renderConfig(
  agent: AgentName,
  defaults: InvocationDefaults,
  env: Env,
): string {
  const config = getAgentConfig(agent);
  const rows: Array<[string, string | TableCell]> = [
    ["Agent", cell(config.name, "magenta")],
    ["Model", valueCell(defaults.model, "magenta")],
    ["Effort", valueCell(defaults.reasoningEffort, "yellow")],
    ["Config dir", cell(config.configRelDir, "cyan")],
    ["Workspace config dir", cell(config.workspaceConfigRelDir, "cyan")],
    ...config.seedPaths.map((path): [string, TableCell] => ["Seed path", cell(path, "cyan")]),
  ];
  return renderBoxTable({ columns: ["Field", "Value"], rows }, { env });
}

function valueCell(value: string | undefined, color: "magenta" | "yellow"): TableCell {
  return value ? cell(value, color) : cell("-", "dim");
}

function resolveDisplayedDefaults(
  agent: AgentName,
  role: Role | undefined,
  options: InvocationDefaults,
  env: Env,
  config: HeadlessConfig,
): InvocationDefaults {
  const resolved = resolveInvocationDefaults(agent, role, options, env, config);
  const builtin = BUILTIN_AGENT_DEFAULTS[agent];
  const usesBuiltinModel = resolved.model === undefined;
  return {
    model: resolved.model ?? builtin.model,
    reasoningEffort: resolved.reasoningEffort ?? (usesBuiltinModel ? builtin.reasoningEffort : undefined),
  };
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function packageVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new CliError("package version not found");
  }
  return packageJson.version;
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

function usageContext(agent: AgentName, defaults: InvocationDefaults, env: Env): { provider?: string; model?: string } {
  if (agent === "codex") {
    return { provider: "openai", model: defaults.model ?? env.CODEX_MODEL ?? "gpt-5.5" };
  }
  if (agent === "claude") {
    return { provider: "anthropic", model: defaults.model ?? "claude-opus-4-6" };
  }
  if (agent === "gemini") {
    return { provider: "google", model: defaults.model ?? DEFAULT_GEMINI_MODEL };
  }
  if (agent === "pi") {
    return piModelSpec(defaults.model, env);
  }
  if (agent === "opencode") {
    return { provider: "openai", model: defaults.model ?? DEFAULT_OPENCODE_MODEL };
  }
  if (agent === "cursor") {
    return { model: cursorModel(defaults) };
  }
  return { model: defaults.model };
}

async function buildUsageOutput(agent: AgentName, stdout: string, context: { provider?: string; model?: string }): Promise<string> {
  const summary = extractUsageSummary(agent, stdout, context);
  if (summary.pricingStatus === "native") {
    return `${JSON.stringify({ usage: priceUsageSummary(summary, {}) })}\n`;
  }
  try {
    const pricing = await fetchModelsDevPricing();
    return `${JSON.stringify({ usage: priceUsageSummary(summary, pricing) })}\n`;
  } catch {
    return `${JSON.stringify({ usage: priceUsageSummary(summary, {}) })}\n`;
  }
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

interface TmuxAttachCommand {
  sessionName: string;
  command: BuiltCommand;
}

interface TmuxAttachAllCommands {
  sessionNames: string[];
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
  stdoutLog?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface WaitingSpinner {
  clear(): void;
  start(): void;
  stop(): void;
}

const waitingSpinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const waitingSpinnerDotCounts = [0, 1, 2, 3, 2, 1];
const waitingSpinnerDotFrameHold = 2;
const waitingSpinnerVerbs = [
  "token churning",
  "context folding",
  "plan shaping",
  "prompt weaving",
  "attention drifting",
  "logits simmering",
  "context packing",
  "reasoning loops",
  "trace reading",
  "tool scouting",
  "clue chasing",
  "thread finding",
  "state sorting",
  "memory paging",
  "diff sniffing",
  "patch sizing",
  "flops spinning",
  "decoder humming",
  "entropy nudging",
  "answer brewing",
  "signal finding",
  "thought stacking",
  "path tracing",
  "output polishing",
];

function randomWaitingSpinnerVerb(): string {
  return waitingSpinnerVerbs[Math.floor(Math.random() * waitingSpinnerVerbs.length)] ?? waitingSpinnerVerbs[0];
}

function createWaitingSpinner(label: string, write: (text: string) => void): WaitingSpinner {
  const verb = randomWaitingSpinnerVerb();
  let frameIndex = 0;
  let dotIndex = 0;
  let dotFrameIndex = 0;
  let timer: NodeJS.Timeout | undefined;
  let active = false;

  const clear = () => {
    write("\r\u001b[2K");
  };
  const render = () => {
    const frame = waitingSpinnerFrames[frameIndex] ?? waitingSpinnerFrames[0];
    const dots = ".".repeat(waitingSpinnerDotCounts[dotIndex] ?? 1);
    write(`\r\u001b[2K${frame} ${label} ${verb} ${dots}`);
    frameIndex = (frameIndex + 1) % waitingSpinnerFrames.length;
    dotFrameIndex = (dotFrameIndex + 1) % waitingSpinnerDotFrameHold;
    if (dotFrameIndex === 0) {
      dotIndex = (dotIndex + 1) % waitingSpinnerDotCounts.length;
    }
  };

  return {
    clear,
    start() {
      if (active) {
        return;
      }
      active = true;
      render();
      timer = setInterval(render, 120);
    },
    stop() {
      if (!active) {
        return;
      }
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      clear();
    },
  };
}

function spinnerModelLabel(agent: AgentName, defaults: InvocationDefaults, env: Env): string {
  if (agent === "codex") {
    return defaults.model ?? env.CODEX_MODEL ?? "gpt-5.5";
  }
  if (agent === "claude") {
    return defaults.model ?? "claude-opus-4-6";
  }
  if (agent === "cursor") {
    return cursorModel(defaults);
  }
  if (agent === "gemini") {
    return defaults.model ?? DEFAULT_GEMINI_MODEL;
  }
  if (agent === "opencode") {
    return defaults.model ?? DEFAULT_OPENCODE_MODEL;
  }
  if (agent === "pi") {
    return defaults.model ?? env.PI_CODING_AGENT_MODEL ?? DEFAULT_PI_MODEL;
  }
  return defaults.model ?? "default";
}

function paintWaitingSpinnerPart(text: string, colorCode: string, enabled: boolean): string {
  return enabled ? `\u001b[${colorCode}m${text}\u001b[0m` : text;
}

function waitingSpinnerLabel(agent: AgentName, defaults: InvocationDefaults, env: Env, color: boolean): string {
  const model = spinnerModelLabel(agent, defaults, env);
  const reasoning = defaults.reasoningEffort ?? "default";
  return [
    "[",
    paintWaitingSpinnerPart(agent, "36", color),
    "-",
    paintWaitingSpinnerPart(model, "35", color),
    "-",
    paintWaitingSpinnerPart(reasoning, "33", color),
    "]",
  ].join("");
}

function renderPrintCommandJson(
  agent: AgentName,
  defaults: InvocationDefaults,
  env: Env,
  command: BuiltCommand,
): string {
  const usage = usageContext(agent, defaults, env);
  return `${JSON.stringify({
    agent,
    provider: usage.provider,
    model: usage.model,
    reasoningEffort: defaults.reasoningEffort,
    command: quoteCommand(command),
  })}\n`;
}

interface SessionPlan {
  alias: string;
  mode: "new" | "resume";
  nativeId?: string;
}

function validateSessionAlias(alias: string | undefined): string | undefined {
  if (alias === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(alias)) {
    throw new CliError("invalid session name; use letters, numbers, dots, dashes, or underscores");
  }
  return alias;
}

function buildSessionPlan(agent: AgentName, alias: string | undefined, env: Env): SessionPlan | undefined {
  const validAlias = validateSessionAlias(alias);
  if (!validAlias) {
    return undefined;
  }
  if (!sessionStorePath(env)) {
    throw new CliError("HOME is required for --session");
  }
  const stored = readStoredSession(env, agent, validAlias);
  if (stored) {
    return { alias: validAlias, mode: "resume", nativeId: stored.nativeId };
  }
  return {
    alias: validAlias,
    mode: "new",
    nativeId: agent === "claude" ? randomUUID() : undefined,
  };
}

async function prepareSessionPlan(
  agent: AgentName,
  plan: SessionPlan | undefined,
  cwd: string | undefined,
  env: Env,
): Promise<SessionPlan | undefined> {
  if (!plan || plan.mode !== "new" || agent !== "cursor" || plan.nativeId) {
    return plan;
  }
  const command = { command: env.CURSOR_CLI_BIN || "agent", args: ["create-chat"] };
  const result = await captureSimpleCommand(command, cwd, env);
  if (result.code !== 0) {
    throw new CliError(result.stderr.trim() || "could not create Cursor session");
  }
  const nativeId = result.stdout.trim();
  if (!nativeId) {
    throw new CliError("Cursor did not return a session id");
  }
  return { ...plan, nativeId };
}

function applySessionPlan(commandOptions: {
  prompt: string;
  promptFile?: string;
  model?: string;
  allow?: AllowMode;
  reasoningEffort?: ReasoningEffort;
}, plan: SessionPlan | undefined): typeof commandOptions & {
  sessionAlias?: string;
  sessionId?: string;
  sessionMode?: "new" | "resume";
} {
  if (!plan) {
    return commandOptions;
  }
  return {
    ...commandOptions,
    sessionAlias: plan.alias,
    sessionId: plan.nativeId,
    sessionMode: plan.mode,
  };
}

async function persistSessionPlan(
  agent: AgentName,
  plan: SessionPlan | undefined,
  stdout: string,
  cwd: string | undefined,
  env: Env,
): Promise<void> {
  if (!plan) {
    return;
  }
  const nativeId = plan.nativeId || (await discoverNativeSessionId(agent, stdout, cwd, env));
  if (!nativeId) {
    throw new CliError(`could not determine ${agent} session id for --session ${plan.alias}`);
  }
  writeStoredSession(env, {
    agent,
    alias: plan.alias,
    nativeId,
    workDir: cwd ?? process.cwd(),
  });
}

async function discoverNativeSessionId(
  agent: AgentName,
  stdout: string,
  cwd: string | undefined,
  env: Env,
): Promise<string> {
  const fromTrace = extractNativeSessionId(agent, stdout);
  if (fromTrace) {
    return fromTrace;
  }
  if (agent === "gemini") {
    return await newestGeminiSessionId(cwd, env);
  }
  if (agent === "opencode") {
    return await newestOpenCodeSessionId(cwd, env);
  }
  if (agent === "pi") {
    return newestPiSessionFile(cwd, env);
  }
  return "";
}

async function newestGeminiSessionId(cwd: string | undefined, env: Env): Promise<string> {
  const result = await captureSimpleCommand(
    { command: "gemini", args: ["--list-sessions", "--skip-trust"] },
    cwd,
    env,
  );
  if (result.code !== 0) {
    return "";
  }
  const matches = [...result.stdout.matchAll(/\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi)];
  return matches.at(-1)?.[1] ?? "";
}

async function newestOpenCodeSessionId(cwd: string | undefined, env: Env): Promise<string> {
  const result = await captureSimpleCommand(
    { command: "opencode", args: ["session", "list", "--format", "json", "--max-count", "20"] },
    cwd,
    env,
  );
  if (result.code !== 0) {
    return "";
  }
  try {
    const sessions = JSON.parse(result.stdout) as Array<{ id?: unknown; directory?: unknown }>;
    const workspace = cwd ? realpathSync(cwd) : process.cwd();
    const match = sessions.find((session) => session.directory === workspace) ?? sessions[0];
    return typeof match?.id === "string" ? match.id : "";
  } catch {
    return "";
  }
}

function newestPiSessionFile(cwd: string | undefined, env: Env): string {
  const home = env.HOME;
  if (!home) {
    return "";
  }
  const sessionDir = join(home, ".pi", "agent", "sessions", piProjectSessionDir(cwd ?? process.cwd()));
  if (!existsSync(sessionDir)) {
    return "";
  }
  let newestPath = "";
  let newestTime = -1;
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }
    const path = join(sessionDir, entry);
    const stats = statSync(path);
    if (stats.mtimeMs > newestTime) {
      newestTime = stats.mtimeMs;
      newestPath = path;
    }
  }
  return newestPath;
}

function piProjectSessionDir(workspace: string): string {
  return `--${realpathSync(workspace).replace(/^\/+/, "").replace(/[\\/]+/g, "-")}--`;
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
        options.stdoutLog?.(chunk);
        if (options.stdoutHandling !== "capture") {
          options.stdout(chunk);
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        options.stderr?.(chunk);
        const filtered = suppressKnownStderr(agent, chunk);
        if (filtered) {
          stderr(filtered);
        }
      });
      child.on("error", (error) => {
        const message = `${error.message}\n`;
        options.stderr?.(message);
        stderr(message);
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
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15_000;
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
      quoteCommand(buildTmuxAttachCommand(session.name).command),
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

function buildTmuxAttachCommand(sessionName: string): TmuxAttachCommand {
  return {
    sessionName,
    command: { command: "env", args: ["-u", "TMUX", "tmux", "attach-session", "-t", sessionName] },
  };
}

function buildTmuxAttachAllCommands(sessions: HeadlessTmuxSessionDetails[]): TmuxAttachAllCommands {
  const sessionNames = sessions.map((session) => session.name);
  if (sessionNames.length === 0) {
    return { sessionNames, commands: [] };
  }
  if (sessionNames.length === 1) {
    return { sessionNames, commands: [buildTmuxAttachCommand(sessionNames[0] as string).command] };
  }

  const aggregatorName = `headless-attach-${process.pid}`;
  const attachShellCommand = (sessionName: string) =>
    quoteCommand({ command: "env", args: ["-u", "TMUX", "tmux", "attach-session", "-t", sessionName] });
  const [firstSession, ...remainingSessions] = sessionNames as [string, ...string[]];
  return {
    sessionNames,
    commands: [
      { command: "tmux", args: ["new-session", "-d", "-s", aggregatorName, attachShellCommand(firstSession)] },
      ...remainingSessions.map((sessionName) => ({
        command: "tmux",
        args: ["split-window", "-t", aggregatorName, attachShellCommand(sessionName)],
      })),
      { command: "tmux", args: ["select-layout", "-t", aggregatorName, "tiled"] },
      { command: "tmux", args: ["set-hook", "-t", aggregatorName, "client-detached", `kill-session -t ${aggregatorName}`] },
      buildTmuxAttachCommand(aggregatorName).command,
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

function validateHeadlessTmuxSession(sessionName: string | undefined): HeadlessTmuxSession {
  const name = validateHeadlessTmuxSessionName(sessionName);
  return parseHeadlessTmuxSession(name) as HeadlessTmuxSession;
}

function resolveDefaultAttachSessionName(sessions: HeadlessTmuxSessionDetails[]): string {
  if (sessions.length === 0) {
    throw new CliError("No active headless tmux sessions");
  }
  return sessions.reduce((latest, session) =>
    session.lastActivityAt > latest.lastActivityAt ? session : latest,
  ).name;
}

async function listHeadlessTmuxSessions(agent: AgentName | undefined, env: Env): Promise<string> {
  return renderHeadlessTmuxSessions(await listHeadlessTmuxSessionDetails(agent, env));
}

async function listHeadlessTmuxSessionDetails(
  agent: AgentName | undefined,
  env: Env,
): Promise<HeadlessTmuxSessionDetails[]> {
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
      return [];
    }
    throw new CliError(result.stderr.trim() || "could not list tmux sessions");
  }

  const waitingAfterMs = parseWaitingAfterMs(env);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseHeadlessTmuxSessionDetails(line, waitingAfterMs))
    .filter((session): session is HeadlessTmuxSessionDetails => Boolean(session))
    .filter((session) => agent === undefined || session.agent === agent);
}

async function headlessTmuxSessionExists(sessionName: string, env: Env): Promise<boolean> {
  const result = await captureSimpleCommand({ command: "tmux", args: ["has-session", "-t", sessionName] }, undefined, env);
  return result.code === 0;
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

function appendRunInvocationLog(env: Env, runId: string, nodeId: string, label: string): void {
  const header = `\n===== ${label} ${new Date().toISOString()} =====\n`;
  appendNodeLog(env, runId, nodeId, "stdout", header);
  appendNodeLog(env, runId, nodeId, "stderr", header);
}

function runStdoutLogger(
  env: Env,
  runId: string | undefined,
  nodeId: string | undefined,
): ((text: string) => void) | undefined {
  if (!runId || !nodeId) {
    return undefined;
  }
  return (text: string) => appendNodeLog(env, runId, nodeId, "stdout", text);
}

function runStderrLogger(
  env: Env,
  runId: string | undefined,
  nodeId: string | undefined,
): ((text: string) => void) | undefined {
  if (!runId || !nodeId) {
    return undefined;
  }
  return (text: string) => appendNodeLog(env, runId, nodeId, "stderr", text);
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

async function executeInteractiveCommand(
  command: BuiltCommand,
  cwd: string | undefined,
  env: Env,
  stderr: (text: string) => void,
): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd,
      env: commandEnv(env, command) as NodeJS.ProcessEnv,
      stdio: "inherit",
    });

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

async function executeTmuxAttachCommand(
  command: TmuxAttachCommand,
  env: Env,
  stderr: (text: string) => void,
): Promise<number> {
  return await executeInteractiveCommand(command.command, undefined, env, stderr);
}

async function executeTmuxAttachAllCommands(
  commands: TmuxAttachAllCommands,
  env: Env,
  stderr: (text: string) => void,
): Promise<number> {
  const finalCommand = commands.commands.at(-1);
  if (!finalCommand) {
    return 0;
  }
  for (const command of commands.commands.slice(0, -1)) {
    const code = await executeSimpleCommand(command, undefined, env, stderr);
    if (code !== 0) {
      return code;
    }
  }
  return await executeInteractiveCommand(finalCommand, undefined, env, stderr);
}

function effectiveCoordination(parsed: ParsedArgs): CoordinationMode {
  if (parsed.coordination) {
    return parsed.coordination;
  }
  if (parsed.tmux) {
    return "tmux";
  }
  if ((parsed.docker || parsed.modal) && parsed.role) {
    return "oneshot";
  }
  return "session";
}

function withRunEnvironment(command: BuiltCommand, runId: string | undefined, nodeId: string | undefined): BuiltCommand {
  if (!runId && !nodeId) {
    return command;
  }
  return {
    ...command,
    env: {
      ...command.env,
      ...(runId ? { HEADLESS_RUN_ID: runId } : {}),
      ...(nodeId ? { HEADLESS_RUN_NODE: nodeId } : {}),
    },
  };
}

async function executeStoredNode(
  node: {
    agent: AgentName;
    allow?: AllowMode;
    coordination: CoordinationMode;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    runId: string;
    nodeId: string;
    role: Role;
    sessionAlias?: string;
    workDir?: string;
  },
  rawPrompt: string,
  env: Env,
  stderr: (text: string) => void,
  stdout: (text: string) => void,
  stdoutHandling: StdoutHandling,
): Promise<ExecuteResult> {
  const run = readRun(env, node.runId);
  const config = loadHeadlessConfig(env);
  const defaults = resolveInvocationDefaults(
    node.agent,
    node.role,
    { model: node.model, reasoningEffort: node.reasoningEffort, allow: node.allow },
    env,
    config,
  );
  const allow = defaults.allow ?? roleDefaultAllow(node.role);
  const prompt = composeRolePrompt(
    rawPrompt,
    {
      agent: node.agent,
      role: node.role,
      coordination: node.coordination,
      runId: node.runId,
      nodeId: node.nodeId,
      dependsOn: [],
      team: [],
      allow,
      model: defaults.model,
      reasoningEffort: defaults.reasoningEffort,
      workDir: node.workDir,
      sessionAlias: node.sessionAlias,
    },
    run,
    { baseInstructionPrompt: defaults.baseInstructionPrompt },
  );
  const sessionPlan =
    node.coordination === "session" ? await prepareSessionPlan(node.agent, buildSessionPlan(node.agent, node.sessionAlias ?? node.nodeId, env), node.workDir, env) : undefined;
  const command = withRunEnvironment(
    buildAgentCommand(
      node.agent,
      applySessionPlan(
        {
          prompt,
          model: defaults.model,
          allow,
          reasoningEffort: defaults.reasoningEffort,
        },
        sessionPlan,
      ),
      env,
    ),
    node.runId,
    node.nodeId,
  );
  appendRunInvocationLog(env, node.runId, node.nodeId, "run message");
  const result = await executeCommand(node.agent, command, node.workDir, env, stderr, {
    stdout,
    stdoutHandling,
    stdoutLog: runStdoutLogger(env, node.runId, node.nodeId),
    stderr: runStderrLogger(env, node.runId, node.nodeId),
  });
  if (result.code === 0 && sessionPlan) {
    await persistSessionPlan(node.agent, sessionPlan, result.stdout, node.workDir, env);
  }
  return result;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const stderrIsTTY = deps.stderrIsTTY ?? Boolean(process.stderr.isTTY);
  const env: Env = { ...(deps.env ?? process.env) };
  let registeredRunNode: { runId: string; nodeId: string } | undefined;

  if (argv[0] === "acp-stdio") {
    await runAcpStdioAgent();
    return 0;
  }
  if (argv[0] === "acp-client") {
    const separator = argv.indexOf("--", 1);
    const commandParts = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1);
    const command = commandParts[0];
    if (!command) {
      stderr("headless: ACP adapter missing server command\n");
      return 2;
    }
    const prompt = deps.stdin ?? (await readStdin());
    return await runAcpClient({
      agentCommand: { command, args: commandParts.slice(1) },
      prompt,
      env,
      allow: env.HEADLESS_ACP_ALLOW === "read-only" ? "read-only" : undefined,
      stdout,
      stderr,
    });
  }

  try {
    const parsed = parseArgs(argv);
    if (parsed.acpAgent) env.HEADLESS_ACP_AGENT = parsed.acpAgent;
    if (parsed.acpCommand) env.HEADLESS_ACP_COMMAND = parsed.acpCommand;
    if (parsed.acpRegistryFile) env.HEADLESS_ACP_REGISTRY_FILE = parsed.acpRegistryFile;
    if (parsed.acpRegistryUrl) env.HEADLESS_ACP_REGISTRY_URL = parsed.acpRegistryUrl;

    if (parsed.help) {
      stdout(usage());
      return 0;
    }
    if (parsed.version) {
      stdout(`${packageVersion()}\n`);
      return 0;
    }
    if (parsed.runCommand) {
      try {
        return await handleRunCommandImpl(
          {
            command: parsed.runCommand,
            runId: parsed.runCommandRunId,
            nodeId: parsed.runCommandNodeId,
            status: parsed.runCommandStatus,
            async: parsed.runCommandAsync,
            printCommand: parsed.printCommand,
          },
          {
            env,
            stdout,
            stderr,
            resolvePrompt: () => resolvePrompt(parsed, deps, { forceText: true, requireAgent: false }),
            executeNode: (node: RunNode, prompt: string) =>
              executeStoredNode(node, prompt, env, stderr, stdout, "capture"),
            sendTmux: async (sessionName: string, prompt: string, printCommand: boolean) => {
              const tmuxCommands = buildTmuxSendCommands(sessionName, prompt);
              if (printCommand) {
                for (const command of tmuxCommands.commands) {
                  stdout(`${quoteCommand(command)}\n`);
                }
                return 0;
              }
              return await executeTmuxSendCommands(tmuxCommands, env, stderr);
            },
          },
        );
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error));
      }
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
      if (
        parsed.tmux ||
        parsed.sessionAlias !== undefined ||
        parsed.json ||
        parsed.debug ||
        parsed.usage ||
        parsed.list ||
        parsed.check ||
        parsed.showConfig
      ) {
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
    if (parsed.attach) {
      if (parsed.docker) {
        throw new CliError("--docker cannot be used with attach");
      }
      if (parsed.modal) {
        throw new CliError("--modal cannot be used with attach");
      }
      if (parsed.tmux) {
        throw new CliError("--tmux cannot be used with attach");
      }
      if (parsed.json) {
        throw new CliError("--json cannot be used with attach");
      }
      if (parsed.debug) {
        throw new CliError("--debug cannot be used with attach");
      }
      if (parsed.usage) {
        throw new CliError("--usage cannot be used with attach");
      }
      if (parsed.tmuxName !== undefined) {
        throw new CliError("--name cannot be used with attach");
      }
      if (parsed.sessionAlias !== undefined) {
        throw new CliError("--session cannot be used with attach");
      }
      if (parsed.prompt !== undefined) {
        throw new CliError("--prompt cannot be used with attach");
      }
      if (parsed.promptFile !== undefined) {
        throw new CliError("--prompt-file cannot be used with attach");
      }
      if (parsed.model !== undefined) {
        throw new CliError("--model cannot be used with attach");
      }
      if (parsed.reasoningEffort !== undefined) {
        throw new CliError("--reasoning-effort cannot be used with attach");
      }
      if (parsed.allow !== undefined) {
        throw new CliError("--allow cannot be used with attach");
      }
      if (parsed.workDir !== undefined) {
        throw new CliError("--work-dir cannot be used with attach");
      }
      if (parsed.role !== undefined) {
        throw new CliError("--role cannot be used with attach");
      }
      if (parsed.coordination !== undefined) {
        throw new CliError("--coordination cannot be used with attach");
      }
      if (parsed.runId !== undefined) {
        throw new CliError("--run cannot be used with attach");
      }
      if (parsed.nodeId !== undefined) {
        throw new CliError("--node cannot be used with attach");
      }
      if (parsed.dependsOn.length > 0) {
        throw new CliError("--depends-on cannot be used with attach");
      }
      if (parsed.teamSpecs.length > 0) {
        throw new CliError("--team cannot be used with attach");
      }
      if (parsed.check) {
        throw new CliError("--check cannot be used with attach");
      }
      if (parsed.list) {
        throw new CliError("--list cannot be used with attach");
      }
      if (parsed.showConfig) {
        throw new CliError("--show-config cannot be used with attach");
      }
      if (hasDockerOptions(parsed)) {
        throw new CliError("--docker-* options cannot be used with attach");
      }
      if (hasModalOptions(parsed)) {
        throw new CliError("--modal-* options cannot be used with attach");
      }
      if (parsed.attachSession !== undefined && parsed.attachAll) {
        throw new CliError("session name cannot be used with attach --all");
      }

      if (parsed.attachAll) {
        const tmuxCommands = buildTmuxAttachAllCommands(await listHeadlessTmuxSessionDetails(undefined, env));
        if (tmuxCommands.commands.length === 0) {
          throw new CliError("No active headless tmux sessions");
        }
        if (parsed.printCommand) {
          for (const command of tmuxCommands.commands) {
            stdout(`${quoteCommand(command)}\n`);
          }
          return 0;
        }
        return await executeTmuxAttachAllCommands(tmuxCommands, env, stderr);
      }

      const targetSessionName = parsed.attachSession
        ? validateHeadlessTmuxSessionName(parsed.attachSession)
        : resolveDefaultAttachSessionName(await listHeadlessTmuxSessionDetails(undefined, env));
      const tmuxCommand = buildTmuxAttachCommand(targetSessionName);
      if (parsed.printCommand) {
        stdout(`${quoteCommand(tmuxCommand.command)}\n`);
        return 0;
      }
      return await executeTmuxAttachCommand(tmuxCommand, env, stderr);
    }
    if (parsed.attachAll) {
      throw new CliError("--all can only be used with attach");
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
      if (parsed.usage) {
        throw new CliError("--usage cannot be used with rename");
      }
      if (parsed.tmuxName !== undefined) {
        throw new CliError("--name cannot be used with rename");
      }
      if (parsed.sessionAlias !== undefined) {
        throw new CliError("--session cannot be used with rename");
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
      if (parsed.usage) {
        throw new CliError("--usage cannot be used with send");
      }
      if (parsed.tmuxName !== undefined) {
        throw new CliError("--name cannot be used with send");
      }
      if (parsed.sessionAlias !== undefined) {
        throw new CliError("--session cannot be used with send");
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
      if (parsed.sessionAlias !== undefined) {
        throw new CliError("--session cannot be used with --check");
      }
      try {
        stdout(renderAgentChecks(await checkAgents(env)));
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error));
      }
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
      if (parsed.sessionAlias !== undefined) {
        throw new CliError("--session cannot be used with --list");
      }
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
    if (parsed.coordination === "tmux") {
      parsed.tmux = true;
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
    if (parsed.usage && parsed.json) {
      throw new CliError("--usage cannot be used with --json");
    }
    if (parsed.usage && parsed.tmux) {
      throw new CliError("--usage cannot be used with --tmux");
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
    if (parsed.sessionAlias !== undefined && parsed.tmuxName !== undefined) {
      throw new CliError("--session cannot be used with --name");
    }
    if (parsed.sessionAlias !== undefined && parsed.docker) {
      throw new CliError("--session cannot be used with --docker");
    }
    if (parsed.sessionAlias !== undefined && parsed.modal) {
      throw new CliError("--session cannot be used with --modal");
    }
    validateSessionAlias(parsed.sessionAlias);
    const coordination = effectiveCoordination(parsed);
    const nodeId = nodeIdForRole(parsed.role, parsed.nodeId);
    if (parsed.runId !== undefined && parsed.role === undefined) {
      throw new CliError("--run requires --role");
    }
    if (parsed.nodeId !== undefined && parsed.runId === undefined) {
      throw new CliError("--node requires --run");
    }
    if (parsed.dependsOn.length > 0 && parsed.runId === undefined) {
      throw new CliError("--depends-on requires --run");
    }
    if (parsed.teamSpecs.length > 0 && parsed.role !== "orchestrator") {
      throw new CliError("--team requires --role orchestrator");
    }
    if (parsed.showConfig) {
      try {
        const config = loadHeadlessConfig(env);
        const defaults = resolveDisplayedDefaults(
          parsed.agent,
          parsed.role,
          { model: parsed.model, reasoningEffort: parsed.reasoningEffort, allow: parsed.allow },
          env,
          config,
        );
        stdout(renderConfig(parsed.agent, defaults, env));
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error));
      }
      return 0;
    }

    let config: HeadlessConfig;
    let configuredDefaults: InvocationDefaults;
    try {
      config = loadHeadlessConfig(env);
      configuredDefaults = resolveInvocationDefaults(
        parsed.agent,
        parsed.role,
        { model: parsed.model, reasoningEffort: parsed.reasoningEffort, allow: parsed.allow },
        env,
        config,
      );
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
    const cwd = validateWorkDir(parsed.workDir);
    const prompt = await resolvePrompt(parsed, deps, { forceText: parsed.tmux || parsed.role !== undefined || parsed.runId !== undefined });
    const allow = configuredDefaults.allow ?? roleDefaultAllow(parsed.role);
    if (parsed.runId && parsed.role === "orchestrator" && allow === "read-only") {
      throw new CliError("--role orchestrator with --run cannot use --allow read-only; it must be able to launch child nodes and update run state");
    }
    const team = parsed.teamSpecs.length > 0 ? expandTeamSpecs(parsed.agent, parsed.teamSpecs) : [];
    if (!parsed.printCommand && parsed.runId && parsed.role && nodeId) {
      for (const teamNode of team) {
        const teamDefaults = resolveInvocationDefaults(teamNode.agent, teamNode.role, {}, env, config);
        registerNode(env, {
          runId: parsed.runId,
          nodeId: teamNode.nodeId,
          role: teamNode.role,
          agent: teamNode.agent,
          coordination,
          status: "planned",
          planned: true,
          allow: teamDefaults.allow ?? roleDefaultAllow(teamNode.role),
          model: teamDefaults.model,
          reasoningEffort: teamDefaults.reasoningEffort,
          workDir: cwd ?? process.cwd(),
          sessionAlias: teamNode.nodeId,
        });
      }
      registerNode(env, {
        runId: parsed.runId,
        nodeId,
        role: parsed.role,
        agent: parsed.agent,
        coordination,
        status: "starting",
        dependsOn: parsed.dependsOn,
        planned: true,
        allow,
        model: configuredDefaults.model,
        reasoningEffort: configuredDefaults.reasoningEffort,
        workDir: cwd ?? process.cwd(),
        sessionAlias: coordination === "session" ? (parsed.sessionAlias ?? nodeId) : parsed.sessionAlias,
      });
      registeredRunNode = { runId: parsed.runId, nodeId };
    }
    const composedPrompt = composeRolePrompt(
      prompt.prompt,
      {
        agent: parsed.agent,
        role: parsed.role,
        coordination,
        runId: parsed.runId,
        nodeId,
        dependsOn: parsed.dependsOn,
        team,
        allow,
        model: configuredDefaults.model,
        reasoningEffort: configuredDefaults.reasoningEffort,
        workDir: cwd ?? process.cwd(),
        sessionAlias: coordination === "session" ? (parsed.sessionAlias ?? nodeId) : parsed.sessionAlias,
      },
      parsed.runId ? readRun(env, parsed.runId) : undefined,
      { baseInstructionPrompt: configuredDefaults.baseInstructionPrompt },
    );

    if (parsed.tmux) {
      const sessionName = parsed.sessionAlias
        ? buildHeadlessTmuxSessionName(parsed.agent, parsed.sessionAlias)
        : undefined;
      if (sessionName && (await headlessTmuxSessionExists(sessionName, env))) {
        const tmuxCommands = buildTmuxSendCommands(sessionName, composedPrompt);
        if (parsed.printCommand) {
          for (const command of tmuxCommands.commands) {
            stdout(`${quoteCommand(command)}\n`);
          }
          return 0;
        }
        const code = await executeTmuxSendCommands(tmuxCommands, env, stderr);
        if (parsed.runId && parsed.role && nodeId) {
          if (code === 0) {
            registerNode(env, {
              runId: parsed.runId,
              nodeId,
              role: parsed.role,
              agent: parsed.agent,
              coordination,
              status: "busy",
              dependsOn: parsed.dependsOn,
              planned: true,
              allow,
              model: configuredDefaults.model,
              reasoningEffort: configuredDefaults.reasoningEffort,
              workDir: cwd ?? process.cwd(),
              sessionAlias: parsed.sessionAlias ?? nodeId,
              tmuxSessionName: sessionName,
            });
          } else {
            updateNodeStatus(env, parsed.runId, nodeId, "failed", `tmux command exited with code ${code}`);
          }
        }
        if (code === 0) {
          stdout(`sent: ${tmuxCommands.sessionName}\n`);
        }
        return code;
      }
      const tmuxCommand = buildInteractiveAgentCommand(
        parsed.agent,
        {
          prompt: composedPrompt,
          model: configuredDefaults.model,
          allow,
          reasoningEffort: configuredDefaults.reasoningEffort,
        },
        env,
      );
      const reasoningWarning = unsupportedReasoningEffortWarning(parsed.agent, configuredDefaults.reasoningEffort, "tmux");
      if (reasoningWarning) {
        stderr(reasoningWarning);
      }
      const tmuxCommands = buildTmuxCommands(
        parsed.agent,
        tmuxCommand,
        composedPrompt,
        cwd,
        env,
        parsed.sessionAlias ?? parsed.tmuxName,
      );
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
      if (parsed.runId && parsed.role && nodeId) {
        if (code === 0) {
          registerNode(env, {
            runId: parsed.runId,
            nodeId,
            role: parsed.role,
            agent: parsed.agent,
            coordination,
            status: "busy",
            dependsOn: parsed.dependsOn,
            planned: true,
            allow,
            model: configuredDefaults.model,
            reasoningEffort: configuredDefaults.reasoningEffort,
            workDir: cwd ?? process.cwd(),
            sessionAlias: parsed.sessionAlias ?? parsed.tmuxName ?? nodeId,
            tmuxSessionName: tmuxCommands.sessionName,
          });
        } else {
          updateNodeStatus(env, parsed.runId, nodeId, "failed", `tmux command exited with code ${code}`);
        }
      }
      if (code === 0) {
        stdout(`tmux session: ${tmuxCommands.sessionName}\n`);
        stdout(`attach: ${quoteCommand(buildTmuxAttachCommand(tmuxCommands.sessionName).command)}\n`);
      }
      return code;
    }

    let sessionPlan = buildSessionPlan(parsed.agent, parsed.sessionAlias, env);
    if (parsed.runId && parsed.role && coordination === "session" && !parsed.sessionAlias) {
      sessionPlan = buildSessionPlan(parsed.agent, nodeId, env);
    }
    if (parsed.runId && parsed.role && coordination === "oneshot") {
      sessionPlan = undefined;
    }
    if (!parsed.printCommand) {
      sessionPlan = await prepareSessionPlan(parsed.agent, sessionPlan, cwd, env);
    }
    let command = withRunEnvironment(buildAgentCommand(
      parsed.agent,
      applySessionPlan({
        prompt: composedPrompt,
        promptFile: parsed.role || parsed.runId ? undefined : prompt.promptFile,
        model: configuredDefaults.model,
        allow,
        reasoningEffort: configuredDefaults.reasoningEffort,
      }, sessionPlan),
      env,
    ), parsed.runId, nodeId);
    const reasoningWarning = unsupportedReasoningEffortWarning(parsed.agent, configuredDefaults.reasoningEffort, "headless");
    if (reasoningWarning) {
      stderr(reasoningWarning);
    }
    if (parsed.docker) {
      command = buildDockerAgentCommand({
        agent: parsed.agent,
        command,
        dockerArgs: parsed.dockerArgs,
        dockerEnv: parsed.dockerEnv,
        env,
        hostUser: detectDockerHostUser(),
        image: parsed.dockerImage ?? DEFAULT_DOCKER_IMAGE,
        runDirHost: parsed.runId ? runDirectory(env, parsed.runId) : undefined,
        runId: parsed.runId,
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
      stdout(parsed.json ? renderPrintCommandJson(parsed.agent, configuredDefaults, env, printableCommand) : `${quoteCommand(printableCommand)}\n`);
      return 0;
    }
    if (parsed.docker && !commandExists("docker", env)) {
      throw new CliError("docker not found on PATH");
    }

    const stdoutHandling: StdoutHandling = parsed.json
      ? parsed.sessionAlias || parsed.runId
        ? "capture-and-stream"
        : "stream"
      : parsed.debug
        ? "capture-and-stream"
        : "capture";
    if (parsed.runId && parsed.role && nodeId) {
      appendRunInvocationLog(env, parsed.runId, nodeId, "node invocation");
    }
    const statusReporter = shouldStreamRunStatus(parsed) && parsed.runId
      ? createRunStatusReporter({
          env,
          intervalMs: parseRunStatusIntervalMs(env.HEADLESS_RUN_STATUS_INTERVAL_MS),
          runId: parsed.runId,
          write: stderr,
        })
      : undefined;
    const waitingSpinner =
      stdoutHandling === "capture" && stderrIsTTY && !statusReporter
        ? createWaitingSpinner(waitingSpinnerLabel(parsed.agent, configuredDefaults, env, env.NO_COLOR === undefined), stderr)
        : undefined;
    const displayStderr = (text: string) => {
      waitingSpinner?.clear();
      stderr(text);
    };
    statusReporter?.start();
    waitingSpinner?.start();
    let result: ExecuteResult | undefined;
    try {
      if (parsed.runId && parsed.role && nodeId) {
        updateNodeStatus(env, parsed.runId, nodeId, "busy");
      }
      const commandStdoutLog = runStdoutLogger(env, parsed.runId, nodeId);
      const commandStderr = runStderrLogger(env, parsed.runId, nodeId);
      result = parsed.modal
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
              commandStderr?.(text);
              const filtered = suppressKnownStderr(parsed.agent as AgentName, text);
              if (filtered) {
                displayStderr(filtered);
              }
            },
            stdout: (text) => {
              commandStdoutLog?.(text);
              stdout(text);
            },
            stdoutHandling,
            timeoutSeconds: parsed.modalTimeoutSeconds ?? DEFAULT_MODAL_TIMEOUT_SECONDS,
            workDir: cwd ?? process.cwd(),
          })
        : await executeCommand(parsed.agent, command, cwd, env, displayStderr, {
            stdout,
            stdoutHandling,
            stdoutLog: commandStdoutLog,
            stderr: commandStderr,
          });
      if (parsed.modal && parsed.runId && nodeId && stdoutHandling === "capture") {
        appendNodeLog(env, parsed.runId, nodeId, "stdout", result.stdout);
      }
      if (parsed.runId && parsed.role && nodeId) {
        const finalMessage = extractFinalMessage(parsed.agent, result.stdout);
        const metrics = extractRunNodeMetrics(parsed.agent, result.stdout, usageContext(parsed.agent, configuredDefaults, env));
        updateNodeStatus(env, parsed.runId, nodeId, result.code === 0 ? "idle" : "failed", finalMessage || undefined, metrics);
        if (result.code === 0 && parsed.role === "orchestrator" && finalMessage) {
          completeIdleRunNodes(env, parsed.runId, nodeId, finalMessage);
        }
      }
    } finally {
      waitingSpinner?.stop();
      statusReporter?.stop();
    }
    if (!result) {
      throw new CliError("agent execution did not produce a result");
    }
    if (result.code === 0 && sessionPlan) {
      await persistSessionPlan(parsed.agent, sessionPlan, result.stdout, cwd, env);
    }
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
      if (parsed.usage) {
        stdout(await buildUsageOutput(parsed.agent, result.stdout, usageContext(parsed.agent, configuredDefaults, env)));
      }
      return result.code;
    }
    const agentError = extractAgentError(parsed.agent, result.stdout);
    if (agentError) {
      stderr(`headless: ${agentError}\n`);
      return result.code === 0 ? 1 : result.code;
    }
    if (result.code === 0) {
      stderr("headless: could not extract final message; rerun with --json for raw trace\n");
      return 1;
    }
    return result.code;
  } catch (error) {
    if (registeredRunNode) {
      try {
        updateNodeStatus(
          env,
          registeredRunNode.runId,
          registeredRunNode.nodeId,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      } catch {
        // Preserve the original CLI error.
      }
    }
    if (error instanceof CliError || error instanceof Error) {
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
