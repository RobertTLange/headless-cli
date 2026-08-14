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
  buildInteractiveOpencodeRun,
  buildInteractiveAgentCommand,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENCODE_MODEL,
  DEFAULT_PI_MODEL,
  claudeModel,
  cursorModel,
  piModelSpec,
  getAgentConfig,
  getAgentHarness,
  isAgentName,
  listAgents,
  waitTierForAgent,
} from "./agents.js";
import { prepareAntigravityUsageCapture, type AntigravityUsageCapture } from "./antigravity-usage.js";
import { checkAgents, checkDocker, commandExists, commandForAgent, renderAgentChecks, renderDockerCheck } from "./check.js";
import {
  BUILTIN_AGENT_DEFAULTS,
  loadHeadlessConfig,
  resolveInvocationDefaults,
  type GeneralDefaults,
  type HeadlessConfig,
  type InvocationDefaults,
} from "./config.js";
import { validateCodexProfileName } from "./codex-profile.js";
import {
  buildDockerAgentCommand,
  DEFAULT_DOCKER_IMAGE,
  dockerSessionAgentHomeEnvNames,
  dockerSessionNativeId,
  dockerSessionHomePath,
  LOCAL_DOCKER_IMAGE,
  detectDockerHostUser,
  ensureDockerSessionHome,
  ensureDockerSessionProfileDirectory,
  ensureDockerSessionStoreDirectory,
  readDockerCursorSessionId,
  validateDockerSessionRootWorkDir,
  validateDockerWorkDir,
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
  isAntigravityStructuredOutput,
  priceUsageSummary,
  type UsageContext,
} from "./output.js";
import {
  deriveNativeTranscriptActivity,
  indexNativeAssistantCompletion,
  nativeTranscriptIncludesText,
  nativeTranscriptKey,
  resolveLatestNativeTranscript,
  resolveLatestNativeTranscripts,
  resolveNativeTranscript,
  resolveOpencodeTranscriptByTitle,
  resolvePiTranscriptInDir,
} from "./native-transcripts.js";
import {
  acquireDockerSessionLock,
  acquireLaunchLock,
  isDockerSessionLockSignalListener,
} from "./launch-lock.js";
import { forceKillWindowsProcessTree } from "./process-tree.js";
import { compactOversizedTraceLine } from "./relevant-trace.js";
import { handleRunCommand as handleRunCommandImpl } from "./run-commands.js";
import { handleCronCommand as handleCronCommandImpl, type CronCommand } from "./cron-commands.js";
import { runCronDaemon } from "./cron.js";
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
import {
  readStoredSession,
  SECURE_SESSION_STORE_ENV,
  sessionStorePath,
  writeStoredSession,
  writeStoredTmuxSession,
  type StoredTmuxWaitStrategy,
} from "./sessions.js";
import { quoteCommand } from "./shell.js";
import {
  SDK_PROTOCOL_VERSION,
  SdkTraceWriter,
  renderSdkError,
  renderSdkResult,
  type SdkFormat,
} from "./sdk.js";
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
import type { AgentName, AllowMode, BuildOptions, BuiltCommand, Env, ReasoningEffort } from "./types.js";

interface ParsedArgs {
  capabilities: boolean;
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
  cronCommand?: CronCommand;
  cronJobId?: string;
  cronEvery?: string;
  cronSchedule?: string;
  cronForce: boolean;
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
  profile?: string;
  fast?: boolean;
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
  timeoutSeconds?: number;
  json: boolean;
  sdkFormat?: SdkFormat;
  debug: boolean;
  usage: boolean;
  wait: boolean;
  delete: boolean;
  printCommand: boolean;
  showConfig: boolean;
  check: boolean;
  list: boolean;
  tmux: boolean;
  help: boolean;
  version: boolean;
}

interface DisplayedConfig {
  agent: AgentName;
  allow: AllowMode | null;
  configDir: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  seedPaths: string[];
  workspaceConfigDir: string;
}

const sdkCaptureLimitBytes = 4 * 1024 * 1024;

interface CliDeps {
  env?: Env;
  stdin?: string;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly sdkMessage = message,
  ) {
    super(message);
    this.name = "CliError";
  }
}

function toCliError(error: unknown): CliError {
  return error instanceof CliError
    ? error
    : new CliError(
        errorMessage(error),
        "headless command failed",
      );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    "       headless cron <add|list|view|pause|resume|kill|rm|start|stop> [args] [options]",
    "       headless capabilities [--sdk-format json]",
    "",
    "Headless gives coding-agent CLIs one shared interface for prompts, models, reasoning effort, output modes, sessions, and work directories.",
    "It runs supported agents locally, in tmux, in Docker, or in Modal while preserving each backend's native execution behavior.",
    "Use it to launch one-off tasks, resume named sessions, or coordinate multi-agent runs from scripts and terminals.",
    "",
    `Agents: ${listAgents().join(", ")}`,
    "",
    "Options:",
    "  --model <name>        Agent model override.",
    "  --profile <name>      Codex configuration profile.",
    "  --fast                Enable Fast mode for Codex or Claude.",
    "  --no-fast             Disable ambient Fast mode for Codex or Claude.",
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
    "  --docker             Run the agent inside Docker; use --session for durable turns.",
    "  --docker-image <img> Docker image. Defaults to ghcr.io/roberttlange/headless:latest.",
    "  --docker-arg <arg>   Extra docker run argument. Repeat for multiple args.",
    "  --docker-env <env>   Pass env into Docker as NAME or NAME=value. Repeatable.",
    "  --modal              Run the agent in a Modal CPU sandbox.",
    `  --modal-image <img>  Modal sandbox image. Defaults to ${DEFAULT_MODAL_IMAGE}.`,
    "  --modal-image-secret <nm> Modal Secret for private registry image pulls.",
    "  --modal-app <name>   Modal app name. Defaults to headless-cli.",
    "  --modal-cpu <n>      Modal CPU reservation. Defaults to 2.",
    "  --modal-memory <mb>  Modal memory reservation in MiB. Defaults to 4096.",
    "  --modal-timeout <s>  Modal sandbox and command timeout. Defaults to 3600.",
    "  --modal-secret <nm>  Inject a named Modal Secret. Repeatable.",
    "  --modal-env <env>    Pass env into Modal as NAME or NAME=value. Repeatable.",
    "  --modal-include-git Include .git metadata in Modal uploads.",
    "  --timeout <s>        One-shot command timeout in seconds.",
    "  --json               Stream raw agent JSON trace output.",
    "  --sdk-format <fmt>   Versioned SDK output: json or ndjson.",
    "  --debug              Stream raw trace and print extracted final message.",
    "  --usage              Append normalized token and API-equivalent cost JSON.",
    "  --tmux               Launch an interactive agent in a tmux session.",
    "  --wait               With --tmux, wait for native transcript completion and print the final message.",
    "  --delete             With --tmux --wait, kill the tmux session after completion.",
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
    "  cron add <agent>    Schedule a detached one-shot agent invocation.",
    "  cron list           List scheduled cron jobs.",
    "  cron view <job>     Show job config, daemon state, and recent executions.",
    "  cron pause|resume <job> Pause or resume a scheduled job.",
    "  cron kill <job>     Kill the active execution and disable the job.",
    "  cron rm <job> [--force] Remove a job and execution history.",
    "  cron start|stop     Start or stop the per-user cron daemon.",
    "  docker doctor       Check Docker setup and image availability.",
    "  docker build        Build the local Docker image tag headless-local:dev.",
    "  --check              Check agents, versions, auth, configured models/effort, and Docker.",
    "  --list               List active headless tmux sessions.",
    "  --print-command      Print the command without executing it. Combine with --json for identity metadata.",
    "  --show-config        Print harness config paths and auth seed paths.",
    "  capabilities         Print the machine-protocol capabilities.",
    "  -v, --version        Print the Headless CLI version.",
    "  -h, --help           Show this help.",
    "",
    "If neither --prompt nor --prompt-file is provided, stdin is used when piped.",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    capabilities: false,
    attach: false,
    attachAll: false,
    send: false,
    rename: false,
    runCommandAsync: false,
    cronForce: false,
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
    wait: false,
    delete: false,
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
    if (args[0] !== "--sdk-format") {
      return parsed;
    }
  }
  if (first === undefined) {
    parsed.help = true;
    return parsed;
  }
  if (first === "-v" || first === "--version") {
    // Continue so versioned SDK output can be requested after --version.
  } else if (first === "attach") {
    parsed.attach = true;
  } else if (first === "send") {
    parsed.send = true;
  } else if (first === "rename") {
    parsed.rename = true;
  } else if (first === "run") {
    parsed.runCommand = parseRunCommand(args.shift());
  } else if (first === "cron") {
    parsed.cronCommand = parseCronCommand(args.shift());
  } else if (first === "docker") {
    parsed.dockerCommand = parseDockerCommand(args.shift());
  } else if (first === "capabilities") {
    parsed.capabilities = true;
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
      case "--every":
        parsed.cronEvery = takeValue(args, arg);
        break;
      case "--schedule":
        parsed.cronSchedule = takeValue(args, arg);
        break;
      case "--model":
      case "--agent-model":
        parsed.model = takeValue(args, arg);
        break;
      case "--profile":
        parsed.profile = parseProfile(takeValue(args, arg));
        break;
      case "--fast":
        if (parsed.fast === false) throw new CliError("--fast and --no-fast are mutually exclusive");
        parsed.fast = true;
        break;
      case "--no-fast":
        if (parsed.fast === true) throw new CliError("--fast and --no-fast are mutually exclusive");
        parsed.fast = false;
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
      case "--timeout":
        parsed.timeoutSeconds = parsePositiveInteger(takeValue(args, arg), arg);
        break;
      case "--name":
        if (parsed.cronCommand) {
          parsed.cronJobId = validateSafeName(takeValue(args, arg), "cron job");
        } else {
          parsed.tmuxName = takeValue(args, arg);
        }
        break;
      case "--session":
        parsed.sessionAlias = takeValue(args, arg);
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--sdk-format":
        parsed.sdkFormat = parseSdkFormat(takeValue(args, arg));
        break;
      case "--debug":
        parsed.debug = true;
        break;
      case "--usage":
        parsed.usage = true;
        break;
      case "--wait":
        parsed.wait = true;
        break;
      case "--delete":
        parsed.delete = true;
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
      case "--force":
        parsed.cronForce = true;
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
        if (parsed.cronCommand && arg && !arg.startsWith("-")) {
          if (parsed.cronCommand === "add" && parsed.agent === undefined && isAgentName(arg)) {
            parsed.agent = arg;
            break;
          }
          if (parsed.cronCommand !== "add" && parsed.cronJobId === undefined) {
            parsed.cronJobId = validateSafeName(arg, "cron job");
            break;
          }
        }
        throw new CliError(`unknown argument: ${arg ?? ""}`);
    }
  }

  return parsed;
}

function parseCronCommand(value: string | undefined): CronCommand {
  if (
    value === "add" ||
    value === "list" ||
    value === "view" ||
    value === "pause" ||
    value === "resume" ||
    value === "kill" ||
    value === "rm" ||
    value === "start" ||
    value === "stop"
  ) {
    return value;
  }
  throw new CliError("missing cron command; use cron add, list, view, pause, resume, kill, rm, start, or stop");
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

function parseProfile(value: string): string {
  try {
    return validateCodexProfileName(value);
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}

function parseSdkFormat(value: string): SdkFormat {
  if (value === "json" || value === "ndjson") {
    return value;
  }
  throw new CliError(`unsupported SDK format: ${value}`);
}

function requestsSdkOutput(argv: string[]): boolean {
  const valueOptions = new Set([
    "--prompt",
    "-p",
    "--prompt-file",
    "--every",
    "--schedule",
    "--model",
    "--agent-model",
    "--profile",
    "--reasoning-effort",
    "--effort",
    "--allow",
    "--acp-agent",
    "--acp-command",
    "--acp-registry",
    "--acp-registry-file",
    "--role",
    "--coordination",
    "--run",
    "--node",
    "--depends-on",
    "--team",
    "--work-dir",
    "-C",
    "--docker-image",
    "--docker-arg",
    "--docker-env",
    "--modal-app",
    "--modal-cpu",
    "--modal-env",
    "--modal-image",
    "--modal-image-secret",
    "--modal-memory",
    "--modal-secret",
    "--modal-timeout",
    "--timeout",
    "--name",
    "--session",
    "--status",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") {
      break;
    }
    if (valueOptions.has(argv[index] ?? "")) {
      index += 1;
      continue;
    }
    if (argv[index] === "--sdk-format") {
      return true;
    }
  }
  return false;
}

function sdkCommandFor(parsed: ParsedArgs): string {
  if (parsed.version) return "version";
  if (parsed.capabilities) return "capabilities";
  if (parsed.check) return "check";
  if (parsed.list) return "sessions.list";
  if (parsed.showConfig) return "config.show";
  if (parsed.runCommand) return `runs.${parsed.runCommand}`;
  if (parsed.cronCommand) return `cron.${parsed.cronCommand}`;
  if (parsed.dockerCommand) return `docker.${parsed.dockerCommand}`;
  if (parsed.attach) return "sessions.attach";
  if (parsed.send) return "sessions.send";
  if (parsed.rename) return "sessions.rename";
  return "invoke";
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
    throw new CliError(`invalid ${label} env: ${value}`, `invalid ${label} env`);
  }
  return value;
}

function parseModalSecret(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new CliError(`invalid modal secret: ${value}`, "invalid modal secret");
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
  if (agent === "gemini" || agent === "antigravity") {
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
  const config = displayedConfig(agent, defaults);
  const rows: Array<[string, string | TableCell]> = [
    ["Agent", cell(config.agent, "magenta")],
    ["Model", valueCell(config.model ?? undefined, "magenta")],
    ["Effort", valueCell(config.reasoningEffort ?? undefined, "yellow")],
    ["Config dir", cell(config.configDir, "cyan")],
    ["Workspace config dir", cell(config.workspaceConfigDir, "cyan")],
    ...config.seedPaths.map((path): [string, TableCell] => ["Seed path", cell(path, "cyan")]),
  ];
  return renderBoxTable({ columns: ["Field", "Value"], rows }, { env });
}

function displayedConfig(agent: AgentName, defaults: InvocationDefaults): DisplayedConfig {
  const config = getAgentConfig(agent);
  return {
    agent,
    model: defaults.model ?? null,
    reasoningEffort: defaults.reasoningEffort ?? null,
    allow: defaults.allow ?? null,
    configDir: config.configRelDir,
    workspaceConfigDir: config.workspaceConfigRelDir,
    seedPaths: config.seedPaths,
  };
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
    allow: resolved.allow,
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

function sdkCapabilities(): Record<string, unknown> {
  return {
    cliVersion: packageVersion(),
    protocolVersion: SDK_PROTOCOL_VERSION,
    sdkFormats: ["json", "ndjson"],
    agents: listAgents(),
    commands: [
      "invoke",
      "capabilities",
      "sessions.list",
      "runs.list",
      "runs.view",
      "cron.list",
      "cron.view",
      "check",
      "config.show",
      "version",
    ],
  };
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
      throw new CliError(`prompt file not found: ${parsed.promptFile}`, "prompt file not found");
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
    throw new CliError(`work dir not found: ${workDir}`, "work dir not found");
  }
  return workDir;
}

const autoAgentPreference: AgentName[] = ["codex", "claude", "pi", "opencode", "gemini", "antigravity", "cursor"];

function selectDefaultAgent(env: Env, preferredAgent: AgentName | undefined): AgentName {
  if (preferredAgent && commandExists(commandForAgent(preferredAgent, env), env)) {
    return preferredAgent;
  }
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
  finalMessageTrace?: string;
  usageTrace?: string;
  stdoutReceived?: boolean;
  stdoutEndsWithNewline?: boolean;
}

function commandEnv(baseEnv: Env, command: BuiltCommand): Env {
  if (!command.env) return baseEnv;
  const merged = { ...baseEnv };
  for (const [key, value] of Object.entries(command.env)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function usageContext(
  agent: AgentName,
  defaults: InvocationDefaults,
  env: Env,
  profile?: string,
): UsageContext {
  if (agent === "codex") {
    const model = defaults.model ?? env.CODEX_MODEL;
    return profile
      ? { model, useDefaultProvider: false }
      : { provider: "openai", model: model ?? "gpt-5.5" };
  }
  if (agent === "claude") {
    return { provider: "anthropic", model: claudeModel(defaults.model ?? "claude-opus-4-6") };
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

async function buildUsageOutput(agent: AgentName, stdout: string, context: UsageContext): Promise<string> {
  return `${JSON.stringify({ usage: await buildUsageReport(agent, stdout, context) })}\n`;
}

async function buildUsageReport(
  agent: AgentName,
  stdout: string,
  context: UsageContext,
): Promise<ReturnType<typeof priceUsageSummary>> {
  const summary = extractUsageSummary(agent, stdout, context);
  if (summary.usageStatus === "missing" || summary.pricingStatus === "native") {
    return priceUsageSummary(summary, {});
  }
  try {
    const pricing = await fetchModelsDevPricing();
    return priceUsageSummary(summary, pricing);
  } catch {
    return priceUsageSummary(summary, {});
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

// How the wait loop locates this run's transcript. Every tier resolves a single
// transcript without reading the injected marker, except the explicit "marker"
// fallback (kept for the env escape hatch and unidentifiable existing sessions).
type WaitResolveStrategy =
  | { kind: "pin"; sessionId: string } // claude/gemini --session-id, cursor minted id, resumed stored id
  | { kind: "title"; title: string } // opencode --title
  | { kind: "dir"; sessionDir: string } // pi --session-dir
  | { kind: "claim"; claimed?: string } // codex: brand-new transcript not in the pre-launch baseline
  | { kind: "marker"; marker: string }; // last-resort prompt-marker scan

interface TmuxWaitSnapshot {
  startedAt: string;
  // Byte sizes of transcripts that existed before launch, so a resumed session's
  // stale bytes are skipped and a brand-new transcript is recognised.
  transcripts: Map<string, number | undefined>;
  strategy: WaitResolveStrategy;
}

interface HeadlessTmuxSession {
  name: string;
  agent: AgentName;
}

type HeadlessTmuxSessionState = "running" | "waiting" | "idle" | "dead";

interface HeadlessTmuxSessionDetails extends HeadlessTmuxSession {
  state: HeadlessTmuxSessionState;
  createdAt: string;
  lastActivityAt: string;
}

interface ParsedHeadlessTmuxSessionDetails extends HeadlessTmuxSession {
  paneDead: string;
  createdSeconds: number;
  activitySeconds: number;
  workDir?: string;
}

type StdoutHandling = "capture" | "stream" | "capture-and-stream";

interface ExecuteCommandOptions {
  stdoutHandling: StdoutHandling;
  stdout: (text: string) => unknown;
  waitForStdoutDrain?: (signal: AbortSignal) => Promise<void>;
  stdoutLog?: (text: string) => void;
  stderr?: (text: string) => void;
  timeoutSeconds?: number;
  captureFinalMessageTrace?: boolean;
  captureRelevantTrace?: boolean;
  maxFinalMessageTraceBytes?: number;
  cleanupBeforeParentSignalExit?: () => void;
  inheritedSignalListeners?: ReadonlyMap<NodeJS.Signals, ReadonlySet<NodeJS.SignalsListener>>;
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

function parentExitSignals(): NodeJS.Signals[] {
  return process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];
}

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

function spinnerModelLabel(agent: AgentName, defaults: InvocationDefaults, env: Env, profile?: string): string {
  if (agent === "codex") {
    return defaults.model ?? env.CODEX_MODEL ?? profile ?? "gpt-5.5";
  }
  if (agent === "claude") {
    return claudeModel(defaults.model ?? "claude-opus-4-6") ?? "claude-opus-4-6";
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

function waitingSpinnerLabel(
  agent: AgentName,
  defaults: InvocationDefaults,
  env: Env,
  color: boolean,
  profile?: string,
): string {
  const model = spinnerModelLabel(agent, defaults, env, profile);
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
  profile?: string,
): string {
  const usage = usageContext(agent, defaults, env, profile);
  return `${JSON.stringify({
    agent,
    provider: usage.provider,
    model: usage.model,
    reasoningEffort: defaults.reasoningEffort,
    profile,
    command: quoteCommand(command),
  })}\n`;
}

interface SessionPlan {
  alias: string;
  mode: "new" | "resume";
  nativeId?: string;
  profile?: string;
  startedAt?: string;
}

type SessionExecution = "docker" | "local";

function validateSessionAlias(alias: string | undefined): string | undefined {
  if (alias === undefined) {
    return undefined;
  }
  if (alias === "." || alias === ".." || !/^[A-Za-z0-9_.-]+$/.test(alias)) {
    throw new CliError("invalid session name; use letters, numbers, dots, dashes, or underscores");
  }
  return alias;
}

function buildSessionPlan(
  agent: AgentName,
  alias: string | undefined,
  env: Env,
  profile?: string,
): SessionPlan | undefined {
  const validAlias = validateSessionAlias(alias);
  if (!validAlias) {
    return undefined;
  }
  if (!sessionStorePath(env)) {
    throw new CliError("HOME is required for --session");
  }
  const stored = readStoredSession(env, agent, validAlias);
  if (stored?.nativeId) {
    return { alias: validAlias, mode: "resume", nativeId: stored.nativeId, profile: profile ?? stored.profile };
  }
  return {
    alias: validAlias,
    mode: "new",
    nativeId: agent === "claude" ? randomUUID() : undefined,
    profile: profile ?? stored?.profile,
  };
}

async function prepareSessionPlan(
  agent: AgentName,
  plan: SessionPlan | undefined,
  cwd: string | undefined,
  env: Env,
  execution: SessionExecution,
): Promise<SessionPlan | undefined> {
  if (!plan || plan.mode !== "new") {
    return plan;
  }
  if (agent === "cursor" && !plan.nativeId && execution === "local") {
    return { ...plan, nativeId: await mintCursorSessionId(cwd, env) };
  }
  if (agent === "antigravity" && !plan.nativeId) {
    return { ...plan, startedAt: new Date().toISOString() };
  }
  return plan;
}

function applySessionPlan(commandOptions: {
  prompt: string;
  promptFile?: string;
  workDir?: string;
  model?: string;
  profile?: string;
  allow?: AllowMode;
  fast?: boolean;
  reasoningEffort?: ReasoningEffort;
  timeoutSeconds?: number;
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
    profile: plan.profile,
  };
}

async function persistSessionPlan(
  agent: AgentName,
  plan: SessionPlan | undefined,
  stdout: string,
  cwd: string | undefined,
  env: Env,
  dockerSessionHome?: string,
  capturedNativeId?: string,
): Promise<void> {
  if (!plan) {
    return;
  }
  const discoveryEnv = dockerSessionHome ? dockerSessionDiscoveryEnv(agent, env, dockerSessionHome) : env;
  const nativeId =
    plan.nativeId ||
    capturedNativeId ||
    (await discoverNativeSessionId(agent, stdout, cwd, discoveryEnv, plan.startedAt, Boolean(dockerSessionHome)));
  if (!nativeId) {
    throw new CliError(`could not determine ${agent} session id for --session ${plan.alias}`);
  }
  if (dockerSessionHome) {
    ensureDockerSessionStoreDirectory(dockerSessionHome);
  }
  writeStoredSession(env, {
    agent,
    alias: plan.alias,
    nativeId,
    profile: plan.profile,
    workDir: cwd ?? process.cwd(),
  });
}

function dockerSessionDiscoveryEnv(agent: AgentName, env: Env, dockerSessionHome: string): Env {
  const discoveryEnv: Env = { ...env, HOME: dockerSessionHome };
  for (const name of dockerSessionAgentHomeEnvNames(agent)) {
    delete discoveryEnv[name];
  }
  return discoveryEnv;
}

function validateDockerSessionEnv(agent: AgentName, dockerEnv: string[]): void {
  const agentHomeVariables = new Set<string>(dockerSessionAgentHomeEnvNames(agent));
  const override = dockerEnv.find((item) => agentHomeVariables.has(item.split("=", 1)[0] ?? ""));
  if (override) {
    const name = override.split("=", 1)[0];
    throw new CliError(`${name} cannot be overridden with --docker-env when using --docker --session`);
  }
}

async function discoverNativeSessionId(
  agent: AgentName,
  stdout: string,
  cwd: string | undefined,
  env: Env,
  startedAt?: string,
  dockerSession: boolean = false,
): Promise<string> {
  const fromTrace = extractNativeSessionId(agent, stdout);
  if (fromTrace) {
    return fromTrace;
  }
  if (agent === "gemini") {
    if (dockerSession) {
      return resolveLatestNativeTranscript(
        "gemini",
        cwd,
        env,
        startedAt ? { startedAt } : {},
        { dockerSessionRoot: env.HOME },
      )?.sessionId ?? "";
    }
    return await newestGeminiSessionId(cwd, env);
  }
  if (agent === "antigravity") {
    return newestAntigravitySessionId(cwd, env, startedAt, dockerSession);
  }
  if (agent === "cursor" && dockerSession) {
    return env.HOME ? readDockerCursorSessionId(env.HOME) : "";
  }
  if (agent === "opencode") {
    if (dockerSession) {
      return resolveLatestNativeTranscript(
        "opencode",
        cwd,
        env,
        startedAt ? { startedAt } : {},
        { dockerSessionRoot: env.HOME },
      )?.sessionId ?? "";
    }
    return await newestOpenCodeSessionId(cwd, env);
  }
  if (agent === "pi") {
    if (dockerSession) {
      return resolveLatestNativeTranscript(
        "pi",
        cwd,
        env,
        startedAt ? { startedAt } : {},
        { dockerSessionRoot: env.HOME },
      )?.path ?? "";
    }
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

function newestAntigravitySessionId(
  cwd: string | undefined,
  env: Env,
  startedAt: string | undefined,
  dockerSession: boolean,
): string {
  return resolveLatestNativeTranscript(
    "antigravity",
    cwd ?? process.cwd(),
    env,
    startedAt ? { startedAt } : {},
    dockerSession ? { dockerSessionRoot: env.HOME } : {},
  )?.sessionId ?? "";
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

function boundedUtf8Tail(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return encoded.subarray(start).toString("utf8");
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
      let stdoutReceived = false;
      let stdoutEndsWithNewline = false;
      let traceBuffer = "";
      let traceRowDiscarded = false;
      const relevantTrace: string[] = [];
      let relevantTraceBytes = 0;
      const finalMessageTrace: string[] = [];
      let finalMessageTraceBytes = 0;
      let pinnedIdentityTrace = "";
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let termination: { code: number } | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      let forceFinish: NodeJS.Timeout | undefined;
      let forceDrain: NodeJS.Timeout | undefined;
      let stdoutDrainPending = false;
      let exitedBeforeClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const stdoutDrainController = new AbortController();
      let removeParentSignalHandlers = () => {};
      const terminationGraceMs = 1000;
      const maxRelevantTraceBytes = 256 * 1024;
      const maxFinalMessageTraceBytes = options.maxFinalMessageTraceBytes ?? 64 * 1024;
      const maxCapturedTraceRowBytes = 4 * 1024 * 1024;
      const maxPinnedIdentityBytes = 16 * 1024;
      const relevantTracePattern =
        /"(?:usage|stats|tokens|context_window|num_turns|duration_ms|duration_api_ms|total_cost_usd|thread_id|session_id|sessionId|sessionID)"\s*:|"type"\s*:\s*"(?:thread\.started|turn\.completed|result|step_finish|message_end|agent_message|response_item|item\.completed|assistant|model|text|planner_response|assistant_response)"|"role"\s*:\s*"assistant"/i;
      const codexIdentityPattern = /"type"\s*:\s*"thread\.started"/;
      const appendRelevantTrace = (line: string) => {
        let trimmed = line.trim();
        if (!trimmed || !relevantTracePattern.test(trimmed)) return;
        let entryBytes = Buffer.byteLength(trimmed, "utf8") + 1;
        if (entryBytes > maxRelevantTraceBytes) {
          trimmed = compactOversizedTraceLine(agent, trimmed);
          if (!trimmed || !relevantTracePattern.test(trimmed)) return;
          entryBytes = Buffer.byteLength(trimmed, "utf8") + 1;
        }
        if (entryBytes > maxRelevantTraceBytes) return;
        const entry = `${trimmed}\n`;
        if (agent === "codex" && codexIdentityPattern.test(trimmed) && entryBytes <= maxPinnedIdentityBytes) {
          pinnedIdentityTrace = entry;
        }
        relevantTrace.push(entry);
        relevantTraceBytes += entryBytes;
        while (relevantTraceBytes > maxRelevantTraceBytes && relevantTrace.length > 1) {
          const removed = relevantTrace.shift() ?? "";
          relevantTraceBytes -= Buffer.byteLength(removed, "utf8");
        }
      };
      const appendFinalMessageLine = (line: string) => {
        let capturedLine = line;
        let entryBytes = Buffer.byteLength(capturedLine, "utf8") + 1;
        if (entryBytes > maxFinalMessageTraceBytes) {
          if (isAntigravityStructuredOutput(capturedLine)) return;
          capturedLine = boundedUtf8Tail(capturedLine, maxFinalMessageTraceBytes - 1);
          entryBytes = Buffer.byteLength(capturedLine, "utf8") + 1;
        }
        const entry = `${capturedLine}\n`;
        finalMessageTrace.push(entry);
        finalMessageTraceBytes += entryBytes;
        while (finalMessageTraceBytes > maxFinalMessageTraceBytes && finalMessageTrace.length > 1) {
          const removed = finalMessageTrace.shift() ?? "";
          finalMessageTraceBytes -= Buffer.byteLength(removed, "utf8");
        }
      };
      const captureRelevantChunk = (chunk: string) => {
        if (!options.captureRelevantTrace && !options.captureFinalMessageTrace) return;
        const fragments = chunk.split("\n");
        for (let index = 0; index < fragments.length; index += 1) {
          if (!traceRowDiscarded) {
            traceBuffer += fragments[index] ?? "";
            if (Buffer.byteLength(traceBuffer, "utf8") > maxCapturedTraceRowBytes) {
              traceBuffer = "";
              traceRowDiscarded = true;
            }
          }
          if (index < fragments.length - 1) {
            if (!traceRowDiscarded) {
              const line = traceBuffer.endsWith("\r") ? traceBuffer.slice(0, -1) : traceBuffer;
              if (options.captureRelevantTrace) appendRelevantTrace(line);
              if (options.captureFinalMessageTrace) appendFinalMessageLine(line);
            }
            traceBuffer = "";
            traceRowDiscarded = false;
          }
        }
      };
      const flushTraceBuffer = () => {
        if (traceBuffer && !traceRowDiscarded) {
          if (options.captureRelevantTrace) appendRelevantTrace(traceBuffer);
          if (options.captureFinalMessageTrace) appendFinalMessageLine(traceBuffer);
        }
        traceBuffer = "";
      };
      const readRelevantTrace = () => {
        const rollingTrace = relevantTrace.join("");
        return pinnedIdentityTrace && !rollingTrace.includes(pinnedIdentityTrace)
          ? `${pinnedIdentityTrace}${rollingTrace}`
          : rollingTrace;
      };
      const finish = (result: ExecuteResult) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (forceKill) {
          clearTimeout(forceKill);
        }
        if (forceFinish) {
          clearTimeout(forceFinish);
        }
        if (forceDrain) {
          clearTimeout(forceDrain);
        }
        stdoutDrainController.abort();
        removeParentSignalHandlers();
        flushTraceBuffer();
        result.finalMessageTrace = finalMessageTrace.join("") || undefined;
        result.usageTrace = readRelevantTrace() || undefined;
        result.stdoutReceived = stdoutReceived;
        result.stdoutEndsWithNewline = stdoutEndsWithNewline;
        resolve(result);
      };
      const ownsChildProcessGroup =
        process.platform !== "win32" &&
        (options.timeoutSeconds !== undefined || options.cleanupBeforeParentSignalExit !== undefined);
      const handlesParentSignals = ownsChildProcessGroup || options.cleanupBeforeParentSignalExit !== undefined;
      const child = spawn(command.command, command.args, {
        cwd,
        detached: ownsChildProcessGroup,
        env: commandEnv(env, command) as NodeJS.ProcessEnv,
        stdio,
      });

      const signalChildTree = (signal: NodeJS.Signals) => {
        if (ownsChildProcessGroup && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to the direct child when the process group has already exited.
          }
        }
        child.kill(signal);
      };

      const clearForceDrain = () => {
        if (forceDrain) {
          clearTimeout(forceDrain);
          forceDrain = undefined;
        }
      };

      const armForceDrain = () => {
        if (
          forceDrain ||
          settled ||
          termination ||
          stdoutDrainPending ||
          options.cleanupBeforeParentSignalExit === undefined ||
          exitedBeforeClose === undefined
        ) {
          return;
        }
        const { code, signal } = exitedBeforeClose;
        forceDrain = setTimeout(() => {
          forceDrain = undefined;
          if (settled || termination || stdoutDrainPending) return;
          signalChildTree("SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({
            code: signal ? 1 : (code ?? 1),
            stdout: capturedStdout,
            stdoutReceived,
            stdoutEndsWithNewline,
          });
        }, terminationGraceMs);
        forceDrain.unref();
      };

      if (handlesParentSignals) {
        const handlers = new Map<NodeJS.Signals, () => void>();
        removeParentSignalHandlers = () => {
          for (const [signal, handler] of handlers) {
            process.off(signal, handler);
          }
        };
        for (const signal of parentExitSignals()) {
          const handler = () => {
            const inheritedListeners = options.inheritedSignalListeners?.get(signal);
            const hasExternalListener = inheritedListeners
              ? process.listeners(signal).some((listener) => inheritedListeners.has(listener))
              : process.listeners(signal).some((listener) => listener !== handler);
            signalChildTree(signal);
            try {
              options.cleanupBeforeParentSignalExit?.();
            } finally {
              removeParentSignalHandlers();
              if (!hasExternalListener) {
                process.kill(process.pid, signal);
              }
            }
          };
          handlers.set(signal, handler);
          process.once(signal, handler);
        }
        if (ownsChildProcessGroup) {
          const suspendHandler = () => {
            signalChildTree("SIGTSTP");
            process.kill(process.pid, "SIGSTOP");
          };
          const continueHandler = () => {
            signalChildTree("SIGCONT");
          };
          handlers.set("SIGTSTP", suspendHandler);
          handlers.set("SIGCONT", continueHandler);
          process.on("SIGTSTP", suspendHandler);
          process.on("SIGCONT", continueHandler);
        }
      }

      const terminateChild = (code: number) => {
        if (settled || termination) return;
        termination = { code };
        if (process.platform === "win32") {
          forceKillWindowsProcessTree(child, terminationGraceMs);
        } else {
          signalChildTree("SIGTERM");
        }
        forceKill = setTimeout(() => {
          if (settled) return;
          if (process.platform === "win32") {
            forceKillWindowsProcessTree(child, terminationGraceMs);
          } else {
            signalChildTree("SIGKILL");
          }
          forceFinish = setTimeout(() => {
            if (settled) return;
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish({ code, stdout: capturedStdout });
          }, terminationGraceMs);
          forceFinish.unref();
        }, terminationGraceMs);
        forceKill.unref();
      };

      if (options.timeoutSeconds !== undefined) {
        timeout = setTimeout(() => {
          const message = `headless: command timed out after ${options.timeoutSeconds}s\n`;
          options.stderr?.(message);
          stderr(message);
          terminateChild(124);
        }, options.timeoutSeconds * 1000);
      }
      if (command.stdinText !== undefined) {
        child.stdin?.end(command.stdinText);
      }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutReceived = true;
        stdoutEndsWithNewline = chunk.endsWith("\n");
        captureRelevantChunk(chunk);
        if (options.stdoutHandling !== "stream") {
          capturedStdout += chunk;
        }
        options.stdoutLog?.(chunk);
        if (options.stdoutHandling !== "capture") {
          const writable = options.stdout(chunk);
          if (
            writable === false &&
            !stdoutDrainPending &&
            options.waitForStdoutDrain
          ) {
            clearForceDrain();
            stdoutDrainPending = true;
            child.stdout?.pause();
            void options.waitForStdoutDrain(stdoutDrainController.signal).then(
              () => {
                stdoutDrainPending = false;
                if (!settled) {
                  child.stdout?.resume();
                  armForceDrain();
                }
              },
              () => {
                stdoutDrainPending = false;
                if (!settled) {
                  const message = "headless: SDK output stream failed\n";
                  options.stderr?.(message);
                  stderr(message);
                  child.stdout?.resume();
                  terminateChild(1);
                }
              },
            );
          }
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
        finish({ code: termination?.code ?? 127, stdout: capturedStdout, stdoutReceived, stdoutEndsWithNewline });
      });
      child.on("exit", (code, signal) => {
        if (options.cleanupBeforeParentSignalExit === undefined || termination !== undefined || settled) {
          return;
        }
        exitedBeforeClose = { code, signal };
        armForceDrain();
      });
      child.on("close", (code, signal) => {
        if (ownsChildProcessGroup && options.cleanupBeforeParentSignalExit !== undefined) {
          signalChildTree("SIGKILL");
        }
        if (termination) {
          signalChildTree("SIGKILL");
        }
        if (signal) {
          finish({ code: termination?.code ?? 1, stdout: capturedStdout, stdoutReceived, stdoutEndsWithNewline });
          return;
        }
        finish({ code: termination?.code ?? code ?? 1, stdout: capturedStdout, stdoutReceived, stdoutEndsWithNewline });
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
  options: { pastePrompt?: boolean } = {},
): TmuxCommands {
  const sessionName = buildHeadlessTmuxSessionName(agent, customName ?? String(process.pid));
  const startDir = cwd ?? process.cwd();
  const pastePrompt = options.pastePrompt ?? true;
  const promptInput = tmuxPromptInput(agent, sessionName, prompt, env, pastePrompt);
  return {
    sessionName,
    newSession: {
      command: "tmux",
      args: ["new-session", "-d", "-s", sessionName, "-c", startDir, quoteCommand(command)],
    },
    postLaunch: promptInput,
  };
}

function tmuxPromptInput(
  agent: AgentName,
  sessionName: string,
  prompt: string,
  env: Env,
  pastePrompt: boolean,
): TmuxPostLaunchCommand[] {
  if (!pastePrompt || (agent !== "opencode" && agent !== "antigravity")) return [];

  const envPrefix = agent === "opencode" ? "OPENCODE" : "ANTIGRAVITY";
  const wakeDelayMs = parseDelayMs(
    env[`HEADLESS_TMUX_${envPrefix}_WAKE_DELAY_MS`] ?? env[`HEADLESS_TMUX_${envPrefix}_ENTER_DELAY_MS`],
    4000,
  );
  const pasteDelayMs = parseDelayMs(env[`HEADLESS_TMUX_${envPrefix}_PASTE_DELAY_MS`], 1000);
  const submitDelayMs = parseDelayMs(env[`HEADLESS_TMUX_${envPrefix}_SUBMIT_DELAY_MS`], 1000);
  const promptBuffer = `${sessionName}-prompt`;

  return [
    {
      command: { command: "tmux", args: ["send-keys", "-t", sessionName, "Space", "BSpace"] },
      delayMs: wakeDelayMs,
    },
    {
      command: { command: "tmux", args: ["set-buffer", "-b", promptBuffer, prompt] },
      delayMs: pasteDelayMs,
    },
    {
      command: { command: "tmux", args: ["paste-buffer", "-d", "-b", promptBuffer, "-t", sessionName] },
      delayMs: 0,
    },
    {
      command: { command: "tmux", args: ["send-keys", "-t", sessionName, "Enter"] },
      delayMs: submitDelayMs,
    },
  ];
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

function parseWaitingAfterMs(env: Env, configuredWaitingAfterMs: number | undefined): number {
  const parsed = Number.parseInt(env.HEADLESS_LIST_WAITING_AFTER_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : (configuredWaitingAfterMs ?? 15_000);
}

function resolveRunStatusIntervalMs(env: Env, general: GeneralDefaults): number {
  if (env.HEADLESS_RUN_STATUS_INTERVAL_MS !== undefined) {
    return parseRunStatusIntervalMs(env.HEADLESS_RUN_STATUS_INTERVAL_MS);
  }
  return general.runStatusIntervalMs ?? parseRunStatusIntervalMs(undefined);
}

function inferHeadlessTmuxSessionState(
  paneDead: string,
  lastActivitySeconds: number,
  waitingAfterMs: number,
  nativeStatus?: "running" | "waiting_input" | "idle",
): HeadlessTmuxSessionState {
  if (paneDead === "1") {
    return "dead";
  }
  if (nativeStatus === "idle") return "idle";
  if (nativeStatus === "waiting_input") return "waiting";
  if (nativeStatus === "running") return "running";
  return Date.now() - lastActivitySeconds * 1000 <= waitingAfterMs ? "running" : "waiting";
}

function parseHeadlessTmuxSessionLine(
  line: string,
): ParsedHeadlessTmuxSessionDetails | undefined {
  const [name, createdRaw, activityRaw, paneDead = "0", workDirRaw = ""] = line.split("\t");
  const session = parseHeadlessTmuxSession(name?.trim() ?? "");
  const createdSeconds = parseEpochSeconds(createdRaw ?? "");
  const activitySeconds = parseEpochSeconds(activityRaw ?? "");
  if (!session || createdSeconds === undefined || activitySeconds === undefined) {
    return undefined;
  }
  return {
    ...session,
    paneDead: paneDead.trim(),
    createdSeconds,
    activitySeconds,
    workDir: workDirRaw.trim() || undefined,
  };
}

function headlessTmuxSessionDetails(
  session: ParsedHeadlessTmuxSessionDetails,
  waitingAfterMs: number,
  nativeActivity?: NonNullable<ReturnType<typeof deriveNativeTranscriptActivity>>,
): HeadlessTmuxSessionDetails | undefined {
  const createdAt = formatEpochSeconds(session.createdSeconds);
  const lastActivitySecondsWithNative = nativeActivity?.updatedAtMs
    ? Math.max(session.activitySeconds, Math.floor(nativeActivity.updatedAtMs / 1000))
    : session.activitySeconds;
  return {
    name: session.name,
    agent: session.agent,
    state: inferHeadlessTmuxSessionState(session.paneDead, lastActivitySecondsWithNative, waitingAfterMs, nativeActivity?.status),
    createdAt,
    lastActivityAt: formatEpochSeconds(lastActivitySecondsWithNative),
  };
}

function assignTmuxNativeActivities(
  sessions: ParsedHeadlessTmuxSessionDetails[],
  env: Env,
): Map<string, NonNullable<ReturnType<typeof deriveNativeTranscriptActivity>>> {
  const claimedTranscripts = new Set<string>();
  const activities = new Map<string, NonNullable<ReturnType<typeof deriveNativeTranscriptActivity>>>();
  const eligibleSessions = sessions
    .filter((session) => session.paneDead !== "1" && Boolean(session.workDir))
    .sort(
      (left, right) =>
        right.createdSeconds - left.createdSeconds ||
        right.activitySeconds - left.activitySeconds ||
        right.name.localeCompare(left.name),
    );
  const candidatesByScope = tmuxSessionTranscriptCandidatesByScope(eligibleSessions, env);

  for (const session of eligibleSessions) {
    const transcript = (candidatesByScope.get(tmuxSessionTranscriptScope(session.agent, session.workDir)) ?? []).find(
      (candidate) => !claimedTranscripts.has(nativeTranscriptKey(candidate)),
    );
    if (!transcript) continue;
    claimedTranscripts.add(nativeTranscriptKey(transcript));
    const activity = deriveNativeTranscriptActivity(session.agent, transcript);
    if (activity) activities.set(session.name, activity);
  }
  return activities;
}

function tmuxSessionTranscriptCandidatesByScope(
  sessions: ParsedHeadlessTmuxSessionDetails[],
  env: Env,
): Map<string, ReturnType<typeof resolveLatestNativeTranscripts>> {
  const sessionsByScope = new Map<string, ParsedHeadlessTmuxSessionDetails[]>();
  for (const session of sessions) {
    const scope = tmuxSessionTranscriptScope(session.agent, session.workDir);
    const scopedSessions = sessionsByScope.get(scope) ?? [];
    scopedSessions.push(session);
    sessionsByScope.set(scope, scopedSessions);
  }

  const candidatesByScope = new Map<string, ReturnType<typeof resolveLatestNativeTranscripts>>();
  for (const [scope, scopedSessions] of sessionsByScope) {
    const firstSession = scopedSessions[0];
    if (!firstSession) continue;
    const earliestCreatedSeconds = scopedSessions.reduce(
      (earliest, session) => Math.min(earliest, session.createdSeconds),
      scopedSessions[0]?.createdSeconds ?? 0,
    );
    candidatesByScope.set(
      scope,
      resolveLatestNativeTranscripts(
        firstSession.agent,
        firstSession.workDir,
        env,
        { startedAt: formatEpochSeconds(earliestCreatedSeconds) },
        scopedSessions.length,
      ),
    );
  }
  return candidatesByScope;
}

function tmuxSessionTranscriptScope(agent: AgentName, workDir: string | undefined): string {
  return `${agent}\t${workDir ?? ""}`;
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

async function listHeadlessTmuxSessions(
  agent: AgentName | undefined,
  env: Env,
  configuredWaitingAfterMs: number | undefined,
): Promise<string> {
  return renderHeadlessTmuxSessions(await listHeadlessTmuxSessionDetails(agent, env, configuredWaitingAfterMs));
}

async function listHeadlessTmuxSessionDetails(
  agent: AgentName | undefined,
  env: Env,
  configuredWaitingAfterMs?: number,
): Promise<HeadlessTmuxSessionDetails[]> {
  const result = await captureSimpleCommand(
    {
      command: "tmux",
      args: ["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{window_activity}\t#{pane_dead}\t#{pane_current_path}"],
    },
    undefined,
    env,
  );

  if (result.code !== 0) {
    if (result.stderr.includes("no server running")) {
      return [];
    }
    throw new CliError(
      result.stderr.trim() || "could not list tmux sessions",
      "could not list tmux sessions",
    );
  }

  const waitingAfterMs = parseWaitingAfterMs(env, configuredWaitingAfterMs);
  const sessions = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseHeadlessTmuxSessionLine)
    .filter((session): session is ParsedHeadlessTmuxSessionDetails => Boolean(session));
  const nativeActivities = assignTmuxNativeActivities(sessions, env);
  return sessions
    .map((session) => headlessTmuxSessionDetails(session, waitingAfterMs, nativeActivities.get(session.name)))
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

function tmuxWaitMarker(sessionName: string): string {
  return `headless-tmux-wait:${sessionName}`;
}

function promptWithTmuxWaitMarker(prompt: string, sessionName: string): string {
  return `${prompt}\n\n<!-- ${tmuxWaitMarker(sessionName)} -->`;
}

function createTmuxWaitSnapshot(
  agent: AgentName,
  workDir: string,
  env: Env,
  strategy: WaitResolveStrategy,
): TmuxWaitSnapshot {
  return {
    startedAt: new Date().toISOString(),
    strategy,
    transcripts: new Map(
      resolveLatestNativeTranscripts(agent, workDir, env, {}, 20, claimTranscriptOptions(agent)).map((transcript) => [
        tmuxWaitTranscriptIdentity(transcript),
        transcript.kind === "jsonl" ? statSync(transcript.path).size : undefined,
      ]),
    ),
  };
}

function tmuxWaitTranscriptIdentity(transcript: ReturnType<typeof resolveLatestNativeTranscripts>[number]): string {
  return [transcript.kind, transcript.path, transcript.sessionId ?? ""].join("\t");
}

// Restrict a transcript to bytes written after the snapshot, so a resumed
// session's prior turns are ignored. Brand-new transcripts (absent from the
// baseline) are read whole; sqlite transcripts rely on the startedAt filter.
function tmuxWaitCandidateWithSnapshot(
  transcript: ReturnType<typeof resolveLatestNativeTranscripts>[number],
  snapshot: TmuxWaitSnapshot,
): ReturnType<typeof resolveLatestNativeTranscripts>[number] | undefined {
  if (transcript.kind !== "jsonl") {
    return transcript;
  }
  const startOffset = snapshot.transcripts.get(tmuxWaitTranscriptIdentity(transcript)) ?? 0;
  const endOffset = statSync(transcript.path).size;
  if (startOffset >= endOffset) {
    return undefined;
  }
  return { ...transcript, startOffset, endOffset };
}

function finalMessageFromTerminalTranscript(
  agent: AgentName,
  transcript: ReturnType<typeof resolveLatestNativeTranscripts>[number] | undefined,
): string {
  if (!transcript) return "";
  const activity = deriveNativeTranscriptActivity(agent, transcript, { terminalDonePrecedence: true });
  if (activity?.reason !== "terminal_done") return "";
  return activity.message ?? indexNativeAssistantCompletion(agent, transcript)?.message ?? "";
}

// Read the final message from a transcript resolved directly by id/title/dir,
// honouring the snapshot baseline so a resumed session's stale turns are skipped.
function finalMessageFromResolved(
  agent: AgentName,
  transcript: ReturnType<typeof resolveLatestNativeTranscripts>[number] | undefined,
  snapshot: TmuxWaitSnapshot,
): string {
  if (!transcript) return "";
  return finalMessageFromTerminalTranscript(agent, tmuxWaitCandidateWithSnapshot(transcript, snapshot));
}

// First transcript that did not exist before launch — the `claim` tier's run.
// A launch lock guarantees only one new transcript can appear in this window.
function claimedTranscript(
  agent: AgentName,
  workDir: string,
  env: Env,
  snapshot: TmuxWaitSnapshot,
): ReturnType<typeof resolveLatestNativeTranscripts>[number] | undefined {
  const claimedPath = snapshot.strategy.kind === "claim" ? snapshot.strategy.claimed : undefined;
  if (claimedPath && existsSync(claimedPath)) {
    return {
      kind: "jsonl",
      path: claimedPath,
      sessionId: claimedNativeIdFromPath(agent, claimedPath),
      startedAt: snapshot.startedAt,
      endOffset: statSync(claimedPath).size,
    };
  }
  return resolveLatestNativeTranscripts(agent, workDir, env, { startedAt: snapshot.startedAt }, 20, claimTranscriptOptions(agent)).find((candidate) =>
    !snapshot.transcripts.has(tmuxWaitTranscriptIdentity(candidate)),
  );
}

function claimedNativeIdFromPath(agent: AgentName, path: string): string | undefined {
  if (agent === "antigravity") {
    const parts = path.split("/");
    const brainIndex = parts.lastIndexOf("brain");
    const nativeId = brainIndex >= 0 ? parts[brainIndex + 1] : undefined;
    return nativeId && /^[A-Za-z0-9_.:-]+$/.test(nativeId) ? nativeId : undefined;
  }
  if (agent === "codex") {
    const name = path.split("/").at(-1)?.replace(/\.jsonl$/, "");
    if (!name) return undefined;
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name);
    return match?.[1] ?? name;
  }
  return undefined;
}

function readTmuxFinalMessage(agent: AgentName, workDir: string, env: Env, snapshot: TmuxWaitSnapshot): string {
  const strategy = snapshot.strategy;
  switch (strategy.kind) {
    case "pin":
      return finalMessageFromResolved(
        agent,
        resolveNativeTranscript(agent, strategy.sessionId, workDir, env, { startedAt: snapshot.startedAt }),
        snapshot,
      );
    case "title":
      return finalMessageFromResolved(
        agent,
        resolveOpencodeTranscriptByTitle(workDir, env, strategy.title, { startedAt: snapshot.startedAt }),
        snapshot,
      );
    case "dir":
      return finalMessageFromResolved(
        agent,
        resolvePiTranscriptInDir(strategy.sessionDir, env, { startedAt: snapshot.startedAt }),
        snapshot,
      );
    case "claim":
      return finalMessageFromResolved(agent, claimedTranscript(agent, workDir, env, snapshot), snapshot);
    case "marker": {
      for (const candidate of resolveLatestNativeTranscripts(agent, workDir, env, { startedAt: snapshot.startedAt }, 20)) {
        const transcript = tmuxWaitCandidateWithSnapshot(candidate, snapshot);
        if (!transcript || !nativeTranscriptIncludesText(transcript, strategy.marker)) continue;
        const message = finalMessageFromTerminalTranscript(agent, transcript);
        if (message) return message;
      }
      return "";
    }
  }
}

async function waitForTmuxFinalMessage(
  agent: AgentName,
  sessionName: string,
  workDir: string,
  env: Env,
  snapshot: TmuxWaitSnapshot,
  timeoutSeconds: number | undefined,
): Promise<string> {
  const intervalMs = parseDelayMs(env.HEADLESS_TMUX_WAIT_INTERVAL_MS, 1000);
  const deadline = timeoutSeconds === undefined ? undefined : Date.now() + timeoutSeconds * 1000;
  while (true) {
    const message = readTmuxFinalMessage(agent, workDir, env, snapshot);
    if (message) return message;
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new CliError(`tmux wait timed out after ${timeoutSeconds}s`);
    }
    if (!(await headlessTmuxSessionExists(sessionName, env))) {
      const finalMessage = readTmuxFinalMessage(agent, workDir, env, snapshot);
      if (finalMessage) return finalMessage;
      throw new CliError(`tmux session ended before final message: ${sessionName}`);
    }
    await waitForDelay(intervalMs);
  }
}

async function mintCursorSessionId(cwd: string | undefined, env: Env): Promise<string> {
  const command = { command: env.CURSOR_CLI_BIN || "agent", args: ["create-chat"] };
  const result = await captureSimpleCommand(command, cwd, env);
  if (result.code !== 0) {
    throw new CliError(
      result.stderr.trim() || "could not create Cursor session",
      "could not create Cursor session",
    );
  }
  const nativeId = result.stdout.trim();
  if (!nativeId) {
    throw new CliError("Cursor did not return a session id");
  }
  return nativeId;
}

function createTmuxWaitSessionDir(env: Env, sessionName: string): string {
  const base = env.HOME ? join(env.HOME, ".headless", "tmux-wait") : ".headless-tmux-wait";
  const dir = join(base, `${sessionName}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Decide how `--tmux --wait` will locate this run's transcript and what the
// interactive launch needs (identity flags, prompt). Each tier keeps the prompt
// clean; only the env-forced marker fallback rewrites it.
async function resolveTmuxWaitPlan(
  agent: AgentName,
  sessionName: string,
  composedPrompt: string,
  cwd: string | undefined,
  env: Env,
): Promise<{ strategy: WaitResolveStrategy; identity: Partial<BuildOptions>; prompt: string }> {
  if (waitTierForAgent(agent) === "unsupported") {
    throw new CliError(`--tmux --wait is not supported by ${agent}: native transcript resolution is not available`);
  }
  if (isTruthyFlag(env.HEADLESS_TMUX_WAIT_FORCE_MARKER)) {
    return {
      strategy: { kind: "marker", marker: tmuxWaitMarker(sessionName) },
      identity: {},
      prompt: promptWithTmuxWaitMarker(composedPrompt, sessionName),
    };
  }
  switch (waitTierForAgent(agent)) {
    case "pin": {
      const sessionId = randomUUID();
      return { strategy: { kind: "pin", sessionId }, identity: { sessionMode: "new", sessionId }, prompt: composedPrompt };
    }
    case "mint": {
      const sessionId = await mintCursorSessionId(cwd, env);
      return { strategy: { kind: "pin", sessionId }, identity: { sessionMode: "new", sessionId }, prompt: composedPrompt };
    }
    case "tag": {
      const title = `headless-wait-${randomUUID()}`;
      return { strategy: { kind: "title", title }, identity: { sessionMode: "new", sessionTitle: title }, prompt: composedPrompt };
    }
    case "dir": {
      const sessionDir = createTmuxWaitSessionDir(env, sessionName);
      return { strategy: { kind: "dir", sessionDir }, identity: { sessionMode: "new", sessionDir }, prompt: composedPrompt };
    }
    case "claim":
      return { strategy: { kind: "claim" }, identity: {}, prompt: composedPrompt };
    case "unsupported":
      throw new CliError(`--tmux --wait is not supported by ${agent}: native transcript resolution is not available`);
  }
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

// Resolving a transcript when sending into an already-running session: reuse the
// native id recorded when the session was created (clean, no marker); otherwise
// fall back to the prompt marker since the running session's id is unknown.
function resolveExistingSessionWaitStrategy(
  agent: AgentName,
  alias: string | undefined,
  sessionName: string,
  env: Env,
): WaitResolveStrategy {
  if (!isTruthyFlag(env.HEADLESS_TMUX_WAIT_FORCE_MARKER) && alias) {
    const stored = readStoredSession(env, agent, alias);
    if (stored?.tmuxWaitStrategy) {
      return waitResolveStrategyFromStored(stored.tmuxWaitStrategy);
    }
  }
  return { kind: "marker", marker: tmuxWaitMarker(sessionName) };
}

function waitResolveStrategyFromStored(strategy: StoredTmuxWaitStrategy): WaitResolveStrategy {
  switch (strategy.kind) {
    case "pin":
      return { kind: "pin", sessionId: strategy.sessionId };
    case "title":
      return { kind: "title", title: strategy.title };
    case "dir":
      return { kind: "dir", sessionDir: strategy.sessionDir };
    case "claim":
      return { kind: "claim", claimed: strategy.claimed };
  }
}

function storedTmuxWaitStrategy(strategy: WaitResolveStrategy): StoredTmuxWaitStrategy | undefined {
  switch (strategy.kind) {
    case "pin":
      return { kind: "pin", sessionId: strategy.sessionId };
    case "title":
      return { kind: "title", title: strategy.title };
    case "dir":
      return { kind: "dir", sessionDir: strategy.sessionDir };
    case "claim":
      return strategy.claimed ? { kind: "claim", claimed: strategy.claimed } : undefined;
    case "marker":
      return undefined;
  }
}

function realWorkspaceForLock(workDir: string): string {
  try {
    return realpathSync(workDir);
  } catch {
    return workDir;
  }
}

function claimLockScope(agent: AgentName, workDir: string): string {
  return agent === "antigravity" ? "__global_antigravity_brain__" : realWorkspaceForLock(workDir);
}

function claimTranscriptOptions(agent: AgentName): Parameters<typeof resolveLatestNativeTranscripts>[5] {
  return agent === "antigravity" ? { antigravityScope: "all" } : {};
}

// Poll until a transcript that did not exist before launch appears, so the claim
// tier can lock onto exactly this run's transcript before the launch lock is released.
async function claimNewTranscriptPath(
  agent: AgentName,
  sessionName: string,
  workDir: string,
  env: Env,
  snapshot: TmuxWaitSnapshot,
  timeoutSeconds: number | undefined,
): Promise<string | undefined> {
  const intervalMs = parseDelayMs(env.HEADLESS_TMUX_WAIT_INTERVAL_MS, 1000);
  const deadline = timeoutSeconds === undefined ? undefined : Date.now() + timeoutSeconds * 1000;
  while (true) {
    const fresh = resolveLatestNativeTranscripts(agent, workDir, env, { startedAt: snapshot.startedAt }, 20, claimTranscriptOptions(agent)).find(
      (candidate) => !snapshot.transcripts.has(tmuxWaitTranscriptIdentity(candidate)),
    );
    if (fresh) return fresh.path;
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new CliError(`tmux wait timed out after ${timeoutSeconds}s`);
    }
    if (!(await headlessTmuxSessionExists(sessionName, env))) {
      return undefined;
    }
    await waitForDelay(intervalMs);
  }
}

async function deleteTmuxSession(sessionName: string, env: Env, stderr: (text: string) => void): Promise<number> {
  const result = await captureSimpleCommand({ command: "tmux", args: ["kill-session", "-t", sessionName] }, undefined, env);
  if (result.code === 0) {
    return 0;
  }
  if (result.stderr.includes("no server running") || result.stderr.includes("can't find session")) {
    return 0;
  }
  if (result.stderr) {
    stderr(result.stderr);
  }
  return result.code;
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

function effectiveCoordination(parsed: ParsedArgs, configuredCoordination: CoordinationMode | undefined): CoordinationMode {
  if (parsed.coordination) {
    return parsed.coordination;
  }
  if (parsed.tmux) {
    return "tmux";
  }
  if ((parsed.docker || parsed.modal) && parsed.role) {
    return "oneshot";
  }
  return configuredCoordination ?? "session";
}

function validateCronCliOptions(parsed: ParsedArgs): void {
  if (parsed.tmux) {
    throw new CliError("--tmux cannot be scheduled");
  }
  if (parsed.wait) {
    throw new CliError("--wait cannot be scheduled");
  }
  if (parsed.delete) {
    throw new CliError("--delete cannot be scheduled");
  }
  if (parsed.sessionAlias !== undefined) {
    throw new CliError("--session cannot be scheduled");
  }
  if (parsed.runId !== undefined || parsed.nodeId !== undefined || parsed.dependsOn.length > 0 || parsed.teamSpecs.length > 0) {
    throw new CliError("run-management options cannot be scheduled");
  }
  if (parsed.role !== undefined || parsed.coordination !== undefined) {
    throw new CliError("--role and --coordination cannot be scheduled");
  }
  if (parsed.attachAll) {
    throw new CliError("--all cannot be used with cron");
  }
  if (parsed.check || parsed.list || parsed.showConfig || parsed.printCommand) {
    throw new CliError("--check, --list, --show-config, and --print-command cannot be used with cron");
  }
  if (parsed.runCommandAsync || parsed.runCommandStatus !== undefined) {
    throw new CliError("run command options cannot be used with cron");
  }
  if (parsed.cronCommand !== "add") {
    const hasAddOnly =
      parsed.agent !== undefined ||
      parsed.cronEvery !== undefined ||
      parsed.cronSchedule !== undefined ||
      parsed.prompt !== undefined ||
      parsed.promptFile !== undefined ||
      parsed.model !== undefined ||
      parsed.profile !== undefined ||
      parsed.fast !== undefined ||
      parsed.reasoningEffort !== undefined ||
      parsed.allow !== undefined ||
      parsed.workDir !== undefined ||
      parsed.docker ||
      hasDockerOptions(parsed) ||
      parsed.modal ||
      hasModalOptions(parsed) ||
      parsed.timeoutSeconds !== undefined ||
      parsed.json ||
      parsed.debug ||
      parsed.usage;
    if (hasAddOnly) {
      throw new CliError(`unsupported option for cron ${parsed.cronCommand}`);
    }
  }
  if (
    (parsed.cronCommand === "list" || parsed.cronCommand === "start" || parsed.cronCommand === "stop") &&
    parsed.cronJobId !== undefined
  ) {
    throw new CliError(`cron ${parsed.cronCommand} does not take a job id`);
  }
  if (parsed.cronForce && parsed.cronCommand !== "rm") {
    throw new CliError("--force can only be used with cron rm");
  }
  if (parsed.cronCommand === "add") {
    validateCronAddCliOptions(parsed);
  }
}

function validateCronAddCliOptions(parsed: ParsedArgs): void {
  if (!parsed.docker && hasDockerOptions(parsed)) {
    throw new CliError("--docker-image, --docker-arg, and --docker-env require --docker");
  }
  if (!parsed.modal && hasModalOptions(parsed)) {
    throw new CliError("--modal-* options require --modal");
  }
  if (parsed.docker && parsed.modal) {
    throw new CliError("--docker cannot be used with --modal");
  }
  if (parsed.debug && parsed.json) {
    throw new CliError("--debug cannot be used with --json");
  }
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
    fast?: boolean;
    model?: string;
    profile?: string;
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
    node.coordination === "session"
      ? await prepareSessionPlan(
          node.agent,
          buildSessionPlan(
            node.agent,
            node.sessionAlias ?? node.nodeId,
            env,
            node.profile,
          ),
          node.workDir,
          env,
          "local",
        )
      : undefined;
  const command = withRunEnvironment(
    buildAgentCommand(
      node.agent,
      applySessionPlan(
        {
          prompt,
          workDir: node.workDir,
          model: defaults.model,
          profile: node.profile,
          allow,
          fast: node.fast,
          reasoningEffort: defaults.reasoningEffort,
          timeoutSeconds: config.general.timeoutSeconds,
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
    timeoutSeconds: config.general.timeoutSeconds,
  });
  if (result.code === 0 && sessionPlan) {
    await persistSessionPlan(node.agent, sessionPlan, result.stdout, node.workDir, env);
  }
  return result;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const waitForSdkStdoutDrain = deps.stdout
    ? undefined
    : (signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            process.stdout.off("drain", handleDrain);
            process.stdout.off("error", handleError);
            process.stdout.off("close", handleClose);
            signal.removeEventListener("abort", handleAbort);
          };
          const handleDrain = () => {
            cleanup();
            resolve();
          };
          const handleError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const handleClose = () => {
            cleanup();
            resolve();
          };
          const handleAbort = () => {
            cleanup();
            resolve();
          };
          if (signal.aborted) {
            resolve();
            return;
          }
          process.stdout.once("drain", handleDrain);
          process.stdout.once("error", handleError);
          process.stdout.once("close", handleClose);
          signal.addEventListener("abort", handleAbort, { once: true });
        });
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const stderrIsTTY = deps.stderrIsTTY ?? Boolean(process.stderr.isTTY);
  const env: Env = { ...(deps.env ?? process.env) };
  const requestedSdkOutput = requestsSdkOutput(argv);
  let activeSdkCommand = "cli";
  const inheritedSignalListeners = new Map(
    parentExitSignals().map((signal) => [
      signal,
      new Set(process.listeners(signal).filter((listener) => !isDockerSessionLockSignalListener(listener))),
    ] as const),
  );
  let registeredRunNode: { runId: string; nodeId: string } | undefined;
  let dockerSessionLock: { release: () => Promise<Error | undefined> } | undefined;

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
  if (argv[0] === "cron-daemon") {
    await runCronDaemon(env);
    return 0;
  }

  try {
    const parsed = parseArgs(argv);
    if (parsed.sdkFormat && parsed.json) {
      throw new CliError("--json cannot be used with --sdk-format");
    }
    if (parsed.sdkFormat && parsed.debug) {
      throw new CliError("--debug cannot be used with --sdk-format");
    }
    if (parsed.sdkFormat && parsed.printCommand) {
      throw new CliError("--print-command cannot be used with --sdk-format");
    }
    activeSdkCommand = sdkCommandFor(parsed);
    if (parsed.acpAgent) env.HEADLESS_ACP_AGENT = parsed.acpAgent;
    if (parsed.acpCommand) env.HEADLESS_ACP_COMMAND = parsed.acpCommand;
    if (parsed.acpRegistryFile) env.HEADLESS_ACP_REGISTRY_FILE = parsed.acpRegistryFile;
    if (parsed.acpRegistryUrl) env.HEADLESS_ACP_REGISTRY_URL = parsed.acpRegistryUrl;

    if (parsed.help) {
      stdout(usage());
      return 0;
    }
    if (parsed.version) {
      stdout(
        parsed.sdkFormat
          ? renderSdkResult("version", { version: packageVersion() })
          : `${packageVersion()}\n`,
      );
      return 0;
    }
    if (parsed.capabilities) {
      stdout(
        parsed.sdkFormat
          ? renderSdkResult("capabilities", sdkCapabilities())
          : `${JSON.stringify(sdkCapabilities(), undefined, 2)}\n`,
      );
      return 0;
    }
    let config: HeadlessConfig;
    try {
      config = loadHeadlessConfig(env);
    } catch (error) {
      throw toCliError(error);
    }
    if (parsed.cronCommand) {
      if (parsed.sdkFormat && parsed.cronCommand !== "list" && parsed.cronCommand !== "view") {
        throw new CliError(`--sdk-format cannot be used with cron ${parsed.cronCommand}`);
      }
      validateCronCliOptions(parsed);
      try {
        return await handleCronCommandImpl(
          {
            command: parsed.cronCommand,
            jobId: parsed.cronJobId,
            agent: parsed.agent,
            every: parsed.cronEvery,
            schedule: parsed.cronSchedule,
            prompt: parsed.prompt,
            promptFile: parsed.promptFile,
            model: parsed.model,
            profile: parsed.profile,
            fast: parsed.fast,
            reasoningEffort: parsed.reasoningEffort,
            allow: parsed.allow,
            workDir: validateWorkDir(parsed.workDir),
            docker: parsed.docker,
            dockerImage: parsed.dockerImage,
            dockerArgs: parsed.dockerArgs,
            dockerEnv: parsed.dockerEnv,
            modal: parsed.modal,
            modalApp: parsed.modalApp,
            modalCpu: parsed.modalCpu,
            modalEnv: parsed.modalEnv,
            modalImage: parsed.modalImage,
            modalImageSecret: parsed.modalImageSecret,
            modalIncludeGit: parsed.modalIncludeGit,
            modalMemoryMiB: parsed.modalMemoryMiB,
            modalSecrets: parsed.modalSecrets,
            modalTimeoutSeconds: parsed.modalTimeoutSeconds,
            timeoutSeconds: parsed.timeoutSeconds,
            json: parsed.json,
            debug: parsed.debug,
            usage: parsed.usage,
            force: parsed.cronForce,
            sdkFormat: parsed.sdkFormat,
          },
          { env, stdout, stderr },
        );
      } catch (error) {
        const message = errorMessage(error);
        if (
          parsed.sdkFormat &&
          parsed.cronCommand === "view" &&
          message === `unknown cron job: ${parsed.cronJobId}`
        ) {
          throw new CliError(message);
        }
        throw toCliError(error);
      }
    }
    if (
      parsed.fast !== undefined &&
      (parsed.attach || parsed.rename || parsed.send || parsed.check || parsed.list || parsed.showConfig || parsed.dockerCommand || parsed.runCommand)
    ) {
      throw new CliError("--fast can only be used with agent runs or cron add");
    }
    if (
      parsed.profile !== undefined &&
      (parsed.attach || parsed.rename || parsed.send || parsed.check || parsed.list || parsed.showConfig || parsed.dockerCommand || parsed.runCommand)
    ) {
      throw new CliError("--profile can only be used with codex agent runs or cron add");
    }
    if (parsed.runCommand) {
      if (parsed.sdkFormat && parsed.runCommand !== "list" && parsed.runCommand !== "view") {
        throw new CliError(`--sdk-format cannot be used with run ${parsed.runCommand}`);
      }
      if (parsed.timeoutSeconds !== undefined) {
        throw new CliError("--timeout cannot be used with run commands");
      }
      try {
        return await handleRunCommandImpl(
          {
            command: parsed.runCommand,
            runId: parsed.runCommandRunId,
            nodeId: parsed.runCommandNodeId,
            status: parsed.runCommandStatus,
            async: parsed.runCommandAsync,
            printCommand: parsed.printCommand,
            sdkFormat: parsed.sdkFormat,
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
        const message = errorMessage(error);
        if (
          parsed.sdkFormat &&
          parsed.runCommand === "view" &&
          message === `unknown run: ${parsed.runCommandRunId}`
        ) {
          throw new CliError(message);
        }
        throw toCliError(error);
      }
    }
    if (parsed.dockerCommand) {
      if (parsed.sdkFormat) {
        throw new CliError(`--sdk-format cannot be used with docker ${parsed.dockerCommand}`);
      }
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
        parsed.wait ||
        parsed.delete ||
        parsed.sessionAlias !== undefined ||
        parsed.json ||
        parsed.debug ||
        parsed.usage ||
        parsed.list ||
        parsed.check ||
        parsed.showConfig ||
        parsed.timeoutSeconds !== undefined
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
      if (parsed.sdkFormat) {
        throw new CliError("--sdk-format cannot be used with attach");
      }
      if (parsed.docker) {
        throw new CliError("--docker cannot be used with attach");
      }
      if (parsed.modal) {
        throw new CliError("--modal cannot be used with attach");
      }
      if (parsed.tmux) {
        throw new CliError("--tmux cannot be used with attach");
      }
      if (parsed.wait) {
        throw new CliError("--wait cannot be used with attach");
      }
      if (parsed.delete) {
        throw new CliError("--delete cannot be used with attach");
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
      if (parsed.timeoutSeconds !== undefined) {
        throw new CliError("--timeout cannot be used with attach");
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
      if (parsed.sdkFormat) {
        throw new CliError("--sdk-format cannot be used with rename");
      }
      if (parsed.docker) {
        throw new CliError("--docker cannot be used with rename");
      }
      if (parsed.modal) {
        throw new CliError("--modal cannot be used with rename");
      }
      if (parsed.tmux) {
        throw new CliError("--tmux cannot be used with rename");
      }
      if (parsed.wait) {
        throw new CliError("--wait cannot be used with rename");
      }
      if (parsed.delete) {
        throw new CliError("--delete cannot be used with rename");
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
      if (parsed.timeoutSeconds !== undefined) {
        throw new CliError("--timeout cannot be used with rename");
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
      if (parsed.sdkFormat) {
        throw new CliError("--sdk-format cannot be used with send");
      }
      if (parsed.docker) {
        throw new CliError("--docker cannot be used with send");
      }
      if (parsed.modal) {
        throw new CliError("--modal cannot be used with send");
      }
      if (parsed.tmux) {
        throw new CliError("--tmux cannot be used with send");
      }
      if (parsed.wait) {
        throw new CliError("--wait cannot be used with send");
      }
      if (parsed.delete) {
        throw new CliError("--delete cannot be used with send");
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
      if (parsed.timeoutSeconds !== undefined) {
        throw new CliError("--timeout cannot be used with send");
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
      if (parsed.timeoutSeconds !== undefined) {
        throw new CliError("--timeout cannot be used with --check");
      }
      if (parsed.wait) {
        throw new CliError("--wait cannot be used with --check");
      }
      if (parsed.delete) {
        throw new CliError("--delete cannot be used with --check");
      }
      if (parsed.sessionAlias !== undefined) {
        throw new CliError("--session cannot be used with --check");
      }
      try {
        const agents = await checkAgents(env);
        const docker = await checkDocker(env, parsed.dockerImage ?? DEFAULT_DOCKER_IMAGE);
        if (parsed.sdkFormat) {
          stdout(renderSdkResult("check", { agents, docker }));
          return 0;
        }
        stdout(renderAgentChecks(agents));
        stdout(renderDockerCheck(docker));
      } catch (error) {
        throw toCliError(error);
      }
      return 0;
    }
    if (parsed.list && parsed.docker) {
      throw new CliError("--docker cannot be used with --list");
    }
    if (parsed.list && parsed.modal) {
      throw new CliError("--modal cannot be used with --list");
    }
    if (parsed.list) {
      if (parsed.timeoutSeconds !== undefined) {
        throw new CliError("--timeout cannot be used with --list");
      }
      if (parsed.wait) {
        throw new CliError("--wait cannot be used with --list");
      }
      if (parsed.delete) {
        throw new CliError("--delete cannot be used with --list");
      }
      if (parsed.sessionAlias !== undefined) {
        throw new CliError("--session cannot be used with --list");
      }
      if (parsed.sdkFormat) {
        const sessions = await listHeadlessTmuxSessionDetails(
          parsed.agent,
          env,
          config.general.listWaitingAfterMs,
        );
        stdout(renderSdkResult("sessions.list", { sessions }));
      } else {
        stdout(await listHeadlessTmuxSessions(parsed.agent, env, config.general.listWaitingAfterMs));
      }
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
      parsed.agent = parsed.docker || parsed.modal
        ? (config.general.defaultAgent ?? autoAgentPreference[0])
        : selectDefaultAgent(env, config.general.defaultAgent);
    }
    if (parsed.fast !== undefined && parsed.agent !== "claude" && parsed.agent !== "codex") {
      throw new CliError("--fast is supported only by claude and codex");
    }
    if (parsed.profile !== undefined && parsed.agent !== "codex") {
      throw new CliError("--profile is supported only by codex");
    }
    if (
      parsed.coordination === "tmux" ||
      (!parsed.coordination && config.general.coordination === "tmux" && !parsed.docker && !parsed.modal)
    ) {
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
    if (parsed.tmux && parsed.sdkFormat) {
      throw new CliError("--sdk-format cannot be used with --tmux");
    }
    if (parsed.tmux && parsed.timeoutSeconds !== undefined) {
      if (!parsed.wait) {
        throw new CliError("--timeout cannot be used with --tmux");
      }
    }
    if (parsed.wait && !parsed.tmux) {
      throw new CliError("--wait requires --tmux");
    }
    if (parsed.delete && !parsed.wait) {
      throw new CliError("--delete requires --wait");
    }
    if (parsed.wait && parsed.printCommand) {
      throw new CliError("--wait cannot be used with --print-command");
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
    if (parsed.sessionAlias !== undefined && parsed.modal) {
      throw new CliError("--session cannot be used with --modal");
    }
    validateSessionAlias(parsed.sessionAlias);
    const coordination = effectiveCoordination(parsed, config.general.coordination);
    if (
      parsed.docker &&
      parsed.runId &&
      parsed.role &&
      (coordination === "session" || parsed.sessionAlias !== undefined)
    ) {
      throw new CliError("Docker run nodes do not support durable sessions; use oneshot coordination without --session");
    }
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
      if (parsed.timeoutSeconds !== undefined) {
        throw new CliError("--timeout cannot be used with --show-config");
      }
      try {
        const defaults = resolveDisplayedDefaults(
          parsed.agent,
          parsed.role,
          { model: parsed.model, reasoningEffort: parsed.reasoningEffort, allow: parsed.allow },
          env,
          config,
        );
        stdout(
          parsed.sdkFormat
            ? renderSdkResult("config.show", displayedConfig(parsed.agent, defaults))
            : renderConfig(parsed.agent, defaults, env),
        );
      } catch (error) {
        throw toCliError(error);
      }
      return 0;
    }

    let configuredDefaults: InvocationDefaults;
    try {
      configuredDefaults = resolveInvocationDefaults(
        parsed.agent,
        parsed.role,
        { model: parsed.model, reasoningEffort: parsed.reasoningEffort, allow: parsed.allow },
        env,
        config,
      );
    } catch (error) {
      throw toCliError(error);
    }
    const commandTimeoutSeconds = parsed.timeoutSeconds ?? config.general.timeoutSeconds;
    const modalTimeoutSeconds = parsed.modalTimeoutSeconds ?? commandTimeoutSeconds ?? DEFAULT_MODAL_TIMEOUT_SECONDS;
    const cwd = validateWorkDir(parsed.workDir);
    if (parsed.docker) {
      validateDockerWorkDir(cwd ?? process.cwd());
    }
    const existingTmuxSession = parsed.tmux && parsed.sessionAlias
      ? await headlessTmuxSessionExists(buildHeadlessTmuxSessionName(parsed.agent, parsed.sessionAlias), env)
      : false;
    if (parsed.profile !== undefined && existingTmuxSession) {
      throw new CliError("--profile cannot be applied to an existing tmux session");
    }
    if (parsed.fast !== undefined && existingTmuxSession) {
      throw new CliError("--fast cannot be applied to an existing tmux session");
    }
    const storedNode = parsed.runId && nodeId ? readRun(env, parsed.runId)?.nodes[nodeId] : undefined;
    const storedFastMode = storedNode?.agent === parsed.agent ? storedNode.fast : undefined;
    const fast = parsed.fast ?? storedFastMode;
    const storedProfile = storedNode?.agent === parsed.agent ? storedNode.profile : undefined;
    const profile = parsed.profile ?? storedProfile ?? (
      parsed.agent === "codex" && parsed.sessionAlias
        ? readStoredSession(env, parsed.agent, parsed.sessionAlias)?.profile
        : undefined
    );
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
          profile: teamNode.agent === "codex" ? profile : undefined,
          fast: teamNode.agent === "claude" || teamNode.agent === "codex" ? fast : undefined,
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
        profile,
        fast,
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
      const tmuxWaitWorkDir = cwd ?? process.cwd();
      const sessionName = parsed.sessionAlias
        ? buildHeadlessTmuxSessionName(parsed.agent, parsed.sessionAlias)
        : undefined;
      if (sessionName && existingTmuxSession) {
        const existingStrategy = parsed.wait
          ? resolveExistingSessionWaitStrategy(parsed.agent, parsed.sessionAlias, sessionName, env)
          : undefined;
        const tmuxPrompt =
          existingStrategy?.kind === "marker" ? promptWithTmuxWaitMarker(composedPrompt, sessionName) : composedPrompt;
        const tmuxCommands = buildTmuxSendCommands(sessionName, tmuxPrompt);
        if (parsed.printCommand) {
          for (const command of tmuxCommands.commands) {
            stdout(`${quoteCommand(command)}\n`);
          }
          return 0;
        }
        const waitSnapshot = existingStrategy
          ? createTmuxWaitSnapshot(parsed.agent, tmuxWaitWorkDir, env, existingStrategy)
          : undefined;
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
              profile,
              fast,
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
          if (waitSnapshot) {
            stderr(`sent: ${tmuxCommands.sessionName}\n`);
            const finalMessage = await waitForTmuxFinalMessage(
              parsed.agent,
              tmuxCommands.sessionName,
              tmuxWaitWorkDir,
              env,
              waitSnapshot,
              commandTimeoutSeconds,
            );
            if (parsed.runId && parsed.role && nodeId) {
              updateNodeStatus(env, parsed.runId, nodeId, "idle", finalMessage);
            }
            const deleteCode = parsed.delete ? await deleteTmuxSession(tmuxCommands.sessionName, env, stderr) : 0;
            stdout(`${finalMessage}\n`);
            return deleteCode;
          }
          stdout(`sent: ${tmuxCommands.sessionName}\n`);
        }
        return code;
      }
      const tmuxNamePart = parsed.sessionAlias ?? parsed.tmuxName ?? String(process.pid);
      const tmuxSessionName = buildHeadlessTmuxSessionName(parsed.agent, tmuxNamePart);
      // Decide how `--tmux --wait` will locate this run's transcript without a
      // prompt marker (pin/mint/tag/dir per harness; claim under a launch lock).
      const waitPlan = parsed.wait
        ? await resolveTmuxWaitPlan(parsed.agent, tmuxSessionName, composedPrompt, cwd, env)
        : undefined;
      const tmuxPrompt = waitPlan?.prompt ?? composedPrompt;
      const tmuxCommandOptions = {
        prompt: tmuxPrompt,
        model: configuredDefaults.model,
        profile,
        allow,
        fast,
        reasoningEffort: configuredDefaults.reasoningEffort,
        ...(waitPlan?.identity ?? {}),
      };
      const tmuxCommand =
        parsed.agent === "opencode" && parsed.wait
          ? buildInteractiveOpencodeRun(tmuxCommandOptions)
          : buildInteractiveAgentCommand(parsed.agent, tmuxCommandOptions, env);
      const reasoningWarning = unsupportedReasoningEffortWarning(parsed.agent, configuredDefaults.reasoningEffort, "tmux");
      if (reasoningWarning) {
        stderr(reasoningWarning);
      }
      const tmuxCommands = buildTmuxCommands(
        parsed.agent,
        tmuxCommand,
        tmuxPrompt,
        cwd,
        env,
        tmuxNamePart,
        { pastePrompt: !(parsed.agent === "opencode" && parsed.wait) },
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

      // The claim tier holds a short launch lock until a brand-new transcript
      // appears, then releases before the long wait.
      const claimLock =
        waitPlan?.strategy.kind === "claim"
          ? acquireLaunchLock(env, parsed.agent, claimLockScope(parsed.agent, tmuxWaitWorkDir))
          : undefined;
      const waitSnapshot = waitPlan
        ? createTmuxWaitSnapshot(parsed.agent, tmuxWaitWorkDir, env, waitPlan.strategy)
        : undefined;
      let code: number;
      try {
        code = await executeTmuxCommands(tmuxCommands, cwd, env, stderr);
        if (code === 0 && waitSnapshot?.strategy.kind === "claim") {
          const claimed = await claimNewTranscriptPath(
            parsed.agent,
            tmuxCommands.sessionName,
            tmuxWaitWorkDir,
            env,
            waitSnapshot,
            commandTimeoutSeconds,
          );
          if (claimed) {
            waitSnapshot.strategy = { kind: "claim", claimed };
          }
        }
      } finally {
        claimLock?.release();
      }
      const tmuxWaitStrategy = waitSnapshot ? storedTmuxWaitStrategy(waitSnapshot.strategy) : undefined;
      if (code === 0 && parsed.sessionAlias && (profile || tmuxWaitStrategy) && sessionStorePath(env)) {
        writeStoredTmuxSession(env, {
          agent: parsed.agent,
          alias: parsed.sessionAlias,
          profile,
          tmuxWaitStrategy,
          workDir: cwd,
        });
      }
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
            profile,
            fast,
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
        const sessionLine = `tmux session: ${tmuxCommands.sessionName}\n`;
        const attachLine = `attach: ${quoteCommand(buildTmuxAttachCommand(tmuxCommands.sessionName).command)}\n`;
        if (waitSnapshot) {
          stderr(sessionLine);
          stderr(attachLine);
          const finalMessage = await waitForTmuxFinalMessage(
            parsed.agent,
            tmuxCommands.sessionName,
            tmuxWaitWorkDir,
            env,
            waitSnapshot,
            commandTimeoutSeconds,
          );
          if (parsed.runId && parsed.role && nodeId) {
            updateNodeStatus(env, parsed.runId, nodeId, "idle", finalMessage);
          }
          const deleteCode = parsed.delete ? await deleteTmuxSession(tmuxCommands.sessionName, env, stderr) : 0;
          stdout(`${finalMessage}\n`);
          return deleteCode;
        }
        stdout(sessionLine);
        stdout(attachLine);
      }
      return code;
    }

    let sessionAlias = parsed.sessionAlias;
    if (parsed.runId && parsed.role && coordination === "session" && !parsed.sessionAlias) {
      sessionAlias = nodeId;
    }
    if (parsed.runId && parsed.role && coordination === "oneshot") {
      sessionAlias = undefined;
    }
    let dockerSessionHome = parsed.docker && sessionAlias
      ? dockerSessionHomePath(parsed.agent, sessionAlias, env)
      : undefined;
    if (parsed.docker && sessionAlias && !dockerSessionHome) {
      throw new CliError("HOME is required for --session");
    }
    if (dockerSessionHome) {
      validateDockerSessionEnv(parsed.agent, parsed.dockerEnv);
      validateDockerSessionRootWorkDir(dockerSessionHome, cwd ?? process.cwd());
      dockerSessionHome = ensureDockerSessionHome(dockerSessionHome);
      validateDockerSessionRootWorkDir(dockerSessionHome, cwd ?? process.cwd());
    }
    dockerSessionLock = dockerSessionHome ? await acquireDockerSessionLock(dockerSessionHome) : undefined;
    if (dockerSessionHome) {
      dockerSessionHome = ensureDockerSessionHome(dockerSessionHome);
      validateDockerSessionRootWorkDir(dockerSessionHome, cwd ?? process.cwd());
      ensureDockerSessionStoreDirectory(dockerSessionHome);
      if (parsed.agent === "codex" && profile) {
        ensureDockerSessionProfileDirectory(dockerSessionHome);
      }
    }
    const sessionEnv = dockerSessionHome
      ? { ...env, HOME: dockerSessionHome, [SECURE_SESSION_STORE_ENV]: "1" }
      : env;
    let sessionPlan = buildSessionPlan(parsed.agent, sessionAlias, sessionEnv, parsed.profile);
    if (!parsed.printCommand) {
      sessionPlan = await prepareSessionPlan(parsed.agent, sessionPlan, cwd, env, parsed.docker ? "docker" : "local");
    }
    const commandSessionPlan = dockerSessionHome && sessionPlan
      ? { ...sessionPlan, nativeId: dockerSessionNativeId(parsed.agent, sessionPlan.nativeId, dockerSessionHome) }
      : sessionPlan;
    const effectiveProfile = sessionPlan?.profile ?? profile;
    let command = withRunEnvironment(buildAgentCommand(
      parsed.agent,
      applySessionPlan({
        prompt: composedPrompt,
        promptFile: parsed.role || parsed.runId ? undefined : prompt.promptFile,
        workDir: cwd ?? process.cwd(),
        model: configuredDefaults.model,
        profile: effectiveProfile,
        allow,
        fast,
        reasoningEffort: configuredDefaults.reasoningEffort,
        timeoutSeconds: parsed.modal ? modalTimeoutSeconds : commandTimeoutSeconds,
      }, commandSessionPlan),
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
        persistentHome: dockerSessionHome,
        profile: effectiveProfile,
        runDirHost: parsed.runId ? runDirectory(env, parsed.runId) : undefined,
        runId: parsed.runId,
        sessionBootstrap:
          parsed.agent === "cursor" && sessionPlan?.mode === "new" && dockerSessionHome
            ? "initialize-cursor"
            : undefined,
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
            timeoutSeconds: modalTimeoutSeconds,
            workDir: cwd ?? process.cwd(),
          })
        : command;
      stdout(parsed.json ? renderPrintCommandJson(parsed.agent, configuredDefaults, env, printableCommand, effectiveProfile) : `${quoteCommand(printableCommand)}\n`);
      return 0;
    }
    if (parsed.docker && !commandExists("docker", env)) {
      throw new CliError("docker not found on PATH");
    }

    const sdkTraceWriter =
      parsed.sdkFormat
        ? new SdkTraceWriter(
            parsed.agent,
            parsed.sdkFormat === "ndjson" ? stdout : undefined,
          )
        : undefined;
    const commandStdout = sdkTraceWriter
      ? (text: string) => sdkTraceWriter.write(text)
      : parsed.sdkFormat
        ? () => undefined
        : stdout;
    const stdoutHandling: StdoutHandling = parsed.sdkFormat
      ? "stream"
      : parsed.json
      ? parsed.usage
        ? "stream"
        : parsed.sessionAlias || parsed.runId
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
          intervalMs: resolveRunStatusIntervalMs(env, config.general),
          runId: parsed.runId,
          write: stderr,
        })
      : undefined;
    const waitingSpinner =
      stdoutHandling === "capture" && stderrIsTTY && !statusReporter && !parsed.sdkFormat
        ? createWaitingSpinner(
            waitingSpinnerLabel(parsed.agent, configuredDefaults, env, env.NO_COLOR === undefined, effectiveProfile),
            stderr,
          )
        : undefined;
    const displayStderr = (text: string) => {
      waitingSpinner?.clear();
      stderr(text);
    };
    statusReporter?.start();
    waitingSpinner?.start();
    let result: ExecuteResult | undefined;
    let antigravityUsageTrace = "";
    let antigravityUsageCapture: AntigravityUsageCapture | undefined;
    if (parsed.agent === "antigravity" && parsed.usage && !parsed.docker && !parsed.modal) {
      try {
        antigravityUsageCapture = prepareAntigravityUsageCapture(env, cwd);
        if (antigravityUsageCapture) {
          command = {
            ...command,
            env: { ...(command.env ?? {}), ...antigravityUsageCapture.commandEnv },
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        displayStderr(`headless: could not prepare Antigravity usage capture: ${message}\n`);
      }
    }
    try {
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
            profile: effectiveProfile,
            maxCapturedStdoutBytes: parsed.sdkFormat ? sdkCaptureLimitBytes : undefined,
            waitForStdoutDrain:
              parsed.sdkFormat === "ndjson" ? waitForSdkStdoutDrain : undefined,
            stderr: (text) => {
              commandStderr?.(text);
              const filtered = suppressKnownStderr(parsed.agent as AgentName, text);
              if (filtered) {
                displayStderr(filtered);
              }
            },
            stdout: (text) => {
              commandStdoutLog?.(text);
              return commandStdout(text);
            },
            stdoutHandling,
            timeoutSeconds: modalTimeoutSeconds,
            workDir: cwd ?? process.cwd(),
            })
          : await executeCommand(parsed.agent, command, cwd, env, displayStderr, {
              stdout: commandStdout,
              stdoutHandling,
              stdoutLog: commandStdoutLog,
              stderr: commandStderr,
              timeoutSeconds: commandTimeoutSeconds,
              captureFinalMessageTrace:
                Boolean(parsed.sdkFormat) ||
                (parsed.agent === "antigravity" && parsed.json && Boolean(parsed.runId)),
              captureRelevantTrace:
                Boolean(parsed.sdkFormat) ||
                (parsed.json && (parsed.usage || Boolean(parsed.runId) || Boolean(parsed.sessionAlias))),
              maxFinalMessageTraceBytes: parsed.sdkFormat ? sdkCaptureLimitBytes : undefined,
              waitForStdoutDrain:
                parsed.sdkFormat === "ndjson" ? waitForSdkStdoutDrain : undefined,
              cleanupBeforeParentSignalExit: antigravityUsageCapture?.cleanup,
              inheritedSignalListeners,
            });
        if (result && parsed.modal && parsed.runId && nodeId && stdoutHandling === "capture") {
          appendNodeLog(env, parsed.runId, nodeId, "stdout", result.stdout);
        }
      } finally {
        waitingSpinner?.stop();
        antigravityUsageTrace = antigravityUsageCapture?.read() ?? "";
        antigravityUsageCapture?.cleanup();
      }

      if (dockerSessionHome) {
        dockerSessionHome = ensureDockerSessionHome(dockerSessionHome);
        ensureDockerSessionStoreDirectory(dockerSessionHome);
      }
      if (!result) {
        throw new CliError("agent execution did not produce a result");
      }
      const commandTrace = result.stdout || result.finalMessageTrace || result.usageTrace || "";
      const usageCommandTrace = result.stdout || result.usageTrace || result.finalMessageTrace || "";
      const usageTrace = antigravityUsageTrace
        ? `${usageCommandTrace}\n${antigravityUsageTrace}`
        : usageCommandTrace;
      const capturedNativeSessionId =
        sdkTraceWriter?.nativeSessionId ||
        ((parsed.sdkFormat || sessionPlan) &&
          extractNativeSessionId(parsed.agent, result.usageTrace ?? commandTrace)) ||
        undefined;
      sdkTraceWriter?.flush();
      if (result.code === 0 && sessionPlan) {
        await persistSessionPlan(
          parsed.agent,
          sessionPlan,
          commandTrace,
          cwd,
          sessionEnv,
          dockerSessionHome,
          capturedNativeSessionId,
        );
      }
      if (parsed.runId && parsed.role && nodeId) {
        const finalMessage =
          extractFinalMessage(parsed.agent, commandTrace) ||
          (result.usageTrace && result.usageTrace !== commandTrace
            ? extractFinalMessage(parsed.agent, result.usageTrace)
            : "");
        const metrics = extractRunNodeMetrics(
          parsed.agent,
          usageTrace,
          usageContext(parsed.agent, configuredDefaults, env, effectiveProfile),
        );
        updateNodeStatus(env, parsed.runId, nodeId, result.code === 0 ? "idle" : "failed", finalMessage || undefined, metrics);
        if (result.code === 0 && parsed.role === "orchestrator" && finalMessage) {
          completeIdleRunNodes(env, parsed.runId, nodeId, finalMessage);
        }
      }
      if (parsed.sdkFormat) {
        const finalMessage =
          extractFinalMessage(parsed.agent, commandTrace) ||
          sdkTraceWriter?.finalMessage;
        const agentError = extractAgentError(parsed.agent, commandTrace);
        if (!finalMessage) {
          const exitCode = result.code || 1;
          stdout(
            renderSdkError(
              agentError ||
                (sdkTraceWriter?.oversizedRecord
                  ? `agent output record exceeded the ${sdkCaptureLimitBytes}-byte SDK limit`
                  : `agent exited with code ${exitCode}`),
              exitCode,
              "invoke",
            ),
          );
          return exitCode;
        }
        const context = usageContext(parsed.agent, configuredDefaults, env, effectiveProfile);
        stdout(
          renderSdkResult("invoke", {
            agent: parsed.agent,
            provider: context.provider,
            model: context.model,
            reasoningEffort: configuredDefaults.reasoningEffort,
            profile: effectiveProfile,
            finalMessage,
            nativeSessionId: capturedNativeSessionId,
            ...(parsed.usage
              ? { usage: await buildUsageReport(parsed.agent, usageTrace, context) }
              : {}),
          }, result.code),
        );
        return result.code;
      }
      if (parsed.json) {
        if (parsed.usage) {
          const stdoutEndsWithNewline = result.stdoutEndsWithNewline ?? result.stdout.endsWith("\n");
          const stdoutReceived = result.stdoutReceived ?? Boolean(result.stdout);
          if (stdoutReceived && !stdoutEndsWithNewline) {
            stdout("\n");
          }
          stdout(
            await buildUsageOutput(
              parsed.agent,
              usageTrace,
              usageContext(parsed.agent, configuredDefaults, env, effectiveProfile),
            ),
          );
        }
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
          stdout(
            await buildUsageOutput(
              parsed.agent,
              usageTrace,
              usageContext(parsed.agent, configuredDefaults, env, effectiveProfile),
            ),
          );
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
    } finally {
      statusReporter?.stop();
    }
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
      if (requestedSdkOutput) {
        const message = error instanceof CliError ? error.sdkMessage : "headless command failed";
        stdout(renderSdkError(message, 2, activeSdkCommand));
      } else {
        stderr(`headless: ${error.message}\n`);
      }
      return 2;
    }
    throw error;
  } finally {
    const releaseError = await dockerSessionLock?.release();
    if (releaseError) {
      stderr(`headless: Docker session lock release failed: ${releaseError.message}\n`);
    }
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
