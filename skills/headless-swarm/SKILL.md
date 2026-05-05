---
name: headless-swarm
description: Create and control a visual macOS Ghostty split layout of durable Headless tmux agent sessions. Use when an orchestrator agent needs to launch visible subagent panes for Codex, Claude, Gemini, Pi, Cursor, or OpenCode, send follow-up messages, capture feedback, or coordinate multi-agent Headless work from one main pane.
---

# Headless Swarm

Use this skill to coordinate several `headless` subagents from a main orchestrator pane while keeping each subagent visible in Ghostty. The orchestrator can be any agent that can run shell commands; the subagents can be any backend supported by Headless.

Resolve the bundled helper from a trusted installed skill directory. Do not run a helper from the current repository unless the user explicitly installed or selected that copy.

```bash
for dir in \
  "${HEADLESS_SWARM_SKILL_DIR:-}" \
  "$HOME/.agents/skills/headless-swarm" \
  "$HOME/.codex/skills/headless-swarm" \
  "$HOME/.claude/skills/headless-swarm" \
  "$HOME/.pi/skills/headless-swarm" \
  "$HOME/.gemini/skills/headless-swarm" \
  "$HOME/.opencode/skills/headless-swarm" \
do
  [ -n "$dir" ] && [ -x "$dir/scripts/headless-splits" ] && SKILL_DIR="$dir" && break
done
[ -n "${SKILL_DIR:-}" ] || { echo "Install headless-swarm or set HEADLESS_SWARM_SKILL_DIR" >&2; exit 1; }
HELPER="$SKILL_DIR/scripts/headless-splits"
"$HELPER" --help
```

## Workflow

1. Start from the orchestrator agent running inside Ghostty on macOS.
2. Create visible subagent splits with `start`.
3. Send follow-ups with `send` or `send-all`.
4. Wait for tracked sessions to become idle with `wait`, then retrieve feedback with `capture-all` or `capture`.
5. Clean up with `cleanup --kill-sessions` when the swarm is no longer needed.

```bash
"$HELPER" start --work-dir "$PWD" --prompt "Use your assigned role. Report findings only." codex:code claude:review gemini:docs pi:ux
"$HELPER" send claude:review --prompt "Focus on regressions and security risks."
"$HELPER" send-all codex:code gemini:docs --prompt "Stop after findings. Do not edit files."
"$HELPER" status
"$HELPER" wait --timeout 120
"$HELPER" capture-all
```

## Behavior

- Prefer the helper over raw AppleScript, raw `tmux send-keys`, or direct agent CLI calls.
- Use Headless named tmux sessions as durable endpoints: node `review` with agent `claude` maps to `headless-claude-review`.
- `start` launches all requested Headless sessions in parallel, then rebuilds the visible tmux aggregator once.
- For mixed-agent starts, prefix nodes as `agent:node`, for example `codex:code claude:review gemini:docs pi:ux`. Unprefixed nodes use `--agent`.
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
"$HELPER" start --work-dir "$PWD" --prompt-file /tmp/swarm-task.md codex:worker claude:reviewer
"$HELPER" send claude:reviewer --prompt-file /tmp/review-followup.md
```

## Recovery

If Ghostty automation fails, verify AppleScript support:

```bash
osascript -e 'tell application "Ghostty" to get version'
```

If a visible split closes, reattach manually:

```bash
headless attach headless-claude-review
```

If a node is not responding, check status and capture:

```bash
"$HELPER" status
"$HELPER" wait --timeout 120
"$HELPER" capture claude:review
```
