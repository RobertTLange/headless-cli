from __future__ import annotations

from collections.abc import Mapping, Sequence
from os import PathLike
from typing import TYPE_CHECKING, Any

from .models import (
    Agent,
    AllowMode,
    CommandResult,
    ReasoningEffort,
    RunResult,
    RunStatus,
    SdkError,
    SdkResult,
)
from .options import append_many, append_value

if TYPE_CHECKING:
    from .client import Headless


def _prompt_args(
    args: list[str],
    prompt: str | None,
    prompt_file: str | PathLike[str] | None,
) -> str | None:
    if prompt is not None and prompt_file is not None:
        raise ValueError("use either prompt or prompt_file, not both")
    input_text = prompt
    if prompt_file is not None:
        append_value(args, "--prompt-file", prompt_file)
    return input_text


class Sessions:
    def __init__(self, client: Headless) -> None:
        self._client = client

    def list(
        self, agent: Agent | str | None = None, **invoke_options: Any
    ) -> SdkResult[dict[str, Any]] | SdkError:
        args = [agent] if agent is not None else []
        args.append("--list")
        return self._client._invoke_sdk(args, **invoke_options)

    def launch(
        self,
        name: str,
        agent: Agent | str | None = None,
        **run_options: Any,
    ) -> RunResult:
        return self._client.run(agent, tmux=True, name=name, **run_options)

    def send(
        self,
        name: str,
        *,
        prompt: str | None = None,
        prompt_file: str | PathLike[str] | None = None,
        print_command: bool = False,
        **invoke_options: Any,
    ) -> CommandResult:
        args = ["send", name]
        input_text = _prompt_args(args, prompt, prompt_file)
        if print_command:
            args.append("--print-command")
        return self._client.invoke(args, input=input_text, **invoke_options)

    def rename(
        self,
        name: str,
        new_name: str,
        *,
        print_command: bool = False,
        **invoke_options: Any,
    ) -> CommandResult:
        args = ["rename", name, new_name]
        if print_command:
            args.append("--print-command")
        return self._client.invoke(args, **invoke_options)

    def attach(
        self,
        name: str | None = None,
        *,
        all: bool = False,
        print_command: bool = False,
        cwd: str | PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
    ) -> CommandResult:
        args = ["attach"]
        if name is not None:
            args.append(name)
        if all:
            args.append("--all")
        if print_command:
            args.append("--print-command")
            return self._client.invoke(args, cwd=cwd, env=env, check=check)
        return self._client._transport.interactive(args, cwd=cwd, env=env, check=check)


class Runs:
    def __init__(self, client: Headless) -> None:
        self._client = client

    def list(self, **invoke_options: Any) -> SdkResult[dict[str, Any]] | SdkError:
        return self._client._invoke_sdk(["run", "list"], **invoke_options)

    def view(
        self, run_id: str, **invoke_options: Any
    ) -> SdkResult[dict[str, Any]] | SdkError:
        return self._client._invoke_sdk(["run", "view", run_id], **invoke_options)

    def mark(
        self,
        run_id: str,
        node: str,
        *,
        status: RunStatus,
        **invoke_options: Any,
    ) -> CommandResult:
        return self._client.invoke(
            ["run", "mark", run_id, node, "--status", status], **invoke_options
        )

    def message(
        self,
        run_id: str,
        node: str,
        *,
        prompt: str | None = None,
        prompt_file: str | PathLike[str] | None = None,
        background: bool = False,
        print_command: bool = False,
        **invoke_options: Any,
    ) -> CommandResult:
        args = ["run", "message", run_id, node]
        input_text = _prompt_args(args, prompt, prompt_file)
        if background:
            args.append("--async")
        if print_command:
            args.append("--print-command")
        return self._client.invoke(args, input=input_text, **invoke_options)

    def wait(self, run_id: str, **invoke_options: Any) -> CommandResult:
        return self._client.invoke(["run", "wait", run_id], **invoke_options)


class Cron:
    def __init__(self, client: Headless) -> None:
        self._client = client

    def add(
        self,
        agent: Agent | str,
        *,
        name: str | None = None,
        every: str | None = None,
        schedule: str | None = None,
        prompt: str | None = None,
        prompt_file: str | PathLike[str] | None = None,
        model: str | None = None,
        fast: bool = False,
        reasoning_effort: ReasoningEffort | None = None,
        allow: AllowMode | None = None,
        work_dir: str | PathLike[str] | None = None,
        docker: bool = False,
        docker_image: str | None = None,
        docker_args: Sequence[str] | None = None,
        docker_env: Sequence[str] | None = None,
        modal: bool = False,
        modal_app: str | None = None,
        modal_cpu: float | None = None,
        modal_env: Sequence[str] | None = None,
        modal_image: str | None = None,
        modal_image_secret: str | None = None,
        modal_include_git: bool = False,
        modal_memory: int | None = None,
        modal_secrets: Sequence[str] | None = None,
        modal_timeout: int | None = None,
        timeout_seconds: int | None = None,
        json: bool = False,
        debug: bool = False,
        usage: bool = False,
        **invoke_options: Any,
    ) -> CommandResult:
        args = ["cron", "add", agent]
        append_value(args, "--name", name)
        append_value(args, "--every", every)
        append_value(args, "--schedule", schedule)
        append_value(args, "--prompt", prompt)
        append_value(args, "--prompt-file", prompt_file)
        append_value(args, "--model", model)
        if fast:
            args.append("--fast")
        append_value(args, "--reasoning-effort", reasoning_effort)
        append_value(args, "--allow", allow)
        append_value(args, "--work-dir", work_dir)
        if docker:
            args.append("--docker")
        append_value(args, "--docker-image", docker_image)
        append_many(args, "--docker-arg", docker_args)
        append_many(args, "--docker-env", docker_env)
        if modal:
            args.append("--modal")
        append_value(args, "--modal-app", modal_app)
        append_value(args, "--modal-cpu", modal_cpu)
        append_many(args, "--modal-env", modal_env)
        append_value(args, "--modal-image", modal_image)
        append_value(args, "--modal-image-secret", modal_image_secret)
        if modal_include_git:
            args.append("--modal-include-git")
        append_value(args, "--modal-memory", modal_memory)
        append_many(args, "--modal-secret", modal_secrets)
        append_value(args, "--modal-timeout", modal_timeout)
        append_value(args, "--timeout", timeout_seconds)
        for enabled, flag in (
            (json, "--json"),
            (debug, "--debug"),
            (usage, "--usage"),
        ):
            if enabled:
                args.append(flag)
        return self._client.invoke(args, **invoke_options)

    def list(self, **invoke_options: Any) -> SdkResult[dict[str, Any]] | SdkError:
        return self._client._invoke_sdk(["cron", "list"], **invoke_options)

    def view(
        self, job: str, **invoke_options: Any
    ) -> SdkResult[dict[str, Any]] | SdkError:
        return self._client._invoke_sdk(["cron", "view", job], **invoke_options)

    def pause(self, job: str, **invoke_options: Any) -> CommandResult:
        return self._simple("pause", job, invoke_options=invoke_options)

    def resume(self, job: str, **invoke_options: Any) -> CommandResult:
        return self._simple("resume", job, invoke_options=invoke_options)

    def kill(self, job: str, **invoke_options: Any) -> CommandResult:
        return self._simple("kill", job, invoke_options=invoke_options)

    def remove(
        self, job: str, *, force: bool = False, **invoke_options: Any
    ) -> CommandResult:
        args = ["cron", "rm", job]
        if force:
            args.append("--force")
        return self._client.invoke(args, **invoke_options)

    def start(self, **invoke_options: Any) -> CommandResult:
        return self._simple("start", invoke_options=invoke_options)

    def stop(self, **invoke_options: Any) -> CommandResult:
        return self._simple("stop", invoke_options=invoke_options)

    def _simple(
        self,
        command: str,
        argument: str | None = None,
        *,
        invoke_options: Mapping[str, Any],
    ) -> CommandResult:
        args = ["cron", command]
        if argument is not None:
            args.append(argument)
        return self._client.invoke(args, **invoke_options)


class Docker:
    def __init__(self, client: Headless) -> None:
        self._client = client

    def doctor(
        self, *, image: str | None = None, **invoke_options: Any
    ) -> CommandResult:
        args = ["docker", "doctor"]
        append_value(args, "--docker-image", image)
        return self._client.invoke(args, **invoke_options)

    def build(
        self,
        *,
        image: str | None = None,
        print_command: bool = False,
        **invoke_options: Any,
    ) -> CommandResult:
        args = ["docker", "build"]
        append_value(args, "--docker-image", image)
        if print_command:
            args.append("--print-command")
        return self._client.invoke(args, **invoke_options)
