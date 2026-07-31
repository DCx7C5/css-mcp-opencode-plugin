"""Smoke tests for the socket-bridge NDJSON test client (scripts/client.py)."""

import importlib.util
from pathlib import Path
from types import ModuleType

import msgspec

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"


def _load_client() -> ModuleType:
    """Import scripts/client.py by path (scripts/ is not a package)."""
    spec = importlib.util.spec_from_file_location("client", SCRIPTS_DIR / "client.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_ops_cover_protocol() -> None:
    client = _load_client()
    assert client.OPS == frozenset(
        {
            "bootstrap",
            "config",
            "pre",
            "permission",
            "post",
            "shell-env",
            "context",
            "event.pipeline",
            "event",
        }
    )


def test_request_roundtrip() -> None:
    client = _load_client()
    request = client.Request(id="req-1", op="bootstrap", body={"key": "value"})
    encoded = msgspec.json.encode(request)
    decoded = msgspec.json.decode(encoded, type=client.Request)
    assert decoded == request


def test_response_allows_extra_payload_fields() -> None:
    client = _load_client()
    response = msgspec.json.decode(
        b'{"id": "req-1", "ok": true, "allowed": true, "note": "hi"}',
        type=client.Response,
    )
    assert response.id == "req-1"
    assert response.ok is True
    assert response.error is None


def test_response_error_detail() -> None:
    client = _load_client()
    response = msgspec.json.decode(
        b'{"id": "req-1", "ok": false, "error": {"code": "E_BLOCK", "message": "denied"}}',
        type=client.Response,
    )
    assert response.ok is False
    assert response.error is not None
    assert response.error.code == "E_BLOCK"
    assert response.error.message == "denied"


def test_request_from_dict_generates_id_and_default_body() -> None:
    client = _load_client()
    request = client.request_from_dict({"op": "config"})
    assert request.op == "config"
    assert request.body == {}
    assert len(request.id) == 36


def test_request_from_dict_rejects_unknown_op() -> None:
    client = _load_client()
    try:
        client.request_from_dict({"op": "nope"})
    except ValueError as exc:
        assert "unknown op" in str(exc)
    else:  # pragma: no cover - failure path
        raise AssertionError("expected ValueError for unknown op")


def test_request_from_dict_rejects_non_object_body() -> None:
    client = _load_client()
    try:
        client.request_from_dict({"op": "config", "body": [1, 2]})
    except ValueError as exc:
        assert "invalid request line" in str(exc)
    else:  # pragma: no cover - failure path
        raise AssertionError("expected ValueError for array body")


def test_parse_body_defaults_to_empty_object() -> None:
    client = _load_client()
    assert client.parse_body(None) == {}
    assert client.parse_body('{"a": 1}') == {"a": 1}


def test_handle_request_event_returns_none() -> None:
    client = _load_client()
    request = client.Request(id="req-1", op="event", body={})
    assert client.handle_request(request) is None


def test_handle_request_pre_allows() -> None:
    client = _load_client()
    request = client.Request(id="req-1", op="pre", body={"tool": "bash"})
    reply = client.handle_request(request)
    assert reply == {"id": "req-1", "ok": True, "allow": True}


def test_handle_request_permission_allows() -> None:
    client = _load_client()
    request = client.Request(id="req-1", op="permission", body={})
    reply = client.handle_request(request)
    assert reply == {"id": "req-1", "ok": True, "allow": True}


def test_handle_request_bootstrap_reports_capabilities() -> None:
    client = _load_client()
    request = client.Request(id="req-1", op="bootstrap", body={})
    reply = client.handle_request(request)
    assert reply is not None
    assert reply["id"] == "req-1"
    assert reply["ok"] is True
    assert reply["capabilities"]["session.inject"] is True


def test_handle_request_shell_env_empty() -> None:
    client = _load_client()
    request = client.Request(id="req-1", op="shell-env", body={})
    reply = client.handle_request(request)
    assert reply == {"id": "req-1", "ok": True, "env": {}}


def test_handle_request_event_pipeline_never_blocks() -> None:
    client = _load_client()
    request = client.Request(id="req-1", op="event.pipeline", body={})
    reply = client.handle_request(request)
    assert reply == {"id": "req-1", "ok": True, "hooks_ran": []}


def test_handle_request_plain_ops_ok() -> None:
    client = _load_client()
    for op in ("config", "post", "context"):
        request = client.Request(id=f"req-{op}", op=op, body={})
        assert client.handle_request(request) == {"id": f"req-{op}", "ok": True}


def test_push_body_session_inject_shape() -> None:
    client = _load_client()
    body = client._push_body("session.inject")
    assert set(body) == {"id", "sessionID", "kind", "content", "metadata"}
    assert body["kind"] == "system"


def test_push_body_generic_channel() -> None:
    client = _load_client()
    body = client._push_body("permissions.update")
    assert set(body) == {"id", "note"}
