import { readRun, type RunNode, type RunRecord } from "./runs.js";
import type { RunStatus } from "./roles.js";
import type { Env } from "./types.js";

export interface RunStatusReporter {
  poll: () => void;
  start: () => void;
  stop: () => void;
}

export interface RunStatusReporterOptions {
  color?: boolean;
  env: Env;
  intervalMs?: number;
  now?: () => Date;
  runId: string;
  write: (text: string) => void;
}

interface RunSnapshot {
  eventCount: number;
  statuses: Map<string, string>;
}

const defaultIntervalMs = 1000;
const colorCodes = {
  cyan: "36",
  dim: "2",
  green: "32",
  red: "31",
  yellow: "33",
} as const;

type AnsiColor = keyof typeof colorCodes;
type LogLevel = "info" | "ok" | "warn" | "error";

export function createRunStatusReporter(options: RunStatusReporterOptions): RunStatusReporter {
  const intervalMs = options.intervalMs ?? parseRunStatusIntervalMs(options.env.HEADLESS_RUN_STATUS_INTERVAL_MS);
  const color = shouldUseColor(options);
  const now = options.now ?? (() => new Date());
  let previous: RunSnapshot | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let finalEmitted = false;

  const poll = (): void => {
    const run = readRun(options.env, options.runId);
    if (!run) {
      return;
    }

    if (!previous) {
      writeLog(options.write, now, color, "info", run.runId, `started ${rootNodeName(run)} (${initialRunSummary(run, color)})`);
      previous = snapshot(run);
      return;
    }

    emitStatusTransitions(options.write, now, color, previous, run);
    emitMessageEvents(options.write, now, color, previous.eventCount, run);
    previous = snapshot(run);
  };

  const start = (): void => {
    if (timer || stopped) {
      return;
    }
    poll();
    timer = setInterval(poll, intervalMs);
    timer.unref?.();
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    stopped = true;
    poll();
    const run = readRun(options.env, options.runId);
    if (run && !finalEmitted) {
      finalEmitted = true;
      const label = activeCount(run) === 0 ? "idle" : "stopped";
      writeLog(options.write, now, color, activeCount(run) === 0 ? "ok" : "warn", run.runId, `${label} (${runSummary(run, color)})`);
    }
  };

  return { poll, start, stop };
}

export function parseRunStatusIntervalMs(value: string | undefined): number {
  if (value === undefined) {
    return defaultIntervalMs;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultIntervalMs;
}

function emitStatusTransitions(
  write: (text: string) => void,
  now: () => Date,
  color: boolean,
  previous: RunSnapshot,
  run: RunRecord,
): void {
  for (const node of sortedNodes(run)) {
    const oldStatus = previous.statuses.get(node.nodeId);
    if (oldStatus === undefined) {
      writeLog(write, now, color, "info", run.runId, `${node.nodeId} registered ${paintStatus(node.status, color)}`);
      continue;
    }
    if (oldStatus !== node.status) {
      writeLog(
        write,
        now,
        color,
        transitionLevel(node.status),
        run.runId,
        `${node.nodeId} ${paintStatus(oldStatus, color)} -> ${paintStatus(node.status, color)}`,
      );
    }
  }
}

function emitMessageEvents(
  write: (text: string) => void,
  now: () => Date,
  color: boolean,
  previousEventCount: number,
  run: RunRecord,
): void {
  const start = previousEventCount <= run.events.length ? previousEventCount : run.events.length;
  for (const event of run.events.slice(start)) {
    if (event.type !== "message_sent") {
      continue;
    }
    writeLog(write, now, color, "info", run.runId, `message ${event.nodeId ?? "cli"} -> ${event.targetNodeId ?? "unknown"}`);
  }
}

function snapshot(run: RunRecord): RunSnapshot {
  return {
    eventCount: run.events.length,
    statuses: new Map(sortedNodes(run).map((node) => [node.nodeId, node.status])),
  };
}

function rootNodeName(run: RunRecord): string {
  return run.nodes.orchestrator ? "orchestrator" : (sortedNodes(run)[0]?.nodeId ?? "run");
}

function runSummary(run: RunRecord, color: boolean): string {
  return `${activeCount(run)} active; ${statusSummary(run, color)}`;
}

function initialRunSummary(run: RunRecord, color: boolean): string {
  return `${sortedNodes(run).length} nodes, ${runSummary(run, color)}`;
}

function activeCount(run: RunRecord): number {
  return sortedNodes(run).filter((node) => node.status === "busy" || node.status === "starting").length;
}

function statusSummary(run: RunRecord, color: boolean): string {
  const counts = new Map<string, number>();
  for (const node of sortedNodes(run)) {
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${paintStatus(status, color)}`)
    .join(", ");
}

function sortedNodes(run: RunRecord): RunNode[] {
  return Object.values(run.nodes).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function writeLog(
  write: (text: string) => void,
  now: () => Date,
  color: boolean,
  level: LogLevel,
  runId: string,
  message: string,
): void {
  const timestamp = paint(now().toISOString(), "dim", color);
  const label = level.toUpperCase();
  write(`${timestamp} ${paint(label, levelColor(level), color)}${" ".repeat(5 - label.length)} headless run ${runId} ${message}\n`);
}

function transitionLevel(status: string): LogLevel {
  if (status === "failed" || status === "unknown") return "error";
  if (status === "done" || status === "idle") return "ok";
  if (status === "busy" || status === "starting") return "info";
  return "info";
}

function paintStatus(status: string, color: boolean): string {
  return paint(status, statusColor(status), color);
}

function statusColor(status: string): AnsiColor | undefined {
  switch (status as RunStatus) {
    case "done":
      return "green";
    case "busy":
    case "starting":
      return "yellow";
    case "failed":
    case "unknown":
      return "red";
    case "idle":
      return "cyan";
    case "planned":
      return "dim";
  }
}

function levelColor(level: LogLevel): AnsiColor {
  switch (level) {
    case "ok":
      return "green";
    case "warn":
      return "yellow";
    case "error":
      return "red";
    case "info":
      return "cyan";
  }
}

function paint(text: string, color: AnsiColor | undefined, enabled: boolean): string {
  if (!enabled || !color) {
    return text;
  }
  return `\x1b[${colorCodes[color]}m${text}\x1b[0m`;
}

function shouldUseColor(options: RunStatusReporterOptions): boolean {
  if (options.env.NO_COLOR !== undefined) {
    return false;
  }
  if (options.color !== undefined) {
    return options.color;
  }
  return process.stderr.isTTY === true;
}
