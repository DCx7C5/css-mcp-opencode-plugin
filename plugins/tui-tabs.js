/**
 * TUI tab-strip producer.
 *
 * This runs in the TUI plugin context — the only context that owns a tab
 * strip (`context.ui.tabs`); the server context has none. The server-side
 * `tabs` field in `plugin-signals.js` is therefore always empty, so the TUI
 * part republishes the strip on a timer and on the two failure surfaces.
 *
 * The definition lives here rather than in `tui.js` because
 * `@opencode/plugin/tui` only resolves inside the opencode runtime; keeping
 * the logic separate lets `node --test` exercise it without that package.
 */
import { PLUGIN_PREFIX, rpc, timeouts } from "./transport.js"

/** Republish cadence: tabs change on open/close/focus, not on every token. */
export const TABS_INTERVAL_MS = 15000

/**
 * Build the `tabs` wire body from a TUI context, or `null` when the context
 * has no usable tab strip (missing `ui.tabs`, a throwing accessor).
 *
 * Runtime shapes differ: the 2.2.5 TUI exposes
 * `{sessionID, title, active, busy, attention, unread}` per tab, while the
 * GUI window context exposes `{key, session: {id} | undefined, active}`.
 * Both are normalized to `{key, sessionID, active}`; a draft tab keeps
 * `sessionID: null`, and a tab with no window key keeps `key: null`.
 *
 * @param {object | null | undefined} context
 * @returns {{ tabs: Array<{ key: string | null, sessionID: string | null, active: boolean }>, at: number } | null}
 */
export function tabPayload(context) {
    const tabs = readTabs(context)
    if (tabs === null) return null

    let enabled = false
    try {
        enabled = typeof tabs.enabled === "function" && Boolean(tabs.enabled())
    } catch {
        return null
    }
    if (!enabled) return { tabs: [], at: Date.now() }

    let list
    try {
        list = tabs.list()
    } catch {
        return null
    }
    if (!Array.isArray(list)) return null

    return {
        tabs: list.map((tab) => ({
            key: nonEmptyString(tab?.key) ?? null,
            sessionID: tabSessionID(tab),
            active: tab?.active === true,
        })),
        at: Date.now(),
    }
}

/**
 * Build a guarded push function. `send` is `rpc` in production and a stub in
 * tests; a transport failure (or a missing brain) must never escape a TUI
 * event handler.
 *
 * @param {object | null | undefined} context
 * @param {typeof rpc} [send]
 * @returns {() => Promise<void>}
 */
export function createTabsPusher(context, send = rpc) {
    return async function pushTabs() {
        try {
            const payload = tabPayload(context)
            if (payload === null) return
            await send("tabs", payload, timeouts.pipeline, { wait: false, prefix: PLUGIN_PREFIX.events })
        } catch {
            // Metadata only: a dead socket is the normal no-brain state, and
            // nothing this function does may escape into a TUI handler.
        }
    }
}

/**
 * Build the TUI plugin definition. Exported separately from `tui.js` so the
 * test suite can drive `setup` without importing `@opencode/plugin/tui`.
 *
 * @param {{ send?: typeof rpc, intervalMs?: number }} [options]
 * @returns {{ id: string, setup: (context: object) => () => void }}
 */
export function createTabsDefinition({ send = rpc, intervalMs = TABS_INTERVAL_MS } = {}) {
    return {
        id: "css-mcp-opencode-plugin/tui",
        setup(context) {
            const push = createTabsPusher(context, send)
            void push()

            const stops = []
            try {
                stops.push(context.data.on("session.execution.failed", () => { void push() }))
                stops.push(context.data.on("session.step.failed", () => { void push() }))
            } catch {
                // No event bus: the interval still republishes.
            }

            const timer = setInterval(() => { void push() }, intervalMs)
            timer.unref?.()

            return () => {
                clearInterval(timer)
                for (const stop of stops) {
                    try {
                        stop()
                    } catch {
                        // Cleanup is best-effort.
                    }
                }
            }
        },
    }
}

/** @param {object | null | undefined} context */
function readTabs(context) {
    try {
        return context?.ui?.tabs ?? null
    } catch {
        return null
    }
}

/** @param {unknown} value */
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined
}

/** @param {object | null | undefined} tab */
function tabSessionID(tab) {
    const direct = nonEmptyString(tab?.sessionID)
    if (direct !== undefined) return direct
    return nonEmptyString(tab?.session?.id) ?? null
}
