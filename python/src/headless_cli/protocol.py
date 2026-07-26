from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, TypeGuard, cast

from .errors import HeadlessProtocolError
from .models import SdkEnvelope, SdkError, SdkResult, SdkTrace

SDK_PROTOCOL_VERSION = 1


def is_supported_protocol_version(value: object) -> TypeGuard[int]:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and value == SDK_PROTOCOL_VERSION
    )


def parse_sdk_envelope(payload: str) -> SdkEnvelope:
    try:
        decoded = json.loads(payload)
    except (json.JSONDecodeError, TypeError) as decode_error:
        raise HeadlessProtocolError("invalid Headless SDK JSON") from decode_error
    if not isinstance(decoded, dict):
        raise HeadlessProtocolError("Headless SDK envelope must be an object")
    envelope = cast(Mapping[str, Any], decoded)
    version = envelope.get("protocolVersion")
    if not is_supported_protocol_version(version):
        raise HeadlessProtocolError(
            f"unsupported Headless SDK protocol version: {version!r}"
        )
    kind = envelope.get("type")
    command = _required_string(envelope, "command")
    if kind == "result":
        return SdkResult(
            protocol_version=version,
            command=command,
            exit_code=_required_integer(envelope, "exitCode"),
            data=envelope.get("data"),
        )
    if kind == "error":
        error_payload = envelope.get("error")
        if not isinstance(error_payload, dict):
            raise HeadlessProtocolError("Headless SDK error payload must be an object")
        return SdkError(
            protocol_version=version,
            command=command,
            exit_code=_required_integer(envelope, "exitCode"),
            message=_required_string(cast(Mapping[str, Any], error_payload), "message"),
        )
    if kind == "trace":
        data = envelope.get("data")
        if not isinstance(data, dict):
            raise HeadlessProtocolError("Headless SDK trace data must be an object")
        trace_data = cast(Mapping[str, Any], data)
        raw = trace_data.get("raw")
        if raw is not None and not isinstance(raw, str):
            raise HeadlessProtocolError("Headless SDK trace raw value must be text")
        partial = trace_data.get("partial")
        if partial is not None and not isinstance(partial, bool):
            raise HeadlessProtocolError(
                "Headless SDK trace partial value must be boolean"
            )
        sequence = trace_data.get("sequence")
        if sequence is not None and (
            not isinstance(sequence, int) or isinstance(sequence, bool)
        ):
            raise HeadlessProtocolError(
                "Headless SDK trace sequence must be an integer"
            )
        return SdkTrace(
            protocol_version=version,
            command=command,
            agent=_required_string(trace_data, "agent"),
            value=trace_data.get("value"),
            raw=raw,
            partial=partial,
            sequence=sequence,
        )
    raise HeadlessProtocolError(f"unsupported Headless SDK envelope type: {kind!r}")


def parse_sdk_result(payload: str) -> SdkResult[Any] | SdkError:
    envelope = parse_sdk_envelope(payload)
    if isinstance(envelope, SdkTrace):
        raise HeadlessProtocolError("expected a Headless SDK result, received a trace")
    return envelope


def _required_string(data: Mapping[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise HeadlessProtocolError(f"Headless SDK field {key!r} must be text")
    return value


def _required_integer(data: Mapping[str, Any], key: str) -> int:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise HeadlessProtocolError(f"Headless SDK field {key!r} must be an integer")
    return value
