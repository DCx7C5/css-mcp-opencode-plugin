# Plugins — feature reference

This repo ships **six per-concern plugins** plus a shared transport. Each plugin
registers only its own hook surface; they all import the `transport.js` ESM
singleton, so every plugin in a process shares **one** socket, **one** bootstrap
handshake, and **one** capability gate — loading one plugin or all six is
functionally identical.

| plugin | file | hook surface | authority |
|--------|------|--------------|-----------|
| secrets | `plugins/plugin-secrets.js` | `tool.execute.before`, `permission.ask` | local, always-on `.env` hardblock |
| hooks | `plugins/plugin-hooks.js` | `tool.execute.before` (non-task), `tool.execute.after`, `shell.env` | general tool gate → Python |
| task | `plugins/plugin-task.js` | `tool.execute.before` (task only) | subagent launch gate → Python |
| permission | `plugins/plugin-permission.js` | `permission.ask` | yes/no popups → Python |
| context | `plugins/plugin-context.js` | `experimental.session.compacting`, `event` (context syncs) | context interface → Python |
| events | `plugins/plugin-events.js` | `event` | observer-only forwarding → Python |

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

## plugins/index.js — aggregator (npm/GitHub default)

`package.json` `main`. opencode's legacy loader treats every `server`-shaped
export as a separate plugin, so pointing opencode at this file registers all six
while sharing one transport. Behavior is identical to the per-file entries.

---

## transport.js — shared singleton API

| export | purpose |
|--------|---------|
| `startBridge(input)` | init from a plugin instance (idempotent; sets client, dir, worktree, project; kicks bootstrap) |
| `rpc(op, body, timeoutMs, {wait})` | request/reply RPC through the pool |
| `pushEvent(event)` | debounced fire-and-forget event |
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
(reverse-RPC above). `permissions.update` is informational — permission rules
live in the Python brain, there is nothing to cache JS-side.

## Testing

```bash
npm run check            # node --check every JS file
npm test                 # node --test — plugin unit (inert) + E2E suites
uv run --group test pytest   # scripts/client.py smoke tests
```

- `tests/plugins.inert.test.mjs` — every plugin with **no brain** (must be a
  no-op; secrets must still block).
- `tests/plugins.e2e.test.mjs` — every plugin against `scripts/client.py
  --serve` (bootstrap → RPC path → allow/unchanged semantics).
- `tests/plugins.context-read.test.mjs` — the `session.context.read`
  reverse-RPC (success, client error, malformed, no-client) against a minimal
  `node:net` brain.
