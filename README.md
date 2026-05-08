<p align="center">
  <img src="docs/logo.png" alt="Headless coding agent orchestration" width="200" style="border-radius: 24px;" />
</p>

<h1 align="center">Headless CLI</h1>

<p align="center">
  One CLI entrypoint for running Claude, Codex, Cursor, Gemini, Pi, OpenCode, and ACP-compatible agents in headless mode.
</p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white" />
  <img alt="npm package" src="https://img.shields.io/badge/npm-%40roberttlange%2Fheadless-CB3837?logo=npm&logoColor=white" />
  <a href="https://roberttlange.com/blog/05-headless"><img alt="Blog post" src="https://img.shields.io/badge/blog-headless-111111" /></a>
</p>

Headless normalizes the small differences between coding-agent CLIs: prompts, models, reasoning effort, working directories, output modes, sessions, and environment checks use one interface while each backend keeps its native execution flags.

## Install

Run once with `npx`:

```bash
npx -y @roberttlange/headless codex --prompt "Hello world"
```

Or install globally:

```bash
npm install -g @roberttlange/headless
headless codex --prompt "Hello world"
```

Requires Node.js 22+.

To install the bundled Codex skill for visual Headless swarms, use `npx` to copy it into Codex's skill directory:

```bash
mkdir -p ~/.codex/skills
HEADLESS_REF=main
npx -y degit@2.8.4 "RobertTLange/headless-cli/skills/headless-swarm#$HEADLESS_REF" ~/.codex/skills/headless-swarm
```

## Core Usage

```bash
# Use the first installed supported agent.
headless --prompt "Inspect this repository"

# Choose an agent, model, and normalized reasoning effort.
headless codex --prompt "Run the tests and fix failures" --model gpt-5 --reasoning-effort high

# Read a prompt from a file and run from another repository.
headless claude --prompt-file prompt.md --work-dir /path/to/project

# Pipe a prompt over stdin.
printf "Review this diff" | headless pi --model claude-opus

# Preview the native backend command.
headless gemini --prompt "Summarize the codebase" --print-command
headless --prompt "identity" --print-command --json

# Run an ACP-compatible agent from the registry or a custom ACP server command.
headless acp --acp-agent auggie --prompt "Inspect this repository"
headless acp --acp-command "atlas alta agent run" --prompt "Fix the failing tests"

# Stream native JSON, debug traces, or append normalized usage.
headless pi --prompt "Summarize this repo" --json
headless codex --prompt "Fix the failing tests" --debug
headless codex --prompt "Summarize this repo" --usage

# Use read-only mode for review/planning work.
headless codex --allow read-only --prompt "Review this repo"

# Start or resume native sessions.
headless codex --prompt "Continue the fix" --session bughunt

# Launch an interactive tmux session.
headless codex --prompt "Fix the failing tests" --tmux
headless attach --all

# Validate local setup.
headless --check
```

When no agent is specified, Headless selects the first installed agent in this order: `codex`, `claude`, `pi`, `opencode`, `gemini`, `cursor`. ACP-compatible agents are explicit-only: use `headless acp --acp-agent ...` or `headless acp --acp-command ...`.

## Multi-Agent Orchestration

Headless can track a local multi-agent run with named roles, team declarations, per-node logs, status updates, and routed follow-up messages. Use an `orchestrator` node to plan work, declare teammates with repeatable `--team` specs, then inspect and message the run with `headless run`.

```bash
headless codex --role orchestrator --run auth --node orchestrator --team explorer --team worker=2 --prompt "Build auth"
headless run view auth
headless run message auth worker-1 --prompt "Implement token refresh" --async
headless run wait auth
```

Roles include `orchestrator`, `explorer`, `worker`, and `reviewer`. Team specs accept forms like `explorer`, `worker=2`, `claude/reviewer`, and `codex/worker=3`. See [docs/orchestration.md](docs/orchestration.md) for coordination modes, run state, and message routing.

## Supported Agents

| Agent | Install | Binary used by Headless |
| --- | --- | --- |
| [Codex](https://developers.openai.com/codex/cli/reference) | `npm install -g @openai/codex` | `codex` |
| [Claude Code](https://code.claude.com/docs/en/cli-reference) | `npm install -g @anthropic-ai/claude-code` | `claude` |
| [Cursor](https://cursor.com/docs/cli/headless) | `curl https://cursor.com/install -fsS \| bash` | `agent`, or set `CURSOR_CLI_BIN=cursor-agent` |
| [Gemini CLI](https://geminicli.com/docs/cli/cli-reference/) | `npm install -g @google/gemini-cli` | `gemini` |
| [OpenCode](https://opencode.ai/docs/cli/) | `curl -fsSL https://opencode.ai/install \| bash` or `npm install -g opencode-ai` | `opencode` |
| [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) | `npm install -g @mariozechner/pi-coding-agent` | `pi`, or set `PI_CODING_AGENT_BIN` |
| [ACP](https://agentclientprotocol.com/) | Use `--acp-agent <id>` to resolve from the ACP registry, or `--acp-command <cmd>` for a custom ACP server | `headless acp-client ...` adapter |

Install the agent CLIs you want Headless to drive.

## More Docs

- [Usage guide](docs/usage.md): agents, output modes, sessions, Docker, Modal, config defaults, CLI flags, and environment variables.
- [Multi-agent workflows](docs/orchestration.md): roles, coordinated runs, teams, run state, messaging, and `headless run` commands.
- [Development](docs/development.md): local setup, test commands, pre-push integration coverage, project layout, and agent install references.

## Development

```bash
npm install
npm run build
npm test
npm run check
```

See [docs/development.md](docs/development.md) for integration tests, hooks, and repository layout.

## Related Inspirations

Projects that shaped parts of Headless' CLI and session-management ergonomics:

- [mngr](https://github.com/imbue-ai/mngr): a tmux-based manager for running and monitoring multiple coding-agent sessions.
- [llm](https://github.com/simonw/llm): Simon Willison's CLI and Python library for running prompts, models, plugins, and local/remote LLM workflows.

## License

Apache-2.0. See [LICENSE](LICENSE).
