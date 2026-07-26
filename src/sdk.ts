import { extractFinalMessage, extractNativeSessionId } from "./output.js";
import type { AgentName } from "./types.js";

export const SDK_PROTOCOL_VERSION = 1;
const maxPendingTraceBytes = 4 * 1024 * 1024;

export type SdkFormat = "json" | "ndjson";

export interface SdkResultEnvelope {
  protocolVersion: typeof SDK_PROTOCOL_VERSION;
  type: "result";
  command: string;
  exitCode: number;
  data: unknown;
}

export interface SdkErrorEnvelope {
  protocolVersion: typeof SDK_PROTOCOL_VERSION;
  type: "error";
  command: string;
  exitCode: number;
  error: {
    message: string;
  };
}

export interface SdkTraceEnvelope {
  protocolVersion: typeof SDK_PROTOCOL_VERSION;
  type: "trace";
  command: "invoke";
  data: {
    agent: AgentName;
    value?: unknown;
    raw?: string;
    partial?: boolean;
    sequence?: number;
  };
}

export function renderSdkResult(command: string, data: unknown, exitCode = 0): string {
  const envelope: SdkResultEnvelope = {
    protocolVersion: SDK_PROTOCOL_VERSION,
    type: "result",
    command,
    exitCode,
    data,
  };
  return renderSdkEnvelope(envelope);
}

export function renderSdkError(message: string, exitCode: number, command = "cli"): string {
  const envelope: SdkErrorEnvelope = {
    protocolVersion: SDK_PROTOCOL_VERSION,
    type: "error",
    command,
    exitCode,
    error: { message },
  };
  return renderSdkEnvelope(envelope);
}

export class SdkTraceWriter {
  private pending = "";
  private fragmenting = false;
  private sequence = 0;
  private writable = true;
  finalMessage = "";
  nativeSessionId = "";
  oversizedRecord = false;

  constructor(
    private readonly agent: AgentName,
    private readonly writeOutput?: (text: string) => unknown,
  ) {}

  write(chunk: string): boolean {
    this.writable = true;
    this.pending += chunk;
    let newlineIndex = this.pending.indexOf("\n");
    while (newlineIndex >= 0) {
      let line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      line = this.writeOversizedFragments(line);
      this.writeLine(line);
      newlineIndex = this.pending.indexOf("\n");
    }
    this.pending = this.writeOversizedFragments(this.pending);
    return this.writable;
  }

  flush(): boolean {
    this.writable = true;
    if (!this.pending) {
      if (this.fragmenting) {
        this.writeLine("");
      }
      return this.writable;
    }
    this.writeLine(this.pending);
    this.pending = "";
    return this.writable;
  }

  private writeLine(line: string): void {
    if (this.fragmenting) {
      this.writeFragment(line, false);
      this.fragmenting = false;
      this.sequence = 0;
      return;
    }
    if (!line.trim()) {
      return;
    }
    this.observeLine(line);
    const data: SdkTraceEnvelope["data"] = { agent: this.agent };
    try {
      data.value = JSON.parse(line) as unknown;
    } catch {
      data.raw = line;
    }
    const envelope: SdkTraceEnvelope = {
      protocolVersion: SDK_PROTOCOL_VERSION,
      type: "trace",
      command: "invoke",
      data,
    };
    this.emit(envelope);
  }

  private writeOversizedFragments(line: string): string {
    let remainder = line;
    while (Buffer.byteLength(remainder, "utf8") > maxPendingTraceBytes) {
      const [fragment, next] = splitUtf8Prefix(remainder, maxPendingTraceBytes);
      this.writeFragment(fragment, true);
      this.fragmenting = true;
      this.oversizedRecord = true;
      remainder = next;
    }
    return remainder;
  }

  private writeFragment(raw: string, partial: boolean): void {
    const envelope: SdkTraceEnvelope = {
      protocolVersion: SDK_PROTOCOL_VERSION,
      type: "trace",
      command: "invoke",
      data: {
        agent: this.agent,
        raw,
        partial,
        sequence: this.sequence,
      },
    };
    this.sequence += 1;
    this.emit(envelope);
  }

  private emit(envelope: SdkTraceEnvelope): void {
    if (this.writeOutput?.(renderSdkEnvelope(envelope)) === false) {
      this.writable = false;
    }
  }

  private observeLine(line: string): void {
    this.finalMessage = extractFinalMessage(this.agent, line) || this.finalMessage;
    this.nativeSessionId =
      extractNativeSessionId(this.agent, line) || this.nativeSessionId;
  }
}

function splitUtf8Prefix(text: string, maxBytes: number): [string, string] {
  const encoded = Buffer.from(text, "utf8");
  let end = Math.min(maxBytes, encoded.byteLength);
  while (end > 0 && end < encoded.byteLength && (encoded[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return [encoded.subarray(0, end).toString("utf8"), encoded.subarray(end).toString("utf8")];
}

function renderSdkEnvelope(envelope: SdkResultEnvelope | SdkErrorEnvelope | SdkTraceEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}
