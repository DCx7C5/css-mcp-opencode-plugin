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
        contains: "You've used today's free messages. They reset at",
    },
]

/** Per signal/session suppression window. */
const COOLDOWN_MS = 10 * 60 * 1000

/** Upper bound on the matched text shipped over the socket. */
const EXCERPT_MAX = 500

/**
 * Events that can carry the pattern. `session.next.text.ended` is the normal
 * assistant-text surface; the rest cover provider errors and TUI messages.
 * `message.part.updated` is a fallback for runtimes that only emit parts —
 * it is restricted to completed, non-synthetic text parts so streamed deltas
 * cannot fire the signal repeatedly.
 */
const WATCHED_EVENTS = new Set([
    "session.next.text.ended",
    "session.next.step.failed",
    "session.error",
    "tui.toast.show",
    "message.part.updated",
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
        case "session.next.text.ended":
            return asText(props.text)
        case "session.next.step.failed":
        case "session.error":
            return asText(props.error)
        case "tui.toast.show":
            return [props.title, props.message].filter(Boolean).map(asText).join(" ")
        case "message.part.updated": {
            const part = props.part
            if (!part || part.type !== "text" || part.synthetic || part.ignored) return ""
            if (!part.time?.end) return ""
            return asText(part.text)
        }
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

    /** First configured pattern contained in *text*, or null. */
    const match = (text) => {
        const haystack = normalize(text)
        if (!haystack) return null
        for (const signal of SIGNALS) {
            if (haystack.includes(normalize(signal.contains))) return signal
        }
        return null
    }

    return {
        event: async ({ event }) => {
            const type = event?.type
            if (!WATCHED_EVENTS.has(type)) return

            const props = propertiesOf(event)
            const text = eventText(type, props)
            if (!text) return

            const signal = match(text)
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
