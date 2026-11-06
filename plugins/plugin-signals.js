/**
 * Signal detector plugin — watches the opencode event stream locally and
 * emits one `signal` RPC per matched pattern. It is deliberately a thin
 * transport concern: the pattern list and the cooldown live here, all
 * decision/action logic stays in the Python brain.
 *
 * Why a dedicated op instead of `event`: the event stream is fire-and-forget
 * and unbounded, and `session.next.text.ended` is not in the plugin's
 * hookable set, so a Python hook cannot see it. A `signal` is a rare,
 * actionable observation and gets its own request/reply op on the existing
 * events prefix (`e:`).
 *
 * Reply expectation: sent with `wait: false` — the event loop never waits
 * for the brain. The reply (or an unknown-op error from an older brain) is
 * matched by the durable pending map and ignored on timeout.
 *
 * Cooldown: 10 minutes per signal/session. The Python action registry keeps
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

/** Patterns the plugin forwards. Each entry becomes one Python signal name. */
const SIGNALS = [
    {
        id: "free_messages_exhausted",
        // The wire error the provider layer raises on a 429 free-quota
        // rejection. The TUI sentence ("You've used today's free messages…")
        // is rendered client-side from retryAfterMs and never appears on the
        // wire, so matching it could never fire.
        contains: "Free usage limit reached",
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
 * Events that can carry the pattern — the runtime hook names, i.e. the
 * `@opencode/protocol` event types. The SDK's `session.next.*` spelling is a
 * client-stream alias and NEVER reaches the plugin `event` hook; do not
 * reintroduce it. `session.text.ended` is the assistant-text surface, and the
 * two failures carry `data.error` (`{type, message, status, response, …}`).
 */
const WATCHED_EVENTS = new Set([
    "session.text.ended",
    "session.step.failed",
    "session.execution.failed",
    "tui.toast.show",
])

/** Normalize typographic apostrophes and whitespace before matching. */
const normalize = (text) => text.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim()

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

/** Extract the candidate text for one watched event. */
const eventText = (type, props) => {
    switch (type) {
        case "session.text.ended":
            return asText(props.text)
        case "session.step.failed":
        case "session.execution.failed":
            return asText(props.error)
        case "tui.toast.show":
            return [props.title, props.message].filter(Boolean).map(asText).join(" ")
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

    /** First configured pattern matched by *props* (structured) or *text*, or null. */
    const match = (text, props) => {
        const error = props?.error
        const errorType = typeof error?.type === "string" ? error.type : ""
        const errorStatus = typeof error?.status === "number" ? error.status : 0
        const haystack = normalize(text)

        for (const signal of SIGNALS) {
            if (errorType && signal.errorTypes?.includes(errorType)) return signal
            if (errorStatus === 429 && signal.errorTypes?.length) return signal
            if (haystack && signal.contains && haystack.includes(normalize(signal.contains))) return signal
        }
        return null
    }

    return {
        event: async ({ event }) => {
            const type = event?.type
            if (!WATCHED_EVENTS.has(type)) return

            const props = propertiesOf(event)
            const text = eventText(type, props)

            const signal = match(text, props)
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
                    matched: signal.contains,
                    excerpt: text.slice(0, EXCERPT_MAX),
                    at: now,
                    directory: directory() ?? dir,
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
