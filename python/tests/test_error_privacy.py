from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from headless_cli import AsyncHeadless, Headless, HeadlessError

CLI_BINARY = Path(__file__).parents[2] / "dist" / "cli.js"
SENSITIVE_ENV = "BAD-NAME=sentinel-secret"


def assert_safe_error(error: HeadlessError) -> None:
    assert "sentinel-secret" not in str(error)
    assert "invalid docker env" in str(error)


def test_sync_sdk_errors_do_not_expose_sensitive_values() -> None:
    client = Headless(binary=CLI_BINARY)

    with pytest.raises(HeadlessError) as caught:
        client.run(
            "codex",
            prompt="review me",
            docker=True,
            docker_env=[SENSITIVE_ENV],
        )

    assert_safe_error(caught.value)


def test_async_sdk_errors_do_not_expose_sensitive_values() -> None:
    client = AsyncHeadless(binary=CLI_BINARY)

    async def exercise() -> None:
        with pytest.raises(HeadlessError) as caught:
            await client.run(
                "codex",
                prompt="review me",
                docker=True,
                docker_env=[SENSITIVE_ENV],
            )

        assert_safe_error(caught.value)

    asyncio.run(exercise())
