# Development

## Local Commands

```bash
npm install
npm run build
npm test
npm run test:integration:local
npm run test:agents
npm run check
npm run hooks:install
```

`npm run check` builds the package and runs the TypeScript test suite. `npm run test:integration:local` runs authenticated local integration coverage; set `HEADLESS_INTEGRATION_AGENTS=claude` to limit it to Claude. After `npm run hooks:install`, the pre-push hook builds the local CLI and runs Claude integration by default; set `HEADLESS_HOOK_ALL_AGENTS=1` to run all agents. `npm run test:agents` is an optional real-agent smoke test; set `HEADLESS_AGENT_SMOKE=1` to run Codex, Claude, Pi, and Gemini with an example prompt.

The package exports one binary, `headless`, from `dist/cli.js`.

## Layout

```text
src/cli.ts      CLI parsing, validation, execution
src/agents.ts   Agent registry and command builders
src/output.ts   Final-message extraction from agent JSON traces
src/modal.ts    Modal sandbox execution and workspace sync
src/roles.ts    Role defaults and prompt composition
src/runs.ts     Local run-state store and locks
src/teams.ts    Team spec parser and generated node names
src/run-view.ts Run graph/list rendering
src/shell.ts    Shell-safe dry-run rendering
src/types.ts    Shared TypeScript contracts
tests/          CLI and command-builder coverage
```