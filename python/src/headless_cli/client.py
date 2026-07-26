from __future__ import annotations

import os
from collections.abc import Generator, Mapping, Sequence
from typing import Any, cast

from .errors import HeadlessError, HeadlessProtocolError, HeadlessVersionError
from .models import (
    Agent,
    AllowMode,
    CommandResult,
    Coordination,
    ReasoningEffort,
    Role,
    RunResult,
    SdkEnvelope,
    SdkError,
    SdkResult,
    StreamEvent,
)
from .namespaces import Cron, Docker, Runs, Sessions
from .options import append_value, build_run_args
from .protocol import (
    SDK_PROTOCOL_VERSION,
    is_supported_protocol_version,
    parse_sdk_envelope,
    parse_sdk_result,
)
from .transport import SubprocessTransport


class Headless:
    def __init__(
        self,
        binary: str | os.PathLike[str] | None = None,
        *,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self._transport = SubprocessTransport(binary, env=env)
        self.sessions = Sessions(self)
        self.runs = Runs(self)
        self.cron = Cron(self)
        self.docker = Docker(self)
        self._protocol_compatible = False

    def invoke(
        self,
        args: Sequence[str],
        *,
        input: str | None = None,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        process_timeout_seconds: float | None = None,
        check: bool = True,
    ) -> CommandResult:
        return self._transport.invoke(
            args,
            input=input,
            cwd=cwd,
            env=env,
            timeout=process_timeout_seconds,
            check=check,
        )

    def stream(
        self,
        args: Sequence[str],
        *,
        input: str | None = None,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        process_timeout_seconds: float | None = None,
        check: bool = True,
    ) -> Generator[SdkEnvelope | StreamEvent, None, None]:
        sdk_args = [*args, "--sdk-format", "ndjson"]

        def parsed_events() -> Generator[SdkEnvelope | StreamEvent, None, None]:
            self._ensure_protocol_compatible(
                cwd=cwd,
                env=env,
                process_timeout_seconds=process_timeout_seconds,
            )
            for event in self._transport.stream(
                sdk_args,
                input=input,
                cwd=cwd,
                env=env,
                timeout=process_timeout_seconds,
                check=check,
            ):
                yield (
                    parse_sdk_envelope(event.text)
                    if event.source == "stdout"
                    else event
                )

        return parsed_events()

    def run(
        self,
        agent: Agent | str | None = None,
        *,
        prompt: str | None = None,
        prompt_file: str | os.PathLike[str] | None = None,
        model: str | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        allow: AllowMode | None = None,
        acp_agent: str | None = None,
        acp_command: str | None = None,
        acp_registry: str | None = None,
        acp_registry_file: str | os.PathLike[str] | None = None,
        role: Role | None = None,
        coordination: Coordination | None = None,
        run_id: str | None = None,
        node: str | None = None,
        depends_on: Sequence[str] | None = None,
        team: Sequence[str] | None = None,
        work_dir: str | os.PathLike[str] | None = None,
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
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        process_timeout_seconds: float | None = None,
        check: bool = True,
    ) -> RunResult:
        args, input_text = build_run_args(
            agent,
            prompt=prompt,
            prompt_file=prompt_file,
            model=model,
            reasoning_effort=reasoning_effort,
            allow=allow,
            acp_agent=acp_agent,
            acp_command=acp_command,
            acp_registry=acp_registry,
            acp_registry_file=acp_registry_file,
            role=role,
            coordination=coordination,
            run_id=run_id,
            node=node,
            depends_on=depends_on,
            team=team,
            work_dir=work_dir,
            docker=docker,
            docker_image=docker_image,
            docker_args=docker_args,
            docker_env=docker_env,
            modal=modal,
            modal_image=modal_image,
            modal_image_secret=modal_image_secret,
            modal_app=modal_app,
            modal_cpu=modal_cpu,
            modal_memory=modal_memory,
            modal_timeout=modal_timeout,
            modal_secrets=modal_secrets,
            modal_env=modal_env,
            modal_include_git=modal_include_git,
            timeout_seconds=timeout_seconds,
            session=session,
            json=json,
            debug=debug,
            usage=usage,
            tmux=tmux,
            wait=wait,
            delete=delete,
            name=name,
            print_command=print_command,
        )

        def raw_result() -> RunResult:
            command = self.invoke(
                args,
                input=input_text,
                cwd=cwd,
                env=env,
                process_timeout_seconds=process_timeout_seconds,
                check=check,
            )
            return RunResult(
                final_message="",
                command=command,
                sdk=None,
                agent=str(agent or ""),
            )

        if json or debug or tmux or coordination == "tmux" or print_command:
            return raw_result()
        try:
            sdk = self._invoke_sdk(
                args,
                input=input_text,
                cwd=cwd,
                env=env,
                process_timeout_seconds=process_timeout_seconds,
                check=check,
            )
        except HeadlessVersionError:
            raise
        except HeadlessError as error:
            if coordination is not None or not _is_tmux_sdk_rejection(error.result):
                raise
            return raw_result()
        if (
            coordination is None
            and isinstance(sdk, SdkError)
            and _is_tmux_sdk_rejection(_command_result(sdk))
        ):
            return raw_result()
        if isinstance(sdk, SdkError):
            return RunResult(
                final_message="",
                command=_command_result(sdk),
                sdk=sdk,
                agent=str(agent or ""),
            )
        data = _run_data(sdk)
        return RunResult(
            final_message=_optional_string(data, "finalMessage") or "",
            command=_command_result(sdk),
            sdk=sdk,
            agent=_optional_string(data, "agent") or str(agent or ""),
            provider=_optional_string(data, "provider"),
            model=_optional_string(data, "model"),
            reasoning_effort=_optional_string(data, "reasoningEffort"),
            native_session_id=_optional_string(data, "nativeSessionId"),
            usage=data.get("usage"),
        )

    def check(
        self, *, docker_image: str | None = None, **invoke_options: Any
    ) -> SdkResult[dict[str, Any]] | SdkError:
        args = ["--check"]
        append_value(args, "--docker-image", docker_image)
        return self._invoke_sdk(args, **invoke_options)

    def show_config(
        self,
        agent: Agent | str | None = None,
        *,
        model: str | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        allow: AllowMode | None = None,
        **invoke_options: Any,
    ) -> SdkResult[dict[str, Any]] | SdkError:
        args = [agent] if agent is not None else []
        args.append("--show-config")
        append_value(args, "--model", model)
        append_value(args, "--reasoning-effort", reasoning_effort)
        append_value(args, "--allow", allow)
        return self._invoke_sdk(args, **invoke_options)

    def version(self, **invoke_options: Any) -> str | SdkError:
        result = self._invoke_sdk(["--version"], **invoke_options)
        if isinstance(result, SdkError):
            return result
        return _required_data_string(result, "version")

    def capabilities(self, **invoke_options: Any) -> SdkResult[dict[str, Any]]:
        result = self._request_sdk(
            ["capabilities"], compatibility_check=True, **invoke_options
        )
        if isinstance(result, SdkError):
            raise _version_error(_command_result(result))
        self._validate_capabilities(result)
        self._protocol_compatible = True
        return result

    def _invoke_sdk(
        self,
        args: Sequence[str],
        *,
        input: str | None = None,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        process_timeout_seconds: float | None = None,
        check: bool = True,
    ) -> SdkResult[dict[str, Any]] | SdkError:
        self._ensure_protocol_compatible(
            cwd=cwd,
            env=env,
            process_timeout_seconds=process_timeout_seconds,
        )
        return self._request_sdk(
            args,
            input=input,
            cwd=cwd,
            env=env,
            process_timeout_seconds=process_timeout_seconds,
            check=check,
        )

    def _request_sdk(
        self,
        args: Sequence[str],
        *,
        input: str | None = None,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        process_timeout_seconds: float | None = None,
        check: bool = True,
        compatibility_check: bool = False,
    ) -> SdkResult[dict[str, Any]] | SdkError:
        command = self.invoke(
            [*args, "--sdk-format", "json"],
            input=input,
            cwd=cwd,
            env=env,
            process_timeout_seconds=process_timeout_seconds,
            check=False,
        )
        try:
            envelope = parse_sdk_result(command.stdout)
        except HeadlessProtocolError as error:
            if compatibility_check:
                raise _version_error(command) from error
            raise
        if isinstance(envelope, SdkError):
            if compatibility_check:
                raise _version_error(command)
            if check:
                raise HeadlessError(envelope.message, command)
            return SdkError(
                protocol_version=envelope.protocol_version,
                command=envelope.command,
                exit_code=envelope.exit_code,
                message=envelope.message,
                command_result=command,
            )
        if command.returncode != 0 or envelope.exit_code != 0:
            if compatibility_check:
                raise _version_error(command)
            if check:
                raise HeadlessError("headless SDK command failed", command)
        if not isinstance(envelope.data, dict):
            if compatibility_check:
                raise _version_error(command)
            raise HeadlessProtocolError("Headless SDK result data must be an object")
        typed = cast(SdkResult[dict[str, Any]], envelope)
        return SdkResult(
            protocol_version=typed.protocol_version,
            command=typed.command,
            exit_code=typed.exit_code,
            data=typed.data,
            command_result=command,
        )

    def _ensure_protocol_compatible(
        self,
        *,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        process_timeout_seconds: float | None = None,
    ) -> None:
        if self._protocol_compatible:
            return
        capabilities = self._request_sdk(
            ["capabilities"],
            cwd=cwd,
            env=env,
            process_timeout_seconds=process_timeout_seconds,
            compatibility_check=True,
        )
        if isinstance(capabilities, SdkError):
            raise _version_error(_command_result(capabilities))
        self._validate_capabilities(capabilities)
        self._protocol_compatible = True

    @staticmethod
    def _validate_capabilities(
        capabilities: SdkResult[dict[str, Any]],
    ) -> None:
        if capabilities.command != "capabilities":
            raise HeadlessVersionError(
                (
                    "installed Headless CLI returned an invalid capabilities "
                    "response. Please upgrade with "
                    "`npm install -g @roberttlange/headless@latest`."
                ),
                _command_result(capabilities),
            )
        version = capabilities.data.get("protocolVersion")
        if not is_supported_protocol_version(version):
            raise HeadlessVersionError(
                (
                    "incompatible Headless CLI SDK protocol "
                    f"{version!r}; expected {SDK_PROTOCOL_VERSION}. "
                    "Please upgrade with "
                    "`npm install -g @roberttlange/headless@latest`."
                ),
                _command_result(capabilities),
            )


def _command_result(
    result: SdkResult[dict[str, Any]] | SdkError,
) -> CommandResult:
    command = result.command_result
    if not isinstance(command, CommandResult):
        raise HeadlessProtocolError("Headless SDK command metadata is missing")
    return command


def _run_data(result: SdkResult[dict[str, Any]]) -> dict[str, Any]:
    if result.command != "invoke":
        raise HeadlessProtocolError(
            f"expected Headless SDK invoke result, received {result.command!r}"
        )
    return result.data


def _optional_string(data: Mapping[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise HeadlessProtocolError(f"Headless SDK data field {key!r} must be text")
    return value


def _required_data_string(result: SdkResult[dict[str, Any]], key: str) -> str:
    value = _optional_string(result.data, key)
    if value is None:
        raise HeadlessProtocolError(f"Headless SDK data field {key!r} is required")
    return value


def _version_error(command: CommandResult) -> HeadlessVersionError:
    return HeadlessVersionError(
        (
            "installed Headless CLI does not support SDK protocol v1. "
            "Please upgrade with "
            "`npm install -g @roberttlange/headless@latest`."
        ),
        command,
    )


def _is_tmux_sdk_rejection(command: CommandResult) -> bool:
    if command.returncode != 2:
        return False
    try:
        envelope = parse_sdk_result(command.stdout)
    except HeadlessProtocolError:
        return False
    return (
        isinstance(envelope, SdkError)
        and envelope.command == "invoke"
        and envelope.exit_code == 2
        and envelope.message == "--sdk-format cannot be used with --tmux"
    )
