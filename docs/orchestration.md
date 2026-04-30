# Multi-Agent Workflows

Headless can coordinate multiple local agents through roles, a shared run store, and message routing commands.

## Roles and Runs

Pass `--role orchestrator|explorer|worker|reviewer` to prepend role-specific coordination instructions. `explorer` and `reviewer` default to `--allow read-only` unless `--allow` is explicit; `worker` and `orchestrator` keep the normal edit-capable default.

Add `--run <name>` and optional `--node <name>` to track local state in `~/.headless/runs/<name>/run.json`, with per-node logs under `nodes/<node>/`.

```bash
headless codex --role orchestrator --run auth --node orchestrator --prompt "Build auth"
```

## Role Config

Role defaults live in `~/.headless/config.toml` under `[roles.<name>]`. Use this to add or override settings for another supported role, including its default model, reasoning effort, permission mode, and base instruction prompt.

```toml
[roles.reviewer]
model = "claude-opus-4-6"
reasoning_effort = "high"
allow = "read-only"
base_instruction_prompt = """
Role: reviewer.
Stay read-only. Review for bugs, regressions, security risks, and missing tests.
Lead with findings ordered by severity and include file and line references.
"""
```

Then invoke the role normally:

```bash
headless claude --role reviewer --run auth --node reviewer --prompt "Review the current diff"
```

Supported role names are currently fixed: `orchestrator`, `explorer`, `worker`, and `reviewer`. Config sections for arbitrary names such as `[roles.scout]` are rejected.

## Team Declarations

Orchestrators can declare prompt-only teams with repeatable `--team` specs:

- `explorer`
- `worker=2`
- `claude/reviewer`
- `codex/worker=3`

Example:

```bash
headless codex \
  --role orchestrator \
  --run auth \
  --node orchestrator \
  --team explorer \
  --team worker=2 \
  --prompt "Build auth"
```

## Coordination Modes

Use `--coordination session|tmux|oneshot` to choose how a run node receives later messages.

- `session`: resume native Headless sessions.
- `tmux`: send through the existing tmux buffer flow.
- `oneshot`: launch a fresh stateless invocation.

## Run Commands

Run commands operate on local run state:

- `headless run list`: list known runs.
- `headless run view <run>`: render the graph, recent messages, and exact message/log/attach commands.
- `headless run mark <run> <node> --status planned|starting|busy|idle|done|failed|unknown`: manually adjust status.
- `headless run message <run> <node> --prompt "..." [--async]`: route a prompt using stored node metadata.
- `headless run wait <run>`: wait until no nodes are `busy` or `starting`.

Example:

```bash
headless run view auth
headless run message auth worker-1 --prompt "Continue with refresh token tests"
headless run message auth reviewer --prompt "Review the diff" --async
headless run wait auth
```

## Status Logs

When an orchestrator run executes locally or through Docker, Headless writes compact lifecycle logs to stderr while it runs. The stream reports node status changes and message routes without printing prompt text, uses short timestamps and ANSI colors on TTYs unless `NO_COLOR` is set, and leaves stdout reserved for final answers or JSON/debug output.

Tune polling with `HEADLESS_RUN_STATUS_INTERVAL_MS`. Modal orchestrator runs rely on final synced run state and node logs for status.

## Docker Run Coordination

Docker run coordination mounts the host run directory into containers with `HEADLESS_RUN_DIR`, so containerized nodes can read and update the same local run state.

```bash
headless codex --role worker --run auth --node worker-1 --docker --prompt "Implement the next task"
```
