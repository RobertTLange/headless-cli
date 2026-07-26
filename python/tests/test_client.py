from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from unittest.mock import Mock

import pytest
from conftest import read_record

from headless_cli import AsyncHeadless, Headless
from headless_cli.errors import HeadlessError, HeadlessVersionError
from headless_cli.models import CommandResult, SdkError, SdkResult


def test_run_builds_structured_one_shot_command(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    result = client.run(
        "codex",
        prompt="review me",
        model="gpt-5",
        reasoning_effort="high",
        allow="read-only",
        role="reviewer",
        coordination="oneshot",
        run_id="review",
        node="reviewer",
        depends_on=["worker-1", "worker-2"],
        team=["explorer", "worker=2"],
        work_dir="/tmp/project",
        docker=True,
        docker_image="headless:test",
        docker_args=["--network=none"],
        docker_env=["TOKEN"],
        timeout_seconds=30,
        usage=True,
    )

    command = read_record(record)
    assert command["stdin"] == "review me"
    assert command["argv"] == [
        "codex",
        "--model",
        "gpt-5",
        "--reasoning-effort",
        "high",
        "--allow",
        "read-only",
        "--role",
        "reviewer",
        "--coordination",
        "oneshot",
        "--run",
        "review",
        "--node",
        "reviewer",
        "--depends-on",
        "worker-1",
        "--depends-on",
        "worker-2",
        "--team",
        "explorer",
        "--team",
        "worker=2",
        "--work-dir",
        "/tmp/project",
        "--docker",
        "--docker-image",
        "headless:test",
        "--docker-arg",
        "--network=none",
        "--docker-env",
        "TOKEN",
        "--timeout",
        "30",
        "--usage",
        "--sdk-format",
        "json",
    ]
    assert result.final_message == "final answer"
    assert isinstance(result.sdk, SdkResult)


def test_run_supports_prompt_file_acp_modal_and_print_command(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    client.run(
        "acp",
        prompt_file="prompt.md",
        acp_agent="auggie",
        acp_command="agent serve",
        acp_registry="https://example.test/registry.json",
        acp_registry_file="registry.json",
        modal=True,
        modal_image="image",
        modal_image_secret="registry",
        modal_app="sdk",
        modal_cpu=2.5,
        modal_memory=8192,
        modal_timeout=600,
        modal_secrets=["one", "two"],
        modal_env=["A=1"],
        modal_include_git=True,
        print_command=True,
    )

    args = read_record(record)["argv"]
    assert args == [
        "acp",
        "--prompt-file",
        "prompt.md",
        "--acp-agent",
        "auggie",
        "--acp-command",
        "agent serve",
        "--acp-registry",
        "https://example.test/registry.json",
        "--acp-registry-file",
        "registry.json",
        "--modal",
        "--modal-image",
        "image",
        "--modal-image-secret",
        "registry",
        "--modal-app",
        "sdk",
        "--modal-cpu",
        "2.5",
        "--modal-memory",
        "8192",
        "--modal-timeout",
        "600",
        "--modal-secret",
        "one",
        "--modal-secret",
        "two",
        "--modal-env",
        "A=1",
        "--modal-include-git",
        "--print-command",
    ]


def test_run_preserves_tmux_mode_without_sdk_format(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    result = client.run(
        "codex",
        prompt="review",
        tmux=True,
        wait=True,
        delete=True,
        name="task",
    )

    assert read_record(record)["argv"] == [
        "codex",
        "--tmux",
        "--wait",
        "--delete",
        "--name",
        "task",
    ]
    assert result.final_message == ""
    assert result.sdk is None


def test_namespaces_build_commands(fake_headless: tuple[Path, Path]) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    cases: list[tuple[Callable[[], object], list[str]]] = [
        (
            lambda: client.sessions.list("codex"),
            ["codex", "--list", "--sdk-format", "json"],
        ),
        (
            lambda: client.sessions.send("bughunt", prompt="continue"),
            ["send", "bughunt"],
        ),
        (
            lambda: client.sessions.rename("old", "new", print_command=True),
            ["rename", "old", "new", "--print-command"],
        ),
        (lambda: client.runs.list(), ["run", "list", "--sdk-format", "json"]),
        (
            lambda: client.runs.view("auth"),
            ["run", "view", "auth", "--sdk-format", "json"],
        ),
        (
            lambda: client.runs.mark("auth", "worker-1", status="idle"),
            ["run", "mark", "auth", "worker-1", "--status", "idle"],
        ),
        (
            lambda: client.runs.message(
                "auth", "worker-1", prompt="go", background=True
            ),
            ["run", "message", "auth", "worker-1", "--async"],
        ),
        (lambda: client.runs.wait("auth"), ["run", "wait", "auth"]),
        (lambda: client.cron.list(), ["cron", "list", "--sdk-format", "json"]),
        (
            lambda: client.cron.view("triage"),
            ["cron", "view", "triage", "--sdk-format", "json"],
        ),
        (lambda: client.cron.pause("triage"), ["cron", "pause", "triage"]),
        (lambda: client.cron.resume("triage"), ["cron", "resume", "triage"]),
        (lambda: client.cron.kill("triage"), ["cron", "kill", "triage"]),
        (
            lambda: client.cron.remove("triage", force=True),
            ["cron", "rm", "triage", "--force"],
        ),
        (lambda: client.cron.start(), ["cron", "start"]),
        (lambda: client.cron.stop(), ["cron", "stop"]),
        (
            lambda: client.docker.doctor(image="registry/headless:test"),
            ["docker", "doctor", "--docker-image", "registry/headless:test"],
        ),
        (
            lambda: client.docker.build(
                image="registry/headless:test", print_command=True
            ),
            [
                "docker",
                "build",
                "--docker-image",
                "registry/headless:test",
                "--print-command",
            ],
        ),
        (
            lambda: client.check(docker_image="registry/headless:test"),
            [
                "--check",
                "--docker-image",
                "registry/headless:test",
                "--sdk-format",
                "json",
            ],
        ),
        (
            lambda: client.show_config(
                "codex",
                model="gpt-5",
                reasoning_effort="high",
                allow="read-only",
            ),
            [
                "codex",
                "--show-config",
                "--model",
                "gpt-5",
                "--reasoning-effort",
                "high",
                "--allow",
                "read-only",
                "--sdk-format",
                "json",
            ],
        ),
    ]
    for call, expected in cases:
        call()
        assert read_record(record)["argv"] == expected


def test_cron_add_exposes_scheduled_run_options(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    client.cron.add(
        "codex",
        name="triage",
        every="1h",
        prompt="triage",
        model="gpt-5",
        reasoning_effort="high",
        allow="yolo",
        work_dir="/tmp/project",
        docker=True,
        docker_image="image",
        docker_args=["--net=host"],
        docker_env=["TOKEN"],
        timeout_seconds=60,
        json=True,
        debug=True,
        usage=True,
    )

    assert read_record(record)["argv"] == [
        "cron",
        "add",
        "codex",
        "--name",
        "triage",
        "--every",
        "1h",
        "--prompt",
        "triage",
        "--model",
        "gpt-5",
        "--reasoning-effort",
        "high",
        "--allow",
        "yolo",
        "--work-dir",
        "/tmp/project",
        "--docker",
        "--docker-image",
        "image",
        "--docker-arg",
        "--net=host",
        "--docker-env",
        "TOKEN",
        "--timeout",
        "60",
        "--json",
        "--debug",
        "--usage",
    ]


def test_attach_uses_inherited_stdio(monkeypatch: pytest.MonkeyPatch) -> None:
    run = Mock(return_value=Mock(returncode=0))
    monkeypatch.setattr("headless_cli.transport.subprocess.run", run)
    client = Headless(binary="/bin/headless")

    result = client.sessions.attach("bughunt")

    assert result.returncode == 0
    run.assert_called_once()
    _, kwargs = run.call_args
    assert "capture_output" not in kwargs
    assert "stdin" not in kwargs
    assert "stdout" not in kwargs
    assert "stderr" not in kwargs
    assert run.call_args.args[0] == ["/bin/headless", "attach", "bughunt"]


def test_attach_print_command_is_captured(monkeypatch: pytest.MonkeyPatch) -> None:
    invoke = Mock(
        return_value=CommandResult(
            returncode=0,
            stdout="tmux attach\n",
            stderr="",
            argv=("/bin/headless", "attach", "bughunt", "--print-command"),
        )
    )
    client = Headless(binary="/bin/headless")
    monkeypatch.setattr(client, "invoke", invoke)

    result = client.sessions.attach("bughunt", print_command=True)

    assert result.stdout == "tmux attach\n"
    invoke.assert_called_once_with(
        ["attach", "bughunt", "--print-command"],
        cwd=None,
        env=None,
        check=True,
    )


def test_session_launch_names_tmux_session(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    result = client.sessions.launch("bughunt", "codex", prompt="fix it")

    assert result.sdk is None
    assert result.final_message == ""
    assert read_record(record)["argv"] == [
        "codex",
        "--tmux",
        "--name",
        "bughunt",
    ]


@pytest.mark.parametrize("method", ["run", "send", "message"])
def test_prompt_sources_are_mutually_exclusive_before_spawn(
    fake_headless: tuple[Path, Path], method: str
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    with pytest.raises(ValueError, match="prompt"):
        if method == "run":
            client.run("codex", prompt="inline", prompt_file="prompt.md")
        elif method == "send":
            client.sessions.send("bughunt", prompt="inline", prompt_file="prompt.md")
        else:
            client.runs.message(
                "auth",
                "worker",
                prompt="inline",
                prompt_file="prompt.md",
            )

    assert not record.exists()


def test_version_returns_trimmed_text(fake_headless: tuple[Path, Path]) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    assert client.version() == "0.4.0"
    assert read_record(record)["argv"] == ["--version", "--sdk-format", "json"]


def test_structured_diagnostics_and_capabilities(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    assert client.check().command == "check"
    config = client.show_config()
    assert isinstance(config, SdkResult)
    assert config.data["agent"] == "codex"
    assert client.capabilities().data["protocolVersion"] == 1
    assert read_record(record)["argv"] == ["capabilities", "--sdk-format", "json"]


def test_protocol_compatibility_is_lazy_and_cached(tmp_path: Path) -> None:
    binary = tmp_path / "headless"
    calls = tmp_path / "calls.json"
    binary.write_text(
        """#!/usr/bin/env python3
import json
import os
import pathlib
import sys

calls_path = pathlib.Path(os.environ["HEADLESS_TEST_CALLS"])
argv = sys.argv[1:]
calls = json.loads(calls_path.read_text()) if calls_path.exists() else []
calls.append(argv)
calls_path.write_text(json.dumps(calls))
command = "capabilities" if "capabilities" in argv else "sessions.list"
data = {"protocolVersion": 1} if command == "capabilities" else {"sessions": []}
print(json.dumps({
    "protocolVersion": 1,
    "type": "result",
    "command": command,
    "exitCode": 0,
    "data": data,
}))
"""
    )
    binary.chmod(0o755)
    client = Headless(binary=binary, env={"HEADLESS_TEST_CALLS": str(calls)})
    assert not calls.exists()
    client.sessions.list()
    client.sessions.list()

    recorded = json.loads(calls.read_text())
    assert recorded == [
        ["capabilities", "--sdk-format", "json"],
        ["--list", "--sdk-format", "json"],
        ["--list", "--sdk-format", "json"],
    ]


def test_old_cli_reports_actionable_version_error(tmp_path: Path) -> None:
    binary = tmp_path / "headless"
    binary.write_text(
        "#!/bin/sh\nprintf '%s\\n' 'unknown option: --sdk-format' >&2\nexit 2\n"
    )
    binary.chmod(0o755)
    client = Headless(binary=binary)

    with pytest.raises(HeadlessVersionError, match="upgrade") as caught:
        client.sessions.list()

    assert caught.value.result.argv == (
        str(binary),
        "capabilities",
        "--sdk-format",
        "json",
    )


def test_incompatible_protocol_reports_expected_version(tmp_path: Path) -> None:
    binary = tmp_path / "headless"
    binary.write_text(
        """#!/usr/bin/env python3
import json

print(json.dumps({
    "protocolVersion": 1,
    "type": "result",
    "command": "capabilities",
    "exitCode": 0,
    "data": {"protocolVersion": 2},
}))
"""
    )
    binary.chmod(0o755)
    client = Headless(binary=binary)

    with pytest.raises(HeadlessVersionError, match="expected 1"):
        client.sessions.list()


def test_structured_check_false_returns_sdk_error(tmp_path: Path) -> None:
    binary = tmp_path / "headless"
    binary.write_text(
        """#!/usr/bin/env python3
import json
import sys

capabilities = "capabilities" in sys.argv
print(json.dumps({
    "protocolVersion": 1,
    "type": "result" if capabilities else "error",
    "command": "capabilities" if capabilities else "sessions.list",
    "exitCode": 0 if capabilities else 2,
    **(
        {"data": {"protocolVersion": 1}}
        if capabilities
        else {"error": {"message": "session failure"}}
    ),
}))
raise SystemExit(0 if capabilities else 2)
"""
    )
    binary.chmod(0o755)

    client = Headless(binary=binary)
    outcome = client.sessions.list(check=False)
    assert isinstance(outcome, SdkError)
    assert outcome.message == "session failure"
    assert outcome.command_result is not None
    with pytest.raises(HeadlessError, match="session failure"):
        client.sessions.list()

    async def exercise() -> None:
        async_client = AsyncHeadless(binary=binary)
        async_outcome = await async_client.sessions.list(check=False)
        assert isinstance(async_outcome, SdkError)
        assert async_outcome.command_result is not None

    asyncio.run(exercise())


def test_result_proxies_command_fields(fake_headless: tuple[Path, Path]) -> None:
    binary, record = fake_headless
    result = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)}).run(
        "codex", prompt="hello"
    )

    assert result.returncode == result.command.returncode
    assert result.stdout == result.command.stdout
    assert result.stderr == result.command.stderr
    assert result.argv == result.command.argv
