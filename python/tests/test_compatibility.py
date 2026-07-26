from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from headless_cli import AsyncHeadless, Headless
from headless_cli.errors import HeadlessError, HeadlessVersionError
from headless_cli.models import SdkError


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
