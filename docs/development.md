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

## Python SDK

The Python package lives in `python/` and calls the built Headless CLI. Install
its test dependencies, then run the full local gate:

```bash
npm run build
python -m pip install -e "./python[test]"
cd python
python -m ruff format --check src tests
python -m ruff check src tests
python -m mypy src tests
python -m coverage run -m pytest
python -m coverage report --fail-under=80
python -m build
HEADLESS_CLI_BIN=../dist/cli.js python -c "from headless_cli import Headless; print(Headless().version())"
```

CI runs the SDK on the oldest and newest supported Python versions. Release
builds publish `headless-cli` to PyPI through trusted publishing when that
package version does not already exist.

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
python/         Typed sync/async Python SDK, tests, and packaging
```
