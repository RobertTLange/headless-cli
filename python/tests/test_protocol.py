from __future__ import annotations

import pytest

from headless_cli.errors import HeadlessProtocolError
from headless_cli.models import SdkError, SdkResult, SdkTrace
from headless_cli.protocol import parse_sdk_envelope


def test_parse_result_envelope() -> None:
    parsed = parse_sdk_envelope(
        '{"protocolVersion":1,"type":"result","command":"version",'
        '"exitCode":0,"data":{"version":"0.4.0"}}'
    )

    assert parsed == SdkResult(
        protocol_version=1,
        command="version",
        exit_code=0,
        data={"version": "0.4.0"},
    )


def test_parse_trace_and_error_envelopes() -> None:
    trace = parse_sdk_envelope(
        '{"protocolVersion":1,"type":"trace","command":"invoke",'
        '"data":{"agent":"codex","value":{"event":"turn"}}}'
    )
    error = parse_sdk_envelope(
        '{"protocolVersion":1,"type":"error","command":"cli",'
        '"exitCode":2,"error":{"message":"bad input"}}'
    )

    assert isinstance(trace, SdkTrace)
    assert trace.agent == "codex"
    assert trace.value == {"event": "turn"}
    assert error == SdkError(
        protocol_version=1,
        command="cli",
        exit_code=2,
        message="bad input",
    )


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        "[]",
        '{"protocolVersion":2,"type":"result","command":"version","exitCode":0,"data":{}}',
        '{"protocolVersion":true,"type":"result","command":"version","exitCode":0,"data":{}}',
        '{"protocolVersion":1.0,"type":"result","command":"version","exitCode":0,"data":{}}',
        '{"protocolVersion":1,"type":"unknown","command":"version"}',
        '{"protocolVersion":1,"type":"error","command":"cli","exitCode":2,"error":{}}',
    ],
)
def test_protocol_errors_are_explicit_and_do_not_echo_payload(payload: str) -> None:
    with pytest.raises(HeadlessProtocolError) as caught:
        parse_sdk_envelope(payload)

    assert payload not in str(caught.value)
