from __future__ import annotations

import asyncio
import codecs
import os
import queue
import signal
import subprocess
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Literal, TypeAlias

from .errors import HeadlessProtocolError
from .models import StreamEvent

CHUNK_BYTES = 64 * 1024
STDERR_CAPTURE_BYTES = 64 * 1024
STDOUT_CAPTURE_BYTES = 32 * 1024 * 1024
TERMINATE_GRACE_SECONDS = 2.0
_STREAM_LINE_BYTES = 32 * 1024 * 1024


class BoundedBytes:
    def __init__(self, max_bytes: int, *, tail: bool = False) -> None:
        self._max_bytes = max_bytes
        self._tail = tail
        self._value = bytearray()
        self.overflowed = False

    def append(self, chunk: bytes) -> None:
        if not chunk:
            return
        if self._tail:
            self._value.extend(chunk)
            if len(self._value) > self._max_bytes:
                del self._value[: len(self._value) - self._max_bytes]
            return
        remaining = self._max_bytes - len(self._value)
        self._value.extend(chunk[:remaining])
        self.overflowed = self.overflowed or len(chunk) > remaining

    def text(self) -> str:
        return bytes(self._value).decode("utf-8", errors="replace")


class LineFramer:
    def __init__(self, max_bytes: int = _STREAM_LINE_BYTES) -> None:
        self._max_bytes = max_bytes
        self._pending = bytearray()

    def feed(self, chunk: bytes) -> list[str]:
        self._pending.extend(chunk)
        lines: list[str] = []
        while True:
            newline = self._pending.find(b"\n")
            if newline < 0:
                break
            if newline > self._max_bytes:
                raise HeadlessProtocolError("Headless SDK stream record exceeded limit")
            line = bytes(self._pending[: newline + 1])
            del self._pending[: newline + 1]
            lines.append(line.decode("utf-8"))
        if len(self._pending) > self._max_bytes:
            raise HeadlessProtocolError("Headless SDK stream record exceeded limit")
        return lines

    def finish(self) -> str | None:
        if not self._pending:
            return None
        return bytes(self._pending).decode("utf-8")


@dataclass(frozen=True)
class ReaderDone:
    pass


@dataclass(frozen=True)
class ReaderFailure:
    error: BaseException


StreamQueueItem: TypeAlias = StreamEvent | ReaderDone | ReaderFailure


def start_capture_threads(
    process: subprocess.Popen[bytes],
    input_text: str | None,
    stdout: BoundedBytes,
    stderr: BoundedBytes,
    failures: list[BaseException],
) -> list[threading.Thread]:
    assert process.stdout is not None
    assert process.stderr is not None

    def read(pipe: BinaryIO, capture: BoundedBytes) -> None:
        try:
            while chunk := pipe.read(CHUNK_BYTES):
                capture.append(chunk)
        except BaseException as error:  # noqa: BLE001 - transfer thread failures.
            failures.append(error)

    threads = [
        threading.Thread(target=read, args=(process.stdout, stdout), daemon=True),
        threading.Thread(target=read, args=(process.stderr, stderr), daemon=True),
        start_sync_writer(process, input_text, failures, start=False),
    ]
    for thread in threads:
        thread.start()
    return threads


def start_stream_readers(
    process: subprocess.Popen[bytes],
    events: queue.Queue[StreamQueueItem],
    stopping: threading.Event,
    captured: Mapping[str, BoundedBytes],
) -> list[threading.Thread]:
    assert process.stdout is not None
    assert process.stderr is not None

    def put(item: StreamQueueItem) -> bool:
        while not stopping.is_set():
            try:
                events.put(item, timeout=0.05)
                return True
            except queue.Full:
                continue
        return False

    def read(source: Literal["stdout", "stderr"], pipe: BinaryIO) -> None:
        framer = LineFramer() if source == "stdout" else None
        decoder = (
            codecs.getincrementaldecoder("utf-8")() if source == "stderr" else None
        )
        try:
            while chunk := pipe.read(CHUNK_BYTES):
                captured[source].append(chunk)
                if framer:
                    values = framer.feed(chunk)
                else:
                    assert decoder is not None
                    values = [decoder.decode(chunk)]
                for value in values:
                    if value and not put(StreamEvent(source, value)):
                        return
            if framer:
                final = framer.finish()
            else:
                assert decoder is not None
                final = decoder.decode(b"", final=True)
            if final:
                put(StreamEvent(source, final))
        except BaseException as error:  # noqa: BLE001 - transfer thread failures.
            put(ReaderFailure(error))
        finally:
            put(ReaderDone())

    threads = [
        threading.Thread(target=read, args=("stdout", process.stdout), daemon=True),
        threading.Thread(target=read, args=("stderr", process.stderr), daemon=True),
    ]
    for thread in threads:
        thread.start()
    return threads


def start_sync_writer(
    process: subprocess.Popen[bytes],
    input_text: str | None,
    failures: list[BaseException],
    *,
    start: bool = True,
) -> threading.Thread:
    def write() -> None:
        if input_text is None or process.stdin is None:
            return
        try:
            process.stdin.write(input_text.encode("utf-8"))
            process.stdin.close()
        except BrokenPipeError:
            pass
        except BaseException as error:  # noqa: BLE001 - transfer thread failures.
            failures.append(error)
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass

    thread = threading.Thread(target=write, daemon=True)
    if start:
        thread.start()
    return thread


async def read_capture_async(
    pipe: asyncio.StreamReader | None, capture: BoundedBytes
) -> None:
    assert pipe is not None
    while chunk := await pipe.read(CHUNK_BYTES):
        capture.append(chunk)


async def read_stream_async(
    source: Literal["stdout", "stderr"],
    pipe: asyncio.StreamReader | None,
    events: asyncio.Queue[StreamQueueItem],
    captured: BoundedBytes,
) -> None:
    assert pipe is not None
    framer = LineFramer() if source == "stdout" else None
    decoder = codecs.getincrementaldecoder("utf-8")() if source == "stderr" else None
    try:
        while chunk := await pipe.read(CHUNK_BYTES):
            captured.append(chunk)
            if framer:
                values = framer.feed(chunk)
            else:
                assert decoder is not None
                values = [decoder.decode(chunk)]
            for value in values:
                if value:
                    await events.put(StreamEvent(source, value))
        if framer:
            final = framer.finish()
        else:
            assert decoder is not None
            final = decoder.decode(b"", final=True)
        if final:
            await events.put(StreamEvent(source, final))
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001 - transfer task failures.
        await events.put(ReaderFailure(error))
        await events.put(ReaderDone())
    else:
        await events.put(ReaderDone())


async def write_async(
    process: asyncio.subprocess.Process, input_text: str | None
) -> None:
    if input_text is None or process.stdin is None:
        return
    try:
        process.stdin.write(input_text.encode("utf-8"))
        await process.stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        process.stdin.close()


def finish_sync_io(
    process: subprocess.Popen[bytes], threads: Sequence[threading.Thread]
) -> None:
    for thread in threads:
        thread.join(timeout=TERMINATE_GRACE_SECONDS)
    if any(thread.is_alive() for thread in threads):
        terminate_process_tree(process, force=True)
        close_process_pipes(process)
        for thread in threads:
            thread.join(timeout=TERMINATE_GRACE_SECONDS)


def close_process_pipes(process: subprocess.Popen[bytes]) -> None:
    for pipe in (process.stdin, process.stdout, process.stderr):
        if pipe is not None:
            try:
                pipe.close()
            except OSError:
                pass


def remaining_timeout(started_at: float, timeout: float | None) -> float | None:
    if timeout is None:
        return None
    return max(0.0, timeout - (time.monotonic() - started_at))


def windows_creation_flags() -> int:
    return getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0


def terminate_process_tree(
    process: subprocess.Popen[bytes], *, force: bool = False
) -> None:
    if os.name == "posix":
        _signal_process_group(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        if not force:
            deadline = time.monotonic() + TERMINATE_GRACE_SECONDS
            while _process_group_exists(process.pid) and time.monotonic() < deadline:
                process.poll()
                time.sleep(0.05)
            if _process_group_exists(process.pid):
                _signal_process_group(process.pid, signal.SIGKILL)
        try:
            process.wait(timeout=TERMINATE_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        return
    elif os.name == "nt":
        _taskkill(process.pid, force)
    elif process.poll() is None:
        process.kill() if force else process.terminate()
    if force:
        try:
            process.wait(timeout=TERMINATE_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        return
    try:
        process.wait(timeout=TERMINATE_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        terminate_process_tree(process, force=True)


async def terminate_async_process_tree(
    process: asyncio.subprocess.Process,
) -> None:
    if os.name == "posix":
        _signal_process_group(process.pid, signal.SIGTERM)
        deadline = time.monotonic() + TERMINATE_GRACE_SECONDS
        while _process_group_exists(process.pid) and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        if _process_group_exists(process.pid):
            _signal_process_group(process.pid, signal.SIGKILL)
        await process.wait()
        return
    elif os.name == "nt":
        await asyncio.to_thread(_taskkill, process.pid, False)
    elif process.returncode is None:
        process.terminate()
    try:
        await asyncio.wait_for(process.wait(), TERMINATE_GRACE_SECONDS)
    except asyncio.TimeoutError:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif os.name == "nt":
            await asyncio.to_thread(_taskkill, process.pid, True)
        elif process.returncode is None:
            process.kill()
        await process.wait()


def _signal_process_group(pid: int, requested_signal: signal.Signals) -> None:
    try:
        os.killpg(pid, requested_signal)
    except (PermissionError, ProcessLookupError):
        pass


def _process_group_exists(pid: int) -> bool:
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False
    return True


async def terminate_async_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), TERMINATE_GRACE_SECONDS)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


def _taskkill(pid: int, force: bool) -> None:
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    executable = Path(system_root, "System32", "taskkill.exe")
    command = [str(executable), "/PID", str(pid), "/T"]
    if force:
        command.append("/F")
    try:
        subprocess.run(
            command,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=TERMINATE_GRACE_SECONDS,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
