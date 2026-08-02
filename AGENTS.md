# AGENTS.md — css-mcp-opencode-plugin

Agent-facing guide. Read this first when working in this repo.

## What this is

OpenCode ↔ Python bridge. The JS plugins (`plugins/*.js` — including the shared `plugins/transport.js`) form a thin transport between OpenCode and a Python "brain" over a Unix socket (NDJSON). The Python side owns all decisions: permission rules, task management, event classification, content injection. The JS side must be able to **block** OpenCode execution for every event type that can be blocked.

## Goals

1. **Python brain, JS gate** — all decision logic lives in Python; JS is a blocking transport only.
2. **Permission management from Python** — `permission.ask` hook + MCP `permissions_add/update/list` tools; mirror OpenCode semantics (keys `read/edit/glob/grep/bash/task/skill/lsp/question/webfetch/websearch/external_directory/doom_loop`, values `allow|ask|deny`, last-match-wins, `*`/`?` wildcards, per-tool object syntax, `~`/`$HOME` expansion).
3. **Full task-tool authority from Python** — pre-hook gate on `tool==="task"` + in-process async TaskManager exposed via MCP `task_create/list/output/cancel/clear`.
4. **Live content injection** — `session.inject` push channel → JS consumer calls `client.session` API → enables A2A message injection into the active session.
5. **Loadable plugin** — npm-publishable package (`package.json` at root); `github:user/repo` URL loading verified on opencode ≥ 1.18.4 (`opencode plugin github:owner/repo`).

## Architecture

- `plugins/transport.js` (inside `plugins/`, ESM): shared singleton — SocketPool (one shared Unix socket, UUID-multiplexed RPC, reconnect with backoff, circuit breaker), bootstrap handshake / capability gate, `rpc()`/`pushEvent()`, event debouncing, `session.inject` consumer. All plugins import from here; ESM singletons make the socket/capabilities shared no matter how many plugins load.
- `plugins/*.js` (repo root `plugins/`, ESM): per-concern plugins, each a named `server = async ({client, directory, worktree, project}) => hooks`. `plugin-secrets.js` (.env hardblock, local always-on), `plugin-hooks.js` (general pre/post/shell-env), `plugin-task.js` (task/subagent gate), `plugin-permission.js` (permission authority = yes/no popups), `plugin-context.js` (compaction + context syncs), `plugin-events.js` (observer-only event forwarding). `plugins/index.js` re-exports all six — opencode's legacy loader treats each `server`-shaped export as a separate plugin, so one entry loads them all.
- `plugins/index.js` (repo root `plugins/`, ESM): one-entry aggregator — npm/GitHub default (`package.json` `main`); opencode's legacy loader treats each `server`-shaped export as a separate plugin, so one entry loads all six.
- Python brain: **not part of this repo** (the `mcps/css-mcp` package was removed). The socket transport still expects an external server at the resolved socket path; without one the bridge runs **inert** (all hooks proceed — opencode is fully functional) until a brain connects. Test the transport with `scripts/client.py`.
- Socket: `$XDG_RUNTIME_DIR/css-mcp/hooks.sock` → `/tmp/css-mcp/hooks.sock` → legacy `/var/run/css-mcp/hooks.sock` only if it exists (`OPENCODE_PYTHON_SOCK` overrides all), NDJSON `\n`-delimited, UTF-8. The default moved to a user-writable path because an MCP/ACP child process (which may serve the socket) cannot create `/var/run/css-mcp` without root. Lifecycle: the plugin loads before the Python process exists; reconnect-with-backoff + re-bootstrap on every connect takes over authority live.
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

Push channels: `capabilities.update`, `permissions.update`, `session.inject` (live content injection: `{id, sessionID, kind: user|assistant|system, content, metadata}` — FIFO per session, dedupe by id, active-session-only, fail-safe on client API error), `session.context.read` (reverse-RPC: Python pushes `{id, sessionID}`, JS replies `{id, ok, session, messages}`), `task.launch` (reverse-RPC: Python pushes `{id, prompt, agent?, model?, system?, tools?, title?, parentSessionID?, directory?, timeoutMs?}`, JS replicates the `task` tool over the SDK — `session.create` + `session.prompt` — and replies `{id, ok, sessionID, info, parts, text}`; timeout aborts best-effort, first reply wins), `session.intel` (reverse-RPC: Python pushes `{id, sessionID, what?: ["stats","recent","diff","todo"]}`, JS replies bounded `{id, ok, sessionID, stats?, recent?, diff?, todo?}`), `session.summarize` (reverse-RPC: Python pushes `{id, sessionID, model?}`, JS kicks off `client.session.summarize` and replies `{id, ok, sessionID, started}`), `permission.answer` (reverse-RPC: Python pushes `{id, permissionID, sessionID?, response: once|always|reject, directory?}`, JS calls `client.postSessionIdPermissionsPermissionId` and replies `{id, ok, permissionID, response}` — pairs with the `permission.asked` event, which now ships the permission `id`).

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
- `task.launch` consumer: the SDK has NO `tool.execute`/`tool.call` — a plugin cannot invoke the `task` tool directly. But the task tool itself is "create a child session + prompt it with the target agent", so transport.js replicates it with `client.session.create` (body `{parentID, title}`) + `client.session.prompt` (body `{parts:[text], agent, model, system, tools}`), which blocks until the run finishes and returns `{info: AssistantMessage, parts: Part[]}`; `text` = last text part (mirrors task tool output extraction). First reply wins; `timeoutMs` (default 0 = wait forever) replies `{code:"timeout", sessionID}` and best-effort aborts via `client.session.abort`. The task-gate `pre` RPC carries best-effort `available_agents` (`client.app.agents()` — validates the requested agent) and `tool_ids` (`client.tool.ids()`; `client.tool.list()` needs a provider/model the gate cannot resolve). Other SDK surfaces the brain can exploit: `client.session.abort/todo/command/shell/summarize/diff`, `client.tool.list/ids`, `client.config.get`, `client.postSessionIdPermissionsPermissionId` (auto-answer pending permission asks — pairs with our `permission.asked` event forwarding, which now ships the permission `id`).
- Compaction handshake: the `experimental.session.compacting` hook now ships bounded session intel to the brain in the `context` RPC body (`session: {stats, recent, diff, todo}` via `sessionIntel()`), so the brain sees exactly what is about to be summarized before it replies `{prompt}` (replace the compaction prompt), `{context}` (inject items that survive), or nothing (default). Bounds: `recent` = last 20 text parts capped at 12k chars — never ships the full dump over the socket (the LLM summarizer already has it); use `session.context.read` for the full list. Per-item fail-safe: a broken SDK surface yields `null`/`""` without failing the hook.
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
- [done] MULTI-PLUGIN SPLIT — the monolithic bridge was divided into per-concern plugins sharing one `transport.js` singleton (SocketPool/bootstrap/caps/rpc/debouncer/injector). `plugins/` (no package.json → per-file entries resolve exactly): `plugin-secrets.js` (local always-on .env hardblock, runs before the Python gate), `plugin-hooks.js` (general pre/post/shell-env), `plugin-task.js` (subagent-launch gate), `plugin-permission.js` (permission authority = yes/no popups), `plugin-context.js` (compaction + context syncs), `plugin-events.js` (observer forwarding). `plugins/index.js` = one-entry aggregator and npm/GitHub default (`main`); the old combined `socket-bridge.js` was deleted as redundant. Default socket path moved to `$XDG_RUNTIME_DIR/css-mcp/hooks.sock` (user-writable — an MCP/ACP child process cannot create `/var/run/css-mcp`), legacy `/var/run` kept only if it exists.
- [done] CONTEXT READING + PLUGIN TESTS — reverse-RPC `session.context.read` push (Python pushes `{id, sessionID}`, JS replies session+messages; fail-safe on client error), `pool.reply()`, `closeBridge()` + `#closed` guards + `EventDebouncer.clear()` for clean test shutdown; `PLUGINS.md` per-plugin reference; README `opencode.json` entries section + PLUGINS.md link; `npm test` (60 tests: inert / E2E vs `client.py --serve` / context-read / lost-brain fail-closed+fail-open / inject / capabilities / task-launch / session-intel / event-completeness / permission-answer vs `node:net` brains).
- [done] HARDENING — `.env` bash bypass fixed (path-boundary `/` added to the token regex; `.env_backup` and full-path reads now blocked, `.env.example*` and `os.environ` still allowed); dead `runtimeConfig` removed (no JS consumer); `startBootstrap()` hardened with a `.catch` so a future rpc rejection cannot stick `bootstrapInFlight` (would block every hook forever); `session.inject` now forwards optional A2A turn knobs (`messageID`/`model`/`agent`/`system`/`tools`) to `promptAsync`; test subprocess brains spawn detached + group-kill (`uv run` does not forward SIGINT); pyproject version aligned to 0.2.0; README warns against loading aggregator + per-file entries together (double hooks → double `pre` RPCs).
- [done] TASK LAUNCH — reverse-RPC `task.launch` push channel: the SDK exposes no `tool.execute`, but the `task` tool is just "create a child session + prompt it with the target agent", so transport.js replicates it (`client.session.create` + blocking `client.session.prompt` with `agent`/`model`/`system`/`tools`) and replies `{id, ok, sessionID, info, parts, text}`. Enables an MCP brain to expose a native tool wrapping `task`. Per-request knobs: `prompt` (required), `agent`, `model`, `system`, `tools`, `title`, `parentSessionID`, `directory`, `timeoutMs` (0 = wait forever; on expiry replies `{code:"timeout", sessionID}` and best-effort aborts via `client.session.abort`). First reply wins. 37 JS tests green.
- [done] SESSION INTEL + COMPACTION HANDSHAKE — reverse-RPC `session.intel` (bounded `stats`/`recent`/`diff`/`todo` reads, per-item fail-safe) and `session.summarize` (force a compaction summarization with optional model override) via `client.session.messages/diff/todo/summarize`; the `experimental.session.compacting` hook now ships that intel in the `context` RPC body (`session: {stats, recent, diff, todo}`) so the Python brain sees exactly what is about to be summarized before deciding `{prompt}`/`{context}`/default. Bounds: recent = last 20 text parts capped at 12k chars. 45 JS tests green.
- [done] COMPLETE EVENT FORWARDING — TRACKED_EVENTS now covers the full SDK `Event` union (added server.instance.disposed, installation.update-available, permission.updated, vcs.branch.updated, pty.*); hookable events fall back to the debounced fire-and-forget `event` RPC when the brain lacks the `eventPipeline` capability (never dropped); `pool.stats()` introspection. Verified: every SDK event type forwarded, fire-and-forget leaves zero pending RPCs. 51 JS tests green.
- [done] PERMISSION.ANSWER + TASK-GATE ENRICHMENT — reverse-RPC `permission.answer` (`response: once|always|reject` → `client.postSessionIdPermissionsPermissionId`, replies `{id, ok, permissionID, response}`); the `permission.asked` event now ships the permission `id` so Python can correlate. The task-gate `pre` RPC body now carries best-effort `available_agents` (`client.app.agents()`) + `tool_ids` (`client.tool.ids()`), both time-bounded and fail-safe to `null`. 60 JS tests green.
- Note: the Python brain (socket server, permission module, TaskManager, MCP tools, A2A ingestion) is **out of repo scope** — implement it externally or as a separate project. It may serve BOTH the MCP stdio channel and the Unix socket from one process (two asyncio tasks, shared in-memory state).

## Known decisions (do not reverse without discussion)

- Option A: Python brain, JS blocking gate.
- Blocking ops fail-closed only after a brain ever connected; never-connected → inert (all hooks proceed). `OPENCODE_FAIL_OPEN` explicit opt-in for the lost-brain case.
- `permission.ask` hook is the permission authority (`client.permission.update()` does not exist).
- Default socket path is user-writable (`$XDG_RUNTIME_DIR`/`/tmp`) so an MCP/ACP child process can serve it; `/var/run/css-mcp` is kept only if it already exists. `OPENCODE_PYTHON_SOCK` overrides all.
- `.env` hardblock is a LOCAL always-on invariant (never Python-gated) — the one deliberate exception to "Python owns all decisions".
- No plugin API launches subagents directly (no `tool.execute` in the SDK) → `task.launch` reverse-RPC replicates the `task` tool (create + prompt with agent); the pre-hook gate keeps authority over model-initiated `tool==="task"` calls (Python-side TaskManager tools are out of repo scope).
- `config` hook mutates only at load → Python supplies config deltas at bootstrap; runtime `config.update` push channel dropped.
- `session.inject` push channel added for live content injection / A2A (new in v0.4).
- GitHub URL plugin loading **verified working** on opencode ≥ 1.18.4: `opencode plugin github:owner/repo` installs from the repo (bun snapshot into `~/.cache/opencode/packages/`), detects the `server` target, and updates the project config. npm publish remains the alternative for versioned distribution.

## Files

- `plugins/transport.js` — shared singleton: SocketPool, bootstrap/capability gate, rpc, debouncer, session.inject consumer
- `plugins/` — six per-concern plugins + `index.js` aggregator (no package.json here on purpose: per-file plugin entries resolve to the exact file; `index.js` is the npm/GitHub default)
- `PLUGINS.md` — per-plugin feature reference (hooks, capabilities, reply contracts, push channels)
- `tests/` — JS test suites (inert / E2E / context-read), run via `npm test`
- `package.json` — npm-publishable plugin metadata (`main: plugins/index.js`)
- `AGENTS.md` — this file
- `README.md` — user-facing usage (npm / github URL / local symlink)
- `pyproject.toml` — plain Python project (no workspace): `msgspec` dep for `scripts/client.py` + `test` dependency group (pytest/ruff)
- `scripts/client.py` — NDJSON bridge test client (v0.4 protocol) with `--serve` mode as the minimal test brain
- `.ai/mcp/mcp.json` — project-local MCP registration
- `LICENSE` — MIT

## Environment variables

| var | default |
|-----|---------|
| OPENCODE_PYTHON_SOCK | $XDG_RUNTIME_DIR/css-mcp/hooks.sock (or /tmp/css-mcp/hooks.sock) |
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
- The config **ships with all six per-plugin entries active** (see below). With no Python brain running the bridge is inert (harmless) — but the `.env` hardblock (`plugin-secrets.js`) still applies locally, so decide consciously before keeping it enabled.
- To test, point `.opencode/opencode.json` at the plugins and **restart opencode** (config is load-only, not hot-reloaded):

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

  Paths are relative to `.opencode/`. `plugins/` has no `package.json`, so each entry resolves to the exact file (a repo-root package.json `main` would otherwise win). Secrets first → the local hardblock runs before the Python gate. `plugins/index.js` loads all six from one entry and is the npm/GitHub default.
- Loading without a brain is now **safe and inert** — opencode runs normally; no `OPENCODE_FAIL_OPEN` needed. It only matters once a brain has connected and is lost (fail-closed default).
- **Automated JS tests** (no brain needed): `npm test` runs `node --test "tests/*.test.mjs"` — the inert suite (every plugin no-brain no-op; secrets still blocks), the E2E suite (every plugin against `scripts/client.py --serve` on a temp socket), the context-read suite (reverse-RPC against a minimal `node:net` brain), the lost-brain suites (`plugins.failclosed.test.mjs` / `plugins.failopen.test.mjs` — brain connects then dies; fail-closed throws/denies fast via the circuit breaker, `OPENCODE_FAIL_OPEN=1` opts out), the inject suite (FIFO/dedupe/fail-safe + A2A knob forwarding), the capabilities suite (live `capabilities.update` re-apply/revoke), the task-launch suite (`plugins.task.test.mjs` — create + prompt call shapes, result/error/timeout paths, gate-enrichment bodies), the session-intel suite (`plugins.session.test.mjs` — intel reads, forced summarize, compaction-handshake RPC body), the event-completeness suite (`plugins.events.test.mjs` — every SDK event type, pipeline fallback, zero pending), and the permission-answer suite (`plugins.permission-answer.test.mjs` — once/always/reject paths + permission `id` correlation). Use `npm run check` for `node --check`. Subprocess brains are spawned `detached` and killed as a process group (`kill(-pid)`), since `uv run` does not forward SIGINT to the python child.
- `scripts/client.py --serve` is the minimal test brain: it listens on the socket (default `$XDG_RUNTIME_DIR/css-mcp/hooks.sock` or `/tmp/css-mcp/hooks.sock`, or `--socket`), replies to every op (never to `event`), and never denies `pre`/`permission`. Use `--push-channel <ch>` to broadcast a test push every `--push-interval` seconds (default 5). Ctrl-C exits with code 130 and removes the socket.

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