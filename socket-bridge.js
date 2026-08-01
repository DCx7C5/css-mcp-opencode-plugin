/**
 * OpenCode ↔ Python bridge — raw NDJSON over Unix socket
 * Socket: /var/run/css-mcp/hooks.sock
 *
 * Debug: set OPENCODE_BRIDGE_DEBUG=1 or OPENCODE_DEBUG=* in env.
 * Logs go to stderr (opencode captures it).
 *
 * Architecture:
 *  - Persistent connection pool: one shared socket, reconnected on failure
 *  - Request/response multiplexing by UUID
 *  - Event debouncing for rapid fire-and-forget events
 *  - Blocking ops fail closed only AFTER a brain ever connected
 *    (OPENCODE_FAIL_OPEN === "1" to opt out). With no brain ever connected
 *    the bridge is inert: every hook proceeds normally, so loading the
 *    plugin without a Python server leaves opencode fully functional.
 */

import net from "node:net"
import { randomUUID } from "node:crypto"

// ── config ────────────────────────────────────────────────────────────

const SOCKET_PATH =
    process.env.OPENCODE_PYTHON_SOCK || "/var/run/css-mcp/hooks.sock"

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
const FAIL_OPEN = process.env.OPENCODE_FAIL_OPEN === "1"
const DEBUG = process.env.OPENCODE_BRIDGE_DEBUG === "1"
    || process.env.OPENCODE_DEBUG === "*"

const RECONNECT_BASE_MS = 100
const RECONNECT_MAX_MS = 5_000
const DEBOUNCE_MS = 50
const MAX_DEBOUNCE_BATCH = 20
const SHORT_TIMEOUT_MS = 2_000

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

// ── bootstrap / capabilities ─────────────────────────────────────────

/**
 * Hook capabilities the Python brain may register during the bootstrap
 * handshake. Each key maps to the hook that consults it:
 *
 *   pre            — tool.execute.before (blocking gate)
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

/**
 * Mutable runtime configuration supplied by the Python brain at bootstrap.
 * The `config` hook only mutates at load time, so config deltas travel via
 * the bootstrap reply (and `capabilities.update` pushes); all hooks read
 * this object at call time. Replaced wholesale per handshake/reconnect.
 * @type {Record<string, any>}
 */
let runtimeConfig = {}

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
            if (msg.config && typeof msg.config === "object") {
                runtimeConfig = msg.config
                log.debug(`bootstrap: config delta keys=[${Object.keys(runtimeConfig).join(",") || "none"}]`)
            }
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
    })
}

/**
 * Gate a *blocking* op (e.g. `pre`) on the handshake + capability.
 * @param {string} capKey
 * @returns {Promise<{kind: "rpc"} | {kind: "skip"} | {kind: "inert"} | {kind: "failed"}>}
 */
async function gateBlocking(capKey) {
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
function warnInert() {
    if (warnedInert) return
    warnedInert = true
    log.warn("bridge inert: no Python brain ever connected — proceeding without authority")
}

/** Gate a *non-blocking* op: skip its RPC unless the capability is registered. */
const gateNonBlocking = (capKey) => hasCap(capKey)

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
 * (we never block the push handler on a full model turn).
 */
class SessionInjector {
    /** @type {Map<string, Array<import("@opencode-ai/sdk").TextPartInput>>} */
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
        const { id, sessionID, kind, content, metadata } = body
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
        if (!this.#queues.has(sessionID)) this.#queues.set(sessionID, [])
        this.#queues.get(sessionID).push(part)
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
                const parts = this.#queues.get(sessionID)
                const part = parts.shift()
                await client.session.promptAsync({
                    body: {
                        parts: [part],
                        noReply: true,
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
 * Handle a push from the Python server. Push dispatch runs BEFORE orphan
 * matching in the pool data handler.
 * @param {string} channel
 * @param {object} body
 */
function handlePush(channel, body) {
    if (channel === "capabilities.update" && body && typeof body === "object") {
        bootstrap.caps = new Set(CAPABILITY_KEYS.filter((key) => body[key] === true))
        bootstrap.status = "ready"
        if (body.config && typeof body.config === "object") {
            runtimeConfig = body.config
            log.debug(`push capabilities.update: config keys=[${Object.keys(runtimeConfig).join(",") || "none"}]`)
        }
        settleBootstrap()
        log.debug(`push capabilities.update: caps=[${[...bootstrap.caps].join(",") || "none"}]`)
        return
    }
    if (channel === "session.inject" && body && typeof body === "object") {
        injector.push(body, activeClient)
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
function rpc(op, body, timeoutMs, { wait = true } = {}) {
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
}

const debouncer = new EventDebouncer()

/**
 * The opencode SDK client from the active plugin instance. Set in `server()`;
 * used by push consumers (`session.inject`) that fire from the pool data
 * handler, outside the hook closure.
 * @type {import("@opencode-ai/sdk").SdkClient}
 */
let activeClient = null

// ── plugin entry point ────────────────────────────────────────────────
// Named export MUST be `server` (the PluginModule shape
// `{ id?, server, tui? }` from @opencode-ai/plugin): opencode's loader
// resolves `module.server` for config/npm plugins. An arbitrary name
// (e.g. the old `PythonBridge`) is never read — the plugin would load
// but no hooks would run.

export const server = async ({ client, directory, worktree, project }) => {
    log.info(
        `loading — socket=${SOCKET_PATH} failOpen=${FAIL_OPEN} debug=${DEBUG}`,
    )

    // Keep the client for push consumers (session.inject) that fire outside
    // the hook closures, from the pool data handler.
    activeClient = client ?? null

    // Validate socket path exists at startup (best-effort)
    try {
        const fs = await import("node:fs/promises")
        const stat = await fs.stat(SOCKET_PATH)
        if (!stat.isSocket()) {
            log.warn(`${SOCKET_PATH} exists but is NOT a unix socket (type=${stat.mode})`)
        } else {
            log.debug(`socket path verified: ${SOCKET_PATH}`)
        }
    } catch (err) {
        log.warn(`socket path not accessible: ${SOCKET_PATH} — ${err.code ?? err.message}`)
        log.warn("bridge loads inert: all hooks proceed normally until a Python brain connects")
    }

    // Kick off the bootstrap handshake immediately so the first hook call
    // already knows the brain's capabilities. Re-applied on every reconnect.
    pool.onConnect = startBootstrap
    startBootstrap()

    try {
        await client?.app?.log?.({
            body: {
                service: "python-bridge",
                level: "info",
                message: `bridge ready → unix:${SOCKET_PATH} (ndjson, pooled)`,
                extra: { directory, worktree, debug: DEBUG },
            },
        })
    } catch {
        // app.log is best-effort
    }

    return {
        // ── pre-hook ──────────────────────────────────────────────────
        "tool.execute.before": async (input, output) => {
            log.debug(`pre-hook: tool=${input.tool} callID=${input.callID}`)

            debouncer.push({
                type: "tool.execute.before",
                properties: { tool: input.tool, callID: input.callID },
                directory,
                worktree,
            })

            const gate = await gateBlocking("pre")
            if (gate.kind === "skip") {
                // Brain is up but has no pre capability → proceed immediately.
                log.debug(`pre-hook: brain has no pre capability, allowing tool=${input.tool}`)
                return
            }
            if (gate.kind === "inert") {
                // No brain ever connected → plugin is a no-op; proceed normally.
                warnInert()
                log.debug(`pre-hook: inert, allowing tool=${input.tool}`)
                return
            }
            if (gate.kind === "failed") {
                if (!FAIL_OPEN) {
                    log.error(`pre-hook: BLOCKING tool=${input.tool} — python server unreachable (fail-closed)`)
                    throw new Error(
                        `Python pre-hook unreachable at ${SOCKET_PATH} — `
                        + `tool "${input.tool}" blocked (fail-closed mode). `
                        + `Set OPENCODE_FAIL_OPEN=1 to allow through.`,
                    )
                }
                log.warn(`pre-hook: FAIL-OPEN tool=${input.tool} — python server unreachable, allowing through`)
                return
            }

            const decision = okReply(await rpc(
                "pre",
                {
                    tool: input.tool,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    args: output.args,
                    directory,
                    // Task-tool authority: surface the subagent request fields
                    // explicitly so the Python TaskManager gate can decide
                    // without re-parsing opaque args.
                    task: input.tool === "task"
                        ? {
                            prompt: output.args?.prompt,
                            description: output.args?.description,
                            agent: output.args?.agent ?? output.args?.subagent_type,
                            model: output.args?.model,
                        }
                        : undefined,
                },
                PRE_TIMEOUT_MS,
            ))

            if (!decision) {
                if (!FAIL_OPEN) {
                    log.error(`pre-hook: BLOCKING tool=${input.tool} — python server unreachable (fail-closed)`)
                    throw new Error(
                        `Python pre-hook unreachable at ${SOCKET_PATH} — `
                        + `tool "${input.tool}" blocked (fail-closed mode). `
                        + `Set OPENCODE_FAIL_OPEN=1 to allow through.`,
                    )
                }
                log.warn(`pre-hook: FAIL-OPEN tool=${input.tool} — python server unreachable, allowing through`)
                return
            }

            if (decision.args && typeof decision.args === "object") {
                const keys = Object.keys(decision.args)
                log.debug(`pre-hook: modifying args for tool=${input.tool}, keys=${keys.join(",")}`)
                Object.assign(output.args, decision.args)
            }
            if (decision.allow === false) {
                log.warn(`pre-hook: DENIED tool=${input.tool} reason="${decision.reason ?? "no reason"}"`)
                throw new Error(decision.reason || "Blocked by Python pre-hook")
            }
            log.debug(`pre-hook: ALLOWED tool=${input.tool}`)
        },

        // ── permission authority ──────────────────────────────────────
        // `permission.ask` is a blocking authority: the Python brain decides
        // allow / ask / deny for every permission prompt. Task-tool authority
        // is handled by the pre-hook above (tool==="task" flows through the
        // same gate with its full args) — no plugin API launches subagents,
        // so Python's TaskManager rules live behind that gate.
        "permission.ask": async (input, output) => {
            log.debug(`permission.ask: type=${input.type} title="${input.title?.slice(0, 60)}"`)

            debouncer.push({
                type: "permission.asked",
                properties: {
                    type: input.type,
                    pattern: input.pattern,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    title: input.title,
                },
                directory,
                worktree,
            })

            const gate = await gateBlocking("permission")
            if (gate.kind === "skip") {
                // Brain is up but has no permission capability → proceed with
                // the default ask flow (deterministic fast path).
                log.debug("permission.ask: brain has no permission capability, default ask")
                return
            }
            if (gate.kind === "inert") {
                // No brain ever connected → plugin is a no-op; default ask.
                warnInert()
                log.debug("permission.ask: inert, default ask")
                return
            }
            if (gate.kind === "failed") {
                if (!FAIL_OPEN) {
                    log.error("permission.ask: DENYING — python server unreachable (fail-closed)")
                    output.status = "deny"
                    return
                }
                log.warn("permission.ask: FAIL-OPEN — python server unreachable, default ask")
                return
            }

            const decision = okReply(await rpc(
                "permission",
                {
                    id: input.id,
                    type: input.type,
                    pattern: input.pattern,
                    sessionID: input.sessionID,
                    messageID: input.messageID,
                    callID: input.callID,
                    title: input.title,
                    metadata: input.metadata,
                    directory,
                },
                PERMISSION_TIMEOUT_MS,
            ))

            if (!decision) {
                if (!FAIL_OPEN) {
                    log.error("permission.ask: DENYING — python server unreachable (fail-closed)")
                    output.status = "deny"
                    return
                }
                log.warn("permission.ask: FAIL-OPEN — no reply, default ask")
                return
            }

            // Brain reply: {status: "allow"|"ask"|"deny"} (v0.4), with
            // backwards-compat {allow: bool} from the minimal test brain.
            const status = decision.status
                ?? (decision.allow === false ? "deny" : decision.allow === true ? "allow" : "ask")
            if (status === "allow" || status === "ask" || status === "deny") {
                log.debug(`permission.ask: brain says ${status} (${input.type})`)
                output.status = status
            } else {
                log.warn(`permission.ask: unknown status=${status}, default ask`)
            }
        },

        // ── post-hook ─────────────────────────────────────────────────
        "tool.execute.after": async (input, output) => {
            log.debug(`post-hook: tool=${input.tool} callID=${input.callID}`)

            debouncer.push({
                type: "tool.execute.after",
                properties: { tool: input.tool, callID: input.callID },
                directory,
                worktree,
            })

            if (!gateNonBlocking("post")) {
                // Brain has no post capability → leave output unchanged.
                log.debug(`post-hook: brain has no post capability, leaving output unchanged`)
                return
            }

            const decision = okReply(await rpc(
                "post",
                {
                    tool: input.tool,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    args: input.args,
                    title: output.title,
                    output: output.output,
                    metadata: output.metadata,
                    directory,
                },
                POST_TIMEOUT_MS,
            ))

            if (!decision) {
                log.debug(`post-hook: no response for tool=${input.tool}, leaving output unchanged`)
                return
            }

            if (decision.title !== undefined) {
                log.debug(`post-hook: replacing title for tool=${input.tool}`)
                output.title = decision.title
            }
            if (decision.output !== undefined) {
                log.debug(`post-hook: replacing output for tool=${input.tool} (${String(decision.output).length} chars)`)
                output.output = decision.output
            }
            if (decision.metadata && typeof decision.metadata === "object") {
                const keys = Object.keys(decision.metadata)
                log.debug(`post-hook: merging metadata for tool=${input.tool}, keys=${keys.join(",")}`)
                output.metadata = { ...(output.metadata || {}), ...decision.metadata }
            }
        },

        // ── shell env injection ───────────────────────────────────────
        "shell.env": async (input, output) => {
            log.debug(`shell-env: cwd=${input.cwd}`)

            debouncer.push({
                type: "shell.env",
                properties: { cwd: input.cwd },
                directory,
                worktree,
            })

            if (!gateNonBlocking("shellEnv")) {
                // Brain has no shell-env capability → env unchanged.
                log.debug("shell-env: brain has no shellEnv capability, env unchanged")
                return
            }

            const reply = okReply(await rpc(
                "shell-env",
                {
                    cwd: input.cwd,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    directory,
                },
                SHORT_TIMEOUT_MS,
            ))

            if (!reply) {
                log.debug("shell-env: no response, env unchanged")
                return
            }

            if (reply.env && typeof reply.env === "object") {
                const keys = Object.keys(reply.env)
                log.debug(`shell-env: injecting ${keys.length} env vars: ${keys.join(",")}`)
                Object.assign(output.env, reply.env)
            }
        },

        // ── session compaction context ────────────────────────────────
        "experimental.session.compacting": async (input, output) => {
            log.debug(`compacting: sessionID=${input?.sessionID}`)

            if (!gateNonBlocking("context")) {
                // Brain has no context capability → context unchanged.
                log.debug("compacting: brain has no context capability, context unchanged")
                return
            }

            const reply = okReply(await rpc(
                "context",
                {
                    reason: "compacting",
                    sessionID: input?.sessionID,
                    directory,
                    worktree,
                    project: project?.name || project?.id,
                },
                CTX_TIMEOUT_MS,
            ))

            if (!reply) {
                log.debug("compacting: no response, context unchanged")
                return
            }

            if (reply.prompt && typeof reply.prompt === "string") {
                log.debug(`compacting: injecting prompt (${reply.prompt.length} chars)`)
                output.prompt = reply.prompt
                return
            }

            const ctx = reply.context
            if (!ctx) {
                log.debug("compacting: empty context in reply")
                return
            }

            if (Array.isArray(ctx)) {
                log.debug(`compacting: injecting ${ctx.length} context items`)
                output.context.push(...ctx)
            } else if (typeof ctx === "string") {
                log.debug(`compacting: injecting context string (${ctx.length} chars)`)
                output.context.push(ctx)
            }
        },

        // ── event forwarding ──────────────────────────────────────────
        event: async ({ event }) => {
            const type = event.type
            if (!TRACKED_EVENTS.has(type) && !type.startsWith("session.")) return

            const properties = event.properties ?? event.data ?? {}
            log.debug(`event: type=${type} keys=${Object.keys(properties).join(",") || "none"}`)

            if (HOOKABLE_EVENTS.has(type)) {
                if (!gateNonBlocking("eventPipeline")) {
                    // Brain has no event.pipeline capability → skip pipeline.
                    log.debug(`event: brain has no eventPipeline capability, skipping ${type}`)
                    return
                }
                // Synchronous pipeline: pre-hooks → store → post-hooks.
                // The host never awaits event hooks (H3 spike verdict), so
                // this RPC runs to its own deadline without blocking
                // OpenCode's event loop; results are informational only.
                const result = okReply(await rpc(
                    "event.pipeline",
                    { type, properties, directory, worktree },
                    PIPELINE_TIMEOUT_MS,
                ))

                if (result?.blocked) {
                    log.info(`event: BLOCKED by pre-hook: ${type}`)
                    return
                }

                log.debug(`event: pipeline ok, hooks_ran=${(result?.hooks_ran ?? []).join(",") || "none"}`)
            } else {
                // Non-hookable events: debounced fire-and-forget.
                debouncer.push({ type, properties, directory, worktree })
            }

            // Context-trigger events sync relevant context into
            // STATE.live_context server-side.
            if (CONTEXT_TRIGGER_EVENTS.has(type) && gateNonBlocking("context")) {
                log.debug(`event: syncing context for ${type}`)
                rpc(
                    "context",
                    { reason: type, properties, directory, worktree },
                    CTX_TIMEOUT_MS,
                    { wait: false },
                ).catch((err) => {
                    log.debug(`event: context sync failed for ${type}: ${err.message}`)
                })
            }
        },
    }
}
