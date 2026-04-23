<h1 align="center">Headless</h1>

<p align="center">
  One CLI entrypoint for running Claude, Codex, Cursor, Gemini, Pi, and OpenCode in headless mode.
</p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white" />
  <img alt="Private package" src="https://img.shields.io/badge/package-private-lightgrey" />
</p>

Headless normalizes the small but annoying differences between coding-agent CLIs. It gives each agent the same prompt, model, workdir, dry-run, and config-inspection interface while preserving the native command flags needed for non-interactive execution.

## Quick Start

### From source

```bash
npm install
npm run build
node dist/cli.js codex --prompt "Inspect this repository" --print-command
```

### Local executable

```bash
npm link
headless codex --prompt "Inspect this repository"
```

## 60-Second Usage

```bash
headless codex --prompt "Run the tests and fix failures" --model gpt-5.2
headless claude --prompt-file prompt.md --work-dir /path/to/project
headless opencode --show-config
headless gemini --prompt "Summarize the codebase" --print-command
headless pi --prompt "Summarize this repo" --json
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
| `cursor` | `agent -p --force --output-format stream-json ...` |
| `gemini` | `gemini -p ... --output-format stream-json --yolo` |
| `opencode` | `opencode run --format json ...` |
| `pi` | `pi --no-session --mode json ...` |

By default, Headless prints the agent's final assistant message. Pass `--json` to print the raw native JSON trace.

## CLI Reference

```bash
headless <agent> (--prompt <text> | --prompt-file <path>) [options]
```

Options:

- `--prompt`, `-p`: prompt text.
- `--prompt-file`: read prompt from a file.
- `--model`, `--agent-model`: model override passed to the agent CLI.
- `--work-dir`, `-C`: run the agent from a specific working directory.
- `--json`: print the raw agent JSON trace instead of extracting the final message.
- `--print-command`: print the shell command without executing it.
- `--show-config`: print config paths and auth seed paths for an agent.
- `--help`: show usage.

If no prompt or prompt file is supplied, Headless reads from piped stdin.

## Environment

- `CODEX_MODEL`: default Codex model when `--model` is omitted. Falls back to `gpt-5.2`.
- `CURSOR_CLI_BIN`: Cursor CLI binary override. Defaults to `agent`.
- `CURSOR_API_KEY`: passed to Cursor as `--api-key`.
- `PI_CODING_AGENT_BIN`: Pi CLI binary override. Defaults to `pi`.
- `PI_CODING_AGENT_PROVIDER`: passed to Pi as `--provider`.
- `PI_CODING_AGENT_MODEL`: default Pi model when `--model` is omitted.
- `PI_CODING_AGENT_MODELS`: passed to Pi as `--models`.

## Development

```bash
npm install
npm run build
npm test
npm run test:agents
npm run check
```

`npm run check` builds the package and runs the TypeScript test suite. `npm run test:agents` is an optional real-agent smoke test; set `HEADLESS_AGENT_SMOKE=1` to run Codex, Claude, Pi, and Gemini with an example prompt. The package exports one binary, `headless`, from `dist/cli.js`.

## Layout

```text
src/cli.ts      CLI parsing, validation, execution
src/agents.ts   Agent registry and command builders
src/output.ts   Final-message extraction from agent JSON traces
src/shell.ts    Shell-safe dry-run rendering
src/types.ts    Shared TypeScript contracts
tests/          CLI and command-builder coverage
```
