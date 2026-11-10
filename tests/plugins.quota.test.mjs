/**
 * TUI credential/session control tests (P-B3).
 *
 * `plugins/tui-control.js` is driven directly with a fake v2 client and a
 * fake environment: the real module imports only the shared transport, so no
 * opencode runtime is needed. Assertions cover every guard branch, the
 * self-discovery `credential.remove` contract (the request body is empty and
 * the ACTIVE entry picks the target), the create-then-activate order,
 * idempotent install (reuse, not duplicate), activate failures, the
 * fork/prompt mappings, call_failed wrapping, the five-channel registration
 * (including `tabs.fork`, whose strip semantics live in `plugins.tui.test.mjs`
 * next to the definition that boots it), and the one invariant that spans all
 * of them: no credential key and no `CredentialEntry.value` may appear in a
 * reply or a log line.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createTuiControlHandlers, registerTuiControl } from "../plugins/tui-control.js"

const KEY = "OPENCODE_API_KEY"
const KEY_1 = "OPENCODE_API_KEY_1"

/** Set (or delete, for `undefined`) one label and restore it after the test. */
function setEnv(t, label, value) {
    const previous = process.env[label]
    if (value === undefined) delete process.env[label]
    else process.env[label] = value
    t.after(() => {
        if (previous === undefined) delete process.env[label]
        else process.env[label] = previous
    })
}

/** Capture every log level the module could use. */
function fakeLog() {
    const lines = []
    const push = (...args) => lines.push(args.map(String).join(" "))
    return { lines, log: { debug: push, info: push, warn: push, error: push } }
}

/** A v2-domain-shaped client with per-call recording and failure injection. */
function fakeClient({
    entries = [],
    createResult,
    forkResult,
    activateResult,
    listError,
    createError,
    activateError,
    removeError,
    forkError,
    promptError,
} = {}) {
    const calls = []
    const client = {
        credential: {
            list: async () => {
                calls.push({ method: "list" })
                if (listError) throw listError
                return { data: entries }
            },
            create: async (input) => {
                calls.push({ method: "create", input })
                if (createError) throw createError
                return createResult ?? { data: { id: "cred_new", label: input.label } }
            },
            activate: async (input) => {
                calls.push({ method: "activate", input })
                if (activateError) throw activateError
                return activateResult ?? { ok: true }
            },
            remove: async (input) => {
                calls.push({ method: "remove", input })
                if (removeError) throw removeError
                return { ok: true }
            },
        },
        session: {
            fork: async (input) => {
                calls.push({ method: "fork", input })
                if (forkError) throw forkError
                return forkResult ?? { id: "ses_fork" }
            },
            prompt: async (input) => {
                calls.push({ method: "prompt", input })
                if (promptError) throw promptError
                return {}
            },
        },
    }
    return { client, calls }
}

function build(options = {}) {
    const { client, calls } = fakeClient(options)
    const { lines, log } = fakeLog()
    const handlers = createTuiControlHandlers({ client, log, tabs: {}, data: {} })
    return { handlers, calls, lines }
}

/** Invoke one handler and return its single reply envelope. */
async function run(handlers, channel, body = {}) {
    const replies = []
    await handlers[channel](body, (id, ok, payload) => replies.push({ id, ok, payload }))
    assert.equal(replies.length, 1, `${channel} must reply exactly once`)
    return replies[0]
}

const names = (calls) => calls.map((call) => call.method)

/** The active credential the module is allowed to remove/cycle. */
const entry = (overrides = {}) => ({
    id: "cred_1",
    integrationID: "opencode",
    label: KEY,
    active: true,
    value: { type: "key", key: "stored-secret-value" },
    ...overrides,
})

/** No key and no CredentialEntry value in a reply or in any captured log. */
function assertClean(reply, lines, secrets) {
    const text = `${JSON.stringify(reply)}\n${lines.join("\n")}`
    for (const secret of secrets) {
        assert.ok(!text.includes(secret), "a reply or log line leaked a credential secret")
    }
}

test("credential.remove: a lost-reply retry answers no_active with the empty active-id snapshot", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const { handlers, calls, lines } = build({ entries: [entry({ active: false })] })

    // Python pushes `{}` for remove: it names no id and no label.
    const reply = await run(handlers, "credential.remove", { id: "r1" })
    assert.deepEqual(reply, {
        id: "r1",
        ok: false,
        payload: { error: { code: "no_active" }, activeOpenCodeIds: [] },
    })
    assert.deepEqual(names(calls), ["list"], "no mutation may run")
    assertClean(reply, lines, ["stored-secret-value", "env-secret-value"])
})

test("credential.remove: one active foreign credential is foreign_integration and untouched", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const foreign = entry({ id: "cred_f", integrationID: "anthropic", label: "ANTHROPIC_API_KEY" })
    const { handlers, calls, lines } = build({ entries: [foreign] })

    const reply = await run(handlers, "credential.remove", { id: "r2" })
    assert.deepEqual(reply, {
        id: "r2",
        ok: false,
        payload: { error: { code: "foreign_integration" } },
    })
    assert.deepEqual(names(calls), ["list"], "no mutation may run")
    assertClean(reply, lines, ["stored-secret-value", "env-secret-value"])
})

test("credential.remove: two active opencode credentials are ambiguous_active and untouched", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const { handlers, calls, lines } = build({
        entries: [entry(), entry({ id: "cred_2", label: KEY_1 })],
    })

    const reply = await run(handlers, "credential.remove", { id: "r3" })
    assert.deepEqual(reply, {
        id: "r3",
        ok: false,
        payload: { error: { code: "ambiguous_active" } },
    })
    assert.deepEqual(names(calls), ["list"], "no mutation may run")
    assertClean(reply, lines, ["stored-secret-value", "env-secret-value"])
})

test("credential.remove: the ACTIVE entry's own label outside the managed set is foreign_label", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const { handlers, calls, lines } = build({ entries: [entry({ label: "OPENCODE_API_KEY_9" })] })

    const reply = await run(handlers, "credential.remove", { id: "r4" })
    assert.deepEqual(reply, {
        id: "r4",
        ok: false,
        payload: { error: { code: "foreign_label" } },
    })
    assert.deepEqual(names(calls), ["list"], "no mutation may run")
    assertClean(reply, lines, ["stored-secret-value", "env-secret-value"])
})

test("credential.remove: a managed active label with no environment value is no_env and untouched", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    setEnv(t, KEY_1, undefined)
    const { handlers, calls, lines } = build({ entries: [entry({ label: KEY_1 })] })

    const reply = await run(handlers, "credential.remove", { id: "r5" })
    assert.deepEqual(reply, {
        id: "r5",
        ok: false,
        payload: { error: { code: "no_env" } },
    })
    assert.deepEqual(names(calls), ["list"], "no mutation may run")
    assertClean(reply, lines, ["stored-secret-value", "env-secret-value"])
})

test("credential.remove: one active opencode credential is discovered, removed and replied without its value", async (t) => {
    setEnv(t, KEY_1, "env-secret-value")
    const { handlers, calls, lines } = build({ entries: [entry({ id: "cred_7", label: KEY_1 })] })

    const reply = await run(handlers, "credential.remove", { id: "r6" })
    assert.deepEqual(reply, {
        id: "r6",
        ok: true,
        // The reply is rebuilt from the listed entry, never from the request.
        payload: { credential: { id: "cred_7", label: KEY_1, integrationID: "opencode" } },
    })
    assert.deepEqual(names(calls), ["list", "remove"])
    assert.deepEqual(calls[1].input, { credentialID: "cred_7" })
    assertClean(reply, lines, ["stored-secret-value", "env-secret-value"])
})

test("credential.remove: a body label never names the target — self-discovery wins", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    setEnv(t, KEY_1, "env-secret-value")
    const { handlers, calls, lines } = build({ entries: [entry({ id: "cred_1", label: KEY })] })

    // A label outside the managed set in the body must change nothing: the
    // active entry is the managed one, so it is the one that goes.
    const reply = await run(handlers, "credential.remove", { id: "r9", label: "OPENCODE_API_KEY_9" })
    assert.deepEqual(reply, {
        id: "r9",
        ok: true,
        payload: { credential: { id: "cred_1", label: KEY, integrationID: "opencode" } },
    })
    assert.deepEqual(names(calls), ["list", "remove"])
    assert.deepEqual(calls[1].input, { credentialID: "cred_1" })
    assertClean(reply, lines, ["stored-secret-value", "env-secret-value"])
})

test("credential.remove: a rejected list is call_failed and never throws", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const { handlers, calls, lines } = build({ listError: new Error("bridge down") })

    const reply = await run(handlers, "credential.remove", { id: "r7" })
    assert.deepEqual(reply, {
        id: "r7",
        ok: false,
        payload: { error: { code: "call_failed", message: "bridge down" } },
    })
    assert.deepEqual(names(calls), ["list"], "nothing may be removed")
    assertClean(reply, lines, ["env-secret-value"])
})

test("credential.remove: a rejected remove is call_failed and scrubs the stored value", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const { handlers, calls, lines } = build({
        entries: [entry()],
        removeError: new Error("remove refused stored-secret-value"),
    })

    const reply = await run(handlers, "credential.remove", { id: "r8" })
    assert.deepEqual(reply, {
        id: "r8",
        ok: false,
        payload: { error: { code: "call_failed", message: "remove refused [redacted]" } },
    })
    assert.deepEqual(names(calls), ["list", "remove"])
    assertClean(reply, lines, ["stored-secret-value", "env-secret-value"])
})

test("credential.install: creates then activates, using the environment key and ignoring a wire key", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const { handlers, calls, lines } = build({ createResult: { data: { id: "cred_2" } } })

    const reply = await run(handlers, "credential.install", {
        id: "i1",
        label: KEY,
        integrationID: "opencode",
        key: "wire-secret",
        value: { type: "key", key: "wire-secret" },
    })
    assert.deepEqual(reply, {
        id: "i1",
        ok: true,
        payload: { credential: { id: "cred_2", label: KEY } },
    })
    assert.deepEqual(names(calls), ["list", "create", "activate"])
    assert.deepEqual(calls[1].input, {
        integrationID: "opencode",
        label: KEY,
        value: { type: "key", key: "env-secret-value" },
    })
    assert.deepEqual(calls[2].input, { credentialID: "cred_2" })
    assertClean(reply, lines, ["env-secret-value", "wire-secret", "stored-secret-value"])
})

test("credential.install: an existing label/integration is activated, never duplicated", async (t) => {
    setEnv(t, KEY_1, "env-secret-value")
    const { handlers, calls, lines } = build({
        entries: [entry({ id: "cred_1", label: KEY_1, active: false })],
    })

    const reply = await run(handlers, "credential.install", { id: "i2", label: KEY_1, integrationID: "opencode" })
    assert.deepEqual(reply, {
        id: "i2",
        ok: true,
        payload: { credential: { id: "cred_1", label: KEY_1 }, reused: true },
    })
    assert.deepEqual(names(calls), ["list", "activate"], "a retry must not create a duplicate")
    assert.deepEqual(calls[1].input, { credentialID: "cred_1" })
    assertClean(reply, lines, ["env-secret-value", "stored-secret-value"])
})

test("credential.install: a missing environment value is no_env and never touches the client", async (t) => {
    setEnv(t, KEY_1, undefined)
    const { handlers, calls, lines } = build()

    const reply = await run(handlers, "credential.install", { id: "i3", label: KEY_1, integrationID: "opencode" })
    assert.deepEqual(reply, {
        id: "i3",
        ok: false,
        payload: { error: { code: "no_env" } },
    })
    assert.deepEqual(names(calls), [], "no list and no create without a local key")
    assertClean(reply, lines, ["env-secret-value"])
})

test("credential.install: a create that succeeds but an activate that rejects is activate_failed", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const { handlers, calls, lines } = build({
        createResult: { data: { id: "cred_2" } },
        activateError: new Error("activate refused env-secret-value"),
    })

    const reply = await run(handlers, "credential.install", { id: "i4", label: KEY, integrationID: "opencode" })
    assert.deepEqual(reply, {
        id: "i4",
        ok: false,
        payload: { error: { code: "activate_failed", credentialID: "cred_2" } },
    })
    assert.deepEqual(names(calls), ["list", "create", "activate"])
    assertClean(reply, lines, ["env-secret-value", "stored-secret-value"])
})

test("credential.install: a resolved adapter {error} on activate is activate_failed too", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const { handlers, calls, lines } = build({
        createResult: { data: { id: "cred_2" } },
        activateResult: { error: { message: "credential.activate unavailable (v2 ctx)" } },
    })

    const reply = await run(handlers, "credential.install", { id: "i5", label: KEY, integrationID: "opencode" })
    assert.deepEqual(reply, {
        id: "i5",
        ok: false,
        payload: { error: { code: "activate_failed", credentialID: "cred_2" } },
    })
    assert.deepEqual(names(calls), ["list", "create", "activate"])
    assertClean(reply, lines, ["env-secret-value"])
})

test("credential.install: a rejected create is call_failed and scrubs the environment key", async (t) => {
    setEnv(t, KEY, "env-secret-value")
    const { handlers, calls, lines } = build({
        createError: new Error("profiler rejected env-secret-value"),
    })

    const reply = await run(handlers, "credential.install", { id: "i6", label: KEY, integrationID: "opencode" })
    assert.deepEqual(reply, {
        id: "i6",
        ok: false,
        payload: { error: { code: "call_failed", message: "profiler rejected [redacted]" } },
    })
    assert.deepEqual(names(calls), ["list", "create"])
    assertClean(reply, lines, ["env-secret-value"])
})

test("session.fork: maps the fork id and forwards before only when present", async () => {
    const { handlers, calls, lines } = build({ forkResult: { data: { id: "ses_fork" } } })

    const first = await run(handlers, "session.fork", { id: "f1", sessionID: "ses_parent", before: "msg_1" })
    assert.deepEqual(first, { id: "f1", ok: true, payload: { sessionID: "ses_fork" } })
    assert.deepEqual(calls[0], { method: "fork", input: { sessionID: "ses_parent", before: "msg_1" } })

    const second = await run(handlers, "session.fork", { id: "f2", sessionID: "ses_parent" })
    assert.deepEqual(second, { id: "f2", ok: true, payload: { sessionID: "ses_fork" } })
    assert.deepEqual(calls[1], { method: "fork", input: { sessionID: "ses_parent" } })
    assertClean(first, lines, [])
    assertClean(second, lines, [])
})

test("session.prompt: forwards sessionID/text and answers ok", async () => {
    const { handlers, calls, lines } = build()

    const reply = await run(handlers, "session.prompt", { id: "p1", sessionID: "ses_1", text: "hello" })
    assert.deepEqual(reply, { id: "p1", ok: true, payload: {} })
    assert.deepEqual(calls, [{ method: "prompt", input: { sessionID: "ses_1", text: "hello" } }])
    assertClean(reply, lines, [])
})

test("session.fork and session.prompt: adapter rejections are call_failed and never throw", async () => {
    const forked = build({ forkError: new Error("fork unavailable") })
    const forkReply = await run(forked.handlers, "session.fork", { id: "f3", sessionID: "ses_parent" })
    assert.deepEqual(forkReply, {
        id: "f3",
        ok: false,
        payload: { error: { code: "call_failed", message: "fork unavailable" } },
    })

    const prompted = build({ promptError: new Error("prompt unavailable") })
    const promptReply = await run(prompted.handlers, "session.prompt", { id: "p2", sessionID: "ses_1", text: "hi" })
    assert.deepEqual(promptReply, {
        id: "p2",
        ok: false,
        payload: { error: { code: "call_failed", message: "prompt unavailable" } },
    })
    assertClean(forkReply, forked.lines, [])
    assertClean(promptReply, prompted.lines, [])
})

test("a throwing reply never escapes a handler", async () => {
    const { handlers } = build()
    await handlers["session.prompt"]({ id: "p3", sessionID: "ses_1", text: "hi" }, () => {
        throw new Error("dead socket")
    })
})

test("registerTuiControl registers all six channels on the shared onPush registry", () => {
    const { client } = fakeClient()
    const { log } = fakeLog()
    const handlers = registerTuiControl({ client, tabs: {}, data: {}, log })

    assert.deepEqual(Object.keys(handlers).sort(), [
        "credential.install",
        "credential.remove",
        "session.fork",
        "session.prompt",
        "tabs.close",
        "tabs.fork",
    ])
    assert.throws(() => registerTuiControl({ client }), /already has a handler/)
})
