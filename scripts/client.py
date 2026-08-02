"""NDJSON test client for the OpenCode ↔ Python socket bridge.

Implements the v0.4 protocol from AGENTS.md:

- Transport: Unix socket, NDJSON (``\\n``-delimited, UTF-8).
- Request (JS→Py): ``{"id": "<uuid4>", "op": "<op>", "body": {...}}``.
- Response (Py→JS): ``{"id": "<id>", "ok": true, ...payload}`` or
  ``{"id": "<id>", "ok": false, "error": {"code": ..., "message": ...}}``.
- Push (Py→JS): ``{"type": "push", "channel": ..., "body": ...}`` — never
  replied to, no id.
- ``event`` is fire-and-forget: the server never replies to it, so the client
  must not wait for a reply.

Usage::

    # Single request with the default empty body
    uv run python scripts/client.py --op bootstrap

    # Single request with a JSON object body
    uv run python scripts/client.py --op pre --body '{"tool": "bash", "input": {"command": "ls"}}'

    # Event op: fire-and-forget, no reply expected
    uv run python scripts/client.py --op event --body '{"name": "some.event"}'

    # Stream mode: one request per stdin line, replies printed to stdout
    printf '{"op": "bootstrap"}\\n' | uv run python scripts/client.py --stream

    # Custom socket path / timeout
    uv run python scripts/client.py --op config --socket /tmp/hooks.sock --timeout 3

Serve mode (minimal test brain)::

    # Stand up the socket server — replies to every op (never to ``event``)
    uv run python scripts/client.py --serve
    uv run python scripts/client.py --serve --socket /tmp/hooks.sock

    # Broadcast a push every 5s to all connected clients
    uv run python scripts/client.py --serve --push-channel permissions.update

Exit codes:

- 0 success (or an ``event`` request was written)
- 1 the server replied with ``ok: false``
- 2 timeout waiting for a reply, or usage error
- 3 could not connect to the socket
- 130 interrupted (Ctrl-C) while serving
"""

import argparse
import asyncio
import os
import sys
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator
from pathlib import Path

import msgspec


def default_socket() -> str:
    """User-writable socket default, mirroring transport.js resolution:
    OPENCODE_PYTHON_SOCK → $XDG_RUNTIME_DIR/css-mcp/hooks.sock →
    /tmp/css-mcp/hooks.sock. The Python side creates the socket, so it must
    live in a directory an unprivileged MCP/ACP child process can write."""
    override = os.environ.get("OPENCODE_PYTHON_SOCK")
    if override:
        return override
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if runtime_dir:
        return f"{runtime_dir}/css-mcp/hooks.sock"
    return "/tmp/css-mcp/hooks.sock"


DEFAULT_SOCKET = default_socket()

DEFAULT_PUSH_INTERVAL = 5.0

# Server-side dedupe limits (spec): replay double-apply is prevented by
# remembering request ids briefly (LRU ~1000, TTL 30s).
DEDUPE_CAPACITY = 1000
DEDUPE_TTL = 30.0

OPS: frozenset[str] = frozenset(
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


class Error(msgspec.Struct):
    """Error detail in a negative response."""

    code: str
    message: str


class Request(msgspec.Struct):
    """A request sent from JS to the Python brain."""

    id: str
    op: str
    body: dict[str, object] = msgspec.field(default_factory=dict)


class Response(msgspec.Struct):
    """A reply from the Python brain, optionally carrying extra payload fields."""

    id: str
    ok: bool
    error: Error | None = None


class BridgeError(Exception):
    """Base error for socket-bridge client failures."""


class ReplyTimeout(BridgeError):
    """Raised when the server does not reply within the deadline."""


class ReplayCache:
    """LRU cache of recently-seen request ids (TTL-bounded).

    Prevents replay double-apply: when a request is re-sent with the same id
    (e.g. the JS pool re-enqueues after a reconnect), the cached reply is
    returned instead of re-running the handler.

    Args:
        capacity: Max ids retained before evicting the least-recently-used.
        ttl: Seconds a cached entry is considered fresh.
    """

    def __init__(self, capacity: int = DEDUPE_CAPACITY, ttl: float = DEDUPE_TTL) -> None:
        self.capacity = capacity
        self.ttl = ttl
        self._seen: OrderedDict[str, tuple[float, dict[str, object]]] = OrderedDict()

    def get(self, request_id: str) -> dict[str, object] | None:
        """Return the cached reply for a replayed id, or ``None`` if fresh."""
        item = self._seen.get(request_id)
        if item is None:
            return None
        seen_at, reply = item
        if time.monotonic() - seen_at > self.ttl:
            del self._seen[request_id]
            return None
        self._seen.move_to_end(request_id)
        return reply

    def put(self, request_id: str, reply: dict[str, object]) -> None:
        """Remember ``request_id`` so a replay within TTL reuses ``reply``."""
        self._seen[request_id] = (time.monotonic(), reply)
        self._seen.move_to_end(request_id)
        while len(self._seen) > self.capacity:
            self._seen.popitem(last=False)


async def send_only(socket_path: str, request: Request) -> None:
    """Write a request without waiting for a reply.

    Used for fire-and-forget ops such as ``event`` whose op has no reply.

    Args:
        socket_path: Unix socket path of the Python brain.
        request: Request to write.

    Raises:
        BridgeError: if the socket cannot be opened.
    """
    try:
        _, writer = await asyncio.open_unix_connection(socket_path)
    except OSError as exc:
        raise BridgeError(f"cannot connect to {socket_path}: {exc}") from exc
    try:
        writer.write(msgspec.json.encode(request))
        writer.write(b"\n")
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def exchange(socket_path: str, request: Request, timeout: float) -> tuple[Response, bytes]:
    """Send one request and await the matching reply.

    The server may push ``{"type": "push", ...}`` lines at any time; those are
    written to stdout as they arrive and the wait continues until the reply.

    Args:
        socket_path: Unix socket path of the Python brain.
        request: Request to send.
        timeout: Maximum seconds to wait for the reply.

    Returns:
        A tuple of the typed ``Response`` and the raw NDJSON line bytes.

    Raises:
        ReplyTimeout: if no reply arrives within ``timeout`` seconds.
        BridgeError: if the socket cannot be opened or closes early.
    """
    try:
        reader, writer = await asyncio.open_unix_connection(socket_path)
    except OSError as exc:
        raise BridgeError(f"cannot connect to {socket_path}: {exc}") from exc
    try:
        writer.write(msgspec.json.encode(request))
        writer.write(b"\n")
        await writer.drain()
        while True:
            try:
                line = await asyncio.wait_for(reader.readline(), timeout)
            except TimeoutError as exc:
                raise ReplyTimeout(
                    f"no reply within {timeout:g}s for op {request.op!r} (id {request.id})"
                ) from exc
            if not line:
                raise BridgeError("connection closed before a reply was received")
            raw = msgspec.json.decode(line, type=dict[str, object])
            if raw.get("type") == "push":
                # Server push — forward to stdout, keep waiting for the reply.
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            else:
                return msgspec.json.decode(line, type=Response), line
    finally:
        writer.close()
        await writer.wait_closed()


def request_from_dict(raw: dict[str, object]) -> Request:
    """Build a ``Request`` from a decoded JSON object.

    A missing or invalid ``id`` is replaced with a fresh UUIDv4. The ``op``
    must be a known op and ``body`` (when present) must be a JSON object.

    Args:
        raw: Decoded request line.

    Returns:
        The validated ``Request``.

    Raises:
        ValueError: if ``op`` is missing/unknown or ``body`` is not an object.
    """
    req_id = raw.get("id")
    if not isinstance(req_id, str) or not req_id:
        raw["id"] = str(uuid.uuid4())
    try:
        request = msgspec.convert(raw, type=Request)
    except msgspec.ValidationError as exc:
        raise ValueError(f"invalid request line: {exc}") from exc
    if request.op not in OPS:
        raise ValueError(f"unknown op {request.op!r}; expected one of {sorted(OPS)}")
    return request


def parse_body(text: str | None) -> dict[str, object]:
    """Parse the ``--body`` CLI argument into a JSON object.

    Args:
        text: Raw JSON text, or ``None`` for the default empty object.

    Returns:
        The decoded object.

    Raises:
        ValueError: if the text is not a JSON object.
    """
    if text is None:
        return {}
    try:
        body = msgspec.json.decode(text, type=dict[str, object])
    except msgspec.MsgspecError as exc:
        raise ValueError("--body must be a JSON object") from exc
    return body


async def _stdin_lines() -> AsyncIterator[str]:
    """Yield one UTF-8 line at a time from stdin without blocking the loop."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    while not reader.at_eof():
        line = await reader.readline()
        if not line:
            break
        yield line.decode("utf-8")


async def run_single(socket_path: str, op: str, body: dict[str, object], timeout: float) -> int:
    """Send one request in ``--op`` mode and print the reply.

    Returns:
        Exit code per the module docstring.
    """
    request = Request(id=str(uuid.uuid4()), op=op, body=body)
    if op == "event":
        try:
            await send_only(socket_path, request)
        except BridgeError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 3
        print(f"event sent (fire-and-forget, no reply expected): {request.id}", file=sys.stderr)
        return 0
    try:
        response, line = await exchange(socket_path, request, timeout)
    except ReplyTimeout as exc:
        print(f"TIMEOUT: {exc}", file=sys.stderr)
        return 2
    except BridgeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 3
    sys.stdout.buffer.write(line)
    sys.stdout.buffer.flush()
    return 0 if response.ok else 1


async def run_stream(socket_path: str, timeout: float) -> int:
    """Read NDJSON requests from stdin and print replies to stdout.

    Returns:
        Exit code per the module docstring (worst code seen).
    """
    code = 0
    async for line in _stdin_lines():
        if not line.strip():
            continue
        try:
            raw = msgspec.json.decode(line, type=dict[str, object])
        except msgspec.MsgspecError as exc:
            print(f"ERROR: invalid JSON on stdin: {exc}", file=sys.stderr)
            code = 2
            continue
        try:
            request = request_from_dict(raw)
        except ValueError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            code = 2
            continue
        if request.op == "event":
            try:
                await send_only(socket_path, request)
            except BridgeError as exc:
                print(f"ERROR: {exc}", file=sys.stderr)
                code = 3
                continue
            print(f"event sent (fire-and-forget, no reply expected): {request.id}", file=sys.stderr)
            continue
        try:
            response, reply = await exchange(socket_path, request, timeout)
        except ReplyTimeout as exc:
            print(f"TIMEOUT: {exc}", file=sys.stderr)
            code = 2
            continue
        except BridgeError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            code = 3
            continue
        sys.stdout.buffer.write(reply)
        sys.stdout.buffer.flush()
        if not response.ok:
            code = 1
    return code


def handle_request(request: Request) -> dict[str, object] | None:
    """Compute the test-brain reply for one request.

    Every op except ``event`` gets an ``ok: true`` reply with a payload the
    plugin's hooks consume (see transport.js ``okReply`` contract):

    - ``pre``: ``allow: true`` (never denies)
    - ``permission``: ``status: "allow"`` (v0.4 protocol — never denies)
    - ``shell-env``: ``env: {}`` (nothing to inject)
    - ``event.pipeline``: ``hooks_ran: []`` (never blocks)
    - ``bootstrap``: a hook-``capabilities`` map (``pre``/``permission``/``post``/
      ``shellEnv``/``context``/``eventPipeline`` — the keys transport.js
      gates on)
    - ``config``, ``post``, ``context``: bare ``ok: true``

    Args:
        request: The decoded request.

    Returns:
        Reply object, or ``None`` for fire-and-forget ops (``event``).
    """
    if request.op == "event":
        return None
    reply: dict[str, object] = {"id": request.id, "ok": True}
    if request.op == "bootstrap":
        reply["capabilities"] = {
            "pre": True,
            "permission": True,
            "post": True,
            "shellEnv": True,
            "context": True,
            "eventPipeline": True,
        }
    elif request.op == "pre":
        reply["allow"] = True
    elif request.op == "permission":
        reply["status"] = "allow"
    elif request.op == "shell-env":
        reply["env"] = {}
    elif request.op == "event.pipeline":
        reply["hooks_ran"] = []
    return reply


def _push_body(channel: str) -> dict[str, object]:
    """Build a push body for ``--serve`` broadcasting.

    ``session.inject`` gets the v0.4 shape from AGENTS.md; other channels get
    a generic test payload.
    """
    if channel == "session.inject":
        return {
            "id": str(uuid.uuid4()),
            "sessionID": "*",
            "kind": "system",
            "content": f"test inject on channel {channel}",
            "metadata": {},
        }
    return {"id": str(uuid.uuid4()), "note": f"test push on channel {channel}"}


async def _serve_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    replay_cache: ReplayCache,
) -> None:
    """Handle one client connection: read requests, write replies, never reply to ``event``."""
    peer = writer.get_extra_info("peername")
    print(f"[serve] client connected: {peer}", file=sys.stderr)
    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            text = line.decode("utf-8")
            try:
                raw = msgspec.json.decode(text, type=dict[str, object])
                request = request_from_dict(raw)
            except msgspec.MsgspecError as exc:
                print(f"[serve] bad request: {exc}", file=sys.stderr)
                continue
            except ValueError as exc:
                print(f"[serve] bad request: {exc}", file=sys.stderr)
                continue
            print(f"[serve] op={request.op} id={request.id[:8]}", file=sys.stderr)
            reply = replay_cache.get(request.id)
            if reply is not None:
                print(f"[serve] replay dedupe id={request.id[:8]}", file=sys.stderr)
            else:
                reply = handle_request(request)
                if reply is None:
                    print("[serve] event: no reply (fire-and-forget)", file=sys.stderr)
                    continue
                replay_cache.put(request.id, reply)
            writer.write(msgspec.json.encode(reply))
            writer.write(b"\n")
            await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def _push_broadcast(
    connections: set[asyncio.StreamWriter],
    channel: str,
    interval: float,
) -> None:
    """Broadcast a test push every ``interval`` seconds to all connected writers."""
    while True:
        await asyncio.sleep(interval)
        payload = {"type": "push", "channel": channel, "body": _push_body(channel)}
        line = msgspec.json.encode(payload) + b"\n"
        dead: list[asyncio.StreamWriter] = []
        for writer in list(connections):
            try:
                writer.write(line)
                await writer.drain()
            except (ConnectionError, TimeoutError):
                dead.append(writer)
        for writer in dead:
            connections.discard(writer)
        print(f"[serve] push channel={channel} clients={len(connections)}", file=sys.stderr)


async def run_serve(
    socket_path: str,
    push_channel: str | None,
    push_interval: float,
) -> int:
    """Run the test brain: listen on a Unix socket and answer protocol requests.

    Args:
        socket_path: Unix socket path to bind.
        push_channel: Channel for periodic test pushes, or ``None`` to disable.
        push_interval: Seconds between pushes (ignored when ``push_channel`` is None).

    Returns:
        Exit code (0 on clean shutdown, 130 when interrupted).

    Raises:
        OSError: if the socket cannot be bound (missing dir / permission).
    """
    parent = Path(socket_path).parent
    parent.mkdir(parents=True, exist_ok=True)
    try:
        os.unlink(socket_path)
    except FileNotFoundError:
        pass
    connections: set[asyncio.StreamWriter] = set()
    replay_cache = ReplayCache()

    async def on_connect(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        connections.add(writer)
        try:
            await _serve_connection(reader, writer, replay_cache)
        finally:
            connections.discard(writer)

    server = await asyncio.start_unix_server(on_connect, socket_path)
    print(f"[serve] listening on {socket_path}", file=sys.stderr)
    try:
        async with server:
            push_task: asyncio.Task[None] | None = None
            if push_channel is not None:
                push_task = asyncio.create_task(
                    _push_broadcast(connections, push_channel, push_interval)
                )
            try:
                await server.serve_forever()
            finally:
                if push_task is not None:
                    push_task.cancel()
    finally:
        try:
            os.unlink(socket_path)
        except FileNotFoundError:
            pass
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="NDJSON test client for the OpenCode ↔ Python socket bridge"
    )
    parser.add_argument(
        "--socket",
        default=DEFAULT_SOCKET,
        help=f"Unix socket path (default: {DEFAULT_SOCKET})",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="seconds to wait for a reply (default: 10)",
    )
    parser.add_argument(
        "--body",
        default=None,
        help="JSON object body for --op (default: {})",
    )
    parser.add_argument(
        "--push-channel",
        default=None,
        help="serve mode: broadcast a test push on this channel (implies --serve)",
    )
    parser.add_argument(
        "--push-interval",
        type=float,
        default=DEFAULT_PUSH_INTERVAL,
        help=f"serve mode: seconds between pushes (default: {DEFAULT_PUSH_INTERVAL})",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--op",
        choices=sorted(OPS),
        help="single request mode: op to send",
    )
    mode.add_argument(
        "--stream",
        action="store_true",
        help="stream mode: read NDJSON requests from stdin, print replies",
    )
    mode.add_argument(
        "--serve",
        action="store_true",
        help="serve mode: act as a minimal test brain on the Unix socket",
    )
    return parser


async def amain(args: argparse.Namespace) -> int:
    """Dispatch to single, stream, or serve mode based on parsed arguments."""
    if args.body is not None and args.op is None:
        print("error: --body requires --op", file=sys.stderr)
        return 2
    if args.serve or args.push_channel is not None:
        return await run_serve(
            args.socket,
            push_channel=args.push_channel,
            push_interval=args.push_interval,
        )
    if args.op is not None:
        try:
            body = parse_body(args.body)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        return await run_single(args.socket, args.op, body, args.timeout)
    if args.stream:
        return await run_stream(args.socket, args.timeout)
    print("error: specify --op <op>, --stream, or --serve", file=sys.stderr)
    return 2


def main(argv: list[str] | None = None) -> int:
    """Entry point: parse args and run the client event loop."""
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return asyncio.run(amain(args))
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
