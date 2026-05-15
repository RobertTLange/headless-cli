import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { extractFinalMessage } from "./output.js";
import { nextCronRun, parseCronSchedule, type CronSchedule } from "./cron-schedule.js";
import type { AgentName, Env } from "./types.js";

export { nextCronRun, parseCronSchedule, type CronSchedule } from "./cron-schedule.js";

const privateDirMode = 0o700;
const privateFileMode = 0o600;
const daemonPollMs = 1000;

export type CronJobStatus = "active" | "paused" | "disabled";
export type CronExecutionStatus = "running" | "succeeded" | "failed" | "killed";

export interface CronCommandRecord {
  args: string[];
  workDir: string;
}

export interface CronJobRecord {
  version: 1;
  id: string;
  agent: AgentName;
  schedule: CronSchedule;
  status: CronJobStatus;
  timezone: string;
  command: CronCommandRecord;
  nextRunAt: string;
  lastRunAt?: string;
  lastExitCode?: number | null;
  lastExecutionId?: string;
  activeExecutionId: string | null;
  pending: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CronExecutionRecord {
  version: 1;
  jobId: string;
  executionId: string;
  status: CronExecutionStatus;
  pid: number | null;
  startedAt: string;
  completedAt?: string;
  exitCode: number | null;
  signal: string | null;
  finalMessage?: string;
  stdoutLog: string;
  stderrLog: string;
}

export interface NewCronJobInput {
  id?: string;
  agent: AgentName;
  schedule: CronSchedule;
  command: CronCommandRecord;
  now?: Date;
}

export function cronRoot(env: Env): string {
  if (env.HEADLESS_CRON_DIR) {
    return env.HEADLESS_CRON_DIR;
  }
  if (!env.HOME) {
    throw new Error("HOME is required for headless cron");
  }
  return join(env.HOME, ".headless", "cron");
}

export function cronPidPath(env: Env): string {
  return join(cronRoot(env), "daemon.pid");
}

export function cronLogPath(env: Env): string {
  return join(cronRoot(env), "daemon.log");
}

export function recordCronJob(env: Env, input: NewCronJobInput | CronJobRecord): CronJobRecord {
  const job = "version" in input ? normalizeJob(input) : createJob(input);
  validateCronJobId(job.id);
  ensurePrivateDir(jobsRoot(env));
  ensurePrivateDir(jobHistoryRoot(env, job.id));
  writeJsonPrivate(jobFilePath(env, job.id), job);
  return job;
}

export function readCronJob(env: Env, id: string): CronJobRecord | undefined {
  validateCronJobId(id);
  const path = jobFilePath(env, id);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CronJobRecord>;
    if (parsed.version !== 1 || parsed.id !== id || !parsed.schedule || !parsed.command) {
      return undefined;
    }
    return normalizeJob(parsed as CronJobRecord);
  } catch {
    return undefined;
  }
}

export function listCronJobs(env: Env): CronJobRecord[] {
  const root = jobsRoot(env);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readCronJob(env, entry.slice(0, -5)))
    .filter((job): job is CronJobRecord => Boolean(job))
    .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt) || left.id.localeCompare(right.id));
}

export function deleteCronJob(env: Env, id: string): void {
  validateCronJobId(id);
  rmSync(jobFilePath(env, id), { force: true });
  rmSync(jobHistoryRoot(env, id), { force: true, recursive: true });
}

export function daemonRunning(env: Env): boolean {
  const pid = readPidFile(cronPidPath(env));
  return pid !== undefined && processAlive(pid);
}

export function resolveHeadlessCronBinary(env: Env): string {
  return env.HEADLESS_CLI_BIN || env.HEADLESS_BIN || process.argv[1] || "headless";
}

export async function runDueCronJobsOnce(env: Env, now = new Date()): Promise<void> {
  reconcileCronJobs(env);
  for (const job of listCronJobs(env)) {
    if (job.status !== "active" || job.nextRunAt > now.toISOString()) {
      continue;
    }
    if (job.activeExecutionId) {
      recordCronJob(env, {
        ...job,
        pending: true,
        nextRunAt: nextCronRun(job.schedule, now).toISOString(),
        updatedAt: now.toISOString(),
      });
      continue;
    }
    startCronExecution(env, job, now);
  }
}

export async function runCronDaemon(env: Env): Promise<void> {
  const release = acquireDaemonLock(env);
  let stopped = false;
  const stop = () => {
    stopped = true;
    killAllActiveExecutions(env);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  writeJsonPrivate(cronPidPath(env), `${process.pid}\n`);
  appendDaemonLog(env, `started ${process.pid}\n`);
  try {
    while (!stopped) {
      await runDueCronJobsOnce(env);
      await new Promise((resolve) => setTimeout(resolve, daemonPollMs));
    }
  } finally {
    appendDaemonLog(env, `stopped ${process.pid}\n`);
    rmSync(cronPidPath(env), { force: true });
    release();
  }
}

export function killCronExecution(env: Env, job: CronJobRecord, status: CronJobStatus = "disabled"): CronJobRecord {
  const execution = job.activeExecutionId ? readExecution(env, job.id, job.activeExecutionId) : undefined;
  if (execution?.pid && processAlive(execution.pid)) {
    try {
      process.kill(execution.pid, "SIGTERM");
    } catch {
      // The reconciler will mark stale records killed.
    }
  }
  if (execution) {
    writeExecution(env, job.id, {
      ...execution,
      status: "killed",
      completedAt: new Date().toISOString(),
      exitCode: null,
      signal: "SIGTERM",
    });
  }
  return recordCronJob(env, {
    ...job,
    status,
    activeExecutionId: null,
    pending: false,
    updatedAt: new Date().toISOString(),
  });
}

export function recentCronExecutions(env: Env, jobId: string, limit = 10): CronExecutionRecord[] {
  validateCronJobId(jobId);
  const root = executionsRoot(env, jobId);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .map((entry) => readExecution(env, jobId, entry))
    .filter((execution): execution is CronExecutionRecord => Boolean(execution))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
}

function startCronExecution(env: Env, job: CronJobRecord, now: Date): ChildProcess {
  const executionId = generatedExecutionId(now);
  const executionDir = executionRoot(env, job.id, executionId);
  ensurePrivateDir(executionDir);
  const stdoutLog = join(executionDir, "stdout.log");
  const stderrLog = join(executionDir, "stderr.log");
  const stdoutFd = openSync(stdoutLog, "a", privateFileMode);
  const stderrFd = openSync(stderrLog, "a", privateFileMode);
  chmodSync(stdoutLog, privateFileMode);
  chmodSync(stderrLog, privateFileMode);
  let logsClosed = false;
  const closeLogs = () => {
    if (logsClosed) return;
    logsClosed = true;
    closeSync(stdoutFd);
    closeSync(stderrFd);
  };

  const child = spawn(resolveHeadlessCronBinary(env), job.command.args, {
    cwd: job.command.workDir,
    detached: false,
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  const running: CronExecutionRecord = {
    version: 1,
    jobId: job.id,
    executionId,
    status: "running",
    pid: child.pid ?? null,
    startedAt: now.toISOString(),
    exitCode: null,
    signal: null,
    stdoutLog,
    stderrLog,
  };
  writeExecution(env, job.id, running);
  recordCronJob(env, {
    ...job,
    activeExecutionId: executionId,
    pending: false,
    lastRunAt: now.toISOString(),
    lastExecutionId: executionId,
    nextRunAt: nextCronRun(job.schedule, now).toISOString(),
    updatedAt: now.toISOString(),
  });

  child.on("close", (code, signal) => {
    closeLogs();
    finishCronExecution(env, job.id, executionId, code ?? null, signal ?? null);
  });
  child.on("error", () => {
    closeLogs();
    finishCronExecution(env, job.id, executionId, 127, null);
  });
  return child;
}

function finishCronExecution(env: Env, jobId: string, executionId: string, code: number | null, signal: string | null): void {
  const execution = readExecution(env, jobId, executionId);
  if (!execution || execution.status === "killed") {
    return;
  }
  const stdout = existsSync(execution.stdoutLog) ? readFileSync(execution.stdoutLog, "utf8") : "";
  const job = readCronJob(env, jobId);
  const status = signal ? "killed" : code === 0 ? "succeeded" : "failed";
  writeExecution(env, jobId, {
    ...execution,
    status,
    completedAt: new Date().toISOString(),
    exitCode: code,
    signal,
    finalMessage: job ? extractFinalMessage(job.agent, stdout) || undefined : undefined,
  });
  if (!job || job.activeExecutionId !== executionId) {
    return;
  }
  const updated = recordCronJob(env, {
    ...job,
    activeExecutionId: null,
    lastExitCode: code,
    updatedAt: new Date().toISOString(),
  });
  if (updated.pending && updated.status === "active") {
    startCronExecution(env, { ...updated, activeExecutionId: null, pending: false }, new Date());
  }
}

function reconcileCronJobs(env: Env): void {
  for (const job of listCronJobs(env)) {
    if (!job.activeExecutionId) {
      continue;
    }
    const execution = readExecution(env, job.id, job.activeExecutionId);
    if (execution?.pid && processAlive(execution.pid)) {
      continue;
    }
    writeExecution(env, job.id, {
      ...(execution ?? missingExecution(env, job)),
      status: "killed",
      completedAt: new Date().toISOString(),
      exitCode: null,
      signal: "stale",
    });
    recordCronJob(env, { ...job, activeExecutionId: null, pending: false, updatedAt: new Date().toISOString() });
  }
}

function killAllActiveExecutions(env: Env): void {
  for (const job of listCronJobs(env)) {
    if (job.activeExecutionId) {
      killCronExecution(env, job, job.status);
    }
  }
}

function createJob(input: NewCronJobInput): CronJobRecord {
  const now = input.now ?? new Date();
  const id = input.id ?? generatedJobId(now);
  return {
    version: 1,
    id,
    agent: input.agent,
    schedule: input.schedule,
    status: "active",
    timezone: resolvedTimezone(),
    command: input.command,
    nextRunAt: nextCronRun(input.schedule, now).toISOString(),
    activeExecutionId: null,
    pending: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function normalizeJob(job: CronJobRecord): CronJobRecord {
  return {
    ...job,
    version: 1,
    status: job.status ?? "active",
    activeExecutionId: job.activeExecutionId ?? null,
    pending: Boolean(job.pending),
  };
}

function validateCronJobId(value: string): string {
  if (!value || value === "." || value === ".." || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("invalid cron job id; use letters, numbers, dots, dashes, or underscores");
  }
  return value;
}

function jobsRoot(env: Env): string {
  return join(cronRoot(env), "jobs");
}

function jobFilePath(env: Env, id: string): string {
  return join(jobsRoot(env), `${id}.json`);
}

function jobHistoryRoot(env: Env, id: string): string {
  return join(jobsRoot(env), id);
}

function executionsRoot(env: Env, jobId: string): string {
  return join(jobHistoryRoot(env, jobId), "executions");
}

function executionRoot(env: Env, jobId: string, executionId: string): string {
  return join(executionsRoot(env, jobId), executionId);
}

function executionPath(env: Env, jobId: string, executionId: string): string {
  return join(executionRoot(env, jobId, executionId), "result.json");
}

function readExecution(env: Env, jobId: string, executionId: string): CronExecutionRecord | undefined {
  const path = executionPath(env, jobId, executionId);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CronExecutionRecord;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeExecution(env: Env, jobId: string, execution: CronExecutionRecord): void {
  ensurePrivateDir(executionRoot(env, jobId, execution.executionId));
  writeJsonPrivate(executionPath(env, jobId, execution.executionId), execution);
}

function missingExecution(env: Env, job: CronJobRecord): CronExecutionRecord {
  const executionId = job.activeExecutionId ?? generatedExecutionId(new Date());
  const root = executionRoot(env, job.id, executionId);
  return {
    version: 1,
    jobId: job.id,
    executionId,
    status: "killed",
    pid: null,
    startedAt: job.lastRunAt ?? new Date().toISOString(),
    exitCode: null,
    signal: "stale",
    stdoutLog: join(root, "stdout.log"),
    stderrLog: join(root, "stderr.log"),
  };
}

function generatedJobId(now: Date): string {
  return `cron-${timestampId(now)}-${randomBytes(2).toString("hex")}`;
}

function generatedExecutionId(now: Date): string {
  return `exec-${timestampId(now)}-${randomBytes(2).toString("hex")}`;
}

function timestampId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
}

function resolvedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || timezoneOffset();
}

function timezoneOffset(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: privateDirMode });
  chmodSync(path, privateDirMode);
}

function writeJsonPrivate(path: string, value: unknown): void {
  ensurePrivateDir(dirname(path));
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(2).toString("hex")}`;
  writeFileSync(tmpPath, text, { mode: privateFileMode });
  chmodSync(tmpPath, privateFileMode);
  renameSync(tmpPath, path);
  chmodSync(path, privateFileMode);
}

function appendDaemonLog(env: Env, text: string): void {
  const path = cronLogPath(env);
  ensurePrivateDir(dirname(path));
  writeFileSync(path, `${new Date().toISOString()} ${text}`, { flag: "a", mode: privateFileMode });
  chmodSync(path, privateFileMode);
}

function readPidFile(path: string): number | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireDaemonLock(env: Env): () => void {
  const lockPath = join(cronRoot(env), "daemon.lock");
  ensurePrivateDir(dirname(lockPath));
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", privateFileMode);
  } catch {
    throw new Error("cron daemon already running");
  }
  chmodSync(lockPath, privateFileMode);
  writeFileSync(fd, `${process.pid}\n`);
  return () => {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  };
}
