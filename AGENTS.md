# AGENTS.md — css-mcp-opencode-plugin

Agent-facing guide. Read this first when working in this repo.

## What this is

OpenCode ↔ Python bridge. The JS plugin (`socket-bridge.js`) is a thin transport between OpenCode and a Python "brain" over a Unix socket (NDJSON). The Python side owns all decisions: permission rules, task management, event classification, content injection. The JS side must be able to **block** OpenCode execution for every event type that can be blocked.

## Goals

1. **Python brain, JS gate** — all decision logic lives in Python; JS is a blocking transport only.
2. **Permission management from Python** — `permission.ask` hook + MCP `permissions_add/update/list` tools; mirror OpenCode semantics (keys `read/edit/glob/grep/bash/task/skill/lsp/question/webfetch/websearch/external_directory/doom_loop`, values `allow|ask|deny`, last-match-wins, `*`/`?` wildcards, per-tool object syntax, `~`/`$HOME` expansion).
3. **Full task-tool authority from Python** — pre-hook gate on `tool==="task"` + in-process async TaskManager exposed via MCP `task_create/list/output/cancel/clear`.
4. **Live content injection** — `session.inject` push channel → JS consumer calls `client.session` API → enables A2A message injection into the active session.
5. **Loadable plugin** — npm-publishable package (`package.json` at root); `github:user/repo` URL loading verified on opencode ≥ 1.18.4 (`opencode plugin github:owner/repo`).

## Architecture

- `socket-bridge.js` (repo root, ESM): OpenCode plugin, named export `server = async ({client, directory, worktree, project}) => hooks` (the `PluginModule` shape `{id?, server, tui?}` from `@opencode-ai/plugin` — opencode resolves `module.server` for config/npm plugins; an arbitrary export name is never loaded). SocketPool = one shared Unix socket, UUID-multiplexed RPC, reconnect with backoff, event debouncing, push handling.
- Python brain: **not part of this repo** (the `mcps/css-mcp` package was removed). The socket transport still expects an external server at `/var/run/css-mcp/hooks.sock`; without one the bridge runs **inert** (all hooks proceed — opencode is fully functional) until a brain connects. Test the transport with `scripts/client.py`.
- Socket: `/var/run/css-mcp/hooks.sock` (`OPENCODE_PYTHON_SOCK` override), NDJSON `\n`-delimited, UTF-8.
- Two channels: **socket** (JS↔Py) and **MCP stdio** (OpenCode↔Py).

## Protocol (v0.4 draft — reference implementation: `scripts/client.py`)

Message classes:
- Request JS→Py: `{id, op, body}` (id = UUID v4)
- Response Py→JS: `{id, ok, ...payload}` or `{id, ok:false, error:{code, message}}`
- Push Py→JS: `{type:"push", channel, body}` — never replied to, no id

Ops table (reply / timeout / blocking):
| op | reply | timeout | blocks? |
|----|-------|---------|---------|
| bootstrap | yes | 5s | yes (handshake) |
| config | yes | 5s | no (fail-open at load) |
| pre | yes | 5s | **yes (throw)** |
| permission | yes | 5s | **yes (throw/set status)** |
| post | yes | 8s | no |
| shell-env | yes | 2s | no |
| context | yes | 3s | no |
| event.pipeline | yes | 10s | spike-dependent |
| event | **no** | 2s | no |

Push channels: `capabilities.update`, `permissions.update`, `session.inject` (live content injection: `{id, sessionID, kind: user|assistant|system, content, metadata}` — FIFO per session, dedupe by id, active-session-only, fail-safe on client API error).

Key semantics (do not regress):
- Reply-expectation per op — server NEVER replies to NO_REPLY ops (no orphan log flood).
- Blocking ops fail-closed only **after a brain ever connected**; non-blocking fail-open. With no brain ever connected the bridge is inert — every hook proceeds, opencode runs normally. `OPENCODE_FAIL_OPEN === "1"` also fails open after a lost brain.
- One deadline per rpc; rpcs survive reconnect until their own deadline; circuit breaker (N failed reconnects) rejects pending once.
- Server-side callID dedupe (LRU ~1000, TTL 30s) prevents replay double-apply.
- Bootstrap queue-until-capabilities (hooks before handshake are queued; queue deadline exceeded → inert if no brain ever connected, else fail-closed for blocking ops).
- Capability-gated hooks: `bootstrap` reply carries `capabilities` (pre/permission/post/shellEnv/context/eventPipeline); a hook whose capability is **not** registered skips its RPC and proceeds immediately (deterministic fast path). Re-applied per reconnect; `capabilities.update` push re-applies live.
- Push dispatch happens BEFORE orphan matching in the data handler.
- One authority per event: `pre` = tool.execute.before only; `permission` = permission.ask only; `event.pipeline` informational (H3 spike verdict: host never awaits event hooks, thrown hook errors swallowed).
- `session.inject` consumer: `client.session.promptAsync` (SDK `gen/sdk.gen.d.ts` line 182, `SessionPromptAsyncData` = `{body:{parts, messageID?, model?, agent?, noReply?, system?, tools?}, path:{id}, query:{directory?}}` → POST `/session/{id}/prompt_async`); `client.session.prompt` = `{body:{parts,...}, path:{id}}` → POST `/session/{id}/message`. Verified in the installed SDK at runtime: `SessionInjector` delivers synthetic text parts with `noReply: true`, FIFO per session, dedupe by id, fail-safe on client error / null client.
- Bootstrap overrides mutate a mutable `runtimeConfig` object (all hooks read it at call time), re-applied per reconnect.
- Config deltas at bootstrap only (config hook is load-only); runtime config.update push channel DROPPED.

## Workflow

- **Track work with `todowrite`** — opencode's native task list. For any multi-step task: create a todo per step, keep exactly one `in_progress`, and mark items `completed` only after their verification actually passes (never by intent). This list is the session's source of truth for what is done vs pending.
- Use the question tool / plan-dev lifecycle per the dispatch mode (standalone vs sub-agent) described in the system prompt.
- **Resuming from a fresh session: reconstruct state from opencode's default database**, never guess.
  - DB path: `~/.local/share/opencode/opencode.db` (opencode's sqlite store on Linux). It is live while opencode runs; open read-only:
    `sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro"`.
  - Find prior sessions for this repo:
    `SELECT id, title, agent, datetime(time_updated/1000,'unixepoch') FROM session WHERE directory LIKE '%css-mcp-opencode-plugin%' ORDER BY time_updated DESC;`
  - Message/part content is JSON inside `part.data` — extract text with `json_extract(data,'$.text')`; a part row with `type='text'` and no `synthetic` flag is real user/agent text.
  - Task lists per session live in the `todo` table (`session_id`, `position`, `status`).
  - Background-agent runs (`bgagent_task()`) are sessions too. A session that contains only the task prompt (no result parts) means the task **never executed** — re-run it. Check `bgagent_list` first.

## Current status / TODOs

- [done] PUBLISHABILITY — package.json, LICENSE, README, git init
- [done] BOOTSTRAP CAPABILITY-GATING — handshake at load + reconnect, capability-gated hooks (fast path when not registered), `capabilities.update` push, fail-closed for blocking ops on failed handshake **only after a brain ever connected** (never-connected → inert, opencode fully functional)
- [done] SPIKE — event-hook await semantics → **H3**: host does NOT await `event` hooks (47 plugin.added invocations in ~250ms with 4s sleeps pending; run completed 3.1s with ~344s of pending sleeps; thrown hook errors logged + swallowed, exit 0). `event.pipeline` is informational only — never a blocking authority.
- [done] Spec v0.4 finalization — H3 branch locked by spike verdict (event.pipeline informational; pre/permission remain the only blocking authorities). Rubber-duck re-gate pending on Phase 2.
- [done] Phase 2 — JS FIX #1–#6 (reply-expectation via `NO_REPLY_OPS` + `pool.send()`, deadline retry — rpcs survive reconnect to their own deadline, server dedupe via `ReplayCache` LRU in client.py, `#onDisconnect` batch semantics via circuit breaker after 3 failed reconnect cycles, push-before-orphan, maxPending 256). E2E verified: NO_REPLY event leaves no pending entry, pre survives reconnect, pre fails closed fast (breaker) when brain gone; `socket-bridge.js` assigns `#socket` at create so failed connects still pass the disconnect guard.
- [done] Phase 3 — JS shim features: `permission.ask` hook (permission authority, capability-gated, fail-closed deny on lost brain, `status: allow|ask|deny` reply with `{allow: bool}` back-compat), task-tool authority (pre-hook surfaces `task` subagent fields explicitly to the TaskManager gate), config deltas at bootstrap (`runtimeConfig` mutable object replaced wholesale per handshake/reconnect, also via `capabilities.update` push), `session.inject` consumer (`SessionInjector`: FIFO per session, dedupe by id, bounded window, `client.session.promptAsync` with synthetic text parts + `noReply: true`, fail-safe on client error / null client). E2E-verified: permission deny propagates, inject FIFO + dedupe + fail-safe.
- [done] INERT-NO-BRAIN — loaded with no Python brain ever connecting now runs completely normal: blocking hooks proceed (pre allows, permission defaults to ask) instead of fail-closing; a one-time warn + per-gate debug note it. If a brain later connects it takes over authority live; if it was authority and is lost, blocking ops fail-closed again (`OPENCODE_FAIL_OPEN=1` opts out).
- Note: the Python brain (socket server, permission module, TaskManager, MCP tools, A2A ingestion) is **out of repo scope** — implement it externally or as a separate project.

## Known decisions (do not reverse without discussion)

- Option A: Python brain, JS blocking gate.
- Blocking ops fail-closed only after a brain ever connected; never-connected → inert (all hooks proceed). `OPENCODE_FAIL_OPEN` explicit opt-in for the lost-brain case.
- `permission.ask` hook is the permission authority (`client.permission.update()` does not exist).
- No plugin API launches subagents → pre-hook authority over `tool==="task"` (Python-side TaskManager tools are out of repo scope).
- `config` hook mutates only at load → Python supplies config deltas at bootstrap; runtime `config.update` push channel dropped.
- `session.inject` push channel added for live content injection / A2A (new in v0.4).
- GitHub URL plugin loading **verified working** on opencode ≥ 1.18.4: `opencode plugin github:owner/repo` installs from the repo (bun snapshot into `~/.cache/opencode/packages/`), detects the `server` target, and updates the project config. npm publish remains the alternative for versioned distribution.

## Files

- `socket-bridge.js` — the JS plugin (852-line baseline incl. bootstrap capability-gating)
- `package.json` — npm-publishable plugin metadata (`main: socket-bridge.js`)
- `AGENTS.md` — this file
- `README.md` — user-facing usage (npm / github URL / local symlink)
- `pyproject.toml` — plain Python project (no workspace): `msgspec` dep for `scripts/client.py` + `test` dependency group (pytest/ruff)
- `scripts/client.py` — NDJSON socket-bridge test client (v0.4 protocol) with `--serve` mode as the minimal test brain
- `.ai/mcp/mcp.json` — project-local MCP registration
- `LICENSE` — MIT

## Environment variables

| var | default |
|-----|---------|
| OPENCODE_PYTHON_SOCK | /var/run/css-mcp/hooks.sock |
| OPENCODE_BOOTSTRAP_TIMEOUT | 5000 |
| OPENCODE_PRE_TIMEOUT | 5000 |
| OPENCODE_PERMISSION_TIMEOUT | 5000 |
| OPENCODE_POST_TIMEOUT | 8000 |
| OPENCODE_CTX_TIMEOUT | 3000 |
| OPENCODE_PIPELINE_TIMEOUT | 10000 |
| OPENCODE_FAIL_OPEN | never-connected → inert; lost brain: unset → fail-closed, "1" → fail open |
| OPENCODE_BRIDGE_DEBUG | unset / "1" |

## Testing the plugin

- The project opencode config lives in `.opencode/opencode.json` — not a root-level `opencode.json`.
- The `plugin` entry for `socket-bridge.js` is **removed by default**: with no Python brain running the bridge would be inert (harmless), but the entry is left out of the default config so the repo ships load-clean without a socket.
- To test the plugin, add the entry to `.opencode/opencode.json` and **restart opencode** (config is load-only, not hot-reloaded):

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["../socket-bridge.js"]
  }
  ```

  `../socket-bridge.js` is relative to `.opencode/` and resolves to the repo-root `socket-bridge.js`.
- Loading without a brain is now **safe and inert** — opencode runs normally; no `OPENCODE_FAIL_OPEN` needed. It only matters once a brain has connected and is lost (fail-closed default).
- `scripts/client.py --serve` is the minimal test brain: it listens on the socket (default `/var/run/css-mcp/hooks.sock`, or `--socket`), replies to every op (never to `event`), and never denies `pre`/`permission`. Use `--push-channel <ch>` to broadcast a test push every `--push-interval` seconds (default 5). Ctrl-C exits with code 130 and removes the socket.

## Tech stack / conventions

- Python 3.14, `uv` only (never pip), `msgspec.Struct` (never @dataclass), async-native (asyncio/aiohttp/aiosqlite/aiofiles).
- Type hints everywhere; no Any, no `# type: ignore`, no `# noqa`.
- SQL parameterized only; secrets via env vars only.
- Tests: `uv run --group test pytest`.
- JS: ESM, `node --check` (or `bun build`) to verify.
- Dispatched sub-agents: run `plan-dev_verify()` after changes (ruff + basedpyright); never call `plan-dev_get_work()`/`plan-dev_finished_work()` when dispatched by the planner.

## CRITICAL RULES:

> [!CAUTION]
> heavily reduce chat output and thinking output to about < 1000 tokens 