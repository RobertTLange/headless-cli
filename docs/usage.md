# Usage Guide

This guide covers the detailed CLI behavior behind the short README examples.

## Prompt Input

Use `--prompt` for inline text, `--prompt-file` for file-backed prompts, or pipe stdin when neither is supplied.

```bash
headless codex --prompt "Fix the failing tests"
headless claude --prompt-file task.md --work-dir /path/to/project
printf "Review this diff" | headless pi --model claude-opus
```

## Agents and Defaults

| Agent | Command shape |
| --- | --- |
| `acp` | `headless acp-client -- <acp-server-command>`, selected with `--acp-agent` or `--acp-command` |
| `antigravity` | `agy -p ... --dangerously-skip-permissions` |
| `claude` | `claude -p ... --output-format stream-json --verbose --dangerously-skip-permissions` |
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ...` |
| `cursor` | `agent -p --trust --force --output-format stream-json --model gpt-5.5-medium ...` |
| `gemini` | `gemini --model gemini-3.1-pro-preview --skip-trust -p ... --output-format stream-json --approval-mode yolo` |
| `opencode` | `opencode run --format json --model openai/gpt-5.4 --dangerously-skip-permissions ...` |
| `pi` | `pi --no-session --mode json --provider openai-codex --model gpt-5.5 --tools read,bash,edit,write ...` |

When no agent is specified, Headless selects the first installed agent in this order: `codex`, `claude`, `pi`, `opencode`, `gemini`, `antigravity`, `cursor`. ACP-compatible agents are explicit-only: use `headless acp --acp-agent ...` or `headless acp --acp-command ...`.

When `--model` is omitted, Headless defaults Codex to `gpt-5.5`, Claude to `claude-opus-4-6`, Cursor to the `gpt-5.5` family with medium effort, Gemini to `gemini-3.1-pro-preview`, OpenCode to `openai/gpt-5.4`, and Pi to `openai-codex/gpt-5.5`. Antigravity has no built-in Headless model default; pass one of the names reported by `agy models` with `--model` when you want a per-run override.

## ACP Agents

ACP support uses [Agent Client Protocol](https://agentclientprotocol.com/) to run any compatible ACP server behind the normal Headless prompt/output flow. Unlike built-in concrete agents, `acp` requires an explicit backend via `--acp-agent`, `--acp-command`, or their environment equivalents.

Resolve an agent from the public ACP registry by id or name:

```bash
headless acp --acp-agent auggie --prompt "Inspect this repository"
```

Headless fetches `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` when `--acp-agent` is used. Override the source with a URL or local registry file:

```bash
headless acp --acp-agent example-acp --acp-registry https://example.com/registry.json --prompt "Summarize this repo"
headless acp --acp-agent example-acp --acp-registry-file ./registry.json --prompt "Run the focused tests"
```

Use a custom ACP server command when the command is not in the registry or when you want full control over the launch command:

```bash
headless acp --acp-command "atlas alta agent run" --prompt "Fix the failing tests"
printf "Review this diff" | headless acp --acp-command "atlas alta agent run"
```

Environment equivalents are also supported: `HEADLESS_ACP_AGENT`, `HEADLESS_ACP_COMMAND`, `HEADLESS_ACP_REGISTRY_URL`, `HEADLESS_ACP_REGISTRY_FILE`, and `HEADLESS_ACP_REGISTRY_JSON`.

## Permissions and Reasoning

By default, Headless uses each agent's native auto-approve/bypass mode. Pass `--allow read-only` to use each agent's read-only or planning mode where available. Pass `--allow yolo` to request full tool access explicitly.

Pass `--reasoning-effort low|medium|high|xhigh` or `--effort low|medium|high|xhigh` to request a normalized reasoning effort for agents with native support. Claude receives `--effort`, Codex receives `model_reasoning_effort`, Cursor combines the model family and effort into Cursor's model variant string, OpenCode receives `--variant` in one-shot mode, and Pi receives `--thinking`. Docker and Modal inherit the same one-shot command. In tmux mode, Claude, Codex, Cursor, and Pi receive their interactive effort flags. Antigravity, Gemini, and OpenCode tmux currently accept the option, leave the command unchanged, and print a warning.

## Output Modes

Raw mode is the default: Headless prints the extracted final assistant message.

```bash
headless codex --prompt "Fix the failing tests"
```

`--json` streams the native agent JSON trace for scripting. It cannot be combined with `--tmux`. Combine it with `--usage` to keep the native trace unchanged and append one normalized usage object after the native process exits.

```bash
headless pi --prompt "Summarize this repo" --json
headless codex --prompt "Summarize this repo" --json --usage
```

When combined with `--print-command`, `--json` prints a single structured object for wrappers that need the selected agent identity without parsing shell text.

```bash
headless --prompt "identity" --print-command --json
```

`--debug` streams the native JSON trace and appends the extracted final assistant message. It cannot be combined with `--json` or `--tmux`.

```bash
headless codex --prompt "Fix the failing tests" --debug
```

`--usage` appends normalized token usage and cost JSON for one-shot runs, including Docker and Modal runs. In the default output mode it follows the extracted final message. With `--json`, it follows the streamed native trace and does not require Headless to extract a final assistant message.

Usage reports input, cache read, cache write, output, reasoning output, total tokens, provider/model metadata, pricing status, and cost when available. `usageStatus` is `reported` only when Headless recognizes a native usage record; otherwise it is `missing`, with cost left null. `costBasis` distinguishes `native-reported` values from `api-list-price-estimate` values calculated from token counts and `https://models.dev/api.json`. The latter is an API-equivalent list-price estimate, not actual subscription spend. If usage or model pricing is unavailable, available token counts are still returned with `cost: null` and `costBasis: null`.

```bash
headless codex --prompt "Summarize this repo" --model gpt-5 --usage
headless codex --prompt "Summarize this repo" --model gpt-5 --json --usage
```

For local Antigravity one-shot runs on macOS and Linux, Headless collects Antigravity's [documented `context_window.current_usage` status payload](https://antigravity.google/docs/cli-statusline) because `agy -p` does not print token counts. It gives `agy` a temporary overlay home that preserves the real home and Antigravity data through symlinks while replacing only the child process's status-line command. The real `~/.gemini/antigravity-cli/settings.json` is not changed, existing custom status-line output is preserved, and the temporary payload excludes account fields such as email and plan tier. Antigravity usage capture is not yet available on Windows, Docker, or Modal.

## Cron Jobs

Use `headless cron add` to schedule the same detached one-shot invocation at fixed intervals or with a five-field cron expression. `--every` accepts positive `s`, `m`, `h`, and `d` durations. `--schedule` accepts `minute hour day-of-month month day-of-week` expressions evaluated in the local system timezone.

```bash
headless cron add codex --name inbox-triage --every 1h --prompt "Triage inbox"
headless cron add claude --schedule "0 */6 * * *" --prompt-file ./triage.md --work-dir /path/to/project
```

Jobs are stored under `~/.headless/cron` with private file permissions. Set `HEADLESS_CRON_DIR` to use another cron root. `cron add` starts the per-user daemon when it is not running; `cron start` and `cron stop` manage the daemon without deleting jobs.

```bash
headless cron list
headless cron view inbox-triage
headless cron start
headless cron stop
```

`cron list` shows active jobs, status, next run, last run, and last exit code. `cron view <job>` shows the stored command, daemon state, active execution, pending flag, prompt-file warnings, recent execution records, log paths, and extracted final messages when available.

Lifecycle commands modify persisted job state without editing OS scheduler state:

```bash
headless cron pause inbox-triage
headless cron resume inbox-triage
headless cron kill inbox-triage
headless cron rm inbox-triage
headless cron rm inbox-triage --force
```

Paused jobs do not schedule new executions. `kill` terminates the active execution if present, clears pending work, and disables the job. `rm` refuses to delete a job with an active execution unless `--force` is set.

Cron jobs accept detached-safe one-shot options: `--model`, `--reasoning-effort`, `--allow`, `--work-dir`, Docker and Modal options, `--timeout`, `--json`, `--debug`, and `--usage`. Interactive options such as `--tmux`, `--wait`, `--delete`, `--session`, and run-management flags are rejected for scheduled jobs.

If a job's next tick arrives while that job is still running, Headless records one pending execution. Further ticks keep the pending flag true instead of creating an unbounded backlog. When the active execution exits, the daemon immediately starts the single pending execution.

## Sessions and tmux

Pass `--session <name>` to start or resume a named native session. Headless stores per-agent aliases in `~/.headless/sessions.json` and maps each alias to the selected backend's native session id or session file. A missing alias starts a new session and records it after the run succeeds; an existing alias resumes that native session.

```bash
headless codex --prompt "Continue the fix" --session bughunt
```

For Antigravity, Headless stores the native conversation id from `~/.gemini/antigravity-cli/brain/<conversation-id>/transcript.jsonl` after the first successful run and resumes with `agy --conversation <conversation-id>`.

Pass `--tmux` to create a detached interactive session named `headless-<agent>-<pid>`, start the selected agent with the prompt as its initial message, print an attach command, and exit. Pass `--wait` with `--tmux` to wait until the agent's native transcript reports completion, then print the final assistant message. `--wait` identifies this run's transcript without altering the executed prompt, using each harness's native mechanism: Claude and Gemini pin a caller-assigned `--session-id`, Cursor mints and resumes a session id, OpenCode tags the session with a unique title, Pi isolates the run in its own `--session-dir`, and Antigravity/Codex claim the brand-new native transcript under a short per-(agent, working-directory) launch lock so concurrent runs in the same directory never pick up each other's transcript. Set `HEADLESS_TMUX_WAIT_FORCE_MARKER=1` to fall back to the legacy behavior of appending a single-line marker comment to the prompt for supported transcript-backed agents. Add `--delete` to kill the tmux session after that final message is captured. Pass `--name <name>` for a stable managed session name. Pass `--session <name>` for start-or-send behavior: if `headless-<agent>-<name>` is active, Headless sends the prompt there; otherwise it starts that named session.

```bash
headless claude --prompt-file task.md --work-dir /path/to/project --tmux
env -u TMUX tmux attach-session -t headless-claude-12345
headless codex --prompt "Fix the tests" --tmux --wait --delete
headless codex --prompt "Fix the tests" --tmux --name work
headless codex --prompt "Run focused tests" --tmux --session work
```

Use `headless --list` to list active tmux sessions created by Headless. Sessions are marked `waiting` after 15 seconds without tmux window activity; override this with `HEADLESS_LIST_WAITING_AFTER_MS`. Use `headless send <session-name> --prompt "..."` for follow-up messages and `headless rename <session-name> <new-name>` to rename managed sessions.

```bash
headless --list
headless attach headless-codex-work
headless attach --all
headless rename headless-codex-12345 work
headless send headless-codex-work --prompt "Run the focused tests now"
```

Use `headless attach` without a session name to attach to the most recently active Headless tmux session. Use `headless attach --all` to create a temporary tiled tmux view across all active Headless sessions.

## Docker

Docker mode wraps headless execution in `docker run --rm`. By default it is one-shot: the target workdir is mounted at the same absolute path inside the container, existing agent config/auth seed paths are mounted read-only, curated credential environment variables are passed through, and the container home is a temporary filesystem. It runs the selected agent from `ghcr.io/roberttlange/headless:latest` by default. For Antigravity, Docker mounts only the credential files needed for authentication and settings; it does not copy the conversation and brain history stored alongside them into the container home.

```bash
headless codex --prompt "Fix the failing tests" --docker
headless claude --prompt-file task.md --work-dir /path/to/project --docker
headless pi --prompt "Summarize this repo" --docker --docker-image custom/headless:dev
```

Use `--docker-env NAME` to pass one host environment variable, `--docker-env NAME=value` to set an inline value, and repeat `--docker-arg <arg>` for additional `docker run` arguments.

```bash
headless codex --prompt "Use the private provider" --docker --docker-env OPENROUTER_API_KEY
headless gemini --prompt "Inspect this repo" --docker --docker-arg --network=host
```

Add `--session <name>` to make Docker execution durable across turns. Headless stores the container home under `~/.headless/docker-sessions/<agent>/<name-prefix>-<hash>` and keeps the native agent's session files there while continuing to remove each container after the turn. The readable prefix may be truncated; the exact-name hash keeps aliases distinct on case-insensitive filesystems.

```bash
headless codex --docker --session bughunt --prompt "Start investigating the failing tests"
headless codex --docker --session bughunt --prompt "Continue the investigation and fix the root cause"
```

The workdir is always persisted through its normal host bind mount. A durable Docker session additionally persists the agent home; seed files are copied only when they do not already exist, so later turns cannot overwrite native conversation state. Delete the corresponding directory to reset the Docker session. Set `HEADLESS_DOCKER_SESSION_ROOT` to use a different absolute root directory.

Durable Docker sessions currently require POSIX filesystem permissions and are rejected on Windows hosts. An existing custom root must be owned by the current user, must not be group- or world-writable, and must not grant access through a permissive macOS ACL; Headless preserves its existing mode. Its parent chain must also be owned by the current user or root and must not be writable by other users unless the directory has the sticky bit, as with `/tmp`.

Docker mode cannot be combined with `--tmux`, `send`, `rename`, or `--list`.

For local development or when the default image has not been published yet, build the packaged Dockerfile explicitly.

```bash
headless docker doctor
headless docker build
headless codex --prompt "Fix the failing tests" --docker --docker-image headless-local:dev
```

## Modal

Modal mode runs one-shot headless execution in a CPU Modal Sandbox. It uploads the target workdir, runs the selected agent in `ghcr.io/roberttlange/headless:latest` by default, downloads the remote workspace afterward, and applies changed files back locally when the local copy has not changed since upload.

```bash
headless codex --prompt "Fix the failing tests" --modal
headless claude --prompt-file task.md --work-dir /path/to/project --modal --modal-secret anthropic
headless pi --prompt "Summarize this repo" --modal --modal-cpu 4 --modal-memory 8192
```

Use `--modal-env NAME` to pass one host environment variable, `--modal-env NAME=value` to set an inline value, and repeat `--modal-secret <name>` to inject named Modal Secrets. Modal authentication uses the standard Modal SDK configuration, either `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` or `~/.modal.toml`.

Modal mode requires a git workdir. By default, it uploads tracked and untracked non-ignored git files, without `.git`. Pass `--modal-include-git` when the remote agent needs repository metadata. Ignored files remain excluded. If a local file changes while the sandbox is running, Headless skips that path during sync-back and reports the conflict instead of overwriting local edits.

Modal mode is only for one-shot headless execution. It cannot be combined with `--docker`, `--tmux`, `send`, `rename`, or `--list`.

## User Defaults

Headless reads optional general, agent, and role defaults from `~/.headless/config.toml`. If the file is missing or unreadable, it silently falls back to built-in defaults.

```bash
mkdir -p ~/.headless
cp config.toml.example ~/.headless/config.toml
```

Supported general keys under `[general]` are `timeout_seconds`, `default_agent`, `coordination`, `run_status_interval_ms`, and `list_waiting_after_ms`. Supported agent sections are `[agents.antigravity]`, `[agents.claude]`, `[agents.codex]`, `[agents.cursor]`, `[agents.gemini]`, `[agents.opencode]`, and `[agents.pi]`; supported agent keys are `model` and `reasoning_effort`. Antigravity passes `model` through to `agy --model`, and accepts `reasoning_effort` for config compatibility but prints an unsupported warning during execution. ACP backend selection is controlled by `--acp-agent`, `--acp-command`, and the ACP environment variables rather than model defaults.

Precedence:

1. CLI flags, such as `--model`, `--reasoning-effort`, and `--timeout`.
2. Existing provider environment model overrides for Codex and Pi, such as `CODEX_MODEL` and `PI_CODING_AGENT_MODEL`.
3. `~/.headless/config.toml`.
4. Built-in defaults.

Example:

```toml
[general]
timeout_seconds = 14400
default_agent = "codex"
coordination = "session"
run_status_interval_ms = 5000
list_waiting_after_ms = 15000

[agents.opencode]
model = "openai/gpt-5.5"
reasoning_effort = "high"

[agents.cursor]
model = "gpt-5.5"
reasoning_effort = "xhigh"

[agents.pi]
model = "openai-codex/gpt-5.5"
reasoning_effort = "xhigh"
```

The full template is tracked as `config.toml.example`.

## CLI Reference

```bash
headless [agent] (--prompt <text> | --prompt-file <path> | --check | --list | --show-config) [options]
headless docker doctor [options]
headless docker build [options]
headless attach [session-name] [--all]
headless send <session-name> (--prompt <text> | --prompt-file <path>) [options]
headless rename <session-name> <new-name> [options]
headless run <list|view|mark|message|wait> [args] [options]
headless cron <add|list|view|pause|resume|kill|rm|start|stop> [args] [options]
```

Options:

- `--prompt`, `-p`: prompt text.
- `--prompt-file`: read prompt from a file.
- `--model`, `--agent-model`: model override passed to the agent CLI.
- `--reasoning-effort`, `--effort`: normalized reasoning effort, one of `low`, `medium`, `high`, or `xhigh`.
- `--allow`: permission mode, either `read-only` or `yolo`.
- `--acp-agent`: with `acp`, resolve an ACP server from the registry by id or name.
- `--acp-command`: with `acp`, run a custom ACP server command such as `atlas alta agent run`.
- `--acp-registry`: with `--acp-agent`, use a custom ACP registry URL.
- `--acp-registry-file`: with `--acp-agent`, read registry JSON from a local file.
- `--work-dir`, `-C`: run the agent from a specific working directory.
- `--docker`: run the agent inside Docker; add `--session` for a durable multi-turn container home.
- `--modal`: run the agent in a Modal CPU sandbox for one-shot headless execution.
- `--timeout <s>`: stop one-shot local, Docker, Modal, or `--tmux --wait` execution after the given number of seconds.
- `--json`: stream the raw agent JSON trace instead of extracting the final message.
- `--debug`: stream the raw agent JSON trace and append the extracted final message.
- `--usage`: append normalized token usage and cost JSON after the final message or streamed `--json` trace.
- `--tmux`: launch an interactive agent in a detached tmux session with the prompt as its initial message.
- `--wait`: with `--tmux`, wait for native transcript completion and print the final message.
- `--delete`: with `--tmux --wait`, kill the tmux session after completion.
- `--name`: use a stable managed session name with `--tmux`.
- `--name`: with `cron add`, use a stable cron job id.
- `--session`: start or resume a named Headless session. Uses `~/.headless/sessions.json`; in tmux mode starts or sends to `headless-<agent>-<name>`.
- `headless attach`: attach to the most recently active Headless tmux session; add `--all` to tile all active sessions.
- `headless cron add <agent>`: schedule a detached one-shot invocation with `--every <duration>` or `--schedule <expr>`.
- `headless cron list|view|pause|resume|kill|rm|start|stop`: inspect and manage scheduled jobs and the cron daemon.
- `--check`: check supported agent binaries, versions, Docker status, and local API/OAuth credential signals.
- `--list`: list active tmux sessions created by Headless, including state and timestamps.
- `--print-command`: print the shell command without executing it. Combine with `--json` for selected-agent metadata.
- `--show-config`: print the selected agent's effective model, reasoning effort, config paths, and auth seed paths.
- `--help`: show usage.

See [orchestration.md](orchestration.md) for `--role`, `--run`, `--node`, `--team`, and `headless run`.

## Environment

- `ANTIGRAVITY_CLI_BIN`, `AGY_CLI_BIN`: Antigravity CLI binary override. Defaults to `agy`.
- `CODEX_MODEL`: Codex model override when `--model` is omitted.
- `CURSOR_CLI_BIN`: Cursor CLI binary override. Defaults to `agent`.
- `CURSOR_API_KEY`: passed to Cursor as `--api-key`.
- `PI_CODING_AGENT_BIN`: Pi CLI binary override. Defaults to `pi`.
- `PI_CODING_AGENT_PROVIDER`: Pi provider override used when the Pi model value does not include `provider/model`.
- `PI_CODING_AGENT_MODEL`: Pi model override when `--model` is omitted. Accepts `provider/model` or a bare model paired with `PI_CODING_AGENT_PROVIDER`.
- `PI_CODING_AGENT_MODELS`: passed to Pi as `--models`.
- `HEADLESS_ACP_AGENT`: ACP registry id or name to resolve when running `headless acp`.
- `HEADLESS_ACP_COMMAND`: custom ACP server command, for example `atlas alta agent run`.
- `HEADLESS_ACP_REGISTRY_URL`: ACP registry URL override.
- `HEADLESS_ACP_REGISTRY_FILE`: local ACP registry JSON file.
- `HEADLESS_ACP_REGISTRY_JSON`: inline ACP registry JSON, mainly useful for tests or wrappers.
- `HEADLESS_CRON_DIR`: cron state root. Defaults to `~/.headless/cron`.
- `HEADLESS_DOCKER_SESSION_ROOT`: root for durable Docker session homes. Defaults to `~/.headless/docker-sessions`.
- `HEADLESS_CLI_BIN`: binary path the cron daemon uses to start scheduled Headless invocations.
- `HEADLESS_BIN`: fallback binary path for detached Headless child invocations.
- `HEADLESS_RUN_DIR`: concrete directory for the active run store, mainly used by Docker run coordination.

Docker and Modal modes also pass common agent/provider credential variables when present, including `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, Cursor/Pi credential variables, common AWS variables, and OpenAI-compatible endpoint variables. Use `--docker-env` or `--modal-env` for anything else. Modal mode additionally supports named Modal Secrets with `--modal-secret`.
