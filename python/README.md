# Headless Python SDK

Typed sync and async interfaces for the
[`headless`](https://github.com/RobertTLange/headless-cli) command-line tool.
The CLI remains the execution engine and the authority for option validation.

## Requirements

- Python 3.10 or newer
- Node.js 22 or newer
- A `headless` executable on `PATH`

You can select a different executable with `binary=...`,
`HEADLESS_CLI_BIN`, or `HEADLESS_BIN`, in that order.

## Usage

```python
from headless_cli import Headless

headless = Headless()
result = headless.run(
    "codex",
    prompt="Review this repository",
    model="gpt-5",
    reasoning_effort="high",
    allow="read-only",
)
print(result.final_message)

headless.sessions.send("bughunt", prompt="Continue the fix")
headless.sessions.launch("review", "codex", prompt="Review the repository")
headless.runs.message("auth", "worker-1", prompt="Fix tests", background=True)
headless.cron.pause("inbox-triage")
headless.docker.doctor()
```

The high-level read and run methods use Headless' versioned SDK protocol.
`stream()` yields parsed `SdkTrace`, `SdkResult`, and `SdkError` envelopes.
Prompts use stdin wherever the CLI permits, keeping them out of process
argument lists.

Protocol compatibility is checked on the first structured operation and
cached for the client lifetime. If the installed CLI is too old, the SDK
raises `HeadlessVersionError` with an upgrade command. Constructing a client
never starts a subprocess.

Structured methods raise on SDK error envelopes by default. Pass
`check=False` to receive a typed `SdkError` value instead.

```python
for event in headless.stream(["codex"], input="Review this diff"):
    print(event)
```

Use `invoke()` as the raw escape hatch for new or uncommon CLI features:

```python
command = headless.invoke(["--help"])
print(command.stdout)
```

Runs using legacy raw-output or interactive flags (`json`, `debug`, `tmux`,
or `print_command`) return `sdk=None`. Read their raw output through
`stdout`; `final_message` is intentionally empty because those modes do not
provide a normalized final-message result.

Interactive attach inherits the current terminal:

```python
headless.sessions.attach("bughunt")
```

`sessions.launch(name, ...)` creates a managed tmux session using
`--tmux --name`. Native durable agent sessions remain available through
`run(..., session=name)`.

Async methods have the same shape:

```python
from headless_cli import AsyncHeadless

headless = AsyncHeadless()
result = await headless.run("claude", prompt="Fix the failing tests")
```

The package has no runtime Python dependencies.
