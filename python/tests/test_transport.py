from __future__ import annotations

import asyncio
import os
import subprocess
import time
from pathlib import Path

import pytest
from conftest import read_record

from headless_cli import AsyncHeadless, Headless, SdkError, SdkResult, SdkTrace
from headless_cli.errors import HeadlessError, HeadlessNotFoundError
from headless_cli.transport import discover_binary


def test_binary_discovery_precedence(
    fake_headless: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    binary, _ = fake_headless
    explicit = binary.with_name("explicit")
    explicit.symlink_to(binary)
    cli_env = binary.with_name("cli-env")
    cli_env.symlink_to(binary)
    legacy_env = binary.with_name("legacy-env")
    legacy_env.symlink_to(binary)
    monkeypatch.setenv("HEADLESS_CLI_BIN", str(cli_env))
    monkeypatch.setenv("HEADLESS_BIN", str(legacy_env))
    monkeypatch.setenv("PATH", str(binary.parent))

    assert discover_binary(explicit) == str(explicit)
    assert discover_binary(env=os.environ) == str(cli_env)
    monkeypatch.delenv("HEADLESS_CLI_BIN")
    assert discover_binary(env=os.environ) == str(legacy_env)
    monkeypatch.delenv("HEADLESS_BIN")
    assert discover_binary(env=os.environ) == str(binary)


def test_binary_discovery_reports_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HEADLESS_CLI_BIN", raising=False)
    monkeypatch.delenv("HEADLESS_BIN", raising=False)
    monkeypatch.setenv("PATH", "")

    with pytest.raises(HeadlessNotFoundError):
        discover_binary(env=os.environ)


def test_invoke_uses_argv_stdin_cwd_and_copied_environment(
    fake_headless: tuple[Path, Path], tmp_path: Path
) -> None:
    binary, record = fake_headless
    base_env = {"FAKE_HEADLESS_RECORD": str(record), "SDK_TEST_ENV": "base"}
    client = Headless(binary=binary, env=base_env)

    result = client.invoke(
        ["codex", "--model", "gpt-5"],
        input="hello",
        cwd=tmp_path,
        env={"SDK_TEST_ENV": "override"},
    )

    assert result.returncode == 0
    assert result.stdout == "final answer\n"
    assert result.stderr == "trace\n"
    assert result.argv == (str(binary), "codex", "--model", "gpt-5")
    assert read_record(record) == {
        "argv": ["codex", "--model", "gpt-5"],
        "cwd": str(tmp_path),
        "env": "override",
        "stdin": "hello",
    }
    assert base_env["SDK_TEST_ENV"] == "base"


def test_nonzero_error_redacts_prompt_and_secret_environment(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(
        binary=binary,
        env={"FAKE_HEADLESS_RECORD": str(record), "OPENAI_API_KEY": "secret-value"},
    )

    with pytest.raises(HeadlessError) as caught:
        client.invoke(["--fail", "--prompt", "sensitive prompt"])

    rendered = repr(caught.value)
    assert "sensitive prompt" not in rendered
    assert "secret-value" not in rendered
    assert "<redacted>" in rendered
    assert caught.value.result.returncode == 7


def test_nonzero_error_redacts_inline_sensitive_values(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    sensitive = [
        "--prompt=private-prompt",
        "--docker-env=TOKEN=private-token",
        "--acp-command=private-command",
    ]
    with pytest.raises(HeadlessError) as caught:
        client.invoke(["--fail", *sensitive])

    rendered = repr(caught.value)
    assert "private-" not in rendered
    assert rendered.count("<redacted>") == len(sensitive)


def test_stream_parses_ndjson_protocol(fake_headless: tuple[Path, Path]) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    events = list(client.stream(["codex"], input="stream input"))

    assert isinstance(events[0], SdkTrace)
    assert isinstance(events[1], SdkResult)
    assert read_record(record)["stdin"] == "stream input"
    assert read_record(record)["argv"] == ["codex", "--sdk-format", "ndjson"]


def test_stream_parses_large_protocol_records(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    events = list(client.stream(["--large-stream"]))

    assert isinstance(events[0], SdkTrace)
    assert len(events[0].raw or "") == 128 * 1024
    assert isinstance(events[1], SdkResult)


def test_stream_propagates_invalid_utf8_without_hanging(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    with pytest.raises(UnicodeDecodeError):
        list(client.stream(["--invalid-utf8"], process_timeout_seconds=1))


def test_sync_timeout_stops_process(fake_headless: tuple[Path, Path]) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    with pytest.raises(subprocess.TimeoutExpired):
        client.invoke(["--sleep"], process_timeout_seconds=0.05)


def test_invoke_drains_output_while_writing_large_input(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})
    prompt = "p" * (2 * 1024 * 1024)

    result = client.invoke(
        ["--writes-first"],
        input=prompt,
        process_timeout_seconds=3,
    )

    assert result.stdout.startswith("x" * 1024)
    assert read_record(record)["stdin"] == prompt


def test_invoke_handles_exit_before_large_input_is_written(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    result = client.invoke(
        ["--exit-before-read"],
        input="p" * (2 * 1024 * 1024),
        process_timeout_seconds=3,
    )

    assert result.returncode == 0


def test_invoke_rejects_oversized_stdout(fake_headless: tuple[Path, Path]) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    with pytest.raises(HeadlessError, match="32 MiB capture limit"):
        client.invoke(["--huge-output"])


def test_stream_nonzero_raises_after_events(fake_headless: tuple[Path, Path]) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    events = list(client.stream(["--fail"], check=False))
    assert len(events) == 1
    assert isinstance(events[0], SdkError)
    with pytest.raises(HeadlessError) as caught:
        list(client.stream(["--fail"]))
    assert caught.value.result.returncode == 7


def test_stream_error_capture_is_bounded(fake_headless: tuple[Path, Path]) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    with pytest.raises(HeadlessError) as caught:
        list(client._transport.stream(["--large-fail"]))

    assert len(caught.value.result.stderr.encode()) <= 64 * 1024


def test_stream_decodes_utf8_split_across_stderr_chunks(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    events = list(client._transport.stream(["--split-stderr"]))
    stderr = "".join(event.text for event in events if event.source == "stderr")

    assert stderr.endswith("€\ntrace\n")


def test_stream_can_close_before_process_finishes(
    fake_headless: tuple[Path, Path],
) -> None:
    binary, record = fake_headless
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})
    events = client.stream(["--many-stream"])

    next(events)
    events.close()


def test_timeout_kills_descendant_process_group(
    fake_headless: tuple[Path, Path], tmp_path: Path
) -> None:
    binary, record = fake_headless
    marker = tmp_path / "descendant-alive"
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    with pytest.raises(subprocess.TimeoutExpired):
        client.invoke(
            ["--spawn-descendant"],
            env={"DESCENDANT_MARKER": str(marker)},
            process_timeout_seconds=0.05,
        )

    time.sleep(0.7)
    assert not marker.exists()


def test_keyboard_interrupt_kills_descendant_process_group(
    fake_headless: tuple[Path, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    binary, record = fake_headless
    marker = tmp_path / "interrupted-descendant-alive"
    client = Headless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})
    original_wait = subprocess.Popen.wait
    interrupted = False

    def interrupt_once(
        process: subprocess.Popen[bytes], timeout: float | None = None
    ) -> int:
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            time.sleep(0.1)
            raise KeyboardInterrupt
        return original_wait(process, timeout=timeout)

    monkeypatch.setattr(subprocess.Popen, "wait", interrupt_once)
    with pytest.raises(KeyboardInterrupt):
        client.invoke(
            ["--spawn-descendant"],
            env={"DESCENDANT_MARKER": str(marker)},
        )

    time.sleep(0.7)
    assert not marker.exists()


def test_async_invoke_run_and_stream(
    fake_headless: tuple[Path, Path], tmp_path: Path
) -> None:
    binary, record = fake_headless
    client = AsyncHeadless(binary=binary, env={"FAKE_HEADLESS_RECORD": str(record)})

    async def exercise() -> None:
        invoked = await client.invoke(["codex"], input="async invoke")
        assert invoked.returncode == 0

        run = await client.run("codex", prompt="async run", model="gpt-5")
        assert run.final_message == "final answer"

        events = [
            event async for event in client.stream(["codex"], input="async stream")
        ]
        assert isinstance(events[0], SdkTrace)
        assert isinstance(events[1], SdkResult)

        large_events = [event async for event in client.stream(["--large-stream"])]
        assert isinstance(large_events[0], SdkTrace)
        assert len(large_events[0].raw or "") == 128 * 1024

        split_events = [
            event async for event in client._transport.stream(["--split-stderr"])
        ]
        split_stderr = "".join(
            event.text for event in split_events if event.source == "stderr"
        )
        assert split_stderr.endswith("€\ntrace\n")

        with pytest.raises(asyncio.TimeoutError):
            await client.invoke(["--sleep"], process_timeout_seconds=0.05)

        marker = tmp_path / "async-descendant-alive"
        with pytest.raises(asyncio.TimeoutError):
            await client.invoke(
                ["--spawn-descendant"],
                env={"DESCENDANT_MARKER": str(marker)},
                process_timeout_seconds=0.05,
            )
        await asyncio.sleep(0.7)
        assert not marker.exists()

        with pytest.raises(asyncio.TimeoutError):
            _ = [
                event
                async for event in client.stream(
                    ["--sleep"], process_timeout_seconds=0.05
                )
            ]

        open_events = client.stream(["--many-stream"])
        await anext(open_events)
        await open_events.aclose()

        cancel_marker = tmp_path / "cancelled-descendant-alive"
        hanging_events = client.stream(
            ["--spawn-descendant"],
            env={"DESCENDANT_MARKER": str(cancel_marker)},
        )
        pending_event = asyncio.create_task(anext(hanging_events))
        await asyncio.sleep(0.05)
        pending_event.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending_event
        await asyncio.sleep(0.7)
        assert not cancel_marker.exists()

    asyncio.run(exercise())
