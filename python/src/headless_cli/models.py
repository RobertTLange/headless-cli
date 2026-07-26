from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, Literal, TypeVar

Agent = Literal[
    "antigravity",
    "claude",
    "codex",
    "cursor",
    "gemini",
    "opencode",
    "pi",
    "acp",
]
AllowMode = Literal["read-only", "yolo"]
ReasoningEffort = Literal["low", "medium", "high", "xhigh"]
Role = Literal["orchestrator", "explorer", "worker", "reviewer"]
Coordination = Literal["session", "tmux", "oneshot"]
RunStatus = Literal[
    "planned",
    "starting",
    "busy",
    "waiting",
    "idle",
    "done",
    "failed",
    "unknown",
]
SdkData = TypeVar("SdkData")


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str
    argv: tuple[str, ...]


@dataclass(frozen=True)
class RunResult:
    final_message: str
    command: CommandResult
    sdk: SdkResult[dict[str, Any]] | SdkError | None
    agent: str
    provider: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    native_session_id: str | None = None
    usage: Any = None

    @property
    def returncode(self) -> int:
        return self.command.returncode

    @property
    def stdout(self) -> str:
        return self.command.stdout

    @property
    def stderr(self) -> str:
        return self.command.stderr

    @property
    def argv(self) -> tuple[str, ...]:
        return self.command.argv


@dataclass(frozen=True)
class StreamEvent:
    source: Literal["stdout", "stderr"]
    text: str


@dataclass(frozen=True)
class SdkResult(Generic[SdkData]):
    protocol_version: int
    command: str
    exit_code: int
    data: SdkData
    command_result: CommandResult | None = field(
        default=None, compare=False, repr=False
    )


@dataclass(frozen=True)
class SdkError:
    protocol_version: int
    command: str
    exit_code: int
    message: str
    command_result: CommandResult | None = field(
        default=None, compare=False, repr=False
    )


@dataclass(frozen=True)
class SdkTrace:
    protocol_version: int
    command: str
    agent: str
    value: Any = None
    raw: str | None = None
    partial: bool | None = None
    sequence: int | None = None


SdkEnvelope = SdkResult[Any] | SdkError | SdkTrace
