"""Command-line entry point for css-mcp."""

from __future__ import annotations

import sys

from css_mcp.config import load_config


def main() -> int:
    """Load config and print the startup banner; socket server lands in Phase 4."""
    config = load_config()
    print(
        f"[css-mcp] starting — socket={config.socket_path} "
        f"pre={config.pre_timeout_ms} fail_open_blocking={config.fail_open_blocking}",
        file=sys.stderr,
    )
    print(
        "[css-mcp] not implemented yet — socket server lands in Phase 4",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
