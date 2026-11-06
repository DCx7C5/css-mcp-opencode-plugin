/**
 * Signal detector plugin — watches the opencode event stream locally and
 * emits one `signal` RPC per matched pattern. It is deliberately a thin
 * transport concern: the pattern list and the cooldown live here, all
 * decision/action logic stays in the Python brain.
 *
 * Detection is structured only: a signal is sent when the provider layer
 * raises its typed error (`error.type`), never when a sentence in assistant
 * text, a user prompt, an injected context or a client-rendered toast happens
 * to contain the same words. Those surfaces run through the same event bus
 * and may quote the error verbatim; matching them would attribute the client
 * frontend's text to the client backend.
 *
 * Why a dedicated op instead of `event`: the event stream is fire-and-forget
 * and unbounded, and a signal is a rare, actionable observation, so it gets
 * its own request/reply op on the existing events prefix (`e:`).
 *
 * Reply expectation: sent with `wait: false` — the event loop never waits
 * for the brain. The reply (or an unknown-op error from an older brain) is
 * matched by the durable pending map and ignored on timeout.
 *
 * Cooldown: one minute per signal/session. The Python action registry keeps
 * the authoritative global cooldown; this one only avoids socket spam.
 */

import {
    startBridge,
    directory,
    worktree,
    rpc,
    timeouts,
    PLUGIN_PREFIX,
    debugEnabled,
} from "./transport.js"

/**
 * Signals the plugin forwards. Each entry becomes one Python signal name.
 *
 * `errorTypes` is the whole matcher: the provider layer's typed error is the
 * only evidence that the backend — not a prompt, an assistant reply or an
 * injected context — produced the condition.
 */
const SIGNALS = [
    {
        id: "free_messages_exhausted",
        // The type the provider layer assigns when the backend's 429 body is
        // `FreeUsageLimitError`. The TUI sentence ("You've used today's free
        // messages…") is rendered client-side from retryAfterMs and never
        // appears on the wire, so it was never a usable trigger.
        errorTypes: ["provider.free-limit"],
    },
]

/**
 * Per signal/session suppression window.
 *
 * One minute, not ten: after a WAN reconnect that did not take effect (the
 * client kept a pre-reconnect TCP flow), the only useful retry window is the
 * ~30 s the old flow needs to idle out. A ten-minute window suppressed that
 * retry entirely; a minute still stops a reconnect storm across sessions.
 */
const COOLDOWN_MS = 60 * 1000

/** Upper bound on the matched text shipped over the socket. */
const EXCERPT_MAX = 500

/**
 * The only surfaces that carry the provider's structured error — the runtime
 * hook names, i.e. the `@opencode/protocol` event types.
 *
 * `session.text.ended` (assistant text) and `tui.toast.show` are deliberately
 * absent: both can echo the error sentence from a user prompt, an assistant
 * reply or an injected context, and a signal must only ever come from the
 * client backend. The SDK's `session.next.*` spelling is a client-stream
 * alias and NEVER reaches the plugin `event` hook; do not reintroduce it.
 */
const WATCHED_EVENTS = new Set([
    "session.step.failed",
    "session.execution.failed",
])

/** Coerce an arbitrary event value to text without throwing on cycles. */
const asText = (value) => {
    if (typeof value === "string") return value
    if (value == null) return ""
    try {
        return JSON.stringify(value)
    } catch {
        return ""
    }
}

/** v2 events carry `properties`; the durable variant carries `data`. */
const propertiesOf = (event) => event?.properties ?? event?.data ?? {}

/** The error object of one watched event, as text (the signal excerpt). */
const eventText = (type, props) => {
    switch (type) {
        case "session.step.failed":
        case "session.execution.failed":
            return asText(props.error)
        default:
            return ""
    }
}

export const server = async ({ client, directory: dir, worktree: wt, project }) => {
    startBridge({ client, directory: dir, worktree: wt, project })
    const debug = debugEnabled()
    const log = (msg) => debug && console.debug("[python-bridge]", "[debug]", msg)

    /** `${signal.id}:${sessionID}` → last send timestamp. */
    const lastSent = new Map()

    /**
     * First signal whose structured error type matches *props*, or null.
     *
     * Only `props.error.type` is consulted. A blank `type` never matches, and
     * a bare `status: 429` is not enough: the provider layer already classifies
     * the body, and a 429 from another cause must not borrow this signal's
     * reconnect action.
     */
    const match = (props) => {
        const error = props?.error
        const errorType = typeof error?.type === "string" ? error.type : ""
        if (!errorType) return null

        for (const signal of SIGNALS) {
            if (signal.errorTypes?.includes(errorType)) return signal
        }
        return null
    }

    return {
        event: async ({ event }) => {
            const type = event?.type
            if (!WATCHED_EVENTS.has(type)) return

            const props = propertiesOf(event)
            const text = eventText(type, props)

            const signal = match(props)
            if (!signal) return

            const sessionID = props.sessionID ?? props.part?.sessionID ?? ""
            const messageID = props.messageID ?? props.assistantMessageID ?? props.part?.messageID ?? null
            const key = `${signal.id}:${sessionID || "unknown"}`
            const now = Date.now()
            const last = lastSent.get(key) ?? 0
            if (now - last < COOLDOWN_MS) {
                log(`signal: ${signal.id} suppressed (cooldown, session=${sessionID || "unknown"})`)
                return
            }
            lastSent.set(key, now)

            log(`signal: ${signal.id} matched in ${type} session=${sessionID || "unknown"}`)
            rpc(
                "signal",
                {
                    signal: signal.id,
                    sessionID: sessionID || null,
                    messageID,
                    matched: typeof props?.error?.type === "string" ? props.error.type : "",
                    excerpt: text.slice(0, EXCERPT_MAX),
                    at: now,
                    directory: directory() ?? dir,
                    // The brain measures this process's live egress flows with
                    // psutil: a WAN flap only moves the public address for new
                    // flows, so a surviving keep-alive socket keeps the old
                    // identity and the old limit. The pid is the one fact only
                    // the plugin can supply; the sockets come from the kernel.
                    pid: process.pid,
                },
                timeouts.pipeline,
                { wait: false, prefix: PLUGIN_PREFIX.events },
            )
        },
    }
}

// ── opencode v2 contract ────────────────────────────────────────────────
// v2 loads plugins from a DEFAULT export: an object `{ id, setup(ctx) }`
// that registers hooks through the plugin context. The v1 `server` export
// above is retained for the legacy loader and npm test; the default
// definition re-registers the same hook map through the v2 domain APIs
// (see opencode-v2.js for the event adapters).
import { definePlugin, bridgeHooksV2 } from "./opencode-v2.js"

export default definePlugin("css-mcp-opencode-plugin/signals", (ctx) =>
    bridgeHooksV2(ctx, [server]),
)
