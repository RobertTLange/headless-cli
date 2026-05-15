# Cron Jobs

This spec defines a first-class `headless cron` feature for running Headless agent invocations on a schedule.

## Goals

- Let users schedule the same Headless agent invocation at regular intervals.
- Provide CLI-native visibility into active jobs, recent executions, logs, and daemon status.
- Let users pause, resume, kill, and remove jobs without editing OS scheduler state.
- Keep scheduled execution portable across macOS, Linux, and CI-like developer environments.

## Non-Goals

- No v1 launchd, systemd, or crontab installation.
- No v1 reboot autostart. Users restart the daemon with `headless cron start`.
- No default tmux/session scheduling. Cron executions are one-shot detached invocations by default.
- No unbounded backlog. A single job collapses missed ticks into at most one queued execution.

## Command Surface

```bash
headless cron add <agent> [--name <job-id>] (--every <duration> | --schedule <expr>) (--prompt <text> | --prompt-file <path>) [options]
headless cron list
headless cron view <job-id>
headless cron pause <job-id>
headless cron resume <job-id>
headless cron kill <job-id>
headless cron rm <job-id> [--force]
headless cron start
headless cron stop
```

`cron add` accepts the normal one-shot Headless options that are safe for detached execution: `--model`, `--reasoning-effort`, `--allow`, `--work-dir`, `--docker`, `--docker-*`, `--modal`, `--modal-*`, `--timeout`, `--json`, `--debug`, and `--usage`.

`cron add` uses `--name` as the optional cron job id. It rejects `--tmux`, `--wait`, `--delete`, `--session`, `--run`, `--node`, `--role`, `--coordination`, `--team`, and run-management commands in v1. Scheduled tmux/session reuse needs a separate design.

## Schedule Syntax

Two schedule forms are supported and mutually exclusive:

```bash
headless cron add codex --every 30m --prompt "Summarize repository changes"
headless cron add codex --schedule "0 */6 * * *" --prompt-file ./triage.md
```

`--every` accepts positive durations with units `s`, `m`, `h`, and `d`, such as `30m`, `6h`, or `1d`.

`--schedule` accepts standard five-field cron expressions:

```text
minute hour day-of-month month day-of-week
```

The daemon evaluates schedules in the local system timezone. The stored job records the timezone name or offset observed at creation for display and debugging, but v1 does not implement per-job timezone overrides.

## Job Identity

Jobs have a stable id. Users may supply it with `--name`; otherwise Headless generates one.

```bash
headless cron add codex --name inbox-triage --every 1h --prompt "Triage inbox"
headless cron view inbox-triage
headless cron kill inbox-triage
```

Names use the existing safe-name rule: letters, numbers, dots, dashes, and underscores. Generated ids use a sortable prefix such as `cron-20260515-143012-a7f3`.

## Scheduling Model

Headless owns scheduling through one per-user daemon process.

- `headless cron add` persists the job and starts the daemon if needed.
- `headless cron start` starts the daemon if it is not already running.
- `headless cron stop` stops the daemon without deleting jobs.
- Other cron commands read persisted state directly and should report when the daemon is not running.

Different cron jobs may run concurrently. A single job never has more than one active execution at a time.

If a job's next tick arrives while that same job is still running, the daemon records one pending execution. Further ticks while the job is still running keep that pending flag true; they do not create more backlog. When the active execution exits, the daemon immediately starts the pending execution and clears the flag.

This is the default and only v1 overlap policy.

## Storage Layout

Cron state lives under `~/.headless/cron`.

```text
~/.headless/cron/
  daemon.pid
  daemon.log
  jobs/
    <job-id>.json
    <job-id>/
      executions/
        <execution-id>/
          stdout.log
          stderr.log
          result.json
```

All directories use private permissions equivalent to `0700`. State and log files use private permissions equivalent to `0600`.

`HEADLESS_CRON_DIR` may override the cron root for tests and advanced usage.

## Job Record

Each job file is JSON. The schema version starts at `1`.

```json
{
  "version": 1,
  "id": "inbox-triage",
  "agent": "codex",
  "schedule": { "kind": "every", "value": "1h", "intervalMs": 3600000 },
  "status": "active",
  "timezone": "Europe/Berlin",
  "command": {
    "args": ["codex", "--prompt", "Triage inbox"],
    "workDir": "/Users/rob/project"
  },
  "nextRunAt": "2026-05-15T13:00:00.000Z",
  "lastRunAt": "2026-05-15T12:00:00.000Z",
  "lastExitCode": 0,
  "activeExecutionId": null,
  "pending": false,
  "createdAt": "2026-05-15T11:30:00.000Z",
  "updatedAt": "2026-05-15T12:00:12.000Z"
}
```

`command.args` stores the normalized Headless argv needed to replay the one-shot invocation. Prompt files are stored as file paths, not copied, so `cron view` must show the path and warn if the file no longer exists.

## Execution Record

Each execution gets a sortable id, for example `exec-20260515-120000-b82c`.

`result.json` contains:

```json
{
  "version": 1,
  "jobId": "inbox-triage",
  "executionId": "exec-20260515-120000-b82c",
  "status": "succeeded",
  "pid": 12345,
  "startedAt": "2026-05-15T12:00:00.000Z",
  "completedAt": "2026-05-15T12:00:12.000Z",
  "exitCode": 0,
  "signal": null,
  "finalMessage": "Done.",
  "stdoutLog": "/Users/rob/.headless/cron/jobs/inbox-triage/executions/exec-20260515-120000-b82c/stdout.log",
  "stderrLog": "/Users/rob/.headless/cron/jobs/inbox-triage/executions/exec-20260515-120000-b82c/stderr.log"
}
```

Statuses are `running`, `succeeded`, `failed`, and `killed`.

## List and View Output

`headless cron list` renders a compact table:

```text
id             agent   schedule   status   next run             last run             last exit
inbox-triage   codex   every 1h   active   2026-05-15 15:00     2026-05-15 14:00     0
```

`headless cron view <job-id>` shows:

- job config and stored command
- daemon running state
- current active execution, if any
- pending flag
- next run time
- recent executions with exit code, duration, and log paths
- final extracted assistant message for completed executions when available

## Lifecycle Semantics

`pause` marks a job paused. It does not stop the active execution. Paused jobs do not schedule new executions and do not consume pending ticks.

`resume` marks a paused job active and computes the next run from the current time.

`kill` terminates the active execution if present, marks its result as `killed`, clears `pending`, and disables the job. The persisted job and execution history remain available for `view`.

`rm` deletes a job and its execution history only when no execution is active. `rm --force` first applies `kill` semantics, then deletes persisted state.

`stop` terminates only the daemon. Active child executions should receive `SIGTERM`, then `SIGKILL` after a short grace period, and their execution records should be marked `killed`.

## Daemon Behavior

The daemon loop:

1. Acquires an exclusive daemon lock.
2. Loads all job records.
3. Reconciles stale active executions by checking stored pids.
4. Sleeps until the nearest due job or a short poll interval.
5. Starts due active jobs with no active execution.
6. Records one pending execution for due jobs already running.
7. On child exit, writes `result.json`, updates the job summary, and starts one pending execution immediately if needed.

Child processes use the current Headless binary path. The daemon should prefer `HEADLESS_CLI_BIN`, then `HEADLESS_BIN`, then the current `process.argv[1]` when available, then `headless`.

## Implementation Plan

1. Add `src/cron.ts` for job storage, schedule parsing, daemon lock/pid handling, execution record helpers, and rendering-friendly data structures.
2. Add `src/cron-commands.ts` for `add`, `list`, `view`, `pause`, `resume`, `kill`, `rm`, `start`, and `stop`.
3. Extend `src/cli.ts` parsing with the `cron` subcommand and cron-specific flags.
4. Add an internal daemon entrypoint such as `headless cron-daemon`, hidden from help, so `cron start` can spawn it detached.
5. Reuse existing `quoteCommand`, output extraction, timeout handling, and private-file patterns from `runs.ts` and `run-commands.ts`.
6. Add tests for argument validation, schedule parsing, job persistence, list/view rendering, daemon start idempotency, queue collapse, pause/resume, kill, and rm safety.
7. Document user-facing behavior in `docs/usage.md` after the implementation lands.

## Open Questions for Implementation

- Whether to vendor a cron-expression parser or implement only the five-field subset locally. If adding a dependency, do the normal dependency health check first.
- Whether `cron list --json` and `cron view --json` should be included in v1 for scripting.
- Whether execution history should have a retention limit, such as keeping the last 100 executions per job.
