---
name: headless-swarm
description: Create and control a visual macOS Ghostty split layout of durable Headless tmux agent sessions. Use when an orchestrator agent needs to split the current Ghostty tab into visible subagent panes, send follow-up messages to subagents, capture their visible feedback, or coordinate multi-agent Headless work from one main pane.
---

# Headless Swarm

Use this skill to coordinate several `headless` subagents from a main orchestrator pane while keeping each subagent visible in Ghostty.

Resolve the bundled helper first; do not assume the current repository has a root-level `scripts/` directory:

```bash
HELPER="$HOME/.codex/skills/headless-swarm/scripts/headless-splits"
[ -x "$HELPER" ] || { echo "Install headless-swarm into ~/.codex/skills first" >&2; exit 1; }
"$HELPER" --help
```

## Workflow

1. Start from the orchestrator agent running inside Ghostty on macOS.
2. Create visible subagent splits with `start`.
3. Send follow-ups with `send` or `send-all`.
4. Wait for tracked sessions to become idle with `wait`, then retrieve feedback with `capture-all` or `capture`.
5. Clean up with `cleanup --kill-sessions` when the swarm is no longer needed.

```bash
"$HELPER" start --agent codex --work-dir "$PWD" --prompt "Investigate the failing tests. Report findings only." worker-1 worker-2 reviewer
"$HELPER" start --work-dir "$PWD" --prompt "Use your assigned role. Report findings only." codex:code claude:review gemini:docs pi:ux
"$HELPER" send worker-1 --agent codex --prompt "Focus on src/sessions.ts and report the likely root cause."
"$HELPER" send-all worker-1 worker-2 --agent codex --prompt "Stop after findings. Do not edit files."
"$HELPER" status
"$HELPER" wait --timeout 120
"$HELPER" capture-all
```

## Behavior

- Prefer the helper over raw AppleScript, raw `tmux send-keys`, or direct agent CLI calls.
- Use Headless named tmux sessions as durable endpoints: node `worker-1` with agent `codex` maps to `headless-codex-worker-1`.
- `start` launches all requested Headless sessions in parallel, then rebuilds the visible tmux aggregator once.
- For mixed-agent starts, prefix nodes as `agent:node`, for example `codex:code claude:review gemini:docs`. Unprefixed nodes use `--agent`.
- If the node equals the agent, for example `claude:claude`, the tmux name is normalized to `headless-claude-main` instead of `headless-claude-claude`.
- Keep the focused orchestrator pane as a full-height left control pane. Subagents appear in one right-side Ghostty pane running a tmux aggregator.
- Size the nested tmux grid explicitly: 4 agents become 2 x 2, and 8 agents become 2 x 4.
- On each `start`, rebuild the current Ghostty tab's tracked Headless sessions, then include both existing and newly started sessions in the aggregator.
- Stale sessions from the current tab's state are pruned before rebuilding the aggregator.
- Treat the current Ghostty tab as owned by the swarm layout: `start` keeps the orchestrator pane and closes all other panes before creating the right-side aggregator.
- The aggregator pane is launched with Ghostty's command configuration, not by typing into an interactive shell.
- Send follow-up work through `headless send` via the helper.
- Use `status`, `wait`, and `capture-all` for mixed-agent swarms. Use `send agent:node` or `capture agent:node` for one explicit mixed-agent node.
- Use `cleanup` to remove the tab aggregator and state; add `--kill-sessions` only when the durable Headless sessions should be terminated too.

## Prompting

Give each node a narrow assignment and tell it whether edits are allowed. The helper prefixes prompts with node identity and a reminder that the orchestrator will route follow-ups through Headless.

For prompts longer than a short sentence, prefer `--prompt-file`:

```bash
"$HELPER" start --agent codex --work-dir "$PWD" --prompt-file /tmp/swarm-task.md worker-1 reviewer
"$HELPER" send reviewer --agent codex --prompt-file /tmp/review-followup.md
```

## Recovery

If Ghostty automation fails, verify AppleScript support:

```bash
osascript -e 'tell application "Ghostty" to get version'
```

If a visible split closes, reattach manually:

```bash
headless attach headless-codex-worker-1
```

If a node is not responding, check status and capture:

```bash
"$HELPER" status
"$HELPER" wait --timeout 120
"$HELPER" capture worker-1 --agent codex
```
