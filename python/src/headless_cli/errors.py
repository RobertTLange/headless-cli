from __future__ import annotations

from collections.abc import Sequence

from .models import CommandResult

_SENSITIVE_FLAGS = frozenset(
    {
        "--prompt",
        "-p",
        "--prompt-file",
        "--work-dir",
        "-C",
        "--docker-env",
        "--docker-arg",
        "--modal-env",
        "--acp-command",
        "--acp-registry",
        "--acp-registry-file",
    }
)


def redact_argv(argv: Sequence[str]) -> tuple[str, ...]:
    redacted: list[str] = []
    hide_next = False
    for value in argv:
        if hide_next:
            redacted.append("<redacted>")
            hide_next = False
            continue
        inline_flag = next(
            (flag for flag in _SENSITIVE_FLAGS if value.startswith(f"{flag}=")),
            None,
        )
        if inline_flag is not None:
            redacted.append(f"{inline_flag}=<redacted>")
            continue
        redacted.append(value)
        hide_next = value in _SENSITIVE_FLAGS
    return tuple(redacted)


class HeadlessError(RuntimeError):
    def __init__(self, message: str, result: CommandResult) -> None:
        self.result = result
        self.safe_argv = redact_argv(result.argv)
        super().__init__(
            f"{message} (exit {result.returncode}; argv={self.safe_argv!r})"
        )

    def __repr__(self) -> str:
        return f"{type(self).__name__}({str(self)!r})"


class HeadlessNotFoundError(FileNotFoundError):
    pass


class HeadlessVersionError(HeadlessError):
    pass


class HeadlessProtocolError(RuntimeError):
    """The CLI returned malformed or unsupported SDK protocol output."""
