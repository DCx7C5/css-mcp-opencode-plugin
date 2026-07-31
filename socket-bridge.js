/**
 * OpenCode ↔ Python bridge — raw NDJSON over Unix socket
 * Socket: /var/run/css-mcp/hooks.sock
 *
 * Debug: set OPENCODE_BRIDGE_DEBUG=1 or OPENCODE_DEBUG=* in env.
 * Logs go to stderr (opencode captures it).
 *
 * Architecture:
 *   - Persistent connection pool: one shared socket, reconnected on failure
 *   - Request/response multiplexing by UUID
 *  - Event debouncing for rapid fire-and-forget events
 *  - Fail-closed by default for blocking ops (OPENCODE_FAIL_OPEN === "1" to opt in)
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

const PRE_TIMEOUT_MS = parseTimeout(process.env.OPENCODE_PRE_TIMEOUT, 5_000)
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
 * @param {object|null} msg
 * @returns {object|null}
 */
const okReply = (msg) => (msg && msg.ok === true ? msg : null)

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
    /** @type {Map<string, { resolve: (v: object|null) => void, timer: ReturnType<typeof setTimeout> }>} */
    #pending = new Map()
    /** @type {number | null} */
    #reconnectTimer = null
    /** @type {number} */
    #reconnectDelay = RECONNECT_BASE_MS

    /** @param {string} path — UNIX socket path */
    constructor(path) {
        this.#path = path
    }

    /** Number of in-flight requests. */
    get pendingCount() {
        return this.#pending.size
    }

    /** Whether the socket is currently connected. */
    get connected() {
        return this.#socket !== null && !this.#socket.destroyed && this.#socket.writable
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

        socket.on("connect", () => {
            this.#socket = socket
            this.#connecting = false
            this.#reconnectDelay = RECONNECT_BASE_MS
            log.debug(`pool: connected (${this.#pending.size} pending)`)
        })

        socket.on("data", (chunk) => {
            this.#buf += chunk.toString("utf8")
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

        socket.on("error", (err) => {
            log.debug(`pool: socket error: ${err.code ?? err.message}`)
            this.#onDisconnect(socket)
        })

        socket.on("close", (hadError) => {
            log.debug(`pool: socket close (hadError=${hadError})`)
            this.#onDisconnect(socket)
        })
    }

    /**
     * Handle disconnection — reject pending, schedule reconnect.
     * Idempotent: the socket identity guard prevents a single failure
     * (error + close double-fire) from tearing down a replacement socket.
     * @param {import("node:net").Socket} [sock]
     */
    #onDisconnect(sock) {
        if (sock && this.#socket !== sock) return
        this.#socket = null
        this.#connecting = false
        this.#buf = ""

        // Reject all pending requests
        for (const [id, entry] of this.#pending) {
            clearTimeout(entry.timer)
            entry.resolve(null)
        }
        this.#pending.clear()

        this.#scheduleReconnect()
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
     * Send one NDJSON request, wait for matching-id response.
     *
     * @param {string} op
     * @param {object} body
     * @param {number} timeoutMs
     * @returns {Promise<object|null>}
     */
    rpc(op, body, timeoutMs) {
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
                this.#ensureConnected()
                return false
            }

            if (this.#socket && !this.#socket.destroyed && this.#socket.writable) {
                doWrite()
                return
            }

            // Not connected yet — poll until writable, connection fails, or
            // the deadline fires. Cleared in every exit path.
            poll = setInterval(() => {
                if (this.#socket && !this.#socket.destroyed && this.#socket.writable) {
                    if (doWrite()) {
                        clearInterval(poll)
                        poll = null
                    }
                } else if (!this.#connecting && !this.#socket) {
                    clearInterval(poll)
                    poll = null
                    clearTimeout(timer)
                    this.#pending.delete(id)
                    resolve(null)
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
        for (const [id, entry] of this.#pending) {
            clearTimeout(entry.timer)
            entry.resolve(null)
        }
        this.#pending.clear()
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
 * @param {string} op
 * @param {object} body
 * @param {number} timeoutMs
 * @param {{ wait?: boolean }} opts
 * @returns {Promise<object|null>}
 */
function rpc(op, body, timeoutMs, { wait = true } = {}) {
    const shortId = String(++_shortIdCounter).padStart(8, "0")
    log.debug(`rpc[${shortId}] → op=${op} timeout=${timeoutMs}ms wait=${wait}`)

    if (!wait) {
        // Fire-and-forget: send, resolve immediately, don't wait for response.
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
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
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
            rpc("event", batch[0], SHORT_TIMEOUT_MS, { wait: false })
        } else {
            // Batched — send as batch event
            log.debug(`debounce: flush ${batch.length} events: ${batch.map(e => e.type).join(",")}`)
            rpc("event", { type: "event.batch", events: batch }, SHORT_TIMEOUT_MS, { wait: false })
        }
    }
}

const debouncer = new EventDebouncer()

// ── plugin entry point ────────────────────────────────────────────────

export const PythonBridge = async ({ client, directory, worktree, project }) => {
    log.info(
        `loading — socket=${SOCKET_PATH} failOpen=${FAIL_OPEN} debug=${DEBUG}`,
    )

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
        log.warn("hook calls will timeout until the Python server creates the socket")
    }

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

            const decision = okReply(await rpc(
                "pre",
                {
                    tool: input.tool,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    args: output.args,
                    directory,
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

        // ── post-hook ─────────────────────────────────────────────────
        "tool.execute.after": async (input, output) => {
            log.debug(`post-hook: tool=${input.tool} callID=${input.callID}`)

            debouncer.push({
                type: "tool.execute.after",
                properties: { tool: input.tool, callID: input.callID },
                directory,
                worktree,
            })

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
                // Synchronous pipeline: pre-hooks → store → post-hooks.
                // Blocks OpenCode's event loop until the Python pipeline returns.
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
            if (CONTEXT_TRIGGER_EVENTS.has(type)) {
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
