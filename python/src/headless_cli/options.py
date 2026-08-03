from __future__ import annotations

from collections.abc import Sequence
from os import PathLike
from typing import Any


def append_value(args: list[str], flag: str, value: object | None) -> None:
    if value is not None:
        args.extend((flag, str(value)))


def append_many(args: list[str], flag: str, values: Sequence[object] | None) -> None:
    for value in values or ():
        append_value(args, flag, value)


def build_run_args(
    agent: str | None,
    *,
    prompt: str | None = None,
    prompt_file: str | PathLike[str] | None = None,
    model: str | None = None,
    fast: bool = False,
    reasoning_effort: str | None = None,
    allow: str | None = None,
    acp_agent: str | None = None,
    acp_command: str | None = None,
    acp_registry: str | None = None,
    acp_registry_file: str | PathLike[str] | None = None,
    role: str | None = None,
    coordination: str | None = None,
    run_id: str | None = None,
    node: str | None = None,
    depends_on: Sequence[str] | None = None,
    team: Sequence[str] | None = None,
    work_dir: str | PathLike[str] | None = None,
    docker: bool = False,
    docker_image: str | None = None,
    docker_args: Sequence[str] | None = None,
    docker_env: Sequence[str] | None = None,
    modal: bool = False,
    modal_image: str | None = None,
    modal_image_secret: str | None = None,
    modal_app: str | None = None,
    modal_cpu: float | None = None,
    modal_memory: int | None = None,
    modal_timeout: int | None = None,
    modal_secrets: Sequence[str] | None = None,
    modal_env: Sequence[str] | None = None,
    modal_include_git: bool = False,
    timeout_seconds: int | None = None,
    session: str | None = None,
    json: bool = False,
    debug: bool = False,
    usage: bool = False,
    tmux: bool = False,
    wait: bool = False,
    delete: bool = False,
    name: str | None = None,
    print_command: bool = False,
    **_: Any,
) -> tuple[list[str], str | None]:
    if prompt is not None and prompt_file is not None:
        raise ValueError("use either prompt or prompt_file, not both")
    args = [agent] if agent is not None else []
    input_text = prompt
    if prompt_file is not None:
        append_value(args, "--prompt-file", prompt_file)
    append_value(args, "--model", model)
    if fast:
        args.append("--fast")
    append_value(args, "--reasoning-effort", reasoning_effort)
    append_value(args, "--allow", allow)
    append_value(args, "--acp-agent", acp_agent)
    append_value(args, "--acp-command", acp_command)
    append_value(args, "--acp-registry", acp_registry)
    append_value(args, "--acp-registry-file", acp_registry_file)
    append_value(args, "--role", role)
    append_value(args, "--coordination", coordination)
    append_value(args, "--run", run_id)
    append_value(args, "--node", node)
    append_many(args, "--depends-on", depends_on)
    append_many(args, "--team", team)
    append_value(args, "--work-dir", work_dir)
    if docker:
        args.append("--docker")
    append_value(args, "--docker-image", docker_image)
    append_many(args, "--docker-arg", docker_args)
    append_many(args, "--docker-env", docker_env)
    if modal:
        args.append("--modal")
    append_value(args, "--modal-image", modal_image)
    append_value(args, "--modal-image-secret", modal_image_secret)
    append_value(args, "--modal-app", modal_app)
    append_value(args, "--modal-cpu", modal_cpu)
    append_value(args, "--modal-memory", modal_memory)
    append_value(args, "--modal-timeout", modal_timeout)
    append_many(args, "--modal-secret", modal_secrets)
    append_many(args, "--modal-env", modal_env)
    if modal_include_git:
        args.append("--modal-include-git")
    append_value(args, "--timeout", timeout_seconds)
    append_value(args, "--session", session)
    for enabled, flag in (
        (json, "--json"),
        (debug, "--debug"),
        (usage, "--usage"),
        (tmux, "--tmux"),
        (wait, "--wait"),
        (delete, "--delete"),
    ):
        if enabled:
            args.append(flag)
    append_value(args, "--name", name)
    if print_command:
        args.append("--print-command")
    return args, input_text
