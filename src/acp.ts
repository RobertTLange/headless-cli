import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type { AllowMode, BuiltCommand, Env } from "./types.js";

type JsonRecord = Record<string, unknown>;

interface AcpRegistry {
  agents?: unknown[];
}

const defaultRegistryUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

interface AcpDistributionCommand {
  command: string;
  args: string[];
  env?: Env;
}

export interface RunAcpClientOptions {
  agentCommand: BuiltCommand;
  prompt: string;
  cwd?: string;
  env: Env;
  allow?: AllowMode;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function splitCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (quote) throw new Error(`unterminated quote in ACP command: ${value}`);
  if (current) parts.push(current);
  return parts;
}

export function commandFromCustom(value: string): AcpDistributionCommand {
  const parts = splitCommandLine(value.trim());
  if (parts.length === 0 || !parts[0]) {
    throw new Error("ACP custom command is empty");
  }
  return { command: parts[0], args: parts.slice(1) };
}

function platformBinaryKey(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${os}-${arch}`;
}

function commandFromDistribution(agent: JsonRecord): AcpDistributionCommand | undefined {
  const distribution = asRecord(agent.distribution);
  const npx = asRecord(distribution.npx);
  if (Object.keys(npx).length > 0) {
    const packageName = asString(npx.package).trim();
    if (!packageName) return undefined;
    return {
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["-y", packageName, ...asStringArray(npx.args)],
      env: Object.fromEntries(
        Object.entries(asRecord(npx.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    };
  }

  const binary = asRecord(distribution.binary);
  const platformBinary = asRecord(binary[platformBinaryKey()]);
  const command = asString(platformBinary.cmd).trim();
  if (command) {
    return { command, args: asStringArray(platformBinary.args) };
  }
  return undefined;
}

export function resolveAcpDistributionCommand(agentId: string, registry: AcpRegistry): AcpDistributionCommand {
  const normalized = agentId.trim().toLowerCase();
  const agents = Array.isArray(registry.agents) ? registry.agents.map(asRecord) : [];
  const found = agents.find((agent) => {
    const id = asString(agent.id).trim().toLowerCase();
    const name = asString(agent.name).trim().toLowerCase();
    return id === normalized || name === normalized;
  });
  if (!found) {
    throw new Error(`ACP registry agent not found: ${agentId}`);
  }
  const command = commandFromDistribution(found);
  if (!command) {
    throw new Error(`ACP registry agent has no supported distribution for this platform: ${agentId}`);
  }
  return command;
}

function loadRegistry(env: Env, options: { fetchDefault?: boolean } = {}): AcpRegistry | undefined {
  const registryJson = env.HEADLESS_ACP_REGISTRY_JSON;
  if (registryJson) {
    return JSON.parse(registryJson) as AcpRegistry;
  }
  const registryPath = env.HEADLESS_ACP_REGISTRY_FILE;
  if (registryPath) {
    return JSON.parse(readFileSync(registryPath, "utf8")) as AcpRegistry;
  }
  const registryUrl = env.HEADLESS_ACP_REGISTRY_URL || (options.fetchDefault ? defaultRegistryUrl : undefined);
  if (!registryUrl) {
    return undefined;
  }
  const curl = spawnSync("curl", ["-fsSL", registryUrl], { encoding: "utf8" });
  if (curl.status !== 0) {
    throw new Error(`failed to fetch ACP registry: ${registryUrl}`);
  }
  return JSON.parse(curl.stdout) as AcpRegistry;
}

export function resolveAcpCommand(env: Env): AcpDistributionCommand {
  const customCommand = env.HEADLESS_ACP_COMMAND;
  if (customCommand) {
    return commandFromCustom(customCommand);
  }
  const agentId = env.HEADLESS_ACP_AGENT;
  const registry = agentId ? loadRegistry(env, { fetchDefault: true }) : undefined;
  if (agentId && registry) {
    return resolveAcpDistributionCommand(agentId, registry);
  }
  throw new Error("acp requires --acp-agent, --acp-command, HEADLESS_ACP_AGENT, or HEADLESS_ACP_COMMAND");
}

export function resolveBuiltinAcpStdioCommand(env: Env): AcpDistributionCommand {
  const headlessCommand = commandFromCustom(env.HEADLESS_BIN || "headless");
  return { command: headlessCommand.command, args: [...headlessCommand.args, "acp-stdio"] };
}

function acpOutputRecord(type: string, value: JsonRecord): string {
  return `${JSON.stringify({ type, ...value })}\n`;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (asString(record.type) === "text") return asString(record.text);
  return asString(record.text);
}

export const acpClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: false },
};

class HeadlessAcpClient {
  private assistantText = "";

  constructor(
    private readonly stdout: (text: string) => void,
    private readonly allow: AllowMode | undefined,
  ) {}

  finalAssistantText(): string {
    return this.assistantText.trim();
  }

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    if (this.allow === "read-only") {
      return { outcome: { outcome: "cancelled" } };
    }
    const option = params.options.find((candidate) => candidate.kind === "allow_once") ?? params.options[0];
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = contentText(update.content);
      if (text) {
        this.assistantText += text;
        this.stdout(acpOutputRecord("message_delta", { role: "assistant", content: [{ type: "text", text }] }));
      }
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      this.stdout(acpOutputRecord("session", { sessionId: params.sessionId }));
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    return { content: readFileSync(params.path, "utf8") };
  }

  async writeTextFile(): Promise<acp.WriteTextFileResponse> {
    throw new Error("ACP client file writes are not supported");
  }
}

function childExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

export async function runAcpClient(options: RunAcpClientOptions): Promise<number> {
  const child = spawn(options.agentCommand.command, options.agentCommand.args, {
    cwd: options.cwd,
    env: { ...options.env, ...(options.agentCommand.env ?? {}) } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => options.stderr(chunk));

  if (!child.stdin || !child.stdout) {
    child.kill();
    return 1;
  }

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const client = new HeadlessAcpClient(options.stdout, options.allow);
  const connection = new acp.ClientSideConnection(() => client, stream);

  try {
    await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities });
    const session = await connection.newSession({ cwd: options.cwd ?? process.cwd(), mcpServers: [] });
    options.stdout(acpOutputRecord("session", { sessionId: session.sessionId }));
    const result = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: options.prompt }] });
    const finalText = client.finalAssistantText();
    if (finalText) {
      options.stdout(acpOutputRecord("message", { role: "assistant", content: [{ type: "text", text: finalText }] }));
    }
    options.stdout(acpOutputRecord("result", { stopReason: result.stopReason }));
    child.kill();
    await childExit(child);
    return 0;
  } catch (error) {
    options.stdout(acpOutputRecord("error", { message: error instanceof Error ? error.message : String(error) }));
    child.kill();
    const code = await childExit(child);
    return code === 0 ? 1 : code;
  }
}

export async function runAcpStdioAgent(): Promise<void> {
  const output = Writable.toWeb(process.stdout);
  const input = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(output as WritableStream<Uint8Array>, input as ReadableStream<Uint8Array>);
  const connection = new acp.AgentSideConnection(() => ({
    async initialize(params) {
      return { protocolVersion: params.protocolVersion, agentCapabilities: {} };
    },
    async authenticate() {
      return {};
    },
    async newSession(params) {
      try {
        if (params.cwd) statSync(params.cwd);
      } catch {
        // Match permissive agent behavior; the parent validates work dirs when appropriate.
      }
      return { sessionId: "headless-acp-stdio" };
    },
    async prompt(params) {
      const text = params.prompt.map(contentText).filter(Boolean).join("\n");
      for (const char of text) {
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: char } },
        });
      }
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }), stream);
  await connection.closed;
}
