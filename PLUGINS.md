# Plugins — feature reference

This repo ships **seven per-concern plugins** plus a shared transport. Each plugin
registers only its own hook surface; they all import the `plugins/transport.js` ESM
singleton, so every plugin in a process shares **one** socket, **one** bootstrap
handshake, and **one** capability gate — loading one plugin or all seven is
functionally identical.

| plugin | file | hook surface | authority |
|--------|------|--------------|-----------|
| secrets | `plugins/plugin-secrets.js` | `tool.execute.before`, `permission.ask` | local, always-on `.env` hardblock |
| hooks | `plugins/plugin-hooks.js` | `tool.execute.before` (non-task), `tool.execute.after`, `shell.env` | general tool gate → Python |
| task | `plugins/plugin-task.js` | `tool.execute.before` (task only) | subagent launch gate → Python |
| permission | `plugins/plugin-permission.js` | `permission.ask` | yes/no popups → Python |
| context | `plugins/plugin-context.js` | `experimental.session.compacting`, `event` (context syncs) | context interface → Python |
| events | `plugins/plugin-events.js` | `event` | observer-only forwarding → Python |
| signals | `plugins/plugin-signals.js` | `event` | pattern detector → Python `signal` |

---

## Wire protocol — per-plugin prefixes

Every JS→Py line on the socket MAY carry the owning plugin's letter followed by
a `:` before the JSON payload; the Python brain strips it before decoding.
Py→JS lines (bootstrap/config replies, `capabilities.update` pushes, reverse-RPC
replies) are always plain JSON — the prefix exists so the *server* knows which
plugin a hook line came from, which it cannot tell from the JSON alone.

| letter | plugin | emits |
|--------|--------|-------|
| `h:` | plugin-hooks | `pre`, `post`, `shell-env`, its own `event` lines |
| `t:` | plugin-task | `pre` (task gate), its own `event` lines |
| `p:` | plugin-permission | `permission`, its own `event` lines |
| `c:` | plugin-context | `context` (compacting + context syncs) |
| `e:` | plugin-events | `event.pipeline`, fire-and-forget `event` |
| `e:` | plugin-signals | `signal` (rare, action-request RPC) |
| `s:` | plugin-secrets | **never** — the hardblock is local-only, no socket bytes |

Bridge-level ops (`bootstrap`, `config`) and every Py→JS line are unprefixed.

**Reverse-RPC replies carry the prefix too** (`REPLY_PREFIX` in transport.js):
`session.context.read`, `session.intel`, `session.summarize` reply with `c:`;
`task.launch` replies with `t:`; `permission.answer` replies with `p:`. A Python
brain that routes replies back by `id` only needs to strip `^[ecpths]:` from
every line it reads (reference: `scripts/client.py` `strip_plugin_prefix`).

---

## plugin-secrets.js — `.env` hardblock (LOCAL invariant)

The one deliberate exception to "Python owns all decisions": secret files are
never exposed to the model, **even when no brain is connected**. It runs before
the Python gate (list it first in `opencode.json`) and never consults Python,
never waits on bootstrap, and is not capability-gated.

Features:

- Blocks **file tools** (`read`, `edit`, `write`, `glob`, `grep`, `list`) whose
  args name a protected file: basenames matching `.env`, `.env.*`, or their glob
  forms (`.env*`), with `~` expansion and quote stripping.
- Blocks **bash** commands containing a `.env` token (`cat .env`, `curl .env.local`,
  `source .env`, …) — token-based, word-bounded.
- Denies **`permission.ask`** prompts that name protected files, even when the
  permission system (not a tool arg) is the access path.
- Allows `.env.example` / `.env.example.*` — example files are meant to be shared.
- Blocks by **throwing** in `tool.execute.before` (opencode aborts the tool) and
  by `output.status = "deny"` in `permission.ask`.

---

## plugin-hooks.js — general hook interface

The wire that connects opencode's generic hooks to the Python brain. Owns every
tool **except** `task` (plugin-task.js owns those), so exactly one `pre` RPC
fires per tool invocation.

| hook | capability | Python op | blocking |
|------|-----------|-----------|----------|
| `tool.execute.before` | `pre` | `pre` | yes (throw to block) |
| `tool.execute.after` | `post` | `post` | no |
| `shell.env` | `shellEnv` | `shell-env` | no |

`pre` reply contract (`{ok:true, ...}`): `{allow:false, reason}` blocks;
`{args:{...}}` mutates tool args (merged over the originals). On a lost brain
the hook **throws** (fail-closed) unless `OPENCODE_FAIL_OPEN=1`.

`post` reply contract: `{title}`, `{output}`, `{metadata:{...}}` replace/merge
the corresponding output fields. `shell-env` reply: `{env:{...}}` merged into
`output.env`.

---

## plugin-task.js — subagent launch gate

opencode has no plugin API that launches subagents, so the `pre`-hook gate on
`tool === "task"` is the only place Python's TaskManager rules can interpose.

- Returns immediately for every non-task tool (delegates to plugin-hooks.js).
- Surfaces the subagent fields **explicitly** so Python decides without
  re-parsing opaque args:

  ```json
  { "op": "pre", "body": { "tool": "task", "task": {
      "prompt": "...", "description": "...", "agent": "general", "model": "..." } } }
  ```

- **Gate enrichment:** the `pre` body also carries best-effort introspection
  so Python can validate the request against what actually exists:
  `available_agents` (`client.app.agents()` — `{name, description, mode,
  builtIn, model}` per agent) and `tool_ids` (`client.tool.ids()` — every
  registered tool, confirming `task` is available). Both are time-bounded
  (~350ms each, parallel) and fail-safe to `null` — the gate never blocks on
  discovery (`client.tool.list()` needs a provider/model the gate cannot
  resolve, so `ids()` stands in for schema checks).
- Same fail-closed semantics as the general gate; supports `{args}` mutation
  and `{allow:false}` denial.

---

## plugin-permission.js — permission authority (human-in-the-chain)

The yes/no popups (TUI, IDE integrations like PyCharm, web) **are** the
`permission.ask` hook: opencode shows the prompt when the hook leaves
`output.status` as `"ask"`.

| hook | capability | Python op | blocking |
|------|-----------|-----------|----------|
| `permission.ask` | `permission` | `permission` | yes (sets status) |

Reply contract (`{ok:true, ...}`): `{status:"allow"|"ask"|"deny"}` (v0.4), with
backwards-compat `{allow:bool}` from the minimal test brain. On a lost brain the
hook **denies** (fail-closed) unless `OPENCODE_FAIL_OPEN=1`; with no brain ever
connected it leaves the default ask flow. Python drives richer flows by pushing
a `user`-kind part via `session.inject` (the human's answer resumes the chain).

Every `permission.asked` event carries the permission **`id`** (plus
`sessionID`, `callID`, `type`, `pattern`, `title`) so Python can correlate a
pending prompt with a later programmatic settlement:

```json
{ "type": "push", "channel": "permission.answer", "body": {
  "id": "…", "permissionID": "…", "sessionID": "…",
  "response": "once|always|reject", "directory": "…" } }
```

transport.js calls `client.postSessionIdPermissionsPermissionId` (the same
endpoint the popup buttons hit) and replies `{id, ok, permissionID, response}`.
This lets Python auto-approve/deny prompts it already ruled on (e.g. from
rules) without flashing a popup. `response` follows the SDK semantics;
anything else replies `{ok:false, error:{code:"invalid_request"}}`.

---

## plugin-context.js — context interface

| hook | capability | Python op | blocking |
|------|-----------|-----------|----------|
| `experimental.session.compacting` | `context` | `context` | no |
| `event` (context triggers only) | `context` | `context` (fire-and-forget) | no |

Compacting reply contract: `{prompt:"…"}` replaces the compaction prompt;
`{context:[…]|"…"}` injects items into `output.context`.

**Context reading (reverse-RPC):** Python can request the current session
context at any time by pushing:

```json
{ "type": "push", "channel": "session.context.read", "body": { "id": "…", "sessionID": "…" } }
```

transport.js fetches `client.session.get` + `client.session.messages` and
replies over the socket (a normal `{id, ok, session, messages}` response):
`session` is the `Session`, `messages` is the `Message[]` the model actually
saw. Use it to diff context before deciding what to inject. Fail-safe: any
client error (or no active client) replies `{ok:false, error:{code, message}}`.

`session.inject` accepts optional A2A turn knobs in the push body —
`messageID`, `model`, `agent`, `system`, `tools` — which transport.js forwards
into the `promptAsync` body so the Python brain can steer the injected turn
(target model/agent, custom system prompt, allowed tools).

**Task launch (reverse-RPC):** Python can spawn a subagent at any time —
the bridge replicates the opencode `task` tool over the SDK (the SDK exposes
no `tool.execute`, but the task tool itself is just "create a child session +
prompt it with the target agent"):

```json
{ "type": "push", "channel": "task.launch", "body": {
  "id": "…", "prompt": "…",
  "agent": "…", "model": { "providerID": "…", "modelID": "…" },
  "system": "…", "tools": { "bash": true },
  "title": "…", "parentSessionID": "…", "directory": "…",
  "timeoutMs": 0
} }
```

transport.js runs `client.session.create` (body `{parentID, title}`) then
`client.session.prompt` (body `{parts:[text], agent, model, system, tools}`),
which blocks until the run finishes, and replies:

```json
{ "id": "…", "ok": true, "sessionID": "…", "info": { "…": "…" }, "parts": [ "…" ], "text": "…" }
```

`text` is the last text part (mirrors the task tool's output extraction), so
an MCP brain can expose a native `task_run`-style tool that wraps `task`.
All knobs are optional except `prompt`; `timeoutMs` (default 0 = wait
forever) replies `{ok:false, error:{code:"timeout", sessionID}}` and aborts
the session best-effort via `client.session.abort`. First reply wins — a
timeout reply is never followed by a late result reply.

**Session intel (reverse-RPC):** bounded reads of the session state, either
on demand or as the compaction handshake:

```json
{ "type": "push", "channel": "session.intel", "body": { "id": "…", "sessionID": "…", "what": ["stats", "recent", "diff", "todo"] } }
```

transport.js replies `{id, ok, sessionID, stats?, recent?, diff?, todo?}`:
- `stats` — `{total, byRole, lastUpdated}` (message count / role split / last activity)
- `recent` — the last 20 text parts, each trimmed, joined and capped at
  12k chars — the shape, never the full dump (use `session.context.read`
  for the full message list)
- `diff` — `FileDiff[]` (`{file, before, after, additions, deletions}`)
- `todo` — `Todo[]` (`{id, content, status, priority}`)

Every item is fail-safe: a broken SDK surface yields `null`/`""` without
failing the request.

**Forced summarization (reverse-RPC):** the brain can kick off a compaction
summarization on demand:

```json
{ "type": "push", "channel": "session.summarize", "body": { "id": "…", "sessionID": "…", "model": { "providerID": "…", "modelID": "…" } } }
```

replies `{id, ok, sessionID, started: true}` — the summarizer runs async in
opencode, so this only starts it (use `session.intel` / event forwarding to
watch for `session.compacted`).

**Compaction handshake:** when opencode's context window is full and
`experimental.session.compacting` fires, plugin-context.js fetches that same
bounded intel (`session: {stats, recent, diff, todo}`) and includes it in
the `context` RPC body before asking the brain for the compaction decision.
The brain replies exactly as before — `{prompt}` replaces the entire
compaction prompt, `{context}` injects items that survive the compaction,
nothing uses opencode's default — but now it can base the decision on what
is actually being summarized (e.g. persist the live todo list into
`context` so it survives, or craft a diff-aware continuation prompt).

---

## plugin-events.js — observer-only event forwarding

Subscribes to the opencode event bus. Pure observer: no blocking, no mutation —
the host never awaits event hooks (H3 spike verdict), so thrown errors are
swallowed by the host anyway; this plugin never throws.

- **Hookable events** (session lifecycle, file edits, todo updates, tool
  execute, permission ask/reply) → `event.pipeline` RPC when the `eventPipeline`
  capability is registered. Informational only — the result never blocks.
- **All other tracked events** → debounced fire-and-forget `event` RPCs
  (50ms window, max batch 20).
- **Context-trigger events** additionally get a context sync from
  plugin-context.js's own event hook (both hooks run in sequence — not
  duplicated here).

Tracked event list lives in `transport.js` (`TRACKED_EVENTS` +
`type.startsWith("session.")`); context triggers in `CONTEXT_TRIGGER_EVENTS`.

---

## plugin-signals.js — structured-error detector

Watches the same event bus locally and emits one `signal` RPC when the provider
layer raises a configured typed error. Detection stays in the plugin (the error
object is already in the JS process); all action logic stays in Python. This is
distinct from `plugin-events.js`: events are fire-and-forget observation, a
signal is a rare action request.

Detection is **structured only** — `event.error.type`, never a substring of
event text. Assistant text (`session.text.ended`), toasts (`tui.toast.show`),
user prompts and injected context can quote the error sentence verbatim; a text
match would fire a reconnect on the client frontend's own words.

Watched surfaces (the only two that carry `error`):

| event | matcher |
|-------|---------|
| `session.step.failed` | `error.type` |
| `session.execution.failed` | `error.type` |

Configured signal:

```json
{ "id": "free_messages_exhausted", "errorTypes": ["provider.free-limit"] }
```

A bare `status: 429` is **not** a trigger: the provider layer already
classifies the body, and a 429 from another cause must not borrow this
signal's reconnect action. The cooldown is **one minute per signal/session**; the Python action registry keeps
the authoritative global cooldown, so a plugin reload or a second connection
cannot re-trigger the action. One minute, not ten: after a reconnect that left a
pre-reconnect TCP flow alive, the only useful retry window is the ~30 s that
flow needs to idle out.

Wire body (`e:signal`, sent with `wait:false` — the event loop never waits for
the brain):

```json
{ "signal": "free_messages_exhausted", "sessionID": "…", "messageID": "…",
  "matched": "…", "excerpt": "…≤500 chars…", "at": 1730000000000, "directory": "…",
  "pid": 48213 }
```

`pid` is the opencode process (`process.pid`). The brain measures that process's
live public flows with `psutil` before and after a WAN reconnect, so it can prove
the new address is actually in use; the socket list cannot come from the plugin,
because Bun keeps its fetch pool internal.

Python replies `{accepted: boolean, signal, action?, dispatched?, deduped?, reason?}`.
An older brain without the op replies `ok:false` (unknown op); the plugin logs it
at debug and continues forwarding events.

---

## plugins/index.js — aggregator (npm/GitHub default)

`package.json` `main`. The default export is a single opencode v2 plugin
definition (`{ id: "css-mcp-opencode-plugin", setup(ctx) }`) that registers all
seven concerns through `opencode-v2.js` (v1-hook → v2-domain-hook adapter) while
sharing one transport. The named `server` re-exports are kept for opencode 1.x
and direct imports. Behavior is identical to the per-file entries.

---

## plugins/transport.js — shared singleton API

| export | purpose |
|--------|---------|
| `startBridge(input)` | init from a plugin instance (idempotent; sets client, dir, worktree, project; kicks bootstrap) |
| `rpc(op, body, timeoutMs, {wait, prefix})` | request/reply RPC through the pool (`prefix` = wire letter `h/t/p/c/e`) |
| `pushEvent(event, prefix)` | debounced fire-and-forget event (batch keyed per prefix) |
| `PLUGIN_PREFIX` | `{hooks:"h", task:"t", permission:"p", context:"c", events:"e", secrets:"s"}` |
| `REPLY_PREFIX` | reverse-RPC reply letters: `session.context.read`/`session.intel`/`session.summarize` → `c`, `task.launch` → `t`, `permission.answer` → `p` |
| `okReply(msg)` | normalize a reply (`{ok:true}` only) |
| `gateBlocking(capKey)` | gate a blocking op → `rpc`/`skip`/`inert`/`failed` |
| `gateNonBlocking(capKey)` | gate a non-blocking op → boolean |
| `warnInert()` | one-time "no brain ever connected" warning |
| `FAIL_OPEN` | `OPENCODE_FAIL_OPEN === "1"` |
| `directory()` / `worktree()` / `project()` | bridge input context |
| `timeouts` | per-op timeout presets |
| `debugEnabled()` | `OPENCODE_BRIDGE_DEBUG === "1"` |
| `isTrackedEvent()` / `isHookableEvent()` / `isContextTriggerEvent()` | event classification |
| `closeBridge()` | shutdown (tests / unload): closes pool + cancels debounces |

Push channels consumed by transport.js: `capabilities.update` (live cap
re-apply + config), `session.inject` (live content injection via
`client.session.promptAsync`, FIFO/dedupe/fail-safe), `session.context.read`
(reverse-RPC above), `task.launch` (reverse-RPC above), `session.intel` and
`session.summarize` (reverse-RPCs above), `permission.answer` (reverse-RPC
above). `permissions.update` is informational — permission rules live in the
Python brain, there is nothing to cache JS-side.

---

## Response reference — every reply payload and type

All socket replies share one envelope (see the prefix note above: reverse-RPC
replies additionally carry `c:`/`t:`/`p:`):

- OK: `{id: string, ok: true, ...payload}`
- Error: `{id: string, ok: false, error: {code: string, message: string, sessionID?: string}}`

### Hook RPC replies (Py→JS, server → plugin)

| op | `ok:true` payload | types | error handling |
|----|-------------------|-------|----------------|
| `bootstrap` | `{capabilities: {pre, post, shellEnv, context, eventPipeline: boolean}}` | booleans | handshake failure → inert (never-connected) or fail-closed (lost brain) |
| `config` | `{config?: object}` | arbitrary config deltas | fail-open at load; deltas applied to the mutable runtime config |
| `pre` | `{}` proceed · `{allow: false, reason: string}` block · `{args: object}` mutate | `reason` string, `args` merged over originals | error reply → hook throws (tool blocked); lost brain → throws |
| `permission` | `{status: "allow" \| "ask" \| "deny"}` (v0.4) · `{allow: boolean}` (back-compat) | string enum / boolean | error reply → `deny` (fail-closed); lost brain → `deny` |
| `post` | `{title?: string, output?: string, metadata?: object}` | merged into output fields | non-blocking, errors swallowed |
| `shell-env` | `{env: {[key: string]: string}}` | merged into `output.env` | non-blocking, errors swallowed |
| `context` | `{}` default · `{prompt: string}` replace · `{context: string \| object[]}` inject | compaction decision | non-blocking, default used on error |
| `event.pipeline` | `{}` informational | — | host never awaits; errors swallowed |
| `event` | **no reply** (fire-and-forget) | — | server must not reply to NO_REPLY ops |
| `signal` | `{accepted: boolean, signal: string, action?: string, dispatched?: boolean, deduped?: boolean, reason?: string}` | action registry result | non-blocking (sent `wait:false`); unknown signal name → `accepted:false` |

### Reverse-RPC replies (JS→Py, prefixed `c:`/`t:`/`p:`)

| channel | `ok:true` payload | types | error codes |
|---------|-------------------|-------|-------------|
| `session.context.read` | `{session: Session, messages: Message[]}` | SDK `Session`, `Message[]` | `no_client`, `client_error` |
| `task.launch` | `{sessionID: string, info: AssistantMessage, parts: Part[], text: string}` | `text` = last text part | `no_client`, `invalid_request`, `client_error`, `timeout` |
| `session.intel` | `{sessionID: string, stats?, recent?, diff?, todo?}` | per-`what` filter | `no_client` |
| `session.summarize` | `{sessionID: string, started: true}` | boolean `started` | `no_client`, `client_error` |
| `permission.answer` | `{permissionID: string, response: "once" \| "always" \| "reject"}` | echo of the push body | `invalid_request`, `no_client`, `client_error` |

### `session.intel` payload types

| field | type | meaning |
|-------|------|---------|
| `stats` | `{total: number, byRole: {[role: string]: number}, lastUpdated: string}` | message count / role split / last activity |
| `recent` | `string` | last 20 text parts, trimmed, joined, capped at 12k chars |
| `diff` | `FileDiff[]` — `{file: string, before: string, after: string, additions: number, deletions: number}` | working-tree diff |
| `todo` | `Todo[]` — `{id: string, content: string, status: string, priority: string}` | opencode todo list |

### Error codes (reverse-RPC)

| code | when |
|------|------|
| `no_client` | bridge not initialized or no active SDK client — nothing to act on |
| `invalid_request` | malformed push body (e.g. `task.launch` without a non-empty `prompt`, `permission.answer` missing `permissionID` or with an unknown `response`) |
| `client_error` | an SDK call failed; `sessionID` included when the session was created/known |
| `timeout` | `task.launch` exceeded `timeoutMs`; `sessionID` included, session aborted best-effort, first reply wins |

## Testing

```bash
npm run check            # node --check every JS file
npm test                 # node --test — plugin unit (inert) + E2E suites
uv run --group test pytest   # scripts/client.py smoke tests
```

- `tests/plugins.inert.test.mjs` — every plugin with **no brain** (must be a
  no-op; secrets must still block, including path/var `.env` shapes).
- `tests/plugins.e2e.test.mjs` — every plugin against `scripts/client.py
  --serve` (bootstrap → RPC path → allow/unchanged semantics).
- `tests/plugins.context-read.test.mjs` — the `session.context.read`
  reverse-RPC (success, client error, malformed, no-client) against a minimal
  `node:net` brain.
- `tests/plugins.failclosed.test.mjs` / `tests/plugins.failopen.test.mjs` —
  a brain connects then dies: `pre` throws / `permission` denies fast
  (fail-closed, circuit breaker) and `OPENCODE_FAIL_OPEN=1` opts out.
- `tests/plugins.inject.test.mjs` — `session.inject` FIFO + dedupe +
  fail-safe + A2A knob forwarding.
- `tests/plugins.capabilities.test.mjs` — `capabilities.update` live
  enable/revoke of a hook capability.
- `tests/plugins.task.test.mjs` — `task.launch` reverse-RPC: create + prompt
  call shapes, result extraction, error / invalid / timeout / no-client
  paths, malformed body ignored; task-gate `pre` body enrichment
  (`available_agents` / `tool_ids`, fail-safe introspection).
- `tests/plugins.permission-answer.test.mjs` — `permission.answer`
  reverse-RPC (once/always/reject, invalid response, missing permissionID,
  client error, no-client) and the `permission.asked` event shipping the
  permission `id`.
- `tests/plugins.events.test.mjs` — event-forwarding completeness: every
  SDK `Event` union type tracked, pipeline-capability fallback to
  fire-and-forget, untracked ignored, zero pending RPCs left behind.
- `tests/plugins.session.test.mjs` — `session.intel` reads (stats/recent/
  diff/todo, `what` filter, per-item fail-safe), `session.summarize`
  kick-off + model override, and the compaction-handshake `context` RPC body.
- `tests/plugins.prefix.test.mjs` — raw-line wire assertions: every plugin
  emits its owning letter prefix (`h`/`t`/`p`/`c`/`e`), `bootstrap`/`config`
  stay unprefixed, and reverse-RPC replies carry `c:`/`t:`/`p:`.
- `tests/plugins.signals.test.mjs` — pattern detection on assistant text,
  provider errors, TUI toasts, and completed text parts (`properties` and
  durable `data`); synthetic/streaming parts ignored; 1-minute per-session
  cooldown; `e:signal` body shape and reply handling.
- `tests/test_client.py` — `strip_plugin_prefix` unit tests (serve/stream
  decode paths in `scripts/client.py`).
