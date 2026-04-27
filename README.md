<p align="center">
  <img src="docs/logo.png" alt="Headless coding agent orchestration" width="200" style="border-radius: 24px;" />
</p>

<h1 align="center">Headless CLI</h1>

<p align="center">
  One CLI entrypoint for running Claude, Codex, Cursor, Gemini, Pi, and OpenCode in headless mode.
</p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white" />
  <img alt="npm package" src="https://img.shields.io/badge/npm-%40roberttlange%2Fheadless-CB3837?logo=npm&logoColor=white" />
</p>

Headless normalizes the small but annoying differences between coding-agent CLIs. It gives each agent the same prompt, model, reasoning-effort, workdir, dry-run, and config-inspection interface while preserving the native command flags needed for non-interactive execution.
Pass `--tmux` when you want the same prompt launched in an interactive agent session instead.

## Quick Start

### With npx

```bash
npx -y @roberttlange/headless codex --prompt "Hello world"
```

### Global install

```bash
npm install -g @roberttlange/headless
headless codex --prompt "Hello world"
```

## 60-Second Usage

```bash
# Use default configured provider with an inline prompt.
headless --prompt "Inspect this repository"
# Run Codex with an explicit model override.
headless codex --prompt "Run the tests and fix failures" --model gpt-5
# Run with a normalized reasoning effort where the selected agent supports it.
headless codex --prompt "Plan the migration" --reasoning-effort high
# Load prompt from file and target another repo path.
headless claude --prompt-file prompt.md --work-dir /path/to/project
# Print resolved OpenCode adapter configuration and exit.
headless opencode --show-config
# Show the backend command without executing it.
headless gemini --prompt "Summarize the codebase" --print-command
# Stream structured JSON output for scripting.
headless pi --prompt "Summarize this repo" --json
# Stream JSON output and append the extracted final message.
headless codex --prompt "Fix the failing tests" --debug
# Print the final message plus token usage and cost JSON.
headless codex --prompt "Summarize this repo" --model gpt-5 --usage
# Launch in tmux for persistent interactive sessions.
headless codex --prompt "Fix the failing tests" --tmux
# Start or resume a named native session.
headless codex --prompt "Continue the fix" --session bughunt
# Run the agent inside the default Docker image.
headless codex --prompt "Fix the failing tests" --docker
# Run the agent in a Modal CPU sandbox and sync edits back.
headless codex --prompt "Fix the failing tests" --modal --modal-secret openai
# Check Docker setup and image availability.
headless docker doctor
# Restrict tool permissions to read-only actions.
headless codex --allow read-only --prompt "Review this repo"
# Allow all tools for autonomous execution.
headless gemini --allow yolo --prompt "Fix the failing tests"
# Validate local setup and environment.
headless --check
# List managed tmux sessions with state and timestamps.
headless --list
```

Pipe a prompt over stdin:

```bash
printf "Review this diff" | headless pi --model claude-opus
```

## Supported Agents

| Agent | Command shape |
| --- | --- |
| `claude` | `claude -p ... --output-format stream-json --verbose --dangerously-skip-permissions` |
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ...` |
| `cursor` | `agent -p --force --output-format stream-json --model gpt-5.5-medium ...` |
| `gemini` | `gemini --model gemini-3.1-pro-preview --skip-trust -p ... --output-format stream-json --approval-mode yolo` |
| `opencode` | `opencode run --format json --model openai/gpt-5.4 --dangerously-skip-permissions ...` |
| `pi` | `pi --no-session --mode json --provider openai-codex --model gpt-5.5 --tools read,bash,edit,write ...` |

By default, Headless uses each agent's native auto-approve/bypass mode. Pass `--allow read-only` to use each agent's read-only/planning mode where available.
Pass `--reasoning-effort low|medium|high|xhigh` to request a normalized reasoning effort for agents with native support. Claude receives `--effort`, Codex receives `model_reasoning_effort`, Cursor combines the requested model family and effort into Cursor's model variant string, OpenCode receives `--variant` in one-shot mode, and Pi receives `--thinking`. For example, `headless cursor --model gpt-5.5 --reasoning-effort xhigh` runs Cursor with `gpt-5.5-extra-high` and prices usage with the base `gpt-5.5` rates. Docker and Modal inherit the same one-shot agent command. In tmux mode, Claude, Codex, Cursor, and Pi receive their interactive effort flags. Gemini and OpenCode tmux currently do not expose stable per-run reasoning-effort flags through their CLIs, so Headless accepts the option for them, leaves the command unchanged, and prints a warning.

By default, Headless prints the agent's final assistant message. Pass `--json` to stream the raw native JSON trace, or `--debug` to stream the trace and append the extracted final message. Pass `--usage` to append normalized token usage and cost JSON for one-shot runs. Headless uses native agent costs when available and fetches live fallback pricing from `https://models.dev/api.json`; if a model cannot be priced, token counts are still returned with `cost: null`. When `--model` is omitted, Headless defaults Codex to `gpt-5.5`, Claude to `claude-opus-4-6`, Cursor to the `gpt-5.5` family with medium effort, Gemini to `gemini-3.1-pro-preview`, OpenCode to `openai/gpt-5.4`, and Pi to `openai-codex/gpt-5.5`.
When no agent is specified, Headless selects the first installed agent in this order: `codex`, `claude`, `pi`, `opencode`, `gemini`, `cursor`.

Pass `--session <name>` to start or resume a named session. Headless stores per-agent aliases in `~/.headless/sessions.json`, separate from `config.toml`, and maps each alias to the selected backend's native session id or session file. A missing alias starts a new session and records it after the run succeeds; an existing alias resumes that native session. In tmux mode, `--session <name>` maps to `headless-<agent>-<name>`: an active tmux session receives the prompt, otherwise Headless starts a new named tmux session. `--session` cannot be combined with `--name`, `--docker`, or `--modal`.

## User Defaults

Headless reads optional model and reasoning defaults from `~/.headless/config.toml`. If the file is missing or unreadable, it silently falls back to built-in defaults.

```bash
mkdir -p ~/.headless
cp config.toml.example ~/.headless/config.toml
```

Supported sections are `[agents.claude]`, `[agents.codex]`, `[agents.cursor]`, `[agents.gemini]`, `[agents.opencode]`, and `[agents.pi]`. Supported keys are `model` and `reasoning_effort`.

Precedence is:

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

## 6 Execution Modes

### 1) Raw mode (default)

Raw mode runs headless in the current terminal and prints the extracted final assistant message.

```bash
headless codex --prompt "Fix the failing tests"
```

### 2) JSON mode (`--json`)

JSON mode runs headless in the current terminal and streams the agent's native JSON trace for scripting or post-processing.

```bash
headless pi --prompt "Summarize this repo" --json
```

`--json` only applies to headless execution and cannot be combined with `--tmux`.

### 3) Debug mode (`--debug`)

Debug mode runs headless in the current terminal, streams the agent's native JSON trace, then appends the extracted final assistant message.

```bash
headless codex --prompt "Fix the failing tests" --debug
```

`--debug` only applies to headless execution and cannot be combined with `--json` or `--tmux`.

### Usage accounting (`--usage`)

Usage accounting runs in normal one-shot mode, including Docker and Modal runs, and appends one JSON object after the final message.

```bash
headless codex --prompt "Summarize this repo" --model gpt-5 --usage
```

The summary includes input, cache read, cache write, output, reasoning output, total tokens, provider/model metadata, pricing status, and cost when available. `--usage` cannot be combined with `--json` or `--tmux`.

### 4) Docker mode (`--docker`)

Docker mode wraps one-shot headless execution in `docker run --rm`. It mounts the target workdir at the same absolute path inside the container, mounts existing agent config/auth seed paths read-only, passes a curated set of credential environment variables, and runs the selected agent from `ghcr.io/roberttlange/headless:latest` by default.

```bash
headless codex --prompt "Fix the failing tests" --docker
headless claude --prompt-file task.md --work-dir /path/to/project --docker
headless pi --prompt "Summarize this repo" --docker --docker-image custom/headless:dev
```

Use `--docker-env NAME` to pass one extra host environment variable, `--docker-env NAME=value` to set one inline value, and repeat `--docker-arg <arg>` for additional `docker run` arguments.

```bash
headless codex --prompt "Use the private provider" --docker --docker-env OPENROUTER_API_KEY
headless gemini --prompt "Inspect this repo" --docker --docker-arg --network=host
```

Docker mode is only for headless execution. It cannot be combined with `--tmux`, `send`, `rename`, or `--list`.

The default image contract is simple: every supported agent binary is available on `PATH`, and the image has no required entrypoint. Plain `--docker` uses `ghcr.io/roberttlange/headless:latest`; Docker will pull it automatically if it is not local. Headless never auto-builds images during agent execution.

For local development or when the default image has not been published yet, build the packaged Dockerfile explicitly:

```bash
headless docker doctor
headless docker build
headless codex --prompt "Fix the failing tests" --docker --docker-image headless-local:dev
```

Use `headless docker build --docker-image <image>` to choose a different local tag.

### 5) tmux mode (`--tmux`)

tmux mode creates a detached session named `headless-<agent>-<pid>`, starts the selected agent in interactive mode with the prompt as its initial message, prints an attach command, and exits. Pass `--name <name>` to create a stable managed session name like `headless-codex-work`. Pass `--session <name>` instead when you want start-or-send behavior: if `headless-<agent>-<name>` is active, Headless sends the prompt there; otherwise it starts that named session.

```bash
headless claude --prompt-file task.md --work-dir /path/to/project --tmux
tmux attach-session -t headless-claude-12345
headless codex --prompt "Fix the tests" --tmux --name work
headless codex --prompt "Run the focused tests now" --tmux --session work
```

Use `--print-command --tmux` to preview the tmux launch command without starting a session.
Claude tmux launches include `--dangerously-skip-permissions` and pre-trust the launch directory so detached sessions do not block on trust or permission prompts.
Cursor tmux launches pre-trust the launch directory so detached sessions do not block on workspace trust.
Gemini tmux launches include `--skip-trust` so detached sessions do not block on folder trust prompts.
OpenCode tmux launches start the TUI, wake it, paste the prompt through a tmux buffer, then send `Enter` so the prompt is submitted after the TUI is ready.
Use `headless --list` to list active tmux sessions created by Headless, including inferred state, creation time, and last activity time. Use `headless codex --list` to list sessions for one agent.
Use `headless send <session-name> --prompt "..."` to send a follow-up message to an existing Headless tmux session.
Use `headless rename <session-name> <new-name>` to rename an existing Headless tmux session while preserving its agent prefix.

```bash
headless --list
headless rename headless-codex-12345 work
headless send headless-codex-work --prompt "Run the focused tests now"
```

### 6) Modal mode (`--modal`)

Modal mode runs one-shot headless execution in a CPU Modal Sandbox. It uploads the target workdir, runs the selected agent in `ghcr.io/roberttlange/headless:latest` by default, downloads the remote workspace afterward, and applies changed files back locally when the local copy has not changed since upload.

```bash
headless codex --prompt "Fix the failing tests" --modal
headless claude --prompt-file task.md --work-dir /path/to/project --modal --modal-secret anthropic
headless pi --prompt "Summarize this repo" --modal --modal-cpu 4 --modal-memory 8192
```

Use `--modal-env NAME` to pass one extra host environment variable, `--modal-env NAME=value` to set one inline value, and repeat `--modal-secret <name>` to inject named Modal Secrets. Modal authentication uses the standard Modal SDK configuration, either `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` or `~/.modal.toml`.

```bash
headless codex --prompt "Use the private provider" --modal --modal-env OPENROUTER_API_KEY
headless gemini --prompt "Inspect this repo" --modal --modal-secret gemini
```

Modal mode requires a git workdir. By default, it uploads tracked and untracked non-ignored git files, without `.git`. Pass `--modal-include-git` when the remote agent needs repository metadata. Ignored files remain excluded. If a local file changes while the sandbox is running, Headless skips that path during sync-back and reports the conflict instead of overwriting local edits.

Modal mode is only for headless execution. It cannot be combined with `--docker`, `--tmux`, `send`, `rename`, or `--list`.

## CLI Reference

```bash
headless [agent] (--prompt <text> | --prompt-file <path> | --check | --list | --show-config) [options]
headless docker doctor [options]
headless docker build [options]
headless send <session-name> (--prompt <text> | --prompt-file <path>) [options]
headless rename <session-name> <new-name> [options]
```

Options:

- `--prompt`, `-p`: prompt text.
- `--prompt-file`: read prompt from a file.
- `--model`, `--agent-model`: model override passed to the agent CLI.
- `--reasoning-effort`: normalized reasoning effort, one of `low`, `medium`, `high`, or `xhigh`.
- `--allow`: permission mode, either `read-only` or `yolo`.
- `--work-dir`, `-C`: run the agent from a specific working directory.
- `--docker`: run the agent inside Docker for one-shot headless execution.
- `--docker-image`: Docker image override. Defaults to `ghcr.io/roberttlange/headless:latest`.
- `--docker-arg`: extra `docker run` argument. Repeat for multiple args.
- `--docker-env`: pass env into Docker as `NAME` or `NAME=value`. Repeatable.
- `--modal`: run the agent in a Modal CPU sandbox for one-shot headless execution.
- `--modal-image`: Modal sandbox image override. Defaults to `ghcr.io/roberttlange/headless:latest`.
- `--modal-image-secret`: Modal Secret for private registry image pulls.
- `--modal-app`: Modal app name. Defaults to `headless-cli`.
- `--modal-cpu`: Modal CPU reservation. Defaults to `2`.
- `--modal-memory`: Modal memory reservation in MiB. Defaults to `4096`.
- `--modal-timeout`: Modal sandbox and command timeout in seconds. Defaults to `3600`.
- `--modal-secret`: inject a named Modal Secret. Repeatable.
- `--modal-env`: pass env into Modal as `NAME` or `NAME=value`. Repeatable.
- `--modal-include-git`: include `.git` metadata in the uploaded workspace.
- `--json`: stream the raw agent JSON trace instead of extracting the final message.
- `--debug`: stream the raw agent JSON trace and append the extracted final message.
- `--usage`: append normalized token usage and cost JSON after the final message.
- `--tmux`: launch an interactive agent in a detached tmux session with the prompt as its initial message.
- `--name`: use a stable managed session name with `--tmux`.
- `--session`: start or resume a named Headless session. Uses `~/.headless/sessions.json`; in tmux mode starts or sends to `headless-<agent>-<name>`.
- `send <session-name>`: send a message to an existing Headless tmux session.
- `rename <session-name> <new-name>`: rename an existing Headless tmux session.
- `docker doctor`: check Docker setup and image availability.
- `docker build`: build the packaged Dockerfile as `headless-local:dev`, or `--docker-image <image>`.
- `--check`: check which supported agent binaries are installed and print their versions.
- `--list`: list active tmux sessions created by Headless, including state and timestamps.
- `--print-command`: print the shell command without executing it.
- `--show-config`: print config paths and auth seed paths for an agent.
- `--help`: show usage.

If no prompt or prompt file is supplied, Headless reads from piped stdin.

## Environment

- `CODEX_MODEL`: Codex model override when `--model` is omitted. When unset, Headless defaults Codex to `gpt-5.5`.
- `CURSOR_CLI_BIN`: Cursor CLI binary override. Defaults to `agent`.
- `CURSOR_API_KEY`: passed to Cursor as `--api-key`.
- `PI_CODING_AGENT_BIN`: Pi CLI binary override. Defaults to `pi`.
- `PI_CODING_AGENT_PROVIDER`: Pi provider override used when the Pi model value does not include `provider/model`.
- `PI_CODING_AGENT_MODEL`: Pi model override when `--model` is omitted. Accepts `provider/model` (for example, `openai-codex/gpt-5.5`) or a bare model paired with `PI_CODING_AGENT_PROVIDER`. When unset, Headless defaults Pi to `openai-codex/gpt-5.5`.
- `PI_CODING_AGENT_MODELS`: passed to Pi as `--models`.

Docker and Modal modes also pass common agent/provider credential variables when present, including `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, Cursor/Pi credential variables, common AWS variables, and OpenAI-compatible endpoint variables. Use `--docker-env` or `--modal-env` for anything else. Modal mode additionally supports named Modal Secrets with `--modal-secret`.

## Development

```bash
npm install
npm run build
npm test
npm run test:integration:local
npm run test:agents
npm run check
npm run hooks:install
```

`npm run check` builds the package and runs the TypeScript test suite. `npm run test:integration:local` runs authenticated local integration coverage; set `HEADLESS_INTEGRATION_AGENTS=codex` to limit it to Codex. After `npm run hooks:install`, the pre-push hook builds the local CLI and runs Codex integration by default; set `HEADLESS_HOOK_ALL_AGENTS=1` to run all agents. `npm run test:agents` is an optional real-agent smoke test; set `HEADLESS_AGENT_SMOKE=1` to run Codex, Claude, Pi, and Gemini with an example prompt. The package exports one binary, `headless`, from `dist/cli.js`.

## Layout

```text
src/cli.ts      CLI parsing, validation, execution
src/agents.ts   Agent registry and command builders
src/output.ts   Final-message extraction from agent JSON traces
src/modal.ts    Modal sandbox execution and workspace sync
src/shell.ts    Shell-safe dry-run rendering
src/types.ts    Shared TypeScript contracts
tests/          CLI and command-builder coverage
```

## Agent Execution References

Install the agent CLIs you want Headless to drive:

| Agent | Install | Binary used by Headless |
| --- | --- | --- |
| [Codex](https://developers.openai.com/codex/cli/reference) | `npm install -g @openai/codex` | `codex` |
| [Claude Code](https://code.claude.com/docs/en/cli-reference) | `npm install -g @anthropic-ai/claude-code` | `claude` |
| [Cursor](https://cursor.com/docs/cli/headless) | `curl https://cursor.com/install -fsS \| bash` | `agent`, or set `CURSOR_CLI_BIN=cursor-agent` |
| [Gemini CLI](https://geminicli.com/docs/cli/cli-reference/) | `npm install -g @google/gemini-cli` | `gemini` |
| [OpenCode](https://opencode.ai/docs/cli/) | `curl -fsSL https://opencode.ai/install \| bash` or `npm install -g opencode-ai` | `opencode` |
| [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) | `npm install -g @mariozechner/pi-coding-agent` | `pi`, or set `PI_CODING_AGENT_BIN` |
