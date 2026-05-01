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
| `claude` | `claude -p ... --output-format stream-json --verbose --dangerously-skip-permissions` |
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ...` |
| `cursor` | `agent -p --trust --force --output-format stream-json --model gpt-5.5-medium ...` |
| `gemini` | `gemini --model gemini-3.1-pro-preview --skip-trust -p ... --output-format stream-json --approval-mode yolo` |
| `opencode` | `opencode run --format json --model openai/gpt-5.4 --dangerously-skip-permissions ...` |
| `pi` | `pi --no-session --mode json --provider openai-codex --model gpt-5.5 --tools read,bash,edit,write ...` |

When no agent is specified, Headless selects the first installed agent in this order: `codex`, `claude`, `pi`, `opencode`, `gemini`, `cursor`.

When `--model` is omitted, Headless defaults Codex to `gpt-5.5`, Claude to `claude-opus-4-6`, Cursor to the `gpt-5.5` family with medium effort, Gemini to `gemini-3.1-pro-preview`, OpenCode to `openai/gpt-5.4`, and Pi to `openai-codex/gpt-5.5`.

## Permissions and Reasoning

By default, Headless uses each agent's native auto-approve/bypass mode. Pass `--allow read-only` to use each agent's read-only or planning mode where available. Pass `--allow yolo` to request full tool access explicitly.

Pass `--reasoning-effort low|medium|high|xhigh` or `--effort low|medium|high|xhigh` to request a normalized reasoning effort for agents with native support. Claude receives `--effort`, Codex receives `model_reasoning_effort`, Cursor combines the model family and effort into Cursor's model variant string, OpenCode receives `--variant` in one-shot mode, and Pi receives `--thinking`. Docker and Modal inherit the same one-shot command. In tmux mode, Claude, Codex, Cursor, and Pi receive their interactive effort flags. Gemini and OpenCode tmux currently accept the option, leave the command unchanged, and print a warning.

## Output Modes

Raw mode is the default: Headless prints the extracted final assistant message.

```bash
headless codex --prompt "Fix the failing tests"
```

`--json` streams the native agent JSON trace for scripting. It cannot be combined with `--tmux`.

```bash
headless pi --prompt "Summarize this repo" --json
```

`--debug` streams the native JSON trace and appends the extracted final assistant message. It cannot be combined with `--json` or `--tmux`.

```bash
headless codex --prompt "Fix the failing tests" --debug
```

`--usage` appends normalized token usage and cost JSON after the final message for one-shot runs, including Docker and Modal runs. It reports input, cache read, cache write, output, reasoning output, total tokens, provider/model metadata, pricing status, and cost when available. Native costs are used when available; fallback pricing comes from `https://models.dev/api.json`. If a model cannot be priced, token counts are still returned with `cost: null`.

```bash
headless codex --prompt "Summarize this repo" --model gpt-5 --usage
```

## Sessions and tmux

Pass `--session <name>` to start or resume a named native session. Headless stores per-agent aliases in `~/.headless/sessions.json` and maps each alias to the selected backend's native session id or session file. A missing alias starts a new session and records it after the run succeeds; an existing alias resumes that native session.

```bash
headless codex --prompt "Continue the fix" --session bughunt
```

Pass `--tmux` to create a detached interactive session named `headless-<agent>-<pid>`, start the selected agent with the prompt as its initial message, print an attach command, and exit. Pass `--name <name>` for a stable managed session name. Pass `--session <name>` for start-or-send behavior: if `headless-<agent>-<name>` is active, Headless sends the prompt there; otherwise it starts that named session.

```bash
headless claude --prompt-file task.md --work-dir /path/to/project --tmux
tmux attach-session -t headless-claude-12345
headless codex --prompt "Fix the tests" --tmux --name work
headless codex --prompt "Run focused tests" --tmux --session work
```

Use `headless --list` to list active tmux sessions created by Headless. Use `headless send <session-name> --prompt "..."` for follow-up messages and `headless rename <session-name> <new-name>` to rename managed sessions.

```bash
headless --list
headless rename headless-codex-12345 work
headless send headless-codex-work --prompt "Run the focused tests now"
```

## Docker

Docker mode wraps one-shot headless execution in `docker run --rm`. It mounts the target workdir at the same absolute path inside the container, mounts existing agent config/auth seed paths read-only, passes curated credential environment variables, and runs the selected agent from `ghcr.io/roberttlange/headless:latest` by default.

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

Docker mode is only for one-shot headless execution. It cannot be combined with `--tmux`, `send`, `rename`, or `--list`.

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

Headless reads optional model and reasoning defaults from `~/.headless/config.toml`. If the file is missing or unreadable, it silently falls back to built-in defaults.

```bash
mkdir -p ~/.headless
cp config.toml.example ~/.headless/config.toml
```

Supported sections are `[agents.claude]`, `[agents.codex]`, `[agents.cursor]`, `[agents.gemini]`, `[agents.opencode]`, and `[agents.pi]`. Supported keys are `model` and `reasoning_effort`.

Precedence:

1. CLI flags, such as `--model` and `--reasoning-effort`.
2. Existing provider environment model overrides for Codex and Pi, such as `CODEX_MODEL` and `PI_CODING_AGENT_MODEL`.
3. `~/.headless/config.toml`.
4. Built-in defaults.

Example:

```toml
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
headless send <session-name> (--prompt <text> | --prompt-file <path>) [options]
headless rename <session-name> <new-name> [options]
headless run <list|view|mark|message|wait> [args] [options]
```

Options:

- `--prompt`, `-p`: prompt text.
- `--prompt-file`: read prompt from a file.
- `--model`, `--agent-model`: model override passed to the agent CLI.
- `--reasoning-effort`, `--effort`: normalized reasoning effort, one of `low`, `medium`, `high`, or `xhigh`.
- `--allow`: permission mode, either `read-only` or `yolo`.
- `--work-dir`, `-C`: run the agent from a specific working directory.
- `--docker`: run the agent inside Docker for one-shot headless execution.
- `--modal`: run the agent in a Modal CPU sandbox for one-shot headless execution.
- `--json`: stream the raw agent JSON trace instead of extracting the final message.
- `--debug`: stream the raw agent JSON trace and append the extracted final message.
- `--usage`: append normalized token usage and cost JSON after the final message.
- `--tmux`: launch an interactive agent in a detached tmux session with the prompt as its initial message.
- `--name`: use a stable managed session name with `--tmux`.
- `--session`: start or resume a named Headless session. Uses `~/.headless/sessions.json`; in tmux mode starts or sends to `headless-<agent>-<name>`.
- `--check`: check supported agent binaries, versions, Docker status, and local API/OAuth credential signals.
- `--list`: list active tmux sessions created by Headless, including state and timestamps.
- `--print-command`: print the shell command without executing it.
- `--show-config`: print the selected agent's effective model, reasoning effort, config paths, and auth seed paths.
- `--help`: show usage.

See [orchestration.md](orchestration.md) for `--role`, `--run`, `--node`, `--team`, and `headless run`.

## Environment

- `CODEX_MODEL`: Codex model override when `--model` is omitted.
- `CURSOR_CLI_BIN`: Cursor CLI binary override. Defaults to `agent`.
- `CURSOR_API_KEY`: passed to Cursor as `--api-key`.
- `PI_CODING_AGENT_BIN`: Pi CLI binary override. Defaults to `pi`.
- `PI_CODING_AGENT_PROVIDER`: Pi provider override used when the Pi model value does not include `provider/model`.
- `PI_CODING_AGENT_MODEL`: Pi model override when `--model` is omitted. Accepts `provider/model` or a bare model paired with `PI_CODING_AGENT_PROVIDER`.
- `PI_CODING_AGENT_MODELS`: passed to Pi as `--models`.
- `HEADLESS_RUN_DIR`: concrete directory for the active run store, mainly used by Docker run coordination.

Docker and Modal modes also pass common agent/provider credential variables when present, including `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, Cursor/Pi credential variables, common AWS variables, and OpenAI-compatible endpoint variables. Use `--docker-env` or `--modal-env` for anything else. Modal mode additionally supports named Modal Secrets with `--modal-secret`.
