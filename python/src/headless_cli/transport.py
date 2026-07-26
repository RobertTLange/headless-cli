from __future__ import annotations

import asyncio
import os
import queue
import shutil
import subprocess
import threading
import time
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence

from ._process import (
    CHUNK_BYTES,
    STDERR_CAPTURE_BYTES,
    STDOUT_CAPTURE_BYTES,
    TERMINATE_GRACE_SECONDS,
    BoundedBytes,
    ReaderDone,
    ReaderFailure,
    StreamQueueItem,
    close_process_pipes,
    finish_sync_io,
    read_capture_async,
    read_stream_async,
    remaining_timeout,
    start_capture_threads,
    start_stream_readers,
    start_sync_writer,
    terminate_async_process,
    terminate_async_process_tree,
    terminate_process_tree,
    windows_creation_flags,
    write_async,
)
from .errors import HeadlessError, HeadlessNotFoundError
from .models import CommandResult, StreamEvent


def discover_binary(
    explicit: str | os.PathLike[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    if explicit is not None:
        return os.fspath(explicit)
    environment = os.environ if env is None else env
    configured = environment.get("HEADLESS_CLI_BIN") or environment.get("HEADLESS_BIN")
    if configured:
        return configured
    found = shutil.which("headless", path=environment.get("PATH"))
    if found:
        return found
    raise HeadlessNotFoundError(
        "headless executable not found; install it, set HEADLESS_CLI_BIN, "
        "or pass binary=..."
    )


def merged_environment(
    base: Mapping[str, str] | None, extra: Mapping[str, str] | None
) -> dict[str, str]:
    merged = dict(os.environ)
    if base is not None:
        merged.update(base)
    if extra is not None:
        merged.update(extra)
    return merged


class SubprocessTransport:
    def __init__(
        self,
        binary: str | os.PathLike[str] | None = None,
        *,
        env: Mapping[str, str] | None = None,
    ) -> None:
        effective_env = merged_environment(env, None)
        self.binary = discover_binary(binary, env=effective_env)
        self._env = dict(env) if env is not None else {}

    def invoke(
        self,
        args: Sequence[str],
        *,
        input: str | None = None,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        check: bool = True,
    ) -> CommandResult:
        argv = self._argv(args)
        process = self._spawn(argv, input is not None, cwd, env)
        stdout = BoundedBytes(STDOUT_CAPTURE_BYTES)
        stderr = BoundedBytes(STDERR_CAPTURE_BYTES, tail=True)
        failures: list[BaseException] = []
        threads = start_capture_threads(process, input, stdout, stderr, failures)
        timed_out = False
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            terminate_process_tree(process)
        except BaseException:
            terminate_process_tree(process)
            raise
        finally:
            finish_sync_io(process, threads)
        if timed_out:
            raise subprocess.TimeoutExpired(argv, timeout or 0.0)
        if failures:
            raise RuntimeError("headless subprocess I/O failed") from failures[0]
        result = CommandResult(
            process.returncode, stdout.text(), stderr.text(), tuple(argv)
        )
        if stdout.overflowed:
            raise HeadlessError(
                "headless stdout exceeded the 32 MiB capture limit", result
            )
        if check and result.returncode != 0:
            raise HeadlessError("headless command failed", result)
        return result

    def interactive(
        self,
        args: Sequence[str],
        *,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
    ) -> CommandResult:
        argv = self._argv(args)
        try:
            completed = subprocess.run(
                argv,
                cwd=cwd,
                env=merged_environment(self._env, env),
                check=False,
            )
        except FileNotFoundError as error:
            raise HeadlessNotFoundError(
                f"headless executable not found: {self.binary}"
            ) from error
        result = CommandResult(completed.returncode, "", "", tuple(argv))
        if check and result.returncode != 0:
            raise HeadlessError("interactive headless command failed", result)
        return result

    def stream(
        self,
        args: Sequence[str],
        *,
        input: str | None = None,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        check: bool = True,
    ) -> Iterator[StreamEvent]:
        argv = self._argv(args)
        process = self._spawn(argv, input is not None, cwd, env)
        events: queue.Queue[StreamQueueItem] = queue.Queue(maxsize=1)
        stopping = threading.Event()
        captured = {
            "stdout": BoundedBytes(STDOUT_CAPTURE_BYTES),
            "stderr": BoundedBytes(STDERR_CAPTURE_BYTES, tail=True),
        }
        readers = start_stream_readers(process, events, stopping, captured)
        writer_failures: list[BaseException] = []
        writer = start_sync_writer(process, input, writer_failures)
        completed_pipes = 0
        completed_normally = False
        started_at = time.monotonic()
        try:
            while completed_pipes < 2:
                remaining = remaining_timeout(started_at, timeout)
                try:
                    item = events.get(
                        timeout=min(0.05, remaining) if remaining is not None else 0.05
                    )
                except queue.Empty:
                    if remaining is not None and remaining <= 0:
                        raise subprocess.TimeoutExpired(argv, timeout or 0.0)
                    continue
                if isinstance(item, ReaderDone):
                    completed_pipes += 1
                elif isinstance(item, ReaderFailure):
                    raise item.error
                else:
                    yield item
            remaining = remaining_timeout(started_at, timeout)
            process.wait(timeout=remaining)
            completed_normally = True
        finally:
            stopping.set()
            if not completed_normally:
                terminate_process_tree(process)
            close_process_pipes(process)
            for thread in [*readers, writer]:
                thread.join(timeout=TERMINATE_GRACE_SECONDS)
        if writer_failures:
            raise RuntimeError("headless stdin write failed") from writer_failures[0]
        result = CommandResult(
            process.returncode,
            captured["stdout"].text(),
            captured["stderr"].text(),
            tuple(argv),
        )
        if check and result.returncode != 0:
            raise HeadlessError("headless stream failed", result)

    def _spawn(
        self,
        argv: Sequence[str],
        has_input: bool,
        cwd: str | os.PathLike[str] | None,
        env: Mapping[str, str] | None,
    ) -> subprocess.Popen[bytes]:
        try:
            return subprocess.Popen(
                argv,
                cwd=cwd,
                env=merged_environment(self._env, env),
                stdin=subprocess.PIPE if has_input else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=os.name == "posix",
                creationflags=windows_creation_flags(),
            )
        except FileNotFoundError as error:
            raise HeadlessNotFoundError(
                f"headless executable not found: {self.binary}"
            ) from error

    def _argv(self, args: Sequence[str]) -> list[str]:
        return [self.binary, *(str(value) for value in args)]


class AsyncSubprocessTransport:
    def __init__(
        self,
        binary: str | os.PathLike[str] | None = None,
        *,
        env: Mapping[str, str] | None = None,
    ) -> None:
        effective_env = merged_environment(env, None)
        self.binary = discover_binary(binary, env=effective_env)
        self._env = dict(env) if env is not None else {}

    async def invoke(
        self,
        args: Sequence[str],
        *,
        input: str | None = None,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        check: bool = True,
    ) -> CommandResult:
        argv = self._argv(args)
        process = await self._spawn(argv, input is not None, cwd, env)
        stdout = BoundedBytes(STDOUT_CAPTURE_BYTES)
        stderr = BoundedBytes(STDERR_CAPTURE_BYTES, tail=True)
        readers = [
            asyncio.create_task(read_capture_async(process.stdout, stdout)),
            asyncio.create_task(read_capture_async(process.stderr, stderr)),
        ]
        writer = asyncio.create_task(write_async(process, input))
        try:
            await asyncio.wait_for(asyncio.shield(process.wait()), timeout)
            try:
                await asyncio.wait_for(
                    asyncio.gather(*readers, writer),
                    TERMINATE_GRACE_SECONDS,
                )
            except asyncio.TimeoutError:
                await terminate_async_process_tree(process)
                raise
        except BaseException:
            await terminate_async_process_tree(process)
            for task in [*readers, writer]:
                task.cancel()
            await asyncio.gather(*readers, writer, return_exceptions=True)
            raise
        result = CommandResult(
            process.returncode or 0, stdout.text(), stderr.text(), tuple(argv)
        )
        if stdout.overflowed:
            raise HeadlessError(
                "headless stdout exceeded the 32 MiB capture limit", result
            )
        if check and result.returncode != 0:
            raise HeadlessError("headless command failed", result)
        return result

    async def interactive(
        self,
        args: Sequence[str],
        *,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
    ) -> CommandResult:
        argv = self._argv(args)
        try:
            process = await asyncio.create_subprocess_exec(
                *argv, cwd=cwd, env=merged_environment(self._env, env)
            )
        except FileNotFoundError as error:
            raise HeadlessNotFoundError(
                f"headless executable not found: {self.binary}"
            ) from error
        try:
            returncode = await process.wait()
        except BaseException:
            await terminate_async_process(process)
            raise
        result = CommandResult(returncode, "", "", tuple(argv))
        if check and returncode != 0:
            raise HeadlessError("interactive headless command failed", result)
        return result

    async def stream(
        self,
        args: Sequence[str],
        *,
        input: str | None = None,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        check: bool = True,
    ) -> AsyncIterator[StreamEvent]:
        argv = self._argv(args)
        process = await self._spawn(argv, input is not None, cwd, env)
        events: asyncio.Queue[StreamQueueItem] = asyncio.Queue(maxsize=1)
        captured = {
            "stdout": BoundedBytes(STDOUT_CAPTURE_BYTES),
            "stderr": BoundedBytes(STDERR_CAPTURE_BYTES, tail=True),
        }
        readers = [
            asyncio.create_task(
                read_stream_async("stdout", process.stdout, events, captured["stdout"])
            ),
            asyncio.create_task(
                read_stream_async("stderr", process.stderr, events, captured["stderr"])
            ),
        ]
        writer = asyncio.create_task(write_async(process, input))
        completed_pipes = 0
        completed_normally = False
        started_at = time.monotonic()
        try:
            while completed_pipes < 2:
                remaining = remaining_timeout(started_at, timeout)
                item = (
                    await asyncio.wait_for(events.get(), remaining)
                    if remaining is not None
                    else await events.get()
                )
                if isinstance(item, ReaderDone):
                    completed_pipes += 1
                elif isinstance(item, ReaderFailure):
                    raise item.error
                else:
                    yield item
            remaining = remaining_timeout(started_at, timeout)
            await asyncio.wait_for(asyncio.shield(process.wait()), remaining)
            await writer
            completed_normally = True
        finally:
            for task in [*readers, writer]:
                task.cancel()
            if not completed_normally:
                await terminate_async_process_tree(process)
            await asyncio.gather(*readers, writer, return_exceptions=True)
        result = CommandResult(
            process.returncode or 0,
            captured["stdout"].text(),
            captured["stderr"].text(),
            tuple(argv),
        )
        if check and result.returncode != 0:
            raise HeadlessError("headless stream failed", result)

    async def _spawn(
        self,
        argv: Sequence[str],
        has_input: bool,
        cwd: str | os.PathLike[str] | None,
        env: Mapping[str, str] | None,
    ) -> asyncio.subprocess.Process:
        try:
            return await asyncio.create_subprocess_exec(
                *argv,
                cwd=cwd,
                env=merged_environment(self._env, env),
                stdin=asyncio.subprocess.PIPE
                if has_input
                else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=os.name == "posix",
                creationflags=windows_creation_flags(),
                limit=CHUNK_BYTES * 2,
            )
        except FileNotFoundError as error:
            raise HeadlessNotFoundError(
                f"headless executable not found: {self.binary}"
            ) from error

    def _argv(self, args: Sequence[str]) -> list[str]:
        return [self.binary, *(str(value) for value in args)]
