from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path

import pytest
from conftest import read_record

from headless_cli import AsyncHeadless
from headless_cli.models import CommandResult, SdkResult


def test_async_namespaces_are_available(fake_headless: tuple[Path, Path]) -> None:
    binary, record = fake_headless
    client = AsyncHeadless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    async def exercise() -> None:
        cases: list[tuple[Callable[[], Awaitable[object]], list[str]]] = [
            (
                lambda: client.sessions.list("codex"),
                ["codex", "--list", "--sdk-format", "json"],
            ),
            (lambda: client.sessions.send("s", prompt="go"), ["send", "s"]),
            (
                lambda: client.sessions.rename("a", "b", print_command=True),
                ["rename", "a", "b", "--print-command"],
            ),
            (lambda: client.runs.list(), ["run", "list", "--sdk-format", "json"]),
            (
                lambda: client.runs.view("auth"),
                ["run", "view", "auth", "--sdk-format", "json"],
            ),
            (
                lambda: client.runs.mark("auth", "node", status="failed"),
                ["run", "mark", "auth", "node", "--status", "failed"],
            ),
            (
                lambda: client.runs.message(
                    "auth", "node", prompt="go", background=True
                ),
                ["run", "message", "auth", "node", "--async"],
            ),
            (lambda: client.runs.wait("auth"), ["run", "wait", "auth"]),
            (lambda: client.cron.list(), ["cron", "list", "--sdk-format", "json"]),
            (
                lambda: client.cron.view("job"),
                ["cron", "view", "job", "--sdk-format", "json"],
            ),
            (lambda: client.cron.pause("job"), ["cron", "pause", "job"]),
            (lambda: client.cron.resume("job"), ["cron", "resume", "job"]),
            (lambda: client.cron.kill("job"), ["cron", "kill", "job"]),
            (
                lambda: client.cron.remove("job", force=True),
                ["cron", "rm", "job", "--force"],
            ),
            (lambda: client.cron.start(), ["cron", "start"]),
            (lambda: client.cron.stop(), ["cron", "stop"]),
            (
                lambda: client.docker.doctor(image="image"),
                ["docker", "doctor", "--docker-image", "image"],
            ),
            (
                lambda: client.docker.build(image="image", print_command=True),
                [
                    "docker",
                    "build",
                    "--docker-image",
                    "image",
                    "--print-command",
                ],
            ),
            (
                lambda: client.check(docker_image="image"),
                [
                    "--check",
                    "--docker-image",
                    "image",
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
            result = await call()
            assert isinstance(result, (CommandResult, SdkResult))
            assert read_record(record)["argv"] == expected
        assert await client.version() == "0.5.0"

    asyncio.run(exercise())


def test_async_cron_add_has_full_typed_parity(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = AsyncHeadless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    async def exercise() -> None:
        await client.cron.add(
            "codex",
            name="triage",
            schedule="0 * * * *",
            prompt_file="triage.md",
            model="gpt-5",
            reasoning_effort="xhigh",
            allow="yolo",
            work_dir="/tmp/project",
            modal=True,
            modal_app="sdk",
            modal_cpu=4,
            modal_env=["A=1"],
            modal_image="image",
            modal_image_secret="registry",
            modal_include_git=True,
            modal_memory=8192,
            modal_secrets=["secret"],
            modal_timeout=600,
            timeout_seconds=60,
            json=True,
            debug=True,
            usage=True,
        )

    asyncio.run(exercise())
    assert read_record(record)["argv"] == [
        "cron",
        "add",
        "codex",
        "--name",
        "triage",
        "--schedule",
        "0 * * * *",
        "--prompt-file",
        "triage.md",
        "--model",
        "gpt-5",
        "--reasoning-effort",
        "xhigh",
        "--allow",
        "yolo",
        "--work-dir",
        "/tmp/project",
        "--modal",
        "--modal-app",
        "sdk",
        "--modal-cpu",
        "4",
        "--modal-env",
        "A=1",
        "--modal-image",
        "image",
        "--modal-image-secret",
        "registry",
        "--modal-include-git",
        "--modal-memory",
        "8192",
        "--modal-secret",
        "secret",
        "--modal-timeout",
        "600",
        "--timeout",
        "60",
        "--json",
        "--debug",
        "--usage",
    ]


def test_async_session_launch_names_tmux_and_has_no_final_message(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = AsyncHeadless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    async def exercise() -> None:
        result = await client.sessions.launch("bughunt", "codex", prompt="fix it")
        assert result.sdk is None
        assert result.final_message == ""

    asyncio.run(exercise())
    assert read_record(record)["argv"] == [
        "codex",
        "--tmux",
        "--name",
        "bughunt",
    ]


def test_async_run_preserves_tmux_coordination_without_sdk_format(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = AsyncHeadless(
        binary=binary,
        env={"FAKE_HEADLESS_RECORD": str(record)},
    )

    async def exercise() -> None:
        result = await client.run("codex", prompt="review", coordination="tmux")

        assert read_record(record)["argv"] == [
            "codex",
            "--coordination",
            "tmux",
        ]
        assert result.final_message == ""
        assert result.sdk is None

    asyncio.run(exercise())


@pytest.mark.parametrize("check", [True, False])
def test_async_run_retries_raw_mode_for_config_default_tmux(
    fake_headless: tuple[Path, Path],
    check: bool,
) -> None:
    binary, record = fake_headless
    history = record.with_name("history.json")
    client = AsyncHeadless(
        binary=binary,
        env={
            "FAKE_HEADLESS_RECORD": str(record),
            "FAKE_HEADLESS_DEFAULT_TMUX": "1",
            "FAKE_HEADLESS_HISTORY": str(history),
        },
    )

    async def exercise() -> None:
        result = await client.run("codex", prompt="review", check=check)

        assert read_record(record)["argv"] == ["codex"]
        assert json.loads(history.read_text()) == [
            ["capabilities", "--sdk-format", "json"],
            ["codex", "--sdk-format", "json"],
            ["codex"],
        ]
        assert result.final_message == ""
        assert result.sdk is None

    asyncio.run(exercise())
