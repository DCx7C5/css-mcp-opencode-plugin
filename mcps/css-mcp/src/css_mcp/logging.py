"""Logging helpers for css-mcp.

All logs go to stderr with a ``[css-mcp]`` prefix so opencode captures them.
"""

from __future__ import annotations

import logging
import os
import sys

_FORMAT = "[css-mcp] %(levelname)s %(name)s: %(message)s"
_CONFIGURED = False


def get_logger(name: str) -> logging.Logger:
    """Return a logger configured for stderr with the css-mcp prefix.

    Idempotent: the handler is installed once per process, so repeated calls
    never stack duplicate handlers.
    """
    global _CONFIGURED
    if not _CONFIGURED:
        level = logging.DEBUG if os.environ.get("CSS_MCP_DEBUG") else logging.INFO
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(_FORMAT))
        root = logging.getLogger("css-mcp")
        root.setLevel(level)
        root.addHandler(handler)
        root.propagate = False
        _CONFIGURED = True
    return logging.getLogger(f"css-mcp.{name}")
