# AGENTS.md — css-mcp-opencode-plugin

Agent-facing guide. Read this first when working in this repo.

## What this is

OpenCode ↔ Python bridge. The JS plugin (`socket-bridge.js`) is a thin transport between OpenCode and a Python "brain" over a Unix socket (NDJSON). The Python side owns all decisions: permission rules, task management, event classification, content injection. The JS side must be able to **block** OpenCode execution for every event type that can be blocked.

## Goals

1. **Python brain, JS gate** — all decision logic lives in Python; JS is a blocking transport only.
2. **Permission management from Python** — `permission.ask` hook + MCP `permissions_add/update/list` tools; mirror OpenCode semantics (keys `read/edit/glob/grep/bash/task/skill/lsp/question/webfetch/websearch/external_directory/doom_loop`, values `allow|ask|deny`, last-match-wins, `*`/`?` wildcards, per-tool object syntax, `~`/`$HOME` expansion).
3. **Full task-tool authority from Python** — pre-hook gate on `tool==="task"` + in-process async TaskManager exposed via MCP `task_create/list/output/cancel/clear`.
4. **Live content injection** — `session.inject` push channel → JS consumer calls `client.session` API → enables A2A message injection into the active session.
5. **Loadable plugin** — npm-publishable package (`package.json` at root); `github:user/repo` URL loading works once opencode#12378 is fixed.

## Architecture

- `socket-bridge.js` (repo root, ESM): OpenCode plugin, V1 named export `PythonBridge = async ({client, directory, worktree, project}) => hooks`. SocketPool = one shared Unix socket, UUID-multiplexed RPC, reconnect with backoff, event debouncing, push handling.
- Python brain (Phase 4, `mcps/css-mcp`): runs **both** a Unix-socket NDJSON server **and** a stdio MCP server, sharing in-process PermissionStore + TaskManager + A2A ingestion.
- Socket: `/var/run/css-mcp/hooks.sock` (`OPENCODE_PYTHON_SOCK` override), NDJSON `\n`-delimited, UTF-8.
- Two channels: **socket** (JS↔Py) and **MCP stdio** (OpenCode↔Py).

## Protocol (v0.4 draft — gated by rubber-duck review, do not implement against until gate passes)

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
- Blocking ops fail-closed by default; non-blocking fail-open. `OPENCODE_FAIL_OPEN` is explicit opt-in (`=== "1"`).
- One deadline per rpc; rpcs survive reconnect until their own deadline; circuit breaker (N failed reconnects) rejects pending once.
- Server-side callID dedupe (LRU ~1000, TTL 30s) prevents replay double-apply.
- Bootstrap queue-until-capabilities (hooks before handshake are queued; queue deadline exceeded → fail-closed for blocking ops).
- Push dispatch happens BEFORE orphan matching in the data handler.
- One authority per event: `pre` = tool.execute.before only; `permission` = permission.ask only; `event.pipeline` informational (branch depends on spike verdict).
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

- [running] SPIKE — event-hook await semantics (bgagent `045ec89b`; gates event.pipeline branch)
- [running] SCAFFOLD — uv workspace + `mcps/css-mcp` (bgagent `045ec5ce`)
- [running] JS TRANSPORT HARDENING v2 — C1 ok:false validation, C2a fail-closed default, H1 timer leak, M1 idempotent #onDisconnect, #7 isFinite parse+pre 5s, #8 SHORT_TIMEOUT_MS, #9 end/destroyed guard, #10 dead branch removal, #11 short-id counter, #buf cap (bgagent `045ec0f1`)
- [running] PUBLISHABILITY — package.json, LICENSE, README, git init (bgagent `045e51bf`)
- [pending] Spec v0.4 finalization (spike verdict picks the H2/H3 branch) + rubber-duck re-gate
- [pending] Phase 2 — JS FIX #1–#6 (reply-expectation, deadline retry, server dedupe, #onDisconnect batch semantics, push-before-orphan, maxPending)
- [pending] Phase 3 — shim rewrite: bootstrap handshake + capabilities, permission.ask hook, task authority, config deltas, session.inject consumer (verify `client.session.prompt`/`paste` in installed `@opencode-ai/sdk`)
- [pending] Phase 4 — Py socket server, permission module, TaskManager, MCP tools, A2A ingestion, register css-mcp in `.ai/mcp/mcp.json`

## Known decisions (do not reverse without discussion)

- Option A: Python brain, JS blocking gate.
- Blocking ops fail-closed by default; `OPENCODE_FAIL_OPEN` explicit opt-in.
- `permission.ask` hook is the permission authority (`client.permission.update()` does not exist).
- No plugin API launches subagents → pre-hook authority over `tool==="task"` + Python TaskManager via MCP tools.
- `config` hook mutates only at load → Python supplies config deltas at bootstrap; runtime `config.update` push channel dropped.
- `session.inject` push channel added for live content injection / A2A (new in v0.4).
- GitHub URL plugin loading is an open feature request (opencode#8264/#12378) — npm publish is the supported path.

## Files

- `socket-bridge.js` — the JS plugin (663-line baseline, being hardened)
- `package.json` — npm-publishable plugin metadata (`main: socket-bridge.js`)
- `AGENTS.md` — this file
- `README.md` — user-facing usage (npm / github URL / local symlink)
- `pyproject.toml` — uv virtual workspace, members: `mcps/css-mcp`
- `mcps/css-mcp/src/css_mcp/` — Python package (`config.py`, `logging.py`, `__main__.py`)
- `.ai/mcp/mcp.json` — MCP registration (css-mcp server added in Phase 4)
- `LICENSE` — MIT

## Environment variables

| var | default |
|-----|---------|
| OPENCODE_PYTHON_SOCK | /var/run/css-mcp/hooks.sock |
| OPENCODE_PRE_TIMEOUT | 5000 |
| OPENCODE_POST_TIMEOUT | 8000 |
| OPENCODE_CTX_TIMEOUT | 3000 |
| OPENCODE_PIPELINE_TIMEOUT | 10000 |
| OPENCODE_FAIL_OPEN | unset → fail-closed; "1" → fail open |
| OPENCODE_BRIDGE_DEBUG | unset / "1" |

Python side uses `CSS_MCP_*` equivalents (CSS_MCP_SOCKET, CSS_MCP_PRE_TIMEOUT, CSS_MCP_FAIL_OPEN_BLOCKING, CSS_MCP_DEBUG, …).

## Tech stack / conventions

- Python 3.14, `uv` only (never pip), `msgspec.Struct` (never @dataclass), async-native (asyncio/aiohttp/aiosqlite/aiofiles).
- Type hints everywhere; no Any, no `# type: ignore`, no `# noqa`.
- SQL parameterized only; secrets via env vars only.
- Tests: `uv run --group test pytest`.
- JS: ESM, `node --check` (or `bun build`) to verify.
- Dispatched sub-agents: run `plan-dev_verify()` after changes (ruff + basedpyright); never call `plan-dev_get_work()`/`plan-dev_finished_work()` when dispatched by the planner.
