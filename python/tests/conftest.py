from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest


@pytest.fixture
def fake_headless(tmp_path: Path) -> tuple[Path, Path]:
    binary = tmp_path / "headless"
    record = tmp_path / "record.json"
    binary.write_text(
        """#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import sys
import time

record = pathlib.Path(os.environ["FAKE_HEADLESS_RECORD"])
if "--writes-first" in sys.argv:
    sys.stdout.write("x" * (2 * 1024 * 1024))
    sys.stdout.flush()
if "--exit-before-read" in sys.argv:
    raise SystemExit(0)
if "--spawn-descendant" in sys.argv:
    marker = os.environ["DESCENDANT_MARKER"]
    subprocess.Popen([
        sys.executable,
        "-c",
        "import pathlib,time; time.sleep(0.5); pathlib.Path(" + repr(marker) + ").write_text('alive')",
    ])
    time.sleep(10)
stdin = sys.stdin.read()
record.write_text(json.dumps({
    "argv": sys.argv[1:],
    "cwd": os.getcwd(),
    "env": os.environ.get("SDK_TEST_ENV"),
    "stdin": stdin,
}))
history_path = os.environ.get("FAKE_HEADLESS_HISTORY")
if history_path:
    history = pathlib.Path(history_path)
    calls = json.loads(history.read_text()) if history.exists() else []
    calls.append(sys.argv[1:])
    history.write_text(json.dumps(calls))
if "--sleep" in sys.argv:
    time.sleep(10)
if "--large-fail" in sys.argv:
    print("x" * 100000, file=sys.stderr)
    raise SystemExit(7)
if "--split-stderr" in sys.argv:
    os.write(2, b"a" * 65535 + b"\\xe2")
    time.sleep(0.05)
    os.write(2, b"\\x82\\xac\\n")
if "--huge-output" in sys.argv:
    sys.stdout.write("x" * (33 * 1024 * 1024))
    raise SystemExit(0)
if "--sdk-format" in sys.argv:
    sdk_format = sys.argv[sys.argv.index("--sdk-format") + 1]
    def envelope(kind, command, **values):
        payload = {
            "protocolVersion": 1,
            "type": kind,
            "command": command,
            "exitCode": values.pop("exitCode", 0),
            **values,
        }
        print(json.dumps(payload))
    if os.environ.get("FAKE_HEADLESS_DEFAULT_TMUX") == "1" and "capabilities" not in sys.argv:
        envelope(
            "error",
            "invoke",
            exitCode=2,
            error={"message": "--sdk-format cannot be used with --tmux"},
        )
        raise SystemExit(2)
    if "--fail" in sys.argv:
        envelope("error", "cli", exitCode=7, error={"message": "safe failure"})
        raise SystemExit(7)
    if sdk_format == "ndjson":
        if "--large-stream" in sys.argv:
            envelope("trace", "invoke", data={"agent": "codex", "raw": "x" * (128 * 1024)})
            envelope("result", "invoke", data={"agent": "codex", "finalMessage": "done"})
            raise SystemExit(0)
        if "--invalid-utf8" in sys.argv:
            sys.stdout.buffer.write(b"\\xff\\n")
            sys.stdout.buffer.flush()
            raise SystemExit(0)
        if "--many-stream" in sys.argv:
            for index in range(1000):
                envelope("trace", "invoke", data={"agent": "codex", "value": {"event": index}})
            envelope("result", "invoke", data={"agent": "codex", "finalMessage": "done"})
            raise SystemExit(0)
        envelope("trace", "invoke", data={"agent": "codex", "value": {"event": "turn"}})
    if "--version" in sys.argv:
        envelope("result", "version", data={"version": "0.5.0"})
    elif "capabilities" in sys.argv:
        envelope("result", "capabilities", data={"protocolVersion": 1, "agents": ["codex"]})
    elif "--check" in sys.argv:
        envelope("result", "check", data={"agents": [], "docker": {}})
    elif "--show-config" in sys.argv:
        allow = sys.argv[sys.argv.index("--allow") + 1] if "--allow" in sys.argv else None
        envelope("result", "config.show", data={"agent": "codex", "allow": allow})
    elif "--list" in sys.argv:
        envelope("result", "sessions.list", data={"sessions": []})
    elif sys.argv[1:3] == ["run", "list"]:
        envelope("result", "runs.list", data={"runs": []})
    elif sys.argv[1:3] == ["run", "view"]:
        envelope("result", "runs.view", data={"run": {"id": sys.argv[3]}})
    elif sys.argv[1:3] == ["cron", "list"]:
        envelope("result", "cron.list", data={"jobs": [], "daemonRunning": False})
    elif sys.argv[1:3] == ["cron", "view"]:
        envelope("result", "cron.view", data={"job": {"id": sys.argv[3]}})
    else:
        envelope("result", "invoke", data={
            "agent": sys.argv[1] if len(sys.argv) > 1 else "codex",
            "provider": "openai",
            "model": "gpt-5",
            "reasoningEffort": "high",
            "finalMessage": "final answer",
            "nativeSessionId": "session-1",
        })
    raise SystemExit(0)
if "--fail" in sys.argv:
    print("private stderr", file=sys.stderr)
    raise SystemExit(7)
if "--version" in sys.argv:
    print("0.5.0")
else:
    print("final answer")
    print("trace", file=sys.stderr)
"""
    )
    binary.chmod(0o755)
    return binary, record


def read_record(record: Path) -> dict[str, object]:
    return cast(dict[str, object], json.loads(record.read_text()))
