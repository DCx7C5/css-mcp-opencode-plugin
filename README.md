# css-mcp-opencode-plugin

OpenCode ↔ Python bridge plugin. The JS side is a thin blocking transport over a
Unix socket; all decision logic lives in a Python "brain".

**Architecture: Python brain, JS gate.**

- **JS plugin** (`socket-bridge.js`) — persistent pooled Unix-socket transport,
  NDJSON request/response, event debouncing, fail-closed blocking hooks.
- **Python brain** — *not part of this repo.* It is an external server that
  listens on the socket and owns permission rules, task management, event
  classification, and content injection. Test the transport with
  [`scripts/client.py`](scripts/client.py).

## How it works

The plugin opens one persistent Unix socket (default `/var/run/css-mcp/hooks.sock`)
and multiplexes every hook over it by UUID. At load (and on every reconnect) it
performs a **bootstrap handshake**: the Python brain declares which hooks it
handles (`capabilities`). Each hook then consults that declaration:

- capability registered → send the RPC (with the op's own timeout)
- capability **not** registered → skip the RPC and proceed immediately
  (deterministic fast path — no stall, no fake timeout)
- bootstrap failed (brain unreachable) → blocking ops (`pre`, `permission`)
  **fail closed**; non-blocking ops skip.

Blocking hooks **fail closed** by default: if the Python brain is unreachable,
the tool call is denied rather than allowed. Non-blocking hooks fail open.

## Install

### npm

```bash
npm install css-mcp-opencode-plugin
```

### GitHub URL

```
"plugin": ["github:DCx7C5/css-mcp-opencode-plugin"]
```

> Note: GitHub URL plugin loading requires opencode#12378 to be fixed. npm
> publish is the supported path.

### Local symlink (development)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["../socket-bridge.js"]
}
```

The path is relative to `.opencode/`. After editing plugin config, **restart
opencode** (config is load-only).

## Environment variables

| var | default |
|-----|---------|
| `OPENCODE_PYTHON_SOCK` | `/var/run/css-mcp/hooks.sock` |
| `OPENCODE_BOOTSTRAP_TIMEOUT` | `5000` |
| `OPENCODE_PRE_TIMEOUT` | `5000` |
| `OPENCODE_POST_TIMEOUT` | `8000` |
| `OPENCODE_CTX_TIMEOUT` | `3000` |
| `OPENCODE_PIPELINE_TIMEOUT` | `10000` |
| `OPENCODE_FAIL_OPEN` | unset → fail-closed; `"1"` → fail open |
| `OPENCODE_BRIDGE_DEBUG` | unset / `"1"` |

Without a Python brain running, keep `OPENCODE_FAIL_OPEN=1` exported — every
blocking op would otherwise time out and block the tool.

## Protocol

v0.4 NDJSON over a Unix socket, `\n`-delimited, UTF-8.

- Request JS→Py: `{id, op, body}` (`id` = UUID v4)
- Response Py→JS: `{id, ok, ...payload}` or `{id, ok:false, error:{code, message}}`
- Push Py→JS: `{type: "push", channel, body}` — never replied to, no `id`

Ops: `bootstrap`, `config`, `pre`, `permission`, `post`, `shell-env`, `context`,
`event.pipeline`, `event`. `scripts/client.py` is the reference implementation.

The `bootstrap` reply carries the hook capability map the JS side gates on:

```json
{ "id": "...", "ok": true, "capabilities": {
    "pre": true, "post": true, "shellEnv": true, "context": true,
    "eventPipeline": true
} }
```

A live `capabilities.update` push re-applies the map without a reconnect.

## Testing the transport

```bash
uv run --group test pytest
scripts/client.py --serve   # minimal test brain on the socket
```

`--serve` replies to every op (never to `event`), never denies `pre`/`permission`,
and can broadcast a test push on a channel with `--push-channel`.

## License

MIT
