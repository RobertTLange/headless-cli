# Changelog

## Unreleased

- Added Modal CPU sandbox execution with workspace upload, sync-back, resource flags, env forwarding, and named Modal Secret support.
- Added Docker execution mode, Docker setup checks, local image builds, and packaged Docker image support. Thanks @RobertTLange for PR #3.

## 0.1.1 - 2026-04-24

- Added `--debug` mode to stream the raw agent trace and append the extracted final assistant message.
- Changed `--json` mode to stream raw agent trace output in real time instead of printing one final buffered dump.

## 0.1.0 - 2026-04-24

- Initial npm release of Headless CLI as `@roberttlange/headless`.
- Added one CLI entrypoint for running Codex, Claude Code, Cursor, Gemini, OpenCode, and Pi in headless mode.
- Normalized prompts, prompt files, stdin prompts, model overrides, working directories, dry-run command printing, JSON output, and adapter config inspection across supported agents.
- Added tmux launch mode with detached interactive sessions, session listing, and agent-specific trust/prompt-submission handling. Thanks @RobertTLange for PR #1, adding the tmux launch workflow.
- Added permission modes for read-only review and explicit yolo/auto-approve execution where supported by each agent.
- Added `headless --check` for local setup validation and agent version reporting.
- Added npm package metadata, release workflow, packaging checks, README usage docs, and TypeScript test coverage for CLI parsing, adapter command building, allow modes, output extraction, and setup checks.
