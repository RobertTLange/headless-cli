#!/usr/bin/env node

import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

import { buildAgentCommand, getAgentConfig, getAgentHarness, isAgentName, listAgents } from "./agents.js";
import { quoteCommand } from "./shell.js";
import type { AgentName, BuiltCommand, Env } from "./types.js";

interface ParsedArgs {
  agent?: AgentName;
  prompt?: string;
  promptFile?: string;
  model?: string;
  workDir?: string;
  printCommand: boolean;
  showConfig: boolean;
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
    "Usage: headless <agent> (--prompt <text> | --prompt-file <path>) [options]",
    "",
    `Agents: ${listAgents().join(", ")}`,
    "",
    "Options:",
    "  --model <name>        Agent model override.",
    "  --prompt, -p <text>   Prompt text.",
    "  --prompt-file <path>  Read prompt from a file.",
    "  --work-dir, -C <path> Run from this directory.",
    "  --print-command      Print the command without executing it.",
    "  --show-config        Print harness config paths and auth seed paths.",
    "  -h, --help           Show this help.",
    "",
    "If neither --prompt nor --prompt-file is provided, stdin is used when piped.",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { printCommand: false, showConfig: false, help: false };
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
  if (first === undefined || !isAgentName(first)) {
    throw new CliError(`unsupported agent: ${first ?? ""}`);
  }
  parsed.agent = first;

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

async function resolvePrompt(parsed: ParsedArgs, deps: CliDeps): Promise<{ prompt: string; promptFile?: string }> {
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
    if (harness.promptFileMode === "stdin") {
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

async function executeCommand(command: BuiltCommand, cwd: string | undefined, env: Env): Promise<number> {
  let stdinFd: number | undefined;
  const stdio: ["inherit" | number, "inherit", "inherit"] = ["inherit", "inherit", "inherit"];

  if (command.stdinFile) {
    stdinFd = openSync(command.stdinFile, "r");
    stdio[0] = stdinFd;
  }

  try {
    return await new Promise<number>((resolve) => {
      const child = spawn(command.command, command.args, {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio,
      });

      child.on("error", (error) => {
        console.error(error.message);
        resolve(127);
      });
      child.on("close", (code, signal) => {
        if (signal) {
          resolve(1);
          return;
        }
        resolve(code ?? 1);
      });
    });
  } finally {
    if (stdinFd !== undefined) {
      closeSync(stdinFd);
    }
  }
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
      throw new CliError("missing agent");
    }
    if (parsed.showConfig) {
      stdout(renderConfig(parsed.agent));
      return 0;
    }

    const cwd = validateWorkDir(parsed.workDir);
    const prompt = await resolvePrompt(parsed, deps);
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

    return await executeCommand(command, cwd, env);
  } catch (error) {
    if (error instanceof CliError) {
      stderr(`headless: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
