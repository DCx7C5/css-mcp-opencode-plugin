/**
 * TUI tab-producer tests — the TUI plugin context is the only one with a tab
 * strip. `plugins/tui-tabs.js` is imported directly: `plugins/tui.js` imports
 * `@opencode/plugin/tui`, which only resolves inside the opencode runtime.
 *
 * Assertions:
 *  - both runtime tab shapes normalize to `{key, sessionID, active}`, drafts
 *    keep `sessionID: null`;
 *  - a disabled strip sends `tabs: []`, a missing/throwing strip sends nothing;
 *  - the push is `e:tabs` with `wait:false` and `timeouts.pipeline`;
 *  - setup pushes immediately, on both failure events and on the interval,
 *    and cleanup unsubscribes both events and stops the interval;
 *  - a rejecting transport or a throwing strip never escapes setup or a
 *    handler.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createTabsDefinition, createTabsPusher, tabPayload, TABS_INTERVAL_MS } from "../plugins/tui-tabs.js"
import { PLUGIN_PREFIX, timeouts } from "../plugins/transport.js"

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A TUI context with a static tab strip and captured event listeners. */
function fakeContext({ tabs, enabled = true, data } = {}) {
    const listeners = new Map()
    const unsubscribed = []
    const context = {
        ui: { tabs: { enabled: () => enabled, list: () => tabs } },
        data: data ?? {
            on(type, handler) {
                listeners.set(type, handler)
                return () => {
                    unsubscribed.push(type)
                    listeners.delete(type)
                }
            },
        },
    }
    return { context, listeners, unsubscribed }
}

/** The shape measured from the 2.2.5 TUI (`context.ui.tabs.list()`). */
const measuredTabs = [
    { sessionID: "ses_one", title: "One", active: true, busy: false, attention: false, unread: "activity" },
    { sessionID: "ses_two", title: "Two", active: false, busy: true, attention: true, unread: "error" },
]

test("tabPayload normalizes the measured 2.2.5 TUI shape", () => {
    const { context } = fakeContext({ tabs: measuredTabs })
    const payload = tabPayload(context)
    assert.ok(payload)
    assert.equal(typeof payload.at, "number")
    assert.ok(payload.at <= Date.now())
    assert.deepEqual(payload.tabs, [
        { key: null, sessionID: "ses_one", active: true },
        { key: null, sessionID: "ses_two", active: false },
    ])
})

test("tabPayload supports the GUI tab shape and keeps drafts", () => {
    const { context } = fakeContext({
        tabs: [
            { key: "tab-a", session: { id: "ses_a" }, active: true },
            { key: "tab-draft", session: undefined, active: false },
        ],
    })
    assert.deepEqual(tabPayload(context).tabs, [
        { key: "tab-a", sessionID: "ses_a", active: true },
        { key: "tab-draft", sessionID: null, active: false },
    ])
})

test("tabPayload sends an empty list when tabs are disabled", () => {
    const { context } = fakeContext({ tabs: measuredTabs, enabled: false })
    const payload = tabPayload(context)
    assert.deepEqual(payload.tabs, [])
    assert.equal(typeof payload.at, "number")
})

test("tabPayload is null when the context has no usable strip", () => {
    assert.equal(tabPayload({}), null)
    assert.equal(tabPayload(null), null)
    assert.equal(tabPayload({ ui: { tabs: { enabled: () => true, list: () => { throw new Error("boom") } } } }), null)
    assert.equal(tabPayload({ ui: { tabs: { enabled: () => { throw new Error("boom") }, list: () => [] } } }), null)
    assert.equal(tabPayload({ ui: { tabs: { enabled: () => true, list: () => "nope" } } }), null)
})

test("createTabsPusher sends e:tabs without waiting", async () => {
    const { context } = fakeContext({ tabs: measuredTabs })
    const calls = []
    const push = createTabsPusher(context, async (...args) => { calls.push(args) })
    await push()
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], "tabs")
    assert.deepEqual(calls[0][1].tabs, [
        { key: null, sessionID: "ses_one", active: true },
        { key: null, sessionID: "ses_two", active: false },
    ])
    assert.equal(calls[0][2], timeouts.pipeline)
    assert.deepEqual(calls[0][3], { wait: false, prefix: PLUGIN_PREFIX.events })
    assert.equal(PLUGIN_PREFIX.events, "e")
})

test("createTabsPusher never throws when the transport rejects", async () => {
    const { context } = fakeContext({ tabs: measuredTabs })
    const push = createTabsPusher(context, async () => { throw new Error("no brain") })
    await push()
})

test("createTabsPusher never throws when the strip itself misbehaves", async () => {
    const hostile = new Proxy([], {
        get(target, property, receiver) {
            if (property === "map") throw new Error("hostile strip")
            return Reflect.get(target, property, receiver)
        },
    })
    const { context } = fakeContext({ tabs: hostile })
    const push = createTabsPusher(context, async () => {})
    await push()
})

test("setup pushes on creation, both failure events and the interval, then cleanup stops it", async () => {
    const { context, listeners, unsubscribed } = fakeContext({ tabs: measuredTabs })
    const calls = []
    const definition = createTabsDefinition({
        send: async (...args) => { calls.push(args) },
        intervalMs: 10,
    })
    assert.equal(definition.id, "css-mcp-opencode-plugin/tui")
    const cleanup = definition.setup(context)
    assert.equal(typeof cleanup, "function")

    assert.equal(calls.length, 1)

    listeners.get("session.execution.failed")()
    assert.equal(calls.length, 2)
    listeners.get("session.step.failed")()
    assert.equal(calls.length, 3)

    await delay(40)
    assert.ok(calls.length > 3, "the interval republishes")

    cleanup()
    const afterCleanup = calls.length
    assert.deepEqual(unsubscribed.sort(), ["session.execution.failed", "session.step.failed"])

    await delay(40)
    assert.equal(calls.length, afterCleanup)
})

test("setup tolerates missing and throwing event buses", async () => {
    const { context: missing } = fakeContext({ tabs: measuredTabs })
    delete missing.data
    const missingCalls = []
    const missingCleanup = createTabsDefinition({
        send: async (...args) => { missingCalls.push(args) },
        intervalMs: 1000,
    }).setup(missing)
    assert.equal(missingCalls.length, 1)
    missingCleanup()

    const { context: throwing } = fakeContext({
        tabs: measuredTabs,
        data: { on() { throw new Error("no bus") } },
    })
    const throwingCalls = []
    const throwingCleanup = createTabsDefinition({
        send: async (...args) => { throwingCalls.push(args) },
        intervalMs: 1000,
    }).setup(throwing)
    assert.equal(throwingCalls.length, 1)
    throwingCleanup()
})
