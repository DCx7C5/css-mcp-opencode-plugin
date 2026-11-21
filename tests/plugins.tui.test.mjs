/**
 * TUI part tests — the tab-strip producer, the definition that boots it, and
 * the tab-fork channel that moves the strip.
 *
 * The TUI plugin context is the only one with a tab strip and the only one
 * whose environment carries the credential keys. `plugins/tui-tabs.js` and
 * `plugins/tui-control.js` are imported directly: `plugins/tui.js` imports
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
 *    handler;
 *  - `createTuiDefinition` boots `startBridge({part:"tui"})` with NO client and
 *    before the first publish, then registers the control channels with the
 *    context's own client/strip/state bus/logger, then publishes; a throwing
 *    boot step still leaves a working publisher;
 *  - `tabs.fork` swaps every open tab onto a fork — fork → open → move into the
 *    old tab's re-read index → verified close, per tab — ignores draft tabs,
 *    skips a subagent child without forking or closing it, leaves the old tab
 *    open on a failed fork and continues, treats a step that throws or answers
 *    `false` as that step's failure, degrades a refused or unavailable move
 *    without stopping the swap, verifies each close by re-reading the strip
 *    (one retry, then the TUI's own close command — skipped when the old tab
 *    cannot be focused), reports a tab it could not prove closed under
 *    `failed`/`unclosed`, leaves a lineage source alone, focuses only the
 *    pre-cycle active tab's fork after the loop (a refused focus is degraded),
 *    answers `tabs_disabled` for a strip that is off or unreadable, and always
 *    replies with all six arrays — `{moves, failed, skipped, lineage, degraded,
 *    unclosed}`.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
    createTabsDefinition,
    createTabsPusher,
    createTuiDefinition,
    tabPayload,
    TABS_INTERVAL_MS,
} from "../plugins/tui-tabs.js"
import { createTuiControlHandlers } from "../plugins/tui-control.js"
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

// ── composition: boot the bridge, wire the controls, then publish ──────

test("createTuiDefinition boots startBridge({part:'tui'}) with no client before the first publish", () => {
    const { context } = fakeContext({ tabs: measuredTabs })
    const order = []
    const boots = []
    const registrations = []
    const sends = []
    const definition = createTuiDefinition({
        intervalMs: 1000,
        boot: (input) => {
            boots.push(input)
            order.push("startBridge")
        },
        register: (input) => {
            registrations.push(input)
            order.push("registerTuiControl")
        },
        send: async (...args) => {
            sends.push(args)
            order.push("publish")
        },
    })
    assert.equal(definition.id, "css-mcp-opencode-plugin/tui")

    const cleanup = definition.setup(context)
    assert.equal(typeof cleanup, "function")

    assert.equal(boots.length, 1, "startBridge is booted exactly once")
    assert.deepEqual(boots[0], { part: "tui" })
    assert.equal(Object.hasOwn(boots[0], "client"), false, "the TUI part must install no client")
    assert.equal(registrations.length, 1, "the control channels are registered once")
    assert.deepEqual(order, ["startBridge", "registerTuiControl", "publish"])
    assert.equal(sends.length, 1)

    cleanup()
})

test("createTuiDefinition hands the context's own client, strip, state bus and logger to the controls", () => {
    const tabs = { enabled: () => true, list: () => measuredTabs }
    const client = { session: {} }
    const data = { session: { get: () => undefined } }
    const log = { debug: () => {} }
    const seen = []
    const cleanup = createTuiDefinition({
        intervalMs: 1000,
        boot: () => {},
        register: (input) => seen.push(input),
        send: async () => {},
    }).setup({ client, ui: { tabs }, data, log })

    assert.equal(seen.length, 1)
    assert.equal(seen[0].client, client)
    assert.equal(seen[0].tabs, tabs)
    assert.equal(seen[0].data, data)
    assert.equal(seen[0].log, log)
    cleanup()
})

test("createTuiDefinition passes a null strip when the context has no tab strip", () => {
    const seen = []
    const cleanup = createTuiDefinition({
        intervalMs: 1000,
        boot: () => {},
        register: (input) => seen.push(input),
        send: async () => {},
    }).setup({ client: {}, data: {}, log: {} })

    assert.equal(seen[0].tabs, null)
    cleanup()
})

test("createTuiDefinition keeps a working tab publisher when a boot step throws", () => {
    const { context } = fakeContext({ tabs: measuredTabs })
    const calls = []

    const bootFailure = createTuiDefinition({
        intervalMs: 1000,
        boot: () => {
            throw new Error("no transport")
        },
        register: () => {},
        send: async (...args) => {
            calls.push(args)
        },
    })
    const bootCleanup = bootFailure.setup(context)
    assert.equal(calls.length, 1, "the first publish still happens")
    bootCleanup()

    const registerFailure = createTuiDefinition({
        intervalMs: 1000,
        boot: () => {},
        register: () => {
            throw new Error('onPush: channel "credential.remove" already has a handler')
        },
        send: async (...args) => {
            calls.push(args)
        },
    })
    const registerCleanup = registerFailure.setup(context)
    assert.equal(calls.length, 2, "a duplicate registration still yields a publish")
    registerCleanup()
})

// ── tabs.fork: the whole-strip command ────────────────────────────────

/**
 * The session id of either runtime tab shape, mirroring the plugin's reader.
 * @param {object | null | undefined} tab
 */
function tabSessionIDOf(tab) {
    if (typeof tab?.sessionID === "string" && tab.sessionID) return tab.sessionID
    const nested = typeof tab?.session === "object" && tab?.session !== null ? tab.session.id : undefined
    return typeof nested === "string" ? nested : ""
}

/**
 * A tab strip that records every mutation into the shared `calls` array, so
 * the per-tab sequence across the client and the strip is directly assertable.
 *
 * The strip models its own state the way the runtime one does: `open` appends
 * an entry, `move` re-splices one into another slot, `close` removes it, and
 * `list()` answers a copy of the ordered array (the same tab objects, so the
 * `active` flag survives a read). Order matters: the fork re-reads the strip
 * per target to find the old tab's index, so a fake that collapsed the strip
 * would hide a stale-index bug. That is also what makes a "close resolved"
 * fake distinguishable from a real removal — the fork re-reads the strip, so a
 * fake that never removes would report every tab unclosed.
 *
 * `enabled`/`tabs` may be the literal "throw" to exercise an unreadable strip.
 * `failOn` makes one method throw; `refuseOn` makes the named method(s) answer
 * `false` and change nothing (a string, an array, or a `(method, sessionID) =>
 * boolean` predicate — the predicate is what refuses the fallback's focus of
 * one specific tab); `refuseClose` makes `close` answer `false` and keep the
 * tab (the silent refusal the fallback exists for); `ignoreClose` makes it
 * answer success without removing the entry (`true` for good, a number for the
 * first N closes — the retry then lands); `unreadableAfter` makes `list()`
 * throw from read N+1 on, so a post-close verification cannot be proven.
 * `remove` simulates the TUI's own close command landing on the strip.
 *
 * `move(sessionID, index)` mirrors the runtime adapter: an id the strip does
 * not list answers `false`; otherwise the tab is removed and spliced back at
 * the clamped index, answering `true`. It never focuses.
 */
function fakeStrip(
    calls,
    {
        tabs = measuredTabs,
        enabled = true,
        failOn,
        refuseOn = [],
        refuseClose = false,
        ignoreClose = false,
        unreadableAfter,
    } = {},
) {
    const listed = Array.isArray(tabs) ? [...tabs] : null
    let reads = 0
    let swallowed = 0
    let refused = 0
    const refuses = (method, sessionID) => {
        if (typeof refuseOn === "function") return refuseOn(method, sessionID) === true
        const methods = Array.isArray(refuseOn) ? refuseOn : [refuseOn]
        return methods.includes(method)
    }
    const indexOf = (sessionID) => listed.findIndex((tab) => tabSessionIDOf(tab) === sessionID)
    const record = (method) => (sessionID) => {
        calls.push({ method, sessionID })
        if (failOn === method) throw new Error(`${method} refused ${sessionID}`)
        if (refuses(method, sessionID)) return false
        if (!listed) return undefined
        if (method === "open") {
            listed.push({ sessionID })
            return undefined
        }
        if (method === "close") {
            const refusals = refuseClose === true ? Infinity : Number(refuseClose) || 0
            if (refused < refusals) {
                refused += 1
                return false
            }
            const budget = ignoreClose === true ? Infinity : Number(ignoreClose) || 0
            if (swallowed < budget) swallowed += 1
            else {
                const index = indexOf(sessionID)
                if (index >= 0) listed.splice(index, 1)
            }
        }
        return undefined
    }
    return {
        enabled() {
            if (enabled === "throw") throw new Error("no strip")
            return enabled
        },
        list() {
            reads += 1
            if (tabs === "throw") throw new Error("no strip")
            if (typeof unreadableAfter === "number" && reads > unreadableAfter) {
                throw new Error("the strip went unreadable")
            }
            if (!listed) return tabs
            return listed.slice()
        },
        /** Simulate the TUI's own `session.tab.close` command landing. */
        remove(sessionID) {
            if (!listed) return
            const index = indexOf(sessionID)
            if (index >= 0) listed.splice(index, 1)
        },
        open: record("open"),
        focus: record("focus"),
        close: record("close"),
        move(sessionID, index) {
            calls.push({ method: "move", sessionID, index })
            if (failOn === "move") throw new Error(`move refused ${sessionID}`)
            if (refuses("move", sessionID)) return false
            if (!listed) return false
            const from = indexOf(sessionID)
            if (from < 0) return false
            const [tab] = listed.splice(from, 1)
            const target = Math.max(0, Math.min(Number(index) || 0, listed.length))
            listed.splice(target, 0, tab)
            return true
        },
    }
}

/** A client whose `session.fork` maps old ids to new ones, or refuses them. */
function forkClient(calls, { forks = {}, failFor = [], missing = false, closeCommand } = {}) {
    const client = {
        session: missing
            ? {}
            : {
                  async fork({ sessionID }) {
                      calls.push({ method: "fork", sessionID })
                      if (failFor.includes(sessionID)) throw new Error(`fork refused ${sessionID}`)
                      const toSessionID = forks[sessionID]
                      return toSessionID === undefined ? {} : { id: toSessionID }
                  },
              },
    }
    if (closeCommand) {
        // The v2 SDK's TUI command route, as the runtime client exposes it:
        // `client.tui.executeCommand({ command })`.
        client.tui = {
            async executeCommand({ command }) {
                calls.push({ method: "execute-command", command })
                closeCommand(command)
            },
        }
    }
    return client
}

/** A state bus whose `session.get` answers from a literal table. */
function sessionState(table) {
    return {
        session: {
            get(sessionID) {
                if (table === "throw") throw new Error("no session state")
                return table[sessionID]
            },
        },
    }
}

const silentLog = { debug: () => {} }

/** Drive one control handler and return its single reply envelope. */
async function invoke(handlers, channel, body = {}) {
    const replies = []
    await handlers[channel](body, (id, ok, payload) => replies.push({ id, ok, payload }))
    assert.equal(replies.length, 1, `${channel} must reply exactly once`)
    return replies[0]
}

test("tabs.fork swaps each tab onto its fork and focuses the pre-cycle active fork last", async () => {
    const calls = []
    const strip = fakeStrip(calls)
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork", ses_two: "ses_two_fork" } }),
        tabs: strip,
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf1" })
    assert.deepEqual(reply, {
        id: "tf1",
        ok: true,
        payload: {
            moves: [
                { fromSessionID: "ses_one", toSessionID: "ses_one_fork" },
                { fromSessionID: "ses_two", toSessionID: "ses_two_fork" },
            ],
            failed: [],
            skipped: [],
            lineage: [],
            degraded: [],
            unclosed: [],
        },
    })
    assert.deepEqual(calls, [
        { method: "fork", sessionID: "ses_one" },
        { method: "open", sessionID: "ses_one_fork" },
        { method: "move", sessionID: "ses_one_fork", index: 0 },
        { method: "close", sessionID: "ses_one" },
        { method: "fork", sessionID: "ses_two" },
        { method: "open", sessionID: "ses_two_fork" },
        { method: "move", sessionID: "ses_two_fork", index: 1 },
        { method: "close", sessionID: "ses_two" },
        { method: "focus", sessionID: "ses_one_fork" },
    ])
    assert.deepEqual(
        strip.list().map((tab) => tab.sessionID),
        ["ses_one_fork", "ses_two_fork"],
        "each fork tab took its old tab's slot",
    )
})

test("tabs.fork on an empty strip answers six empty lists", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls),
        tabs: fakeStrip(calls, { tabs: [] }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf2" })
    assert.deepEqual(reply, {
        id: "tf2",
        ok: true,
        payload: { moves: [], failed: [], skipped: [], lineage: [], degraded: [], unclosed: [] },
    })
    assert.deepEqual(calls, [])
})

test("tabs.fork ignores a draft tab and accepts both runtime tab shapes", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_a: "ses_a_fork", ses_b: "ses_b_fork" } }),
        tabs: fakeStrip(calls, {
            tabs: [
                { key: "tab-draft", session: undefined, active: true },
                { key: "tab-a", session: { id: "ses_a" }, active: false },
                { sessionID: "ses_b", title: "B", active: false },
            ],
        }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf3" })
    assert.deepEqual(reply.payload.moves, [
        { fromSessionID: "ses_a", toSessionID: "ses_a_fork" },
        { fromSessionID: "ses_b", toSessionID: "ses_b_fork" },
    ])
    assert.deepEqual(reply.payload.failed, [])
    assert.deepEqual(reply.payload.skipped, [])
    assert.deepEqual(reply.payload.unclosed, [])
})

test("tabs.fork skips a subagent tab into `skipped` and never forks or closes it", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, {
            forks: { ses_root: "ses_root_fork", ses_child_forked: "ses_child_forked_fork" },
        }),
        tabs: fakeStrip(calls, {
            tabs: [
                { sessionID: "ses_root", active: true },
                { sessionID: "ses_child", active: false },
                { sessionID: "ses_child_forked", active: false },
            ],
        }),
        data: sessionState({
            ses_root: { id: "ses_root" },
            ses_child: { id: "ses_child", parentID: "ses_root" },
            // A subagent that already carries a `fork` marker was moved here by
            // an earlier fork, so it is a target again.
            ses_child_forked: { id: "ses_child_forked", parentID: "ses_root", fork: {} },
        }),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf4" })
    assert.deepEqual(reply.payload.skipped, ["ses_child"])
    assert.deepEqual(reply.payload.moves, [
        { fromSessionID: "ses_root", toSessionID: "ses_root_fork" },
        { fromSessionID: "ses_child_forked", toSessionID: "ses_child_forked_fork" },
    ])
    assert.deepEqual(reply.payload.unclosed, [])
    assert.ok(
        !calls.some((call) => call.method === "fork" && call.sessionID === "ses_child"),
        "a subagent session is never forked",
    )
    assert.ok(
        !calls.some((call) => call.method === "close" && call.sessionID === "ses_child"),
        "a subagent tab is never closed",
    )
})

test("tabs.fork leaves a lineage source alone and forks only the tab that names it", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_a_fork: "ses_a_fork_fork" } }),
        tabs: fakeStrip(calls, {
            tabs: [
                { sessionID: "ses_a", active: true },
                { sessionID: "ses_a_fork", active: false },
            ],
        }),
        data: sessionState({
            ses_a: { id: "ses_a" },
            ses_a_fork: { id: "ses_a_fork", fork: { sessionID: "ses_a" } },
        }),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf20" })
    assert.deepEqual(reply.payload.lineage, ["ses_a"])
    assert.deepEqual(reply.payload.moves, [{ fromSessionID: "ses_a_fork", toSessionID: "ses_a_fork_fork" }])
    assert.deepEqual(reply.payload.skipped, [])
    assert.deepEqual(reply.payload.failed, [])
    assert.deepEqual(reply.payload.degraded, [])
    assert.deepEqual(reply.payload.unclosed, [])
    for (const method of ["fork", "open", "move", "close"]) {
        assert.ok(
            !calls.some((call) => call.method === method && call.sessionID === "ses_a"),
            `${method} never touches the lineage source`,
        )
    }
})

test("tabs.fork treats an unclassifiable tab as a target", async () => {
    for (const data of [sessionState("throw"), {}, null]) {
        const calls = []
        const handlers = createTuiControlHandlers({
            client: forkClient(calls, { forks: { ses_one: "ses_one_fork" } }),
            tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }] }),
            data,
            log: silentLog,
        })
        const reply = await invoke(handlers, "tabs.fork", { id: "tf5" })
        assert.deepEqual(reply.payload.moves, [{ fromSessionID: "ses_one", toSessionID: "ses_one_fork" }])
        assert.deepEqual(reply.payload.skipped, [])
        assert.deepEqual(reply.payload.unclosed, [])
    }
})

test("tabs.fork leaves the old tab open on a failed fork and continues with the rest", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_two: "ses_two_fork" }, failFor: ["ses_one"] }),
        tabs: fakeStrip(calls),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf6" })
    assert.deepEqual(reply.payload.failed, [{ fromSessionID: "ses_one", error: "fork refused ses_one" }])
    assert.deepEqual(reply.payload.moves, [{ fromSessionID: "ses_two", toSessionID: "ses_two_fork" }])
    assert.deepEqual(reply.payload.unclosed, [])
    assert.ok(
        !calls.some((call) => call.method === "close" && call.sessionID === "ses_one"),
        "a failed fork leaves its tab open",
    )
})

test("tabs.fork records a missing adapter method and a fork without an id, never throwing", async () => {
    const calls = []
    const noMethod = createTuiControlHandlers({
        client: forkClient(calls, { missing: true }),
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }] }),
        data: sessionState({}),
        log: silentLog,
    })
    const missing = await invoke(noMethod, "tabs.fork", { id: "tf7" })
    assert.equal(missing.ok, true)
    assert.equal(missing.payload.failed.length, 1)
    assert.equal(missing.payload.failed[0].fromSessionID, "ses_one")
    assert.match(missing.payload.failed[0].error, /fork/)
    assert.deepEqual(missing.payload.moves, [])
    assert.deepEqual(missing.payload.unclosed, [])

    const noId = createTuiControlHandlers({
        client: forkClient(calls, { forks: {} }),
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_two", active: true }] }),
        data: sessionState({}),
        log: silentLog,
    })
    const empty = await invoke(noId, "tabs.fork", { id: "tf8" })
    assert.deepEqual(empty.payload.failed, [
        { fromSessionID: "ses_two", error: "session.fork returned no session id" },
    ])
    assert.deepEqual(empty.payload.moves, [])
    assert.deepEqual(empty.payload.unclosed, [])
})

test("tabs.fork keeps the pair in `moves` when the strip refuses the move", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork" } }),
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], refuseOn: "move" }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf9" })
    assert.deepEqual(reply.payload.moves, [{ fromSessionID: "ses_one", toSessionID: "ses_one_fork" }])
    assert.deepEqual(reply.payload.degraded, [
        {
            fromSessionID: "ses_one",
            toSessionID: "ses_one_fork",
            step: "move",
            error: "tabs.move refused ses_one_fork at index 0",
        },
    ])
    assert.deepEqual(reply.payload.failed, [])
    assert.deepEqual(reply.payload.unclosed, [])
    assert.ok(
        calls.some((call) => call.method === "close" && call.sessionID === "ses_one"),
        "a refused move still closes the old tab",
    )
})

test("tabs.fork reports a tab failed at open when the strip answers false", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork" } }),
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], refuseOn: "open" }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf16" })
    assert.deepEqual(reply.payload.moves, [])
    assert.deepEqual(reply.payload.failed, [
        { fromSessionID: "ses_one", toSessionID: "ses_one_fork", step: "open", error: "tabs.open refused ses_one_fork" },
    ])
    assert.deepEqual(reply.payload.degraded, [])
    assert.deepEqual(reply.payload.unclosed, [], "a fork tab that was never opened leaves nothing unclosed")
    assert.ok(!calls.some((call) => call.method === "close"), "the old tab is never closed when the fork tab was not opened")
    assert.ok(!calls.some((call) => call.method === "move"), "no move runs for a fork tab that was never opened")
    assert.ok(!calls.some((call) => call.method === "focus"), "focus never runs when no fork tab exists")
})

test("tabs.fork degrades a strip without `tabs.move` and still completes the swap", async () => {
    const calls = []
    const strip = fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }] })
    delete strip.move
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork" } }),
        tabs: strip,
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf17" })
    assert.deepEqual(reply.payload.moves, [{ fromSessionID: "ses_one", toSessionID: "ses_one_fork" }])
    assert.deepEqual(reply.payload.degraded, [
        { fromSessionID: "ses_one", toSessionID: "ses_one_fork", step: "move", error: "tabs.move unavailable" },
    ])
    assert.deepEqual(reply.payload.failed, [])
    assert.deepEqual(reply.payload.unclosed, [])
    assert.ok(
        !calls.some((call) => call.method === "move"),
        "no move call is attempted when the adapter has none",
    )
})

test("tabs.fork degrades a refused focus of the pre-cycle active fork and keeps the pair moved", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork" } }),
        tabs: fakeStrip(calls, {
            tabs: [{ sessionID: "ses_one", active: true }],
            // The close needs no fallback focus here; only the post-loop fork focus is refused.
            refuseOn: (method, sessionID) => method === "focus" && sessionID === "ses_one_fork",
        }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf19" })
    assert.deepEqual(reply.payload.moves, [{ fromSessionID: "ses_one", toSessionID: "ses_one_fork" }])
    assert.deepEqual(reply.payload.degraded, [
        {
            fromSessionID: "ses_one",
            toSessionID: "ses_one_fork",
            step: "focus",
            error: "tabs.focus refused ses_one_fork",
        },
    ])
    assert.deepEqual(reply.payload.failed, [])
    assert.deepEqual(reply.payload.unclosed, [])
    assert.deepEqual(
        calls.filter((call) => call.method === "focus"),
        [{ method: "focus", sessionID: "ses_one_fork" }],
        "exactly one focus runs — after the loop, on the fork of the pre-cycle active tab",
    )
    assert.equal(calls.at(-1).method, "focus", "the post-loop focus is the last call of the cycle")
})

test("tabs.fork re-reads the old tab's index per target after a degraded move", async () => {
    const calls = []
    const strip = fakeStrip(calls, {
        tabs: [
            { sessionID: "ses_one", active: true },
            { sessionID: "ses_two", active: false },
        ],
        // Only the first target's move is refused, so its fork tab stays at the
        // end of the strip and the second target's index shifts.
        refuseOn: (method, sessionID) => method === "move" && sessionID === "ses_one_fork",
    })
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork", ses_two: "ses_two_fork" } }),
        tabs: strip,
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf21" })
    assert.deepEqual(reply.payload.moves, [
        { fromSessionID: "ses_one", toSessionID: "ses_one_fork" },
        { fromSessionID: "ses_two", toSessionID: "ses_two_fork" },
    ])
    assert.deepEqual(reply.payload.degraded, [
        {
            fromSessionID: "ses_one",
            toSessionID: "ses_one_fork",
            step: "move",
            error: "tabs.move refused ses_one_fork at index 0",
        },
    ])
    assert.deepEqual(
        calls.filter((call) => call.method === "move"),
        [
            { method: "move", sessionID: "ses_one_fork", index: 0 },
            { method: "move", sessionID: "ses_two_fork", index: 0 },
        ],
        "the second target moves to its own current index (0), not the snapshot's 1",
    )
    assert.deepEqual(
        strip.list().map((tab) => tab.sessionID),
        ["ses_two_fork", "ses_one_fork"],
        "the second fork took the slot the first target's degraded move left behind",
    )
})

test("tabs.fork retries a close the strip did not apply and then reports the tab moved", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork" } }),
        // The first close resolves without removing the entry; the retry lands.
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], ignoreClose: 1 }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf11" })
    assert.deepEqual(reply.payload.moves, [{ fromSessionID: "ses_one", toSessionID: "ses_one_fork" }])
    assert.deepEqual(reply.payload.failed, [])
    assert.deepEqual(reply.payload.unclosed, [])
    assert.deepEqual(
        calls.filter((call) => call.method === "close").length,
        2,
        "a close that did not take effect is retried exactly once",
    )
    assert.deepEqual(calls, [
        { method: "fork", sessionID: "ses_one" },
        { method: "open", sessionID: "ses_one_fork" },
        { method: "move", sessionID: "ses_one_fork", index: 0 },
        { method: "close", sessionID: "ses_one" },
        { method: "close", sessionID: "ses_one" },
        { method: "focus", sessionID: "ses_one_fork" },
    ])
})

test("tabs.fork falls back to the TUI close command when the strip ignores close", async () => {
    const calls = []
    const strip = fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], ignoreClose: true })
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, {
            forks: { ses_one: "ses_one_fork" },
            closeCommand: (command) => {
                assert.equal(command, "session.tab.close")
                strip.remove("ses_one")
            },
        }),
        tabs: strip,
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf12" })
    assert.deepEqual(reply.payload.moves, [{ fromSessionID: "ses_one", toSessionID: "ses_one_fork" }])
    assert.deepEqual(reply.payload.degraded, [])
    assert.deepEqual(reply.payload.unclosed, [])
    assert.deepEqual(calls, [
        { method: "fork", sessionID: "ses_one" },
        { method: "open", sessionID: "ses_one_fork" },
        { method: "move", sessionID: "ses_one_fork", index: 0 },
        { method: "close", sessionID: "ses_one" },
        { method: "close", sessionID: "ses_one" },
        { method: "focus", sessionID: "ses_one" },
        { method: "execute-command", command: "session.tab.close" },
        { method: "focus", sessionID: "ses_one_fork" },
    ])
})

test("tabs.fork skips the TUI close command when focusing the old tab is refused", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork" }, closeCommand: () => {} }),
        tabs: fakeStrip(calls, {
            tabs: [{ sessionID: "ses_one", active: true }],
            ignoreClose: true,
            // The fork tab focuses fine; only the fallback's focus of the OLD tab is refused.
            refuseOn: (method, sessionID) => method === "focus" && sessionID === "ses_one",
        }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf18" })
    assert.deepEqual(reply.payload.moves, [])
    assert.equal(reply.payload.unclosed.length, 1)
    assert.equal(reply.payload.unclosed[0].step, "close")
    assert.match(reply.payload.unclosed[0].error, /tabs\.focus refused ses_one/)
    assert.match(reply.payload.unclosed[0].error, /close command was not sent/)
    assert.ok(
        !calls.some((call) => call.method === "execute-command"),
        "session.tab.close must not run without the old tab focused",
    )
})

test("tabs.fork reports a tab unclosed when neither close path removes it", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork" } }),
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], ignoreClose: true }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf13" })
    assert.deepEqual(reply.payload.moves, [])
    assert.deepEqual(reply.payload.failed, [
        {
            fromSessionID: "ses_one",
            toSessionID: "ses_one_fork",
            step: "close",
            error: "tab ses_one is still listed after close",
        },
    ])
    assert.deepEqual(reply.payload.unclosed, reply.payload.failed)
})

test("tabs.fork treats a close that answers false as unclosed", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork" } }),
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], refuseClose: true }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf14" })
    assert.deepEqual(reply.payload.moves, [])
    assert.deepEqual(reply.payload.failed, [
        {
            fromSessionID: "ses_one",
            toSessionID: "ses_one_fork",
            step: "close",
            error: "tabs.close refused ses_one",
        },
    ])
    assert.deepEqual(reply.payload.unclosed, reply.payload.failed)
})

test("tabs.fork treats a strip it cannot re-read as unclosed", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, { forks: { ses_one: "ses_one_fork" } }),
        // Read 1 is the snapshot, 2 the debug strip dump, 3 the per-target
        // index re-read and 4 the pre-close probe; every verification read throws.
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], unreadableAfter: 4 }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.fork", { id: "tf15" })
    assert.deepEqual(reply.payload.moves, [])
    assert.equal(reply.payload.unclosed.length, 1)
    assert.equal(reply.payload.unclosed[0].step, "close")
    assert.match(reply.payload.unclosed[0].error, /unreadable/)
})

test("tabs.fork answers tabs_disabled when the strip is off, unreadable or absent", async () => {
    const cases = [
        fakeStrip([], { enabled: false }),
        fakeStrip([], { enabled: "throw" }),
        fakeStrip([], { tabs: "throw" }),
        fakeStrip([], { tabs: "not-a-list" }),
        null,
    ]
    for (const tabs of cases) {
        const handlers = createTuiControlHandlers({
            client: forkClient([]),
            tabs,
            data: sessionState({}),
            log: silentLog,
        })
        const reply = await invoke(handlers, "tabs.fork", { id: "tf10" })
        assert.deepEqual(reply, { id: "tf10", ok: false, payload: { error: { code: "tabs_disabled" } } })
    }
})

// ── tabs.close: the single-tab close command ─────────────────────────

test("tabs.close removes one id from the strip and proves it left", async () => {
    const calls = []
    const strip = fakeStrip(calls, { tabs: measuredTabs })
    const handlers = createTuiControlHandlers({
        client: forkClient(calls),
        tabs: strip,
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.close", { id: "tc1", sessionID: "ses_one" })
    assert.deepEqual(reply, {
        id: "tc1",
        ok: true,
        payload: { sessionID: "ses_one", mechanism: "tabs.close" },
    })
    assert.deepEqual(
        strip.list().map((tab) => tab.sessionID),
        ["ses_two"],
        "the closed id is gone from the strip and the other tab is untouched",
    )
    assert.deepEqual(calls, [{ method: "close", sessionID: "ses_one" }])
})

test("tabs.close is idempotent for an id the strip no longer lists", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls),
        tabs: fakeStrip(calls, { tabs: measuredTabs }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.close", { id: "tc2", sessionID: "ses_gone" })
    assert.deepEqual(reply, {
        id: "tc2",
        ok: true,
        payload: { sessionID: "ses_gone", mechanism: null },
    })
    assert.deepEqual(calls, [], "an absent tab is the goal state, never a close attempt")
})

test("tabs.close retries a close the strip did not apply", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls),
        // The first close resolves without removing the entry; the retry lands.
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], ignoreClose: 1 }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.close", { id: "tc3", sessionID: "ses_one" })
    assert.equal(reply.ok, true)
    assert.equal(reply.payload.mechanism, "tabs.close")
    assert.equal(calls.filter((call) => call.method === "close").length, 2)
})

test("tabs.close falls back to the TUI close command when the strip ignores close", async () => {
    const calls = []
    const strip = fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], ignoreClose: true })
    const handlers = createTuiControlHandlers({
        client: forkClient(calls, {
            closeCommand: (command) => {
                assert.equal(command, "session.tab.close")
                strip.remove("ses_one")
            },
        }),
        tabs: strip,
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.close", { id: "tc4", sessionID: "ses_one" })
    assert.equal(reply.ok, true)
    assert.equal(reply.payload.mechanism, "execute-command")
    assert.deepEqual(calls, [
        { method: "close", sessionID: "ses_one" },
        { method: "close", sessionID: "ses_one" },
        { method: "focus", sessionID: "ses_one" },
        { method: "execute-command", command: "session.tab.close" },
    ])
})

test("tabs.close reports close_unverified when neither path removes the tab", async () => {
    const calls = []
    const handlers = createTuiControlHandlers({
        client: forkClient(calls),
        tabs: fakeStrip(calls, { tabs: [{ sessionID: "ses_one", active: true }], ignoreClose: true }),
        data: sessionState({}),
        log: silentLog,
    })

    const reply = await invoke(handlers, "tabs.close", { id: "tc5", sessionID: "ses_one" })
    assert.equal(reply.ok, false)
    assert.equal(reply.payload.error.code, "close_unverified")
    assert.equal(reply.payload.error.message, "tab ses_one is still listed after close")
    assert.equal(reply.payload.sessionID, "ses_one")
})

test("tabs.close requires a session id", async () => {
    const handlers = createTuiControlHandlers({
        client: forkClient([]),
        tabs: fakeStrip([]),
        data: sessionState({}),
        log: silentLog,
    })

    for (const body of [{ id: "tc6" }, { id: "tc6", sessionID: "" }, { id: "tc6", sessionID: 42 }]) {
        const reply = await invoke(handlers, "tabs.close", body)
        assert.equal(reply.ok, false)
        assert.equal(reply.payload.error.code, "call_failed")
        assert.match(reply.payload.error.message, /sessionID is required/)
    }
})

test("tabs.close answers tabs_disabled when the strip is off, unreadable or absent", async () => {
    const cases = [
        fakeStrip([], { enabled: false }),
        fakeStrip([], { enabled: "throw" }),
        fakeStrip([], { tabs: "throw" }),
        fakeStrip([], { tabs: "not-a-list" }),
        null,
    ]
    for (const tabs of cases) {
        const handlers = createTuiControlHandlers({
            client: forkClient([]),
            tabs,
            data: sessionState({}),
            log: silentLog,
        })
        const reply = await invoke(handlers, "tabs.close", { id: "tc7", sessionID: "ses_one" })
        assert.deepEqual(reply, {
            id: "tc7",
            ok: false,
            payload: { error: { code: "tabs_disabled" }, sessionID: "ses_one" },
        })
    }
})
