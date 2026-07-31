"""Environment-based configuration for css-mcp.

All settings are read from environment variables once at startup via
:func:`load_config`.  Invalid or missing values fall back to defaults so the
bridge never starts with a negative or NaN timeout.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable

import msgspec

_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})


def _parse_int(
    name: str,
    default: int,
    *,
    min_value: int = 0,
    log: Callable[[str], None] = lambda msg: print(msg, file=sys.stderr),
) -> int:
    """Read ``name`` from the environment as an int.

    Returns ``default`` when the variable is missing, not an integer, or below
    ``min_value``.  Invalid values are reported through ``log``.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        log(f"[css-mcp] config: {name}={raw!r} is not an int; using {default}")
        return default
    if value < min_value:
        log(f"[css-mcp] config: {name}={value} below min {min_value}; using {default}")
        return default
    return value


def _parse_bool(name: str, default: bool) -> bool:
    """Read ``name`` from the environment as a boolean.

    Accepts ``1``/``true``/``yes``/``on`` (case-insensitive) as true; any other
    value is false.  Missing variables yield ``default``.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUE_VALUES


def _env_socket_path() -> str:
    """Resolve the Unix socket path from ``CSS_MCP_SOCKET`` or
    ``OPENCODE_PYTHON_SOCK``, defaulting to the shared hooks socket."""
    return os.environ.get("CSS_MCP_SOCKET") or os.environ.get(
        "OPENCODE_PYTHON_SOCK"
    ) or "/var/run/css-mcp/hooks.sock"


class Config(msgspec.Struct, frozen=True):
    """Immutable runtime configuration for the css-mcp bridge.

    Timeouts are in milliseconds.  ``fail_open_blocking`` controls blocking
    ops (default fail-closed); ``fail_open_nonblocking`` controls non-blocking
    ops (default fail-open).
    """

    socket_path: str
    pre_timeout_ms: int = 5_000
    post_timeout_ms: int = 8_000
    ctx_timeout_ms: int = 3_000
    pipeline_timeout_ms: int = 10_000
    fail_open_blocking: bool = False
    fail_open_nonblocking: bool = True
    debug: bool = False


def load_config() -> Config:
    """Parse all environment variables once and return an immutable Config."""
    return Config(
        socket_path=_env_socket_path(),
        pre_timeout_ms=_parse_int("CSS_MCP_PRE_TIMEOUT", 5_000),
        post_timeout_ms=_parse_int("CSS_MCP_POST_TIMEOUT", 8_000),
        ctx_timeout_ms=_parse_int("CSS_MCP_CTX_TIMEOUT", 3_000),
        pipeline_timeout_ms=_parse_int("CSS_MCP_PIPELINE_TIMEOUT", 10_000),
        fail_open_blocking=_parse_bool("CSS_MCP_FAIL_OPEN_BLOCKING", False),
        fail_open_nonblocking=_parse_bool("CSS_MCP_FAIL_OPEN_NONBLOCKING", True),
        debug=_parse_bool("CSS_MCP_DEBUG", False),
    )
