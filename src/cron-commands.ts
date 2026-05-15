import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

import {
  cronLogPath,
  cronPidPath,
  daemonRunning,
  deleteCronJob,
  killCronExecution,
  listCronJobs,
  nextCronRun,
  parseCronSchedule,
  readCronJob,
  recentCronExecutions,
  recordCronJob,
  resolveHeadlessCronBinary,
  type CronJobRecord,
} from "./cron.js";
import { quoteCommand } from "./shell.js";
import type { AgentName, AllowMode, Env, ReasoningEffort } from "./types.js";

export type CronCommand = "add" | "list" | "view" | "pause" | "resume" | "kill" | "rm" | "start" | "stop";

export interface CronCommandInput {
  command: CronCommand;
  jobId?: string;
  agent?: AgentName;
  every?: string;
  schedule?: string;
  prompt?: string;
  promptFile?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  allow?: AllowMode;
  workDir?: string;
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
  debug: boolean;
  usage: boolean;
  force: boolean;
}

export interface CronCommandHandlers {
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function handleCronCommand(input: CronCommandInput, handlers: CronCommandHandlers): Promise<number> {
  if (input.command === "add") return await cronAdd(input, handlers);
  if (input.command === "list") return cronList(handlers);
  if (input.command === "view") return cronView(requireJobId(input), handlers);
  if (input.command === "pause") return cronPause(requireJobId(input), handlers);
  if (input.command === "resume") return cronResume(requireJobId(input), handlers);
  if (input.command === "kill") return cronKill(requireJobId(input), handlers);
  if (input.command === "rm") return cronRemove(requireJobId(input), input.force, handlers);
  if (input.command === "start") return await cronStart(handlers);
  if (input.command === "stop") return cronStop(handlers);
  throw new Error("unsupported cron command");
}

async function cronAdd(input: CronCommandInput, handlers: CronCommandHandlers): Promise<number> {
  if (!input.agent) {
    throw new Error("cron add requires an agent");
  }
  if (input.prompt !== undefined && input.promptFile !== undefined) {
    throw new Error("use either --prompt or --prompt-file, not both");
  }
  if (input.prompt === undefined && input.promptFile === undefined) {
    throw new Error("cron add requires --prompt or --prompt-file");
  }
  const schedule = parseCronSchedule({ every: input.every, schedule: input.schedule });
  const args = buildScheduledArgs(input);
  const job = recordCronJob(handlers.env, {
    id: input.jobId,
    agent: input.agent,
    schedule,
    command: {
      args,
      workDir: input.workDir ?? process.cwd(),
    },
  });
  if (!daemonRunning(handlers.env)) {
    await startDaemonProcess(handlers);
  }
  handlers.stdout(`added: ${job.id}\nnext run: ${formatDisplayTime(job.nextRunAt)}\n`);
  return 0;
}

function cronList(handlers: CronCommandHandlers): number {
  const jobs = listCronJobs(handlers.env);
  if (jobs.length === 0) {
    handlers.stdout("No cron jobs\n");
    return 0;
  }
  handlers.stdout(
    renderTable(
      ["id", "agent", "schedule", "status", "next run", "last run", "last exit"],
      jobs.map((job) => [
        job.id,
        job.agent,
        scheduleLabel(job),
        job.status,
        formatDisplayTime(job.nextRunAt),
        job.lastRunAt ? formatDisplayTime(job.lastRunAt) : "-",
        job.lastExitCode === undefined || job.lastExitCode === null ? "-" : String(job.lastExitCode),
      ]),
    ),
  );
  if (!daemonRunning(handlers.env)) {
    handlers.stdout("daemon: stopped\n");
  }
  return 0;
}

function cronView(jobId: string, handlers: CronCommandHandlers): number {
  const job = requireJob(handlers.env, jobId);
  const executions = recentCronExecutions(handlers.env, jobId, 10);
  const lines = [
    `id: ${job.id}`,
    `agent: ${job.agent}`,
    `schedule: ${scheduleLabel(job)}`,
    `status: ${job.status}`,
    `daemon: ${daemonRunning(handlers.env) ? "running" : "stopped"}`,
    `timezone: ${job.timezone}`,
    `work dir: ${job.command.workDir}`,
    `command: ${quoteCommand({ command: "headless", args: job.command.args })}`,
    `active execution: ${job.activeExecutionId ?? "-"}`,
    `pending: ${job.pending ? "yes" : "no"}`,
    `next run: ${formatDisplayTime(job.nextRunAt)}`,
    `last run: ${job.lastRunAt ? formatDisplayTime(job.lastRunAt) : "-"}`,
    `last exit: ${job.lastExitCode === undefined || job.lastExitCode === null ? "-" : String(job.lastExitCode)}`,
  ];
  const promptFile = promptFileFromArgs(job.command.args);
  if (promptFile) {
    lines.push(`prompt file: ${promptFile}`);
    if (!existsSync(promptFile)) {
      lines.push(`warning: prompt file not found: ${promptFile}`);
    }
  }
  lines.push("", "recent executions:");
  if (executions.length === 0) {
    lines.push("  none");
  } else {
    for (const execution of executions) {
      const duration = execution.completedAt
        ? `${Math.max(0, new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime())}ms`
        : "-";
      lines.push(
        `  ${execution.executionId} ${execution.status} exit=${execution.exitCode ?? "-"} duration=${duration}`,
        `    stdout: ${execution.stdoutLog}`,
        `    stderr: ${execution.stderrLog}`,
      );
      if (execution.finalMessage) {
        lines.push(`    final: ${execution.finalMessage}`);
      }
    }
  }
  handlers.stdout(`${lines.join("\n")}\n`);
  return 0;
}

function cronPause(jobId: string, handlers: CronCommandHandlers): number {
  const job = requireJob(handlers.env, jobId);
  recordCronJob(handlers.env, { ...job, status: "paused", pending: false, updatedAt: new Date().toISOString() });
  handlers.stdout(`paused: ${jobId}\n`);
  return 0;
}

function cronResume(jobId: string, handlers: CronCommandHandlers): number {
  const job = requireJob(handlers.env, jobId);
  const now = new Date();
  const schedule = parseCronSchedule(job.schedule.kind === "every" ? { every: job.schedule.value } : { schedule: job.schedule.value });
  const resumed = recordCronJob(handlers.env, {
    ...job,
    schedule,
    status: "active",
    pending: false,
    nextRunAt: nextCronRun(schedule, now).toISOString(),
    updatedAt: now.toISOString(),
  });
  handlers.stdout(`resumed: ${jobId}\nnext run: ${formatDisplayTime(resumed.nextRunAt)}\n`);
  return 0;
}

function cronKill(jobId: string, handlers: CronCommandHandlers): number {
  const job = requireJob(handlers.env, jobId);
  killCronExecution(handlers.env, job);
  handlers.stdout(`killed: ${jobId}\n`);
  return 0;
}

function cronRemove(jobId: string, force: boolean, handlers: CronCommandHandlers): number {
  const job = requireJob(handlers.env, jobId);
  if (job.activeExecutionId && !force) {
    throw new Error(`job has an active execution; use --force to remove: ${jobId}`);
  }
  if (job.activeExecutionId) {
    killCronExecution(handlers.env, job);
  }
  deleteCronJob(handlers.env, jobId);
  handlers.stdout(`removed: ${jobId}\n`);
  return 0;
}

async function cronStart(handlers: CronCommandHandlers): Promise<number> {
  if (daemonRunning(handlers.env)) {
    handlers.stdout("daemon already running\n");
    return 0;
  }
  await startDaemonProcess(handlers);
  handlers.stdout("daemon started\n");
  return 0;
}

function cronStop(handlers: CronCommandHandlers): number {
  const pid = readDaemonPid(handlers.env);
  if (!pid) {
    handlers.stdout("daemon already stopped\n");
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    handlers.stdout("daemon already stopped\n");
    return 0;
  }
  handlers.stdout("daemon stopped\n");
  return 0;
}

function buildScheduledArgs(input: CronCommandInput): string[] {
  const args = [input.agent as string];
  if (input.prompt !== undefined) args.push("--prompt", input.prompt);
  if (input.promptFile !== undefined) args.push("--prompt-file", input.promptFile);
  if (input.model !== undefined) args.push("--model", input.model);
  if (input.reasoningEffort !== undefined) args.push("--reasoning-effort", input.reasoningEffort);
  if (input.allow !== undefined) args.push("--allow", input.allow);
  if (input.workDir !== undefined) args.push("--work-dir", input.workDir);
  if (input.docker) args.push("--docker");
  if (input.dockerImage !== undefined) args.push("--docker-image", input.dockerImage);
  for (const value of input.dockerArgs) args.push("--docker-arg", value);
  for (const value of input.dockerEnv) args.push("--docker-env", value);
  if (input.modal) args.push("--modal");
  if (input.modalApp !== undefined) args.push("--modal-app", input.modalApp);
  if (input.modalCpu !== undefined) args.push("--modal-cpu", String(input.modalCpu));
  for (const value of input.modalEnv) args.push("--modal-env", value);
  if (input.modalImage !== undefined) args.push("--modal-image", input.modalImage);
  if (input.modalImageSecret !== undefined) args.push("--modal-image-secret", input.modalImageSecret);
  if (input.modalIncludeGit) args.push("--modal-include-git");
  if (input.modalMemoryMiB !== undefined) args.push("--modal-memory", String(input.modalMemoryMiB));
  for (const value of input.modalSecrets) args.push("--modal-secret", value);
  if (input.modalTimeoutSeconds !== undefined) args.push("--modal-timeout", String(input.modalTimeoutSeconds));
  if (input.timeoutSeconds !== undefined) args.push("--timeout", String(input.timeoutSeconds));
  if (input.json) args.push("--json");
  if (input.debug) args.push("--debug");
  if (input.usage) args.push("--usage");
  return args;
}

async function startDaemonProcess(handlers: CronCommandHandlers): Promise<void> {
  const logPath = cronLogPath(handlers.env);
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const stdoutFd = openSync(logPath, "a", 0o600);
  const stderrFd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  let failed = false;
  const child = spawn(resolveHeadlessCronBinary(handlers.env), ["cron-daemon"], {
    detached: true,
    env: handlers.env as NodeJS.ProcessEnv,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  child.on("error", () => {
    failed = true;
    // Add/list/view still operate on persisted state; daemon status is visible separately.
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  child.unref();
  const deadline = Date.now() + 1000;
  while (!failed && Date.now() < deadline) {
    if (daemonRunning(handlers.env)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function requireJobId(input: CronCommandInput): string {
  if (!input.jobId) {
    throw new Error(`cron ${input.command} requires a job id`);
  }
  return input.jobId;
}

function requireJob(env: Env, jobId: string): CronJobRecord {
  const job = readCronJob(env, jobId);
  if (!job) {
    throw new Error(`unknown cron job: ${jobId}`);
  }
  return job;
}

function scheduleLabel(job: CronJobRecord): string {
  return job.schedule.kind === "every" ? `every ${job.schedule.value}` : job.schedule.value;
}

function promptFileFromArgs(args: string[]): string | undefined {
  const index = args.indexOf("--prompt-file");
  return index >= 0 ? args[index + 1] : undefined;
}

function formatDisplayTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)].join("\n").concat("\n");
}

function readDaemonPid(env: Env): number | undefined {
  if (!existsSync(cronPidPath(env))) {
    return undefined;
  }
  const parsed = Number.parseInt(readFileSync(cronPidPath(env), "utf8").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
