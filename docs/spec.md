# Multi-Agent Role and Run Coordination Spec

## Purpose

Headless should support natural multi-agent work without requiring a graph
configuration file. The first-class abstraction is a role-aware Headless
invocation:

```bash
headless codex --role orchestrator --run auth --coordination session --prompt "Build auth"
```

The orchestrator remains an LLM agent. Headless provides prompt templates,
run-state tracking, message routing, and async process supervision. The
orchestrator decides how to use the team within the constraints Headless gives
it.

## Non-Goals

- No `graph.yml` or required file-based graph configuration.
- No `headless orchestrate` subcommand for v1.
- No hard enforcement that the orchestrator only uses the declared team.
- No networked cross-container message broker.
- No required summaries. Run context should expose only roster, status, last
  message, and messaging commands.

## User-Facing CLI

### Role Flags

Add role and coordination flags to normal agent execution:

```bash
headless <agent> --role <role> [--coordination session|tmux|oneshot]
```

Built-in roles:

- `orchestrator`: coordinates a fixed team of subagents.
- `explorer`: read-only codebase investigation.
- `worker`: edit-capable implementation.
- `reviewer`: read-only findings-first review.

`explorer` and `reviewer` default to `--allow read-only`. `worker` and
`orchestrator` default to the normal edit-capable behavior. Explicit CLI flags
override role defaults.

### Run Flags

Add run identity flags:

```bash
--run <run>
--node <node>
--depends-on <node>    # repeatable
--team <spec>          # repeatable, orchestrator prompt input
```

`--run` identifies the shared coordination context. `--node` identifies the
current agent inside that run. If omitted for a role invocation, Headless may
derive a node name from the role, but orchestrator flows should use explicit
nodes.

`--depends-on` records dependency edges for observability. It should not block
execution by itself.

### Team Grammar

`--team` is prompt/context only. It informs the orchestrator which team to
create, but does not prevent surprise nodes.

Supported forms:

```bash
--team explorer
--team worker=2
--team reviewer
--team claude/reviewer
--team codex/worker=3
```

Fields:

- `role`
- `role=N`
- `agent/role`
- `agent/role=N`

Rules:

- Agent prefix is optional. Without a prefix, inherit the orchestrator agent.
- Count defaults to `1`.
- Count must be positive.
- Role must be built-in or configured.
- Agent must be one of the supported Headless agents.

Generated node names:

- `explorer` for a single explorer.
- `reviewer` for a single reviewer.
- `worker-1`, `worker-2` for repeated workers.
- For mixed-agent teams, include the agent only when needed for
  disambiguation, e.g. `reviewer-claude` or `worker-codex-1`.

## Coordination Modes

### `session`

Default mode. Communication is turn-based via native Headless session aliases:

```bash
headless codex --role worker --run auth --node worker-1 --session worker-1 --prompt "..."
headless run message auth worker-1 --prompt "Continue with X"
```

This is persistent conversation messaging, not stdin injection into a running
process. Headless must guard against concurrent writes to the same node/session
with a per-node lock.

### `tmux`

Interactive mode. Nodes are long-lived tmux-backed sessions:

```bash
headless codex --role worker --run auth --node worker-1 --tmux --session worker-1 --prompt "..."
headless run message auth worker-1 --prompt "Continue with X"
```

`run message` routes through existing tmux send behavior. Status is best effort
unless the role explicitly reports back.

### `oneshot`

Stateless child invocations:

```bash
headless codex --role explorer --run auth --node explorer --prompt "..."
```

`run message` launches a new one-shot invocation using the stored node metadata.

## Run Commands

Add a `run` command group:

```bash
headless run list
headless run view <run>
headless run mark <run> <node> --status planned|starting|busy|idle|done|failed|unknown
headless run message <run> <node> --prompt "..." [--async]
headless run wait <run>
```

### `run list`

Lists known runs from the local run store.

### `run view`

Prints the current roster, node statuses, last messages, dependencies, and exact
commands for messaging each node. The default human output should include a
compact graph view first. Do not require a separate `graph` subcommand for v1.

Example:

```text
auth  session  4 nodes

Graph
orchestrator [busy]
|- explorer [done] last: Found auth middleware paths
|- worker-1 [busy] depends: explorer
`- reviewer [planned] depends: worker-1

Recent messages
orchestrator -> worker-1  Implement token refresh
explorer -> orchestrator  Found auth middleware paths

Commands
message worker-1: headless run message auth worker-1 --prompt "..."
logs worker-1:    tail -f ~/.headless/runs/auth/nodes/worker-1/latest.stdout.log
```

Graph rendering rules:

- Render the orchestrator-rooted tree first because most runs are
  orchestrator-centered.
- Support arbitrary DAG state in storage. For edges that do not fit the primary
  tree, show inline `depends: a,b` and add an `Extra edges` section when needed.
- Treat `--depends-on` as structural dependency edges.
- Treat `message_sent` events as runtime communication edges. Show recent
  message flow separately from dependencies.
- Show latest node state first. Include a short recent-event or recent-message
  trail so the user can see how the graph reached that state.
- Keep exact messaging, attach, and log commands in a separate command section
  instead of inline in graph labels.

### `run mark`

Manually updates node status. This is useful for tmux and failure recovery.

### `run message`

Sends a prompt to a registered node using the node's stored metadata:

- `agent`
- `role`
- `coordination`
- `allow`
- `model`
- `reasoningEffort`
- `sessionAlias` or tmux session name

Defaults come from the stored node record. CLI overrides may be added later,
but v1 should prefer the stored record to keep command usage simple.

Synchronous behavior:

- `session`: resume stored native session and wait.
- `oneshot`: run the stored node once and wait.
- `tmux`: send the prompt and return after paste/send.

Async behavior:

```bash
headless run message auth worker-1 --prompt "Implement X" --async
```

For `session` and `oneshot`, async starts a detached child process that invokes
Headless internally. The node becomes `busy`, logs are written under the run
store, and completion updates status to `idle` or `failed`.

For `tmux`, messaging is already fire-and-forget.

### `run wait`

Waits until no nodes in the run are `busy`. The orchestrator prompt must tell
the parent agent to call this before final response when it has launched async
children.

### Team Registration

When an orchestrator invocation includes `--team`, Headless should pre-register
the declared nodes before they are launched. These nodes start as `planned` and
become `starting`, `busy`, `idle`, `done`, or `failed` as execution produces
events. This makes `run view` useful immediately and makes never-started nodes
visible.

Nodes that appear outside the declared team should still be recorded and shown.
Mark them as `planned: false` or `unplanned: true` so the CLI can distinguish
surprise nodes from the orchestrator's initial team.

## Run Store

Default local store:

```text
~/.headless/runs/<run>/
  events.jsonl
  run.json
  nodes/
    <node>/
      state.json
      latest.stdout.log
      latest.stderr.log
```

Allow override via:

```bash
HEADLESS_RUN_DIR=/path/to/run
```

### Node State

Node state should be lightweight:

```json
{
  "runId": "auth",
  "nodeId": "worker-1",
  "role": "worker",
  "agent": "codex",
  "coordination": "session",
  "sessionAlias": "worker-1",
  "status": "idle",
  "lastMessage": "Implemented token refresh; tests pass.",
  "dependsOn": ["explorer"],
  "planned": true,
  "unplanned": false,
  "updatedAt": "2026-04-28T12:00:00.000Z"
}
```

Statuses:

- `planned`
- `starting`
- `busy`
- `idle`
- `done`
- `failed`
- `unknown`

### Events

Append-only JSONL events make the graph auditable:

```json
{
  "type": "node_started",
  "runId": "auth",
  "nodeId": "worker-1",
  "parentNodeId": "orchestrator",
  "role": "worker",
  "agent": "codex",
  "coordination": "session",
  "dependsOn": ["explorer"],
  "createdAt": "2026-04-28T12:00:00.000Z"
}
```

Useful event types:

- `run_started`
- `node_registered`
- `node_started`
- `message_sent`
- `status_changed`
- `node_output`
- `node_failed`
- `node_completed`

Dependency and message edges have different meanings:

- `dependsOn` records structural planning edges. These edges drive the primary
  graph visualization.
- `message_sent` records runtime communication edges. These edges drive recent
  message flow and audit history.

## Prompt Contracts

### Common Injected Context

For any role invocation with `--run`, Headless prepends compact context:

- run id
- current node id
- current role
- coordination mode
- roster from run state and `--team`
- each node's status
- each node's last message
- each node's dependencies
- whether each node is planned or unplanned
- exact command to message each node

Do not inject summaries or full event history. The context should mark the
current node clearly.

### Orchestrator Prompt

The orchestrator role prompt must state:

- Create the declared team at the beginning of the run.
- Treat the declared team as the coordination contract.
- After initial team creation, do not spawn new agents unless the user
  explicitly asks.
- Use `headless run message <run> <node>` for later communication.
- Use the selected `--coordination` style when starting nodes.
- Use async messaging for parallel work when appropriate.
- Call `headless run wait <run>` before final response if async work is running.
- Coordinate based on roster status and last messages.
- Ask each child to send an explicit status message back to the orchestrator
  when finished or blocked.

### Explorer Prompt

The explorer role prompt must state:

- Stay read-only.
- Investigate and report concise findings.
- Include enough status detail for `run view` to show useful `lastMessage`
  text.
- When finished or blocked, message the orchestrator:

```bash
headless run message <run> orchestrator --prompt "<findings or blocker>"
```

### Worker Prompt

The worker role prompt must state:

- Implement the assigned task.
- Keep changes scoped.
- Run relevant verification.
- Include enough status detail for `run view` to show useful `lastMessage`
  text.
- When finished or blocked, message the orchestrator with changes, tests, and
  blockers:

```bash
headless run message <run> orchestrator --prompt "<status>"
```

### Reviewer Prompt

The reviewer role prompt must state:

- Stay read-only.
- Review for bugs, regressions, security risks, and missing tests.
- Lead with findings and file references.
- Include enough status detail for `run view` to show useful `lastMessage`
  text.
- When finished, message the orchestrator with findings or `No findings`:

```bash
headless run message <run> orchestrator --prompt "<findings>"
```

## Docker Behavior

When a top-level Docker invocation has `--run`, Headless should bind-mount the
host run directory into the container and set `HEADLESS_RUN_DIR`:

```text
~/.headless/runs/<run>:/headless-runs/<run>
HEADLESS_RUN_DIR=/headless-runs/<run>
```

The Docker orchestrator is the execution island. Child Headless processes are
spawned inside the same container. They share the mounted run store and can be
visible from the host through the same files.

Async children must finish before the top-level container exits. The
orchestrator prompt enforces this via `headless run wait <run>`.

## Modal Behavior

The Modal orchestrator is also an execution island. Child Headless processes are
spawned inside the same sandbox.

Host-side visibility should be provided by event mirroring:

```text
@@HEADLESS_EVENT@@{"runId":"auth","nodeId":"worker-1","status":"busy"}
```

The local Modal wrapper consumes these framed events and mirrors state into the
host's `~/.headless/runs/<run>` store. The sandbox still writes its own run
store internally. Final workspace sync can reconcile artifacts where practical.

As with Docker, async children must finish before the top-level sandbox exits.
The orchestrator prompt must call `headless run wait <run>` before final
response when async work is active.

## Implementation Notes

- Keep the feature primitive-first. Roles and run commands should compose with
  existing `--session`, `--tmux`, Docker, and Modal behavior.
- Reuse the existing session store concepts, but keep run state in
  `~/.headless/runs` instead of `~/.headless/sessions.json`.
- Use atomic writes for `state.json` and append-only writes for `events.jsonl`.
- Add per-node locks for `session` and `oneshot` messaging to avoid concurrent
  native session resumes.
- Do not rely on final message extraction for correctness. Explicit
  role-to-orchestrator messages are the primary coordination mechanism.
  Opportunistic output capture is still useful for observability and failure
  recovery.
- CLI flags should override role defaults.
- Missing `--run` should still allow `--role`; it just skips run-state context.

## Suggested Implementation Phases

1. Add role parsing, built-in prompt templates, and role default options.
2. Add run store primitives and `run list/view/mark`.
3. Record node state for normal role invocations with `--run` and `--node`.
4. Implement `run message` synchronously for `session`, `oneshot`, and `tmux`.
5. Add async detached child process support and per-node locks.
6. Add `run wait`.
7. Add Docker run-dir bind mount support.
8. Add Modal event-frame mirroring.
9. Expand docs and integration tests.
