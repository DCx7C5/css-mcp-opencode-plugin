/**
 * css-mcp shared transport — raw NDJSON over a Unix socket.
 *
 * This module is the SINGLE shared instance for every plugin in this repo.
 * It owns the socket connection pool, the bootstrap handshake / capability
 * gate, the rpc() wrapper, the event debouncer, and the push consumers
 * (`capabilities.update`, `session.inject`, `session.context.read`,
 * `task.launch`, `session.intel`, `session.summarize`). Per-concern plugins
 * in `plugins/` import from here and register only their own hooks. Because
 * ESM modules are singletons within one opencode process, all plugins share
 * one socket and one capability declaration no matter how many of them are
 * loaded.
 *
 * Lifecycle note (IDE → opencode → MCP/ACP server): the plugin loads before
 * the Python process that serves the socket exists. The pool reconnects with
 * exponential backoff forever and re-runs the bootstrap handshake on every
 * successful connect (`pool.onConnect = startBootstrap`), so when the Python
 * process (which may be the MCP stdio server — see README) finally creates
 * the socket, the bridge connects and takes over authority live. No restart.
 *
 * Socket path resolution (must be writable by the serving process, which
 * runs as the user): OPENCODE_PYTHON_SOCK wins; else $XDG_RUNTIME_DIR/
 * css-mcp/hooks.sock; else /tmp/css-mcp/hooks.sock; else the legacy
 * /var/run/css-mcp/hooks.sock ONLY if it already exists (requires root to
 * create — not usable by an MCP/ACP child process).
 */

import net from "node:net"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"

// ── config ────────────────────────────────────────────────────────────

const LEGACY_SOCKET = "/var/run/css-mcp/hooks.sock"

const defaultSocketPath = () => {
    const override = process.env.OPENCODE_PYTHON_SOCK
    if (override) return override
    const runtimeDir = process.env.XDG_RUNTIME_DIR
    if (runtimeDir) return `${runtimeDir}/css-mcp/hooks.sock`
    return "/tmp/css-mcp/hooks.sock"
}

const SOCKET_PATH = (() => {
    const next = defaultSocketPath()
    if (next.startsWith("/var/run/")) {
        // Legacy path requires root to create; keep it only if it already
        // exists (someone provisioned it) — otherwise fall back to the
        // user-writable default so an MCP/ACP child process can serve it.
        return existsSync(LEGACY_SOCKET) ? LEGACY_SOCKET : next
    }
    return next
})()

const parseTimeout = (env, fallback) => {
    const v = Number(env)
    return Number.isFinite(v) && v >= 0 ? v : fallback
}

const BOOTSTRAP_TIMEOUT_MS = parseTimeout(process.env.OPENCODE_BOOTSTRAP_TIMEOUT, 5_000)
const PRE_TIMEOUT_MS = parseTimeout(process.env.OPENCODE_PRE_TIMEOUT, 5_000)
const PERMISSION_TIMEOUT_MS = parseTimeout(process.env.OPENCODE_PERMISSION_TIMEOUT, 5_000)
const POST_TIMEOUT_MS = parseTimeout(process.env.OPENCODE_POST_TIMEOUT, 8_000)
const CTX_TIMEOUT_MS = parseTimeout(process.env.OPENCODE_CTX_TIMEOUT, 3_000)
const PIPELINE_TIMEOUT_MS = parseTimeout(process.env.OPENCODE_PIPELINE_TIMEOUT, 10_000)
/** Fail-open opt-out for the lost-brain case (blocking ops skip fail-closed). */
export const FAIL_OPEN = process.env.OPENCODE_FAIL_OPEN === "1"
const DEBUG = process.env.OPENCODE_BRIDGE_DEBUG === "1"
    || process.env.OPENCODE_DEBUG === "*"

const RECONNECT_BASE_MS = 100
const RECONNECT_MAX_MS = 5_000
const DEBOUNCE_MS = 50
const MAX_DEBOUNCE_BATCH = 20
const SHORT_TIMEOUT_MS = 2_000
/** Bounds for `session.intel` recent-text extraction (never ship the dump). */
const RECENT_MESSAGE_COUNT = 20
const RECENT_PART_CHARS = 2_000
const RECENT_CHARS = 12_000

/** Ops the Python server NEVER replies to (fire-and-forget; no orphan log). */
const NO_REPLY_OPS = new Set(["event"])

/** Consecutive failed reconnect cycles before the circuit breaker opens. */
const CIRCUIT_BREAKER_LIMIT = 3

/** Hard cap on in-flight requests awaiting a reply (bounds the pending map). */
const MAX_PENDING = 256

// ── logging ───────────────────────────────────────────────────────────

const TAG = "[python-bridge]"

const log = {
    debug: (...a) => DEBUG && console.debug(TAG, "[debug]", ...a),
    info:  (...a) => console.error(TAG, "[info]", ...a),
    warn:  (...a) => console.error(TAG, "[warn]", ...a),
    error: (...a) => console.error(TAG, "[error]", ...a),
}

/**
 * Validate a server reply: only `{ok: true}` responses are usable.
 * An error reply `{ok:false, error:{code,message}}` is truthy but must behave
 * exactly like no reply (null) in every hook.
 * @param {Record<string, any>|null} msg
 * @returns {Record<string, any>|null}
 */
const okReply = (msg) => (msg && msg.ok === true ? msg : null)

/** Public wrapper so plugins can validate server replies identically. */
export { okReply }

// ── bootstrap / capabilities ─────────────────────────────────────────

/**
 * Hook capabilities the Python brain may register during the bootstrap
 * handshake. Each key maps to the hook that consults it:
 *
 *   pre            — tool.execute.before (blocking gate, plugins/hooks + task)
 *   permission     — permission.ask (blocking authority)
 *   post           — tool.execute.after (non-blocking enrichment)
 *   shellEnv       — shell.env
 *   context        — experimental.session.compacting + event context syncs
 *   eventPipeline  — event.pipeline (H3 verdict: informational only)
 *
 * A capability defaults to `false`; when `false` the hook skips its RPC and
 * proceeds immediately (the deterministic fast path — "empty → just go").
 * A *failed* bootstrap handshake fail-closes blocking ops (`pre`,
 * `permission`) only when the brain was previously connected; if no brain
 * ever connected the bridge runs inert (all hooks proceed normally) unless
 * OPENCODE_FAIL_OPEN=1.
 */
const CAPABILITY_KEYS = ["pre", "permission", "post", "shellEnv", "context", "eventPipeline"]

/** @type {{ status: "pending"|"ready"|"failed", caps: Set<string> }} */
let bootstrap = { status: "pending", caps: new Set() }

/** True while a bootstrap RPC is in flight (guards load → connect double-fire). */
let bootstrapInFlight = false

/** Waiters parked until the bootstrap handshake settles. @type {Array<() => void>} */
let bootstrapWaiters = []

/** True when the named hook capability is currently registered. */
const hasCap = (key) => bootstrap.status === "ready" && bootstrap.caps.has(key)

/**
 * Wait for the bootstrap handshake to settle (ready or failed).
 * The wait is bounded by the bootstrap RPC's own deadline, so queued hooks
 * cannot hang forever on a dead Python server.
 * @returns {"ready"|"failed"}
 */
async function awaitBootstrap() {
    if (bootstrap.status !== "pending") return bootstrap.status
    await new Promise((resolve) => bootstrapWaiters.push(resolve))
    return bootstrap.status
}

/** Release every hook queued on the handshake. */
function settleBootstrap() {
    const waiters = bootstrapWaiters
    bootstrapWaiters = []
    for (const resolve of waiters) resolve()
}

/** Monotonic generation: a newer handshake supersedes a stale one. */
let bootstrapGen = 0

/** True once the bootstrap handshake ever succeeded. While false, a failed
 * handshake means "no Python brain is present" → the bridge runs inert (all
 * hooks proceed normally). Once true, a later handshake failure fail-closes
 * blocking ops: an authority that vanished must not silently become
 * permissive. */
let everReady = false

/** One-time warn that the bridge is running inert (no brain ever connected). */
let warnedInert = false
/**
 * Run (or re-run) the bootstrap handshake. Re-applied on every reconnect:
 * the caps set is replaced wholesale by the newest reply, and all hooks read
 * it at call time. No-op while a handshake is already in flight (guards the
 * load → first-connect double-fire).
 */
function startBootstrap() {
    if (bootstrapInFlight) return
    bootstrapInFlight = true
    const gen = ++bootstrapGen
    bootstrap.status = "pending"
    bootstrap.caps = new Set()
    rpc("bootstrap", { protocol: "v0.4" }, BOOTSTRAP_TIMEOUT_MS).then((msg) => {
        if (gen !== bootstrapGen) return
        bootstrapInFlight = false
        if (msg && msg.ok === true && msg.capabilities && typeof msg.capabilities === "object") {
            everReady = true
            bootstrap.caps = new Set(
                CAPABILITY_KEYS.filter((key) => msg.capabilities[key] === true),
            )
            bootstrap.status = "ready"
            log.debug(`bootstrap: ready caps=[${[...bootstrap.caps].join(",") || "none"}]`)
        } else {
            bootstrap.status = "failed"
            if (everReady) {
                log.warn("bootstrap: failed — brain lost, blocking ops fail-closed")
            } else {
                log.warn("bootstrap: no Python brain connected — bridge inert, all hooks proceed normally")
            }
        }
        settleBootstrap()
    }).catch((err) => {
        // rpc() never rejects today, but if it ever does the in-flight guard
        // must not stick: every queued hook would block forever in awaitBootstrap.
        if (gen !== bootstrapGen) return
        bootstrapInFlight = false
        bootstrap.status = "failed"
        log.error(`bootstrap: rpc rejected: ${err.message}`)
        settleBootstrap()
    })
}

/**
 * Gate a *blocking* op (e.g. `pre`) on the handshake + capability.
 * @param {string} capKey
 * @returns {Promise<{kind: "rpc"} | {kind: "skip"} | {kind: "inert"} | {kind: "failed"}>}
 */
export async function gateBlocking(capKey) {
    if (bootstrap.status === "pending") await awaitBootstrap()
    if (bootstrap.status === "ready" && bootstrap.caps.has(capKey)) return { kind: "rpc" }
    if (bootstrap.status === "ready") return { kind: "skip" }
    // Handshake failed. Distinguish "no brain ever connected" — bridge is
    // inert, proceed normally (opencode fully functional without Python) —
    // from "brain connected then vanished" — fail closed.
    if (!everReady) return { kind: "inert" }
    return { kind: "failed" }
}

/** Warn once when the bridge proceeds without any authority (no brain ever
 * connected). Used by blocking hooks on the inert path. */
export function warnInert() {
    if (warnedInert) return
    warnedInert = true
    log.warn("bridge inert: no Python brain ever connected — proceeding without authority")
}

/** Gate a *non-blocking* op: skip its RPC unless the capability is registered. */
export const gateNonBlocking = (capKey) => hasCap(capKey)

// ── session.inject consumer ───────────────────────────────────────────

/**
 * Live content injection into an active session, driven by Python pushes
 * (`session.inject`). FIFO per session, dedupe by message id, bounded queue,
 * fail-safe on any client API error (log + drop, never throw into the
 * push handler). Injected parts are synthetic text parts; the A2A message is
 * authored by the Python brain, this side only pushes it into opencode.
 *
 * `client.session.promptAsync` (POST /session/{id}/prompt_async) starts the
 * agent if needed and returns immediately — the right shape for injection
 * (we never block the push handler on a full model turn). A `user`-kind
 * injected part is how the human-in-the-chain flow works: Python pushes a
 * question, opencode turns it into a prompt, the human answers.
 */
class SessionInjector {
    /** @type {Map<string, Array<{ part: import("@opencode-ai/sdk").TextPartInput, extras: Record<string, any> }>>} */
    #queues = new Map()
    /** @type {Set<string>} — dedupe window for inject ids (LRU-ish, bounded). */
    #seen = new Set()
    /** @type {Array<string>} — FIFO of ids for bounded eviction. */
    #seenOrder = []
    /** @type {Set<string>} — sessions with an in-flight inject. */
    #inFlight = new Set()

    /**
     * Queue one injection for delivery to its session.
     * @param {object} body — {id, sessionID, kind, content, metadata}
     * @param {{ session: import("@opencode-ai/sdk").SdkClient }} client
     */
    push(body, client) {
        if (!body || typeof body !== "object") return
        const {
            id, sessionID, kind, content, metadata,
            messageID, model, agent, system, tools,
        } = body
        if (!id || !sessionID || typeof content !== "string") {
            log.warn(`session.inject: invalid body (id=${id} sessionID=${sessionID})`)
            return
        }
        if (this.#seen.has(id)) {
            log.debug(`session.inject: dedupe id=${id.slice(0, 8)}`)
            return
        }
        if (!["user", "assistant", "system"].includes(kind)) {
            log.warn(`session.inject: unknown kind=${kind} id=${id.slice(0, 8)}`)
            return
        }
        this.#remember(id)

        const part = {
            type: "text",
            text: content,
            synthetic: true,
            ...(metadata && typeof metadata === "object" ? { metadata } : {}),
        }
        // Optional A2A turn knobs from the push body, forwarded to the SDK.
        const extras = {
            ...(messageID ? { messageID } : {}),
            ...(model ? { model } : {}),
            ...(agent ? { agent } : {}),
            ...(system ? { system } : {}),
            ...(Array.isArray(tools) ? { tools } : {}),
        }
        if (!this.#queues.has(sessionID)) this.#queues.set(sessionID, [])
        this.#queues.get(sessionID).push({ part, extras })
        log.debug(`session.inject: queued id=${id.slice(0, 8)} kind=${kind} session=${sessionID.slice(0, 8)}`)

        // Deliver asynchronously; the push handler must never block on it.
        void this.#drain(sessionID, client)
    }

    /** Remember an inject id, evicting the oldest when the window overflows. */
    #remember(id) {
        this.#seen.add(id)
        this.#seenOrder.push(id)
        if (this.#seenOrder.length > MAX_PENDING) {
            const oldest = this.#seenOrder.shift()
            this.#seen.delete(oldest)
        }
    }

    /**
     * Drain one session's queue serially (FIFO): one in-flight inject per
     * session. Any client error is logged and dropped (fail-safe).
     * @param {string} sessionID
     * @param {import("@opencode-ai/sdk").SdkClient} client
     */
    async #drain(sessionID, client) {
        if (this.#inFlight.has(sessionID)) return
        const queue = this.#queues.get(sessionID)
        if (!queue || queue.length === 0) return
        this.#inFlight.add(sessionID)

        try {
            while (this.#queues.get(sessionID)?.length) {
                const entries = this.#queues.get(sessionID)
                const { part, extras } = entries.shift()
                await client.session.promptAsync({
                    body: {
                        parts: [part],
                        noReply: true,
                        ...extras,
                    },
                    path: { id: sessionID },
                })
                log.debug(`session.inject: delivered part to session=${sessionID.slice(0, 8)}`)
            }
            this.#queues.delete(sessionID)
        } catch (err) {
            // Fail-safe: log + drop; never throw into the push handler.
            log.error(`session.inject: client error session=${sessionID.slice(0, 8)}: ${err.message}`)
            this.#queues.delete(sessionID)
        } finally {
            this.#inFlight.delete(sessionID)
        }
    }
}

const injector = new SessionInjector()

/**
 * Reverse-RPC: Python pushed `session.context.read` and expects the current
 * session context back. Fetch the session + messages from the SDK client and
 * reply over the socket (`pool.reply`). Fail-safe: any client error is
 * answered with an error reply, never thrown into the push handler.
 *
 * The SDK returns `{data, error, request, response}` (responseStyle
 * "fields"), so both the result error field and thrown exceptions are
 * handled.
 *
 * @param {string} id Reply id echoed from the push body.
 * @param {string} sessionID Session to read.
 */
async function readSessionContext(id, sessionID) {
    const client = activeClient
    if (!client) {
        log.error("session.context.read: no active client (no plugin instance initialized the bridge)")
        pool.reply(id, false, { error: { code: "no_client", message: "no plugin instance initialized the bridge" } })
        return
    }
    try {
        const [sessionRes, messagesRes] = await Promise.all([
            client.session.get({ path: { id: sessionID } }),
            client.session.messages({ path: { id: sessionID } }),
        ])
        const err = sessionRes?.error ?? messagesRes?.error
        if (err) {
            log.error(`session.context.read: client error session=${sessionID.slice(0, 8)}: ${err.message ?? String(err)}`)
            pool.reply(id, false, { error: { code: "client_error", message: err.message ?? String(err) } })
            return
        }
        const messages = messagesRes?.data
        log.debug(
            `session.context.read: replied session=${sessionID.slice(0, 8)}`
            + ` messages=${Array.isArray(messages) ? messages.length : "?"}`,
        )
        pool.reply(id, true, { session: sessionRes?.data, messages })
    } catch (err) {
        log.error(`session.context.read: exception session=${sessionID.slice(0, 8)}: ${err.message}`)
        pool.reply(id, false, { error: { code: "client_error", message: err.message } })
    }
}

/**
 * Reverse-RPC: Python pushed `task.launch` and expects the subagent result
 * back. Replicates the opencode `task` tool over the SDK client — the SDK
 * exposes no `tool.execute`, but the task tool itself is just "create a
 * child session + prompt it with the target agent": `session.create` then
 * `session.prompt`, which blocks until the run finishes and returns
 * `{info: AssistantMessage, parts: Part[]}`.
 *
 * Optional per-request knobs mirror the task tool's parameters and the
 * `session.prompt` body: `agent`, `model {providerID, modelID}`, `system`,
 * `tools {[key]: boolean}`, plus `title`, `parentSessionID` (child of the
 * calling session), `directory` and `timeoutMs` (0 = wait forever; on expiry
 * the run is aborted best-effort).
 *
 * Reply: `{id, ok:true, sessionID, info, parts, text}` — `text` is the last
 * text part, mirroring the task tool's output extraction. Any client error
 * is answered `{id, ok:false, error:{code, message, sessionID?}}`. The
 * first reply wins; a timeout reply is never followed by a late result
 * reply for the same id.
 *
 * @param {string} id Reply id echoed from the push body.
 * @param {object} body
 */
async function launchTask(id, body) {
    const client = activeClient
    if (!client) {
        log.error("task.launch: no active client (no plugin instance initialized the bridge)")
        pool.reply(id, false, { error: { code: "no_client", message: "no plugin instance initialized the bridge" } })
        return
    }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
    if (!prompt) {
        pool.reply(id, false, { error: { code: "invalid_request", message: "task.launch requires a non-empty prompt" } })
        return
    }
    const agent = typeof body.agent === "string" && body.agent ? body.agent : undefined
    const model = body.model && typeof body.model === "object" ? body.model : undefined
    const system = typeof body.system === "string" ? body.system : undefined
    const tools = body.tools && typeof body.tools === "object" ? body.tools : undefined
    const title = typeof body.title === "string" ? body.title : undefined
    const parentID = typeof body.parentSessionID === "string" ? body.parentSessionID : undefined
    const directory = typeof body.directory === "string" ? body.directory : undefined
    const timeoutMs = Number.isFinite(Number(body.timeoutMs)) && Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 0

    let sessionID
    try {
        const createRes = await client.session.create({
            body: {
                ...(parentID ? { parentID } : {}),
                ...(title ? { title } : {}),
            },
            ...(directory ? { query: { directory } } : {}),
        })
        if (createRes?.error) {
            log.error(`task.launch: create error: ${createRes.error.message ?? String(createRes.error)}`)
            pool.reply(id, false, { error: { code: "client_error", message: createRes.error.message ?? String(createRes.error) } })
            return
        }
        sessionID = createRes?.data?.id
        if (!sessionID) {
            pool.reply(id, false, { error: { code: "client_error", message: "session.create returned no id" } })
            return
        }
    } catch (err) {
        log.error(`task.launch: create exception: ${err.message}`)
        pool.reply(id, false, { error: { code: "client_error", message: err.message } })
        return
    }

    // Guard against a timeout reply being followed by a late result reply.
    let replied = false
    const reply = (ok, payload) => {
        if (replied) return
        replied = true
        pool.reply(id, ok, payload)
    }

    log.debug(`task.launch: created session=${sessionID.slice(0, 8)} agent=${agent ?? "default"} timeoutMs=${timeoutMs}`)
    let timer = null
    if (timeoutMs > 0) {
        timer = setTimeout(() => {
            log.error(`task.launch: timeout session=${sessionID.slice(0, 8)} after ${timeoutMs}ms`)
            reply(false, { error: { code: "timeout", message: `task.launch timed out after ${timeoutMs}ms`, sessionID } })
            Promise.resolve(client.session.abort?.({ path: { id: sessionID } })).catch(() => {})
        }, timeoutMs)
    }

    try {
        const res = await client.session.prompt({
            path: { id: sessionID },
            body: {
                parts: [{ type: "text", text: prompt }],
                ...(agent ? { agent } : {}),
                ...(model ? { model } : {}),
                ...(system ? { system } : {}),
                ...(tools ? { tools } : {}),
            },
        })
        if (timer) clearTimeout(timer)
        if (res?.error) {
            log.error(`task.launch: prompt error session=${sessionID.slice(0, 8)}: ${res.error.message ?? String(res.error)}`)
            reply(false, { error: { code: "client_error", message: res.error.message ?? String(res.error), sessionID } })
            return
        }
        const parts = res?.parts
        const text = Array.isArray(parts)
            ? parts.findLast((p) => p?.type === "text")?.text ?? ""
            : ""
        log.debug(
            `task.launch: completed session=${sessionID.slice(0, 8)}`
            + ` parts=${Array.isArray(parts) ? parts.length : "?"}`,
        )
        reply(true, { sessionID, info: res?.info, parts, text })
    } catch (err) {
        if (timer) clearTimeout(timer)
        log.error(`task.launch: exception session=${sessionID.slice(0, 8)}: ${err.message}`)
        reply(false, { error: { code: "client_error", message: err.message, sessionID } })
    }
}

/**
 * Bounded session intel fetched from the SDK client: message stats, recent
 * text parts, the file diff and the todo list. This powers the compaction
 * "handshake" — the brain sees exactly what is about to be summarized —
 * and the `session.intel` reverse-RPC for on-demand reads. Every item is
 * individually fail-safe: a fetch error yields `null` (or `""` for recent)
 * so a broken surface never breaks the rest.
 *
 * Bounds: `recent` keeps the last RECENT_MESSAGE_COUNT text parts, each
 * trimmed to RECENT_PART_CHARS, joined and capped at RECENT_CHARS — never
 * ships the full context over the socket (the LLM summarizer already has
 * it; the brain needs the shape, not the dump). Use `session.context.read`
 * for the full message list.
 *
 * @param {string} sessionID
 * @param {string[]|null} [what] Which intel to fetch — subset of
 *   `["stats", "recent", "diff", "todo"]`; default fetches all.
 * @returns {Promise<Record<string, any>>} `{stats?, recent?, diff?, todo?}`
 */
async function readSessionIntel(sessionID, what = null) {
    const client = activeClient
    const keys = what && Array.isArray(what) && what.length ? what : ["stats", "recent", "diff", "todo"]
    const out = {}

    let messagesRes = null
    for (const key of keys) {
        if (key === "stats" || key === "recent") {
            if (messagesRes === null) {
                try {
                    messagesRes = await client?.session?.messages?.({ path: { id: sessionID } })
                } catch (err) {
                    log.debug(`session.intel: messages fetch failed for ${sessionID.slice(0, 8)}: ${err.message}`)
                    messagesRes = { data: [] }
                }
            }
            const messages = messagesRes?.data ?? []
            if (key === "stats") {
                const byRole = {}
                let lastUpdated = 0
                for (const m of messages) {
                    const role = m?.info?.role ?? m?.role ?? "unknown"
                    byRole[role] = (byRole[role] ?? 0) + 1
                    const t = Number(m?.info?.time?.updated ?? m?.time?.updated ?? 0)
                    if (t > lastUpdated) lastUpdated = t
                }
                out.stats = { total: messages.length, byRole, lastUpdated }
            } else {
                const texts = []
                for (const m of messages) {
                    for (const p of m?.parts ?? m?.data?.parts ?? []) {
                        if (p?.type === "text" && typeof p?.text === "string") {
                            texts.push(p.text.slice(0, RECENT_PART_CHARS))
                        }
                    }
                }
                out.recent = texts.slice(-RECENT_MESSAGE_COUNT).join("\n\n").slice(-RECENT_CHARS)
            }
            continue
        }
        try {
            if (key === "diff") {
                const res = await client?.session?.diff?.({ path: { id: sessionID } })
                out.diff = res?.data ?? []
            } else if (key === "todo") {
                const res = await client?.session?.todo?.({ path: { id: sessionID } })
                out.todo = res?.data ?? []
            } else {
                out[key] = null
            }
        } catch (err) {
            log.debug(`session.intel: ${key} fetch failed for ${sessionID.slice(0, 8)}: ${err.message}`)
            out[key] = key === "recent" ? "" : null
        }
    }
    return out
}

/** Export for plugins (compaction hook enrichment). */
export const sessionIntel = (sessionID, what = null) => readSessionIntel(sessionID, what)

/**
 * Reverse-RPC: Python pushed `session.intel` and expects bounded session
 * intel back (`{id, ok, sessionID, stats?, recent?, diff?, todo?}`) — see
 * `readSessionIntel` for shapes and bounds. Fail-safe: no client or client
 * error answers `{ok:false, error:{code, message}}`.
 * @param {string} id Reply id echoed from the push body.
 * @param {string} sessionID Session to inspect.
 * @param {string[]|null} what Intel keys to fetch (default all).
 */
async function replySessionIntel(id, sessionID, what) {
    if (!activeClient) {
        log.error("session.intel: no active client (no plugin instance initialized the bridge)")
        pool.reply(id, false, { error: { code: "no_client", message: "no plugin instance initialized the bridge" } })
        return
    }
    const intel = await readSessionIntel(sessionID, what)
    log.debug(`session.intel: replied session=${sessionID.slice(0, 8)} keys=[${Object.keys(intel).join(",") || "none"}]`)
    pool.reply(id, true, { sessionID, ...intel })
}

/**
 * Reverse-RPC: Python pushed `session.summarize` to force a compaction
 * summarization (`client.session.summarize` — the summarizer runs async in
 * opencode, so this only kicks it off). Replies `{id, ok, sessionID,
 * started: true}`; fail-safe `{ok:false, error}` on client failure.
 * @param {string} id Reply id echoed from the push body.
 * @param {string} sessionID Session to summarize.
 * @param {{ providerID?: string, modelID?: string }|null} [model] Optional
 *   summarizer model override (defaults to opencode's choice).
 */
async function summarizeSession(id, sessionID, model) {
    const client = activeClient
    if (!client) {
        log.error("session.summarize: no active client (no plugin instance initialized the bridge)")
        pool.reply(id, false, { error: { code: "no_client", message: "no plugin instance initialized the bridge" } })
        return
    }
    try {
        const res = await client.session.summarize({
            path: { id: sessionID },
            body: model && typeof model === "object" ? { providerID: model.providerID, modelID: model.modelID } : undefined,
        })
        if (res?.error) {
            log.error(`session.summarize: client error session=${sessionID.slice(0, 8)}: ${res.error.message ?? String(res.error)}`)
            pool.reply(id, false, { error: { code: "client_error", message: res.error.message ?? String(res.error), sessionID } })
            return
        }
        log.debug(`session.summarize: kicked off session=${sessionID.slice(0, 8)}`)
        pool.reply(id, true, { sessionID, started: true })
    } catch (err) {
        log.error(`session.summarize: exception session=${sessionID.slice(0, 8)}: ${err.message}`)
        pool.reply(id, false, { error: { code: "client_error", message: err.message, sessionID } })
    }
}

/**
 * Handle a push from the Python server. Push dispatch runs BEFORE orphan
 * matching in the pool data handler.
 * @param {string} channel
 * @param {object} body
 */
function handlePush(channel, body) {
    if (channel === "capabilities.update" && body && typeof body === "object") {
        bootstrap.caps = new Set(CAPABILITY_KEYS.filter((key) => body[key] === true))
        bootstrap.status = "ready"
        settleBootstrap()
        log.debug(`push capabilities.update: caps=[${[...bootstrap.caps].join(",") || "none"}]`)
        return
    }
    if (channel === "session.inject" && body && typeof body === "object") {
        injector.push(body, activeClient)
        return
    }
    if (channel === "session.context.read" && body && typeof body === "object") {
        if (typeof body.id === "string" && typeof body.sessionID === "string") {
            void readSessionContext(body.id, body.sessionID)
        } else {
            log.error("session.context.read: missing id/sessionID, ignored")
        }
        return
    }
    if (channel === "task.launch" && body && typeof body === "object") {
        if (typeof body.id === "string") {
            void launchTask(body.id, body)
        } else {
            log.error("task.launch: missing id, ignored")
        }
        return
    }
    if (channel === "session.intel" && body && typeof body === "object") {
        if (typeof body.id === "string" && typeof body.sessionID === "string") {
            void replySessionIntel(body.id, body.sessionID, body.what)
        } else {
            log.error("session.intel: missing id/sessionID, ignored")
        }
        return
    }
    if (channel === "session.summarize" && body && typeof body === "object") {
        if (typeof body.id === "string" && typeof body.sessionID === "string") {
            void summarizeSession(body.id, body.sessionID, body.model ?? null)
        } else {
            log.error("session.summarize: missing id/sessionID, ignored")
        }
        return
    }
    // permissions.update is informational on the JS side: permission rules
    // live in the Python brain, so no consumer is needed here.
    log.debug(`push channel=${channel} (no consumer)`)
}

// ── tracked events ────────────────────────────────────────────────────

const TRACKED_EVENTS = new Set([
    "command.executed",
    "file.edited",
    "file.watcher.updated",
    "installation.updated",
    "lsp.client.diagnostics",
    "lsp.updated",
    "message.part.removed",
    "message.part.updated",
    "message.removed",
    "message.updated",
    "permission.asked",
    "permission.replied",
    "server.connected",
    "session.created",
    "session.compacted",
    "session.deleted",
    "session.diff",
    "session.error",
    "session.idle",
    "session.status",
    "session.updated",
    "todo.updated",
    "shell.env",
    "tool.execute.after",
    "tool.execute.before",
    "tui.prompt.append",
    "tui.command.execute",
    "tui.toast.show",
])

/** True when the event type is one the bridge forwards to Python. */
export const isTrackedEvent = (type) => TRACKED_EVENTS.has(type) || type.startsWith("session.")

// Events that trigger a context sync to STATE.live_context.
// The Python handler stores the result so it persists across compaction
// cycles (the only path that actually injects into the LLM).
const CONTEXT_TRIGGER_EVENTS = new Set([
    "session.created",
    "session.idle",
    "session.compacted",
    "session.error",
    "file.edited",
    "todo.updated",
    "lsp.client.diagnostics",
])

/** True when the event type triggers a context sync. */
export const isContextTriggerEvent = (type) => CONTEXT_TRIGGER_EVENTS.has(type)

// Events that go through the synchronous hook pipeline (pre → store → post).
// The JS bridge blocks OpenCode's event loop until the pipeline returns.
const HOOKABLE_EVENTS = new Set([
    "session.created",
    "session.idle",
    "session.compacted",
    "session.error",
    "file.edited",
    "todo.updated",
    "tool.execute.before",
    "tool.execute.after",
    "permission.asked",
    "permission.replied",
])

/** True when the event type goes through the event.pipeline RPC. */
export const isHookableEvent = (type) => HOOKABLE_EVENTS.has(type)

// ── persistent connection pool ────────────────────────────────────────

/**
 * Persistent connection pool — one shared socket, reconnected on failure.
 *
 * Routes responses by UUID so multiple in-flight requests can share a
 * single TCP connection.  Automatically reconnects with exponential
 * backoff when the Python server goes down.
 *
 * Liveness semantics (v0.4):
 * - One deadline per rpc; rpcs survive reconnect until their own deadline.
 * - Reply-expectation per op: NO_REPLY ops go through `send()` — they never
 *   register a pending entry, so the server's non-reply cannot orphan them.
 * - Circuit breaker: after N consecutive failed reconnect cycles all pending
 *   are rejected once (batch) so blocking ops fail-closed fast instead of
 *   hanging until every individual deadline.
 */
class SocketPool {
    /** @type {string} */
    #path
    /** @type {import("node:net").Socket | null} */
    #socket = null
    /** @type {boolean} */
    #connecting = false
    /** @type {string} */
    #buf = ""
    /** @type {Map<string, { resolve: (v: Record<string, any> | null) => void, timer: number | ReturnType<typeof setTimeout> }>} */
    #pending = new Map()
    /** @type {number | ReturnType<typeof setTimeout> | null} */
    #reconnectTimer = null
    /** @type {number} */
    #reconnectDelay = RECONNECT_BASE_MS
    /** @type {(() => void) | null} — called after every successful connect */
    #onConnect = null
    /** @type {number} — consecutive failed reconnect cycles */
    #failStreak = 0
    /** @type {boolean} — circuit breaker open: reject new + pending rpcs */
    #breakerOpen = false
    /** @type {boolean} — closed: no new connects, no reconnect (unload/tests) */
    #closed = false

    /** @param {string} path — UNIX socket path */
    constructor(path) {
        this.#path = path
    }

    /**
     * Register a callback fired after every successful connect (initial and
     * reconnects) — used to re-run the bootstrap handshake.
     * @param {() => void} cb
     */
    set onConnect(cb) {
        this.#onConnect = cb
    }

    /** Ensure we have a live connection.  No-op if already connected or connecting. */
    #ensureConnected() {
        if (this.#closed) return
        if (this.#socket && !this.#socket.destroyed && this.#socket.writable) return
        if (this.#connecting) return
        if (this.#socket) {
            // Destroyed/half-closed socket — tear it down before reconnecting.
            this.#socket.destroy()
            this.#socket = null
        }
        this.#connecting = true

        const socket = net.createConnection(this.#path)
        // Assign at creation, not just on connect: #onDisconnect's identity
        // guard compares the failing socket against #socket, and a failed
        // connect attempt (ENOENT etc.) must pass that guard too, or the
        // reconnect chain dies (connecting stuck true, breaker never opens).
        this.#socket = socket

        socket.on("connect", () => {
            this.#socket = socket
            this.#connecting = false
            this.#reconnectDelay = RECONNECT_BASE_MS
            this.#failStreak = 0
            this.#breakerOpen = false
            log.debug(`pool: connected (${this.#pending.size} pending)`)
            this.#onConnect?.()
        })

        socket.on("data", (chunk) => {
            // toString() defaults to utf8, the NDJSON protocol encoding.
            this.#buf += chunk.toString()
            if (this.#buf.length > 1_000_000) {
                log.error("pool: buffer exceeded 1MB, dropping (unterminated NDJSON line)")
                this.#buf = ""
            }
            let idx
            while ((idx = this.#buf.indexOf("\n")) >= 0) {
                const raw = this.#buf.slice(0, idx)
                this.#buf = this.#buf.slice(idx + 1)
                if (!raw.trim()) continue
                try {
                    const msg = JSON.parse(raw)
                    if (msg && msg.type === "push") {
                        // Push dispatch happens BEFORE orphan matching.
                        handlePush(msg.channel, msg.body)
                        continue
                    }
                    const entry = this.#pending.get(msg.id)
                    if (entry) {
                        clearTimeout(entry.timer)
                        this.#pending.delete(msg.id)
                        log.debug(`pool: response id=${String(msg.id).slice(0, 8)} ok=${msg.ok}`)
                        entry.resolve(msg)
                    } else {
                        log.debug(`pool: ignoring orphan response id=${String(msg.id).slice(0, 8)}`)
                    }
                } catch (err) {
                    log.error(`pool: JSON parse error: ${err.message}`, raw.slice(0, 200))
                }
            }
        })

        socket.on("end", () => {
            log.debug("pool: socket end (peer FIN)")
            this.#onDisconnect(socket)
        })

        const onSocketError = /** @param {NodeJS.ErrnoException} err */ (err) => {
            log.debug(`pool: socket error: ${err.code ?? err.message}`)
            this.#onDisconnect(socket)
        }
        socket.on("error", onSocketError)

        socket.on("close", (hadError) => {
            log.debug(`pool: socket close (hadError=${hadError})`)
            this.#onDisconnect(socket)
        })
    }

    /**
     * Handle disconnection — schedule reconnect.  Pending rpcs are NOT
     * rejected here: each keeps its own deadline and is re-sent after the
     * reconnect (deadline retry).  Only the circuit breaker (N consecutive
     * failed reconnect cycles) rejects all pending in one batch.
     * Idempotent: the socket identity guard prevents a single failure
     * (error + close double-fire) from tearing down a replacement socket.
     * @param {import("node:net").Socket} [sock]
     */
    #onDisconnect(sock) {
        if (this.#closed) return
        if (sock && this.#socket !== sock) return
        this.#socket = null
        this.#connecting = false
        this.#buf = ""

        this.#failStreak += 1
        if (!this.#breakerOpen && this.#failStreak >= CIRCUIT_BREAKER_LIMIT) {
            this.#breakerOpen = true
            log.warn(
                `pool: circuit breaker OPEN after ${this.#failStreak} failed reconnect cycles `
                + `— rejecting ${this.#pending.size} pending rpcs`,
            )
            this.#rejectAllPending()
        }

        this.#scheduleReconnect()
    }

    /** Reject every pending rpc with null (fail-closed), clearing the map. */
    #rejectAllPending() {
        for (const entry of this.#pending.values()) {
            clearTimeout(entry.timer)
            entry.resolve(null)
        }
        this.#pending.clear()
    }

    /** Exponential backoff reconnect. */
    #scheduleReconnect() {
        if (this.#reconnectTimer !== null) return
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null
            log.debug(`pool: reconnecting in ${this.#reconnectDelay}ms`)
            this.#ensureConnected()
        }, this.#reconnectDelay)
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS)
    }

    /**
     * Send one NDJSON request WITHOUT registering a pending entry.
     * For NO_REPLY ops (reply-expectation per op): the server never replies,
     * so a pending entry would just orphan/timeout. Best-effort write — if
     * no socket is writable the line is dropped (these ops are informational).
     * @param {string} op
     * @param {object} body
     */
    send(op, body) {
        if (this.#closed) {
            log.debug(`pool: send dropped op=${op} (bridge closed)`)
            return
        }
        this.#ensureConnected()
        const id = randomUUID()
        const line = JSON.stringify({ id, op, body }) + "\n"
        if (this.#socket && !this.#socket.destroyed && this.#socket.writable) {
            this.#socket.write(line)
            log.debug(`pool: sent (no-reply) op=${op} id=${id.slice(0, 8)}`)
            return
        }
        log.debug(`pool: send dropped op=${op} id=${id.slice(0, 8)} (no writable socket)`)
    }

    /**
     * Write a response line for a reverse-RPC push: Python sent a push
     * carrying an `id` (e.g. `session.context.read`), JS computes the data
     * and answers with the standard `{id, ok, ...}` response shape so the
     * Python side's pending map matches it like any request reply.
     * Best-effort: if no socket is writable the reply is dropped.
     *
     * @param {string} id
     * @param {boolean} ok
     * @param {Record<string, any>} payload Extra fields merged into the line.
     */
    reply(id, ok, payload = {}) {
        if (this.#closed) {
            log.debug(`pool: reply dropped id=${id.slice(0, 8)} ok=${ok} (bridge closed)`)
            return
        }
        const line = JSON.stringify({ id, ok, ...payload }) + "\n"
        if (this.#socket && !this.#socket.destroyed && this.#socket.writable) {
            this.#socket.write(line)
            log.debug(`pool: replied id=${id.slice(0, 8)} ok=${ok}`)
            return
        }
        log.debug(`pool: reply dropped id=${id.slice(0, 8)} ok=${ok} (no writable socket)`)
    }

    /**
     * Send one NDJSON request, wait for matching-id response.
     *
     * One deadline covers the whole lifetime, including any re-enqueue after
     * a failed write; rpcs survive reconnect until that deadline. Returns
     * null on timeout, disconnect-without-reconnect, breaker trip, or
     * pending-map overflow.
     *
     * @param {string} op
     * @param {object} body
     * @param {number} timeoutMs
     * @returns {Promise<Record<string, any>|null>}
     */
    rpc(op, body, timeoutMs) {
        if (this.#closed) {
            log.debug(`pool: rpc rejected op=${op} (bridge closed)`)
            return Promise.resolve(null)
        }
        if (this.#breakerOpen) {
            log.warn(`pool: circuit breaker open — rejecting op=${op}`)
            return Promise.resolve(null)
        }
        if (this.#pending.size >= MAX_PENDING) {
            log.error(`pool: pending overflow (${MAX_PENDING}) — rejecting op=${op}`)
            return Promise.resolve(null)
        }
        this.#ensureConnected()

        const id = randomUUID()
        const line = JSON.stringify({ id, op, body }) + "\n"

        return new Promise((resolve) => {
            // ONE deadline timer covers the whole lifetime, including any
            // re-enqueue after a failed write. resolve() runs at most once.
            const timer = setTimeout(() => {
                if (poll) clearInterval(poll)
                this.#pending.delete(id)
                log.debug(`pool: timeout id=${id.slice(0, 8)} op=${op} after ${timeoutMs}ms`)
                resolve(null)
            }, timeoutMs)

            /** @type {ReturnType<typeof setInterval> | null} */
            let poll = null

            this.#pending.set(id, { resolve, timer })

            /** Attempt the write. Returns true on success; on failure keeps
             * the entry + deadline and lets the poll retry after reconnect. */
            const doWrite = () => {
                if (this.#socket && !this.#socket.destroyed && this.#socket.writable) {
                    this.#socket.write(line)
                    return true
                }
                log.debug(`pool: socket unavailable for id=${id.slice(0, 8)}, retrying`)
                return false
            }

            if (doWrite()) return

            // Not connected yet — poll until writable or the deadline fires.
            // The deadline is the ONLY resolver here: rpcs survive reconnect
            // (#onDisconnect does not reject them), so the poll just keeps
            // waiting for a writable socket. Cleared in every exit path.
            poll = setInterval(() => {
                if (this.#socket && !this.#socket.destroyed && this.#socket.writable) {
                    if (doWrite()) {
                        clearInterval(poll)
                        poll = null
                    }
                }
            }, 10)
        })
    }

    /** Shutdown the pool gracefully. */
    close() {
        this.#closed = true
        if (this.#reconnectTimer !== null) {
            clearTimeout(this.#reconnectTimer)
            this.#reconnectTimer = null
        }
        this.#rejectAllPending()
        if (this.#socket) {
            this.#socket.destroy()
            this.#socket = null
        }
        this.#connecting = false
        this.#buf = ""
    }
}

/** Process-wide pool instance. */
const pool = new SocketPool(SOCKET_PATH)

/** Monotonic counter for short log ids (replaces randomUUID().slice(0, 8)). */
let _shortIdCounter = 0

/**
 * High-level RPC wrapper — routes through the persistent pool.
 *
 * Reply-expectation per op: ops in NO_REPLY_OPS (e.g. `event`) are sent
 * write-only via `pool.send()` — the server never replies, so registering a
 * pending entry would only produce an orphan timeout log. All other ops
 * register a pending entry and wait for the matching response.
 *
 * @param {string} op
 * @param {object} body
 * @param {number} timeoutMs
 * @param {{ wait?: boolean }} opts
 * @returns {Promise<Record<string, any>|null>}
 */
export function rpc(op, body, timeoutMs, { wait = true } = {}) {
    const shortId = String(++_shortIdCounter).padStart(8, "0")
    log.debug(`rpc[${shortId}] → op=${op} timeout=${timeoutMs}ms wait=${wait}`)

    if (NO_REPLY_OPS.has(op)) {
        // Server NEVER replies to this op — write-only, no pending entry,
        // no orphan timeout log, no wait.
        pool.send(op, body)
        return Promise.resolve({})
    }

    if (!wait) {
        // Reply expected but the caller doesn't need it: register with a
        // short deadline so the reply can still be matched and resolved.
        pool.rpc(op, body, Math.min(timeoutMs, SHORT_TIMEOUT_MS)).catch(() => {})
        return Promise.resolve({})
    }

    return pool.rpc(op, body, timeoutMs)
}

// ── event debouncer ───────────────────────────────────────────────────

/**
 * Batches rapid fire-and-forget events within a time window.
 * Individual events are coalesced into a single batched RPC.
 */
class EventDebouncer {
    /** @type {Map<string, Array<{ type: string, properties: object, directory: string, worktree: string }>>} */
    #batches = new Map()
    /** @type {Map<string, number | ReturnType<typeof setTimeout>>} */
    #timers = new Map()

    /**
     * Queue an event for debounced sending.
     * @param {{ type: string, properties: object, directory: string, worktree: string }} event
     */
    push(event) {
        const key = "default"
        if (!this.#batches.has(key)) {
            this.#batches.set(key, [])
        }
        const batch = this.#batches.get(key)
        batch.push(event)

        // If we hit the max batch size, flush immediately
        if (batch.length >= MAX_DEBOUNCE_BATCH) {
            this.#flush(key)
            return
        }

        // Otherwise, set/reset the debounce timer
        if (this.#timers.has(key)) return
        this.#timers.set(key, setTimeout(() => {
            this.#flush(key)
        }, DEBOUNCE_MS))
    }

    /** @param {string} key */
    #flush(key) {
        const timer = this.#timers.get(key)
        if (timer) {
            clearTimeout(timer)
            this.#timers.delete(key)
        }
        const batch = this.#batches.get(key)
        if (!batch || batch.length === 0) {
            this.#batches.delete(key)
            return
        }
        this.#batches.delete(key)

        if (batch.length === 1) {
            // Single event — send directly
            log.debug(`debounce: flush 1 event: ${batch[0].type}`)
            void rpc("event", batch[0], SHORT_TIMEOUT_MS, { wait: false })
        } else {
            // Batched — send as batch event
            log.debug(`debounce: flush ${batch.length} events: ${batch.map(e => e.type).join(",")}`)
            void rpc("event", { type: "event.batch", events: batch }, SHORT_TIMEOUT_MS, { wait: false })
        }
    }

    /** Cancel every pending debounce timer (bridge shutdown). */
    clear() {
        for (const timer of this.#timers.values()) clearTimeout(timer)
        this.#timers.clear()
        this.#batches.clear()
    }
}

const debouncer = new EventDebouncer()

/** Queue a fire-and-forget event for debounced delivery to Python. */
export const pushEvent = (event) => debouncer.push(event)

/**
 * Shut the bridge down: close the socket pool (clears the reconnect chain,
 * rejects pending rpcs, destroys the socket) and cancel pending debounces so
 * the event loop drains. Used by tests and available for plugin unload.
 */
export const closeBridge = () => {
    debouncer.clear()
    pool.close()
}

/**
 * The opencode SDK client from the active plugin instance. Set by
 * `startBridge()` in every plugin; used by push consumers (`session.inject`)
 * that fire from the pool data handler, outside the hook closure.
 * @type {import("@opencode-ai/sdk").SdkClient}
 */
let activeClient = null

// ── plugin bootstrapping ──────────────────────────────────────────────

/** Shared per-instance input context captured by the first startBridge call. */
const bridgeEnv = {
    /** @type {string|undefined} */
    directory: undefined,
    /** @type {string|undefined} */
    worktree: undefined,
    /** @type {{ name?: string, id?: string }|undefined} */
    project: undefined,
}

/**
 * Initialize the shared bridge from a plugin instance's input. Idempotent:
 * the socket stat check runs once, `activeClient` is set to the newest
 * instance, and the bootstrap handshake is kicked exactly once (the
 * in-flight guard in startBootstrap prevents double-fire).
 *
 * @param {{ client?: import("@opencode-ai/sdk").SdkClient, directory?: string, worktree?: string, project?: { name?: string, id?: string } }} input
 */
export function startBridge(input) {
    activeClient = input?.client ?? null
    bridgeEnv.directory ??= input?.directory
    bridgeEnv.worktree ??= input?.worktree
    bridgeEnv.project ??= input?.project

    const statOnce = async () => {
        try {
            const fs = await import("node:fs/promises")
            const stat = await fs.stat(SOCKET_PATH)
            if (!stat.isSocket()) {
                log.warn(`${SOCKET_PATH} exists but is NOT a unix socket (type=${stat.mode})`)
            } else {
                log.debug(`socket path verified: ${SOCKET_PATH}`)
            }
        } catch {
            log.warn(`socket path not accessible: ${SOCKET_PATH}`)
            log.warn("bridge loads inert: all hooks proceed normally until a Python brain connects")
        }
    }
    void statOnce()

    // Kick off the bootstrap handshake immediately so the first hook call
    // already knows the brain's capabilities. Re-applied on every reconnect.
    pool.onConnect = startBootstrap
    startBootstrap()
}

/** The directory of the plugin instance that initialized the bridge. */
export const directory = () => bridgeEnv.directory

/** The git worktree root of the plugin instance (undefined if not a repo). */
export const worktree = () => bridgeEnv.worktree

/** The project metadata of the plugin instance. */
export const project = () => bridgeEnv.project

/** Timeout presets shared by the hooks. */
export const timeouts = {
    bootstrap: BOOTSTRAP_TIMEOUT_MS,
    pre: PRE_TIMEOUT_MS,
    permission: PERMISSION_TIMEOUT_MS,
    post: POST_TIMEOUT_MS,
    context: CTX_TIMEOUT_MS,
    pipeline: PIPELINE_TIMEOUT_MS,
    short: SHORT_TIMEOUT_MS,
}

/** Debug flag (used by hooks for cheap log branching). */
export const debugEnabled = () => DEBUG
