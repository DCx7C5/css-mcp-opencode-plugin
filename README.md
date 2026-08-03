# css-mcp-opencode-plugin

OpenCode ↔ Python bridge. The JS side is a set of thin blocking transports over a
Unix socket; all decision logic lives in a Python "brain".

**Architecture: Python brain, JS gate — split into per-concern plugins.**

- **Shared transport** (`plugins/transport.js`) — one socket connection pool, one
  bootstrap handshake, one capability gate, one event debouncer, one
  `session.inject` consumer. Every plugin shares it (ESM singletons), so loading
  one plugin or all six is functionally identical.
- **Per-concern plugins** (`plugins/`) — each registers only its own hooks:

  | plugin | hook surface | authority |
  |--------|--------------|-----------|
  | `plugin-secrets.js` | `tool.execute.before`, `permission.ask` | **local, always-on** .env hardblock (never consults Python) |
  | `plugin-hooks.js` | `tool.execute.before` (non-task), `tool.execute.after`, `shell.env` | hook interface → Python (`pre`/`post`/`shell-env`) |
  | `plugin-task.js` | `tool.execute.before` (task only) | subagent launch gate → Python TaskManager |
  | `plugin-permission.js` | `permission.ask` | the yes/no popups → Python (`allow`/`ask`/`deny`) |
  | `plugin-context.js` | `experimental.session.compacting`, `event` (context syncs) | full context interface → Python (`context`) |
  | `plugin-events.js` | `event` | observer-only forwarding → Python (`event`/`event.pipeline`) |

- **Aggregator** (`plugins/index.js`) — the repo's npm/GitHub default
  (`package.json` `main`); loads all six plugins from one entry via opencode's
  multi-export plugin loading.
- **Python brain** — *not part of this repo.* It is an external server that
  listens on the socket and owns permission rules, task management, event
  classification, and content injection. Test the transport with
  [`scripts/client.py`](scripts/client.py).

> **Per-plugin feature reference:** every hook, capability, and reply contract
> is documented in [`PLUGINS.md`](PLUGINS.md).

## Lifecycle: IDE → opencode → MCP/ACP server

The plugin loads at opencode startup, **before** the Python process that serves
the socket exists (it may be your MCP stdio server — see below). This is fine:
the pool reconnects with exponential backoff forever and re-runs the bootstrap
handshake on every successful connect, so when the Python process finally
creates the socket, the bridge connects and takes over authority **live**. No
restart, no race. Until then the bridge is inert (all hooks proceed).

To have a single Python process serve **both** the MCP stdio channel and the
Unix socket, run `mcp.server.stdio_server()` and
`asyncio.start_unix_server(...)` as sibling tasks in one event loop — both
channels then share the same in-memory state (permission rules, TaskManager,
capabilities). The socket path must be writable by that process.

## Socket path

Resolved in order: `OPENCODE_PYTHON_SOCK` → `$XDG_RUNTIME_DIR/css-mcp/hooks.sock`
→ `/tmp/css-mcp/hooks.sock` → legacy `/var/run/css-mcp/hooks.sock` (only if it
already exists — it requires root to create, so an MCP/ACP child process cannot
use it).

## How it works

The plugins open one persistent Unix socket and multiplex every hook over it by
UUID. At load (and on every reconnect) the shared transport performs a
**bootstrap handshake**: the Python brain declares which hooks it handles
(`capabilities`). Each hook then consults that declaration:

- capability registered → send the RPC (with the op's own timeout)
- capability **not** registered → skip the RPC and proceed immediately
  (deterministic fast path — no stall, no fake timeout)
- bootstrap failed with **no brain ever connected** → the bridge runs **inert**:
  every hook proceeds, so opencode is fully functional without Python.
- bootstrap failed **after a brain connected and vanished** → blocking ops
  (`pre`, `permission`) **fail closed**; non-blocking ops skip. This keeps an
  authority that disappeared from silently becoming permissive; opt out with
  `OPENCODE_FAIL_OPEN=1`.

Blocking hooks (`pre`, `permission`) fail closed **only after a brain ever
connected**. The `.env` hardblock is the exception: it is a **local invariant**
that always holds, even with no brain.

## Install

### npm

```bash
npm install css-mcp-opencode-plugin
```

Loads the aggregator `plugins/index.js` (all six plugins, one entry).

### GitHub URL

```
"plugin": ["github:DCx7C5/css-mcp-opencode-plugin"]
```

> GitHub URL plugin loading is verified on opencode ≥ 1.18.4: `opencode plugin
> github:DCx7C5/css-mcp-opencode-plugin` installs the repo, detects the `server`
> target, and updates the project config. npm publish remains the alternative
> for versioned distribution.

### Split into plugins (one repo → many plugins)

All six plugins live in this one repo and load individually via `opencode.json`.
`plugins/` deliberately has **no `package.json`**, so opencode resolves each file
entry to the exact file (not the package `main`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "../plugins/plugin-secrets.js",
    "../plugins/plugin-hooks.js",
    "../plugins/plugin-task.js",
    "../plugins/plugin-permission.js",
    "../plugins/plugin-context.js",
    "../plugins/plugin-events.js"
  ]
}
```

Order matters: `plugin-secrets.js` first so the local hardblock runs before the
Python gate. To load all of them from a single entry instead, point at
`plugins/index.js` (opencode loads every `server`-shaped export as a separate
plugin) — this is also the npm/GitHub default.

> ⚠️ Load **either** the per-file entries **or** the aggregator
> (`plugins/index.js`) — never both. Each hook would register twice, so every
> tool invocation would fire **two** `pre` RPCs at the Python brain.

### opencode.json entries — every load form

Plugins are declared in the `"plugin"` array. Put it in the **project**
`.opencode/opencode.json`, or in the **global** `~/.config/opencode/opencode.json`
to apply to every project.

| form | entry | loads |
|------|-------|-------|
| npm package | `"plugin": ["css-mcp-opencode-plugin"]` | all six via `main` (`plugins/index.js`) |
| GitHub URL | `"plugin": ["github:DCx7C5/css-mcp-opencode-plugin"]` | all six via `main` |
| local per-file | `"plugin": ["../plugins/plugin-secrets.js", …]` | exactly the listed plugins (project-local dev) |
| local aggregator | `"plugin": ["../plugins/index.js"]` | all six, one entry |
| single plugin | `"plugin": ["../plugins/plugin-secrets.js"]` | one plugin only |

Example — project `.opencode/opencode.json`, all six from this repo:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "../plugins/plugin-secrets.js",
    "../plugins/plugin-hooks.js",
    "../plugins/plugin-task.js",
    "../plugins/plugin-permission.js",
    "../plugins/plugin-context.js",
    "../plugins/plugin-events.js"
  ]
}
```

Config is read once at startup — **restart opencode** after changing it (no
hot-reload). Per-file entries resolve to the exact file because `plugins/` has
no `package.json`; the repo-root `main` would otherwise win.

## Environment variables

| var | default |
|-----|---------|
| `OPENCODE_PYTHON_SOCK` | `$XDG_RUNTIME_DIR/css-mcp/hooks.sock` (or `/tmp/css-mcp/hooks.sock`) |
| `OPENCODE_BOOTSTRAP_TIMEOUT` | `5000` |
| `OPENCODE_PRE_TIMEOUT` | `5000` |
| `OPENCODE_POST_TIMEOUT` | `8000` |
| `OPENCODE_CTX_TIMEOUT` | `3000` |
| `OPENCODE_PIPELINE_TIMEOUT` | `10000` |
| `OPENCODE_FAIL_OPEN` | never-connected → inert; lost brain: unset → fail-closed, `"1"` → fail open |
| `OPENCODE_BRIDGE_DEBUG` | unset / `"1"` |

Loading without a Python brain is **safe and inert**: opencode runs normally
(blocking hooks proceed, permissions keep their default ask flow) until a brain
connects and takes over authority. If that brain is later lost, blocking ops
fail closed again unless `OPENCODE_FAIL_OPEN=1`. The `.env` hardblock always
applies.

## Protocol

v0.4 NDJSON over a Unix socket, `\n`-delimited, UTF-8.

- Request JS→Py: `{id, op, body}` (`id` = UUID v4)
- Response Py→JS: `{id, ok, ...payload}` or `{id, ok:false, error:{code, message}}`
- Push Py→JS: `{type: "push", channel, body}` — never replied to, no `id`

Every JS→Py line MAY carry the owning plugin's letter prefix before the JSON
(`h:` hooks, `t:` task, `p:` permission, `c:` context, `e:` events; secrets
never talks to Python) — the server strips `^[ecpths]:` before decoding.
Py→JS lines are always plain JSON. See
[`PLUGINS.md`](PLUGINS.md) for the wire-prefix table and the full
**response reference** — every reply payload, type, and error code for the
hook RPCs (`bootstrap`/`config`/`pre`/`permission`/`post`/`shell-env`/
`context`/`event.pipeline`) and the reverse-RPCs (`session.context.read`,
`session.intel`, `session.summarize`, `task.launch`, `permission.answer`).

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
`session.inject` pushes deliver live content into an active session — a
`user`-kind part is how Python asks the human a question mid-session
(human-in-the-chain). `session.context.read` is a reverse-RPC: Python pushes
`{id, sessionID}` and transport.js replies with the session + messages (see
[`PLUGINS.md`](PLUGINS.md)).

## Testing the transport

```bash
uv run --group test pytest
npm run check            # node --check every JS file
npm test                 # node --test — plugin unit (inert) + E2E suites
scripts/client.py --serve   # minimal test brain on the socket
```

`--serve` replies to every op (never to `event`), never denies `pre`/`permission`,
and can broadcast a test push on a channel with `--push-channel`.

## License

MIT
