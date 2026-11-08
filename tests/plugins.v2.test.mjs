/**
 * opencode v2 contract tests — default-export plugin definitions and the
 * v1-hook → v2-domain-hook adapter layer (plugins/opencode-v2.js).
 *
 * These run WITHOUT an opencode host: a stub v2 plugin context captures the
 * domain-hook registrations, and fake v2 events are driven through the
 * registered callbacks to verify the event adaptation semantics.
 */

import { test, after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-v2-"))
process.env.OPENCODE_PYTHON_SOCK = join(dir, "missing.sock") // never created
process.env.OPENCODE_BOOTSTRAP_TIMEOUT = "200" // fast inert settle
import assert from "node:assert/strict"

const plugins = {
    secrets: "plugin-secrets.js",
    hooks: "plugin-hooks.js",
    task: "plugin-task.js",
    permission: "plugin-permission.js",
    context: "plugin-context.js",
    events: "plugin-events.js",
    signals: "plugin-signals.js",
}

const mod = async (name) => (await import(new URL(`../plugins/${plugins[name]}`, import.meta.url))).default

after(async () => {
    // Stop transport reconnect timers so the test process can exit cleanly.
    const { closeBridge } = await import(new URL("../plugins/transport.js", import.meta.url))
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

/** Stub v2 plugin context: captures every domain-hook registration. */
function makeCtx() {
    /** @type {Record<string, Function>} */
    const registrations = {}
    /** @type {{prompt: object[], synthetic: object[]}} */
    const calls = { prompt: [], synthetic: [] }
    /** @type {object[]} — buffered v2 events for the activity tracker. */
    const events = []
    let wake = null
    const pushEvent = (event) => {
        events.push(event)
        wake?.()
    }
    const subscribe = () => ({
        async *[Symbol.asyncIterator]() {
            while (true) {
                if (events.length === 0) await new Promise((resolve) => (wake = resolve))
                while (events.length > 0) yield events.shift()
            }
        },
    })
    const register = (domain, name) => async (hookName, cb) => {
        registrations[`${domain}:${hookName}`] = cb
        return { dispose: async () => {} }
    }
    const ctx = {
        location: { directory: "/proj", project: { id: "proj" } },
        agent: { list: async () => [{ name: "a1", description: "", mode: "subagent", builtIn: false, model: "m" }] },
        tool: { hook: register("tool", null), list: async () => [{ id: "read" }, { id: "bash" }] },
        permission: { hook: register("permission", null), reply: async () => ({ ok: true }) },
        shell: { hook: register("shell", null) },
        session: {
            hook: register("session", null),
            get: async ({ sessionID }) => ({ id: sessionID, directory: "/proj" }),
            context: async ({ sessionID }) => [{ id: "msg1" }],
            list: async () => [{ id: "s1", time: { updated: Date.now() } }],
            create: async (input) => ({ id: "s-new" }),
            prompt: async (input) => {
                calls.prompt.push(input)
                return { user: { message: { role: "assistant", parts: [] } }, parts: [{ type: "text", text: "done" }] }
            },
            synthetic: async (input) => {
                calls.synthetic.push(input)
                return {}
            },
            interrupt: async () => ({}),
        },
        event: { subscribe },
    }
    return { ctx, registrations, calls, pushEvent }
}

const runSetup = async (name, ctx) => {
    const def = await mod(name)
    assert.equal(typeof def, "object")
    assert.ok(typeof def.id === "string" && def.id.length > 0)
    assert.equal(typeof def.setup, "function")
    return { def, cleanup: await def.setup(ctx) }
}

for (const [key, file] of Object.entries(plugins)) {
    test(`default export definition: ${key}`, async () => {
        const { cleanup } = await runSetup(key, makeCtx().ctx)
        assert.equal(typeof cleanup, "function")
        await cleanup()
    })
}

test("secrets: tool.execute.before blocks .env paths via v2 event", async () => {
    const { ctx, registrations } = makeCtx()
    const { cleanup } = await runSetup("secrets", ctx)
    const cb = registrations["tool:execute.before"]
    assert.ok(cb, "tool.execute.before registered")
    const evt = { tool: "read", sessionID: "s1", agent: "a", messageID: "m", id: "c1", input: { path: "/proj/.env" } }
    await assert.rejects(cb(evt), /hardblock/)
    await cleanup()
})

test("secrets: bash tool referencing .env is blocked", async () => {
    const { ctx, registrations } = makeCtx()
    const { cleanup } = await runSetup("secrets", ctx)
    const cb = registrations["tool:execute.before"]
    const evt = { tool: "bash", sessionID: "s1", agent: "a", messageID: "m", id: "c1", input: { command: "cat .env" } }
    await assert.rejects(cb(evt), /hardblock/)
    await cleanup()
})

test("secrets: permission evaluation denies .env patterns (effect denied)", async () => {
    const { ctx, registrations } = makeCtx()
    const { cleanup } = await runSetup("secrets", ctx)
    const cb = registrations["permission:evaluate"]
    assert.ok(cb, "permission.evaluate registered")
    const evt = { sessionID: "s1", action: "read", resources: ["**/.env"], effect: "ask" }
    await cb(evt)
    assert.equal(evt.effect, "deny")
    await cleanup()
})

test("secrets: non-secret permission evaluation keeps effect", async () => {
    const { ctx, registrations } = makeCtx()
    const { cleanup } = await runSetup("secrets", ctx)
    const cb = registrations["permission:evaluate"]
    const evt = { sessionID: "s1", action: "read", resources: ["src/main.py"], effect: "ask" }
    await cb(evt)
    assert.equal(evt.effect, "ask")
    await cleanup()
})

test("hooks: tool.execute.before allows through when bridge inert (no brain)", async () => {
    const { ctx, registrations } = makeCtx()
    const { cleanup } = await runSetup("hooks", ctx)
    const cb = registrations["tool:execute.before"]
    const evt = { tool: "bash", sessionID: "s1", agent: "a", messageID: "m", id: "c1", input: { command: "ls" } }
    await cb(evt) // must resolve (inert) — and event.args stays mutable in place
    assert.ok(evt)
    await cleanup()
})

test("hooks: tool.execute.after enrichment maps onto v2 result", async () => {
    const { ctx, registrations } = makeCtx()
    const { cleanup } = await runSetup("hooks", ctx)
    const cb = registrations["tool:execute.after"]
    assert.ok(cb, "tool.execute.after registered")
    const evt = {
        tool: "bash",
        sessionID: "s1",
        agent: "a",
        messageID: "m",
        id: "c1",
        input: { command: "ls" },
        status: "completed",
        result: { output: "orig", metadata: { a: 1 } },
    }
    await cb(evt) // no brain → no post capability → result unchanged
    assert.equal(evt.result.output, "orig")
    assert.deepEqual(evt.result.metadata, { a: 1 })
    await cleanup()
})

test("context: compaction hook leaves result unset when the bridge is inert", async () => {
    const { ctx, registrations } = makeCtx()
    const { cleanup } = await runSetup("context", ctx)
    const cb = registrations["session:compaction"]
    assert.ok(cb, "session.compaction registered")
    const evt = {
        sessionID: "s1",
        model: "m",
        system: [],
        messages: [],
        options: {},
        agent: "a",
        tools: {},
        result: undefined,
    }
    await cb(evt)
    // Inert bridge: no brain → no context reply → result stays unset.
    assert.equal(evt.result, undefined)
    await cleanup()
})

test("context: compaction context steers the summarizer, never replaces the summary", async () => {
    const { ctx, registrations } = makeCtx()
    const { bridgeHooksV2 } = await import(new URL("../plugins/opencode-v2.js", import.meta.url))
    const fakeServer = async () => ({
        "experimental.session.compacting": async (_input, output) => {
            output.prompt = "Summarize with the checkpoint headings."
            output.context.push("PROJECT RULES: reload AGENTS.md")
        },
    })
    const cleanup = await bridgeHooksV2(ctx, [fakeServer])
    const cb = registrations["session:compaction"]
    assert.ok(cb, "session.compaction registered")
    const evt = {
        sessionID: "s1",
        model: "m",
        system: [],
        messages: [],
        options: {},
        agent: "a",
        tools: {},
        result: undefined,
    }
    await cb(evt)
    // Setting result would replace the checkpoint and skip the model call —
    // the ~100-token compaction regression.
    assert.equal(evt.result, undefined)
    assert.equal(evt.system.length, 1)
    assert.match(evt.system[0].text, /checkpoint headings/)
    assert.match(evt.system[0].text, /PROJECT RULES: reload AGENTS\.md/)
    await cleanup()
})

test("task: gate enrichment resolves via stubbed v2 ctx (agents/tools)", async () => {
    const { ctx, registrations } = makeCtx()
    const { cleanup } = await runSetup("task", ctx)
    const cb = registrations["tool:execute.before"]
    const evt = {
        tool: "task",
        sessionID: "s1",
        agent: "a",
        messageID: "m",
        id: "c1",
        input: { description: "sub", prompt: "hello", agent: "general", model: undefined },
    }
    await cb(evt) // inert bridge: gate proceeds, introspection must not crash
    assert.ok(evt)
    await cleanup()
})

test("aggregator: index.js default registers all seven concerns", async () => {
    const index = await import(new URL("../plugins/index.js", import.meta.url))
    assert.equal(typeof index.default, "object")
    assert.equal(index.default.id, "css-mcp-opencode-plugin")
    assert.equal(typeof index.default.setup, "function")
    const { ctx, registrations } = makeCtx()
    const cleanup = await index.default.setup(ctx)
    assert.ok(registrations["tool:execute.before"], "tool gate")
    assert.ok(registrations["tool:execute.after"], "post")
    assert.ok(registrations["permission:evaluate"], "permission")
    assert.ok(registrations["shell:create.before"], "shell env")
    assert.ok(registrations["session:compaction"], "compaction")
    assert.equal(typeof cleanup, "function")
    await cleanup()
})

test("v2 promptAsync: noReply injects synthetic; a plain prompt starts a real turn", async () => {
    const { ctx, calls } = makeCtx()
    const { bridgeHooksV2 } = await import(new URL("../plugins/opencode-v2.js", import.meta.url))
    let adapted
    await bridgeHooksV2(ctx, [
        async ({ client }) => {
            adapted = client
            return {}
        },
    ])
    await adapted.session.promptAsync({
        path: { id: "s1" },
        body: { parts: [{ type: "text", text: "resume" }] },
    })
    await new Promise((r) => setTimeout(r, 0))
    assert.deepEqual(calls.synthetic, [])
    assert.deepEqual(calls.prompt.map((call) => call.text), ["resume"])

    await adapted.session.promptAsync({
        path: { id: "s1" },
        body: { parts: [{ type: "text", text: "context" }], noReply: true },
    })
    assert.deepEqual(calls.synthetic.map((call) => call.text), ["context"])
    assert.equal(calls.prompt.length, 1)
})

test("v2 activity tracker: status/execution events mark sessions broadcast-active", async () => {
    const { ctx, pushEvent } = makeCtx()
    const { bridgeHooksV2 } = await import(new URL("../plugins/opencode-v2.js", import.meta.url))
    let adapted
    await bridgeHooksV2(ctx, [
        async ({ client }) => {
            adapted = client
            return {}
        },
    ])
    pushEvent({ type: "session.status", data: { sessionID: "s-run", status: { type: "busy" } } })
    pushEvent({
        type: "session.status",
        data: { sessionID: "s-429", status: { type: "retry", attempt: 1, message: "429", next: 0 } },
    })
    pushEvent({ type: "session.execution.started", data: { sessionID: "s-exec" } })
    pushEvent({ type: "session.status", data: { sessionID: "s-idle", status: { type: "idle" } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const res = await adapted.session.active()
    assert.deepEqual(Object.keys(res.data).sort(), ["s-429", "s-exec", "s-run"])
})

/** Adapt a v2 server ctx into the v1-shaped client without registering a plugin. */
const adaptOnly = async (ctx) => {
    const { bridgeHooksV2 } = await import(new URL("../plugins/opencode-v2.js", import.meta.url))
    let adapted
    await bridgeHooksV2(ctx, [
        async ({ client }) => {
            adapted = client
            return {}
        },
    ])
    return adapted
}

test("v2 server stubs: TUI-owned surfaces fail safe without touching ctx", async () => {
    let touchedCredential = false
    let touchedFork = false
    const ctx = {
        get credential() {
            touchedCredential = true
            return undefined
        },
        session: {
            get fork() {
                touchedFork = true
                return undefined
            },
        },
    }
    const client = await adaptOnly(ctx)

    for (const surface of ["list", "create", "remove"]) {
        assert.equal(typeof client.credential?.[surface], "function", `credential.${surface} exists`)
    }
    assert.equal(typeof client.session.fork, "function", "session.fork exists")
    assert.equal(typeof client.credential.activate, "function", "server credential.activate stays real")
    assert.equal(client.integration, undefined, "no client.integration")

    const results = [
        await client.credential.list(),
        await client.credential.create({ integrationID: "opencode", label: "L", key: "k" }),
        await client.credential.remove({ credentialID: "cred_1" }),
        await client.session.fork({ path: { id: "s1" } }),
    ]
    for (const res of results) {
        // Each stub resolves (never throws) an error object — not an empty
        // result that a caller could mistake for "no credentials".
        assert.match(res.error.message, /unavailable on the server part \(the TUI part owns it\)/)
        assert.equal("data" in res, false)
    }
    assert.equal(touchedCredential, false, "stubs never read ctx.credential")
    assert.equal(touchedFork, false, "session.fork stub never reads ctx.session.fork")
})

test("v2 server credential.activate: real mapping, fail-safe when absent", async () => {
    const calls = []
    const ctx = {
        session: {},
        credential: {
            activate: async (input) => {
                calls.push(input)
            },
        },
    }
    const client = await adaptOnly(ctx)
    assert.deepEqual(await client.credential.activate({ credentialID: "cred_1" }), { ok: true })
    assert.deepEqual(calls, [{ credentialID: "cred_1" }])

    const absent = await adaptOnly({ session: {} })
    const res = await absent.credential.activate({ credentialID: "cred_1" })
    assert.match(res.error.message, /credential\.activate unavailable/)
})

test("adaptTuiClient: exact param/return mapping over the TUI client", async () => {
    const { adaptTuiClient } = await import(new URL("../plugins/opencode-v2.js", import.meta.url))
    const calls = { create: [], activate: [], remove: [], fork: [], prompt: [] }
    const client = adaptTuiClient({
        credential: {
            list: async () => [
                {
                    id: "cred_1",
                    integrationID: "opencode",
                    label: "OPENCODE_API_KEY",
                    active: true,
                    value: { type: "key", key: "stored-secret" },
                },
            ],
            create: async (input) => {
                calls.create.push(input)
                return {
                    id: "cred_2",
                    integrationID: input.integrationID,
                    label: input.label,
                    active: true,
                    value: input.value,
                }
            },
            activate: async (input) => calls.activate.push(input),
            remove: async (input) => calls.remove.push(input),
        },
        session: {
            fork: async (input) => {
                calls.fork.push(input)
                return { id: "s-fork", parentID: input.sessionID }
            },
            prompt: async (input) => calls.prompt.push(input),
        },
    })

    assert.deepEqual(await client.credential.list(), {
        ok: true,
        credentials: [{ id: "cred_1", integrationID: "opencode", label: "OPENCODE_API_KEY", active: true }],
    })

    const created = await client.credential.create({
        integrationID: "opencode",
        label: "OPENCODE_API_KEY_1",
        key: "next-secret",
    })
    // create maps the caller's `key` into the client's value union.
    assert.deepEqual(calls.create, [
        { integrationID: "opencode", label: "OPENCODE_API_KEY_1", value: { type: "key", key: "next-secret" } },
    ])
    assert.deepEqual(created, {
        ok: true,
        id: "cred_2",
        label: "OPENCODE_API_KEY_1",
        integrationID: "opencode",
        active: true,
    })

    assert.deepEqual(await client.credential.activate({ credentialID: "cred_1" }), { ok: true })
    assert.deepEqual(await client.credential.remove({ credentialID: "cred_1" }), { ok: true })
    assert.deepEqual(calls.activate, [{ credentialID: "cred_1" }])
    assert.deepEqual(calls.remove, [{ credentialID: "cred_1" }])

    assert.deepEqual(await client.session.fork({ sessionID: "s1", before: "m9" }), { ok: true, id: "s-fork" })
    assert.deepEqual(calls.fork, [{ sessionID: "s1", before: "m9" }])
    // An omitted `before` still maps the exact two-key request shape.
    await client.session.fork({ sessionID: "s2" })
    assert.deepEqual(calls.fork[1], { sessionID: "s2", before: undefined })

    assert.deepEqual(await client.session.prompt({ sessionID: "s1", text: "ignore rate limit & resume" }), {
        ok: true,
    })
    assert.deepEqual(calls.prompt, [{ sessionID: "s1", text: "ignore rate limit & resume" }])

    // `value` is input-only: no output may carry the secret or the field.
    const outputs = JSON.stringify([await client.credential.list(), created])
    assert.equal(outputs.includes("value"), false)
    assert.equal(outputs.includes("stored-secret"), false)
    assert.equal(outputs.includes("next-secret"), false)
})

test("adaptTuiClient: missing methods are unsupported, rejected calls are call_failed", async () => {
    const { adaptTuiClient } = await import(new URL("../plugins/opencode-v2.js", import.meta.url))
    const empty = adaptTuiClient({})
    const attempts = [
        ["credential.list", () => empty.credential.list()],
        ["credential.create", () => empty.credential.create({ integrationID: "o", label: "L", key: "k" })],
        ["credential.activate", () => empty.credential.activate({ credentialID: "cred_1" })],
        ["credential.remove", () => empty.credential.remove({ credentialID: "cred_1" })],
        ["session.fork", () => empty.session.fork({ sessionID: "s1" })],
        ["session.prompt", () => empty.session.prompt({ sessionID: "s1", text: "t" })],
    ]
    for (const [surface, attempt] of attempts) {
        const res = await attempt() // resolves, never throws
        assert.equal(res.ok, false)
        assert.equal(res.error.code, "unsupported", `${surface} unsupported`)
        assert.match(res.error.message, /unavailable on the TUI client/)
    }

    const broken = adaptTuiClient({
        credential: {
            list: async () => {
                throw new Error("list boom")
            },
            create: async () => {
                throw new Error("create boom")
            },
            activate: async () => Promise.reject(new Error("activate boom")),
            remove: async () => {
                throw new Error("remove boom")
            },
        },
        session: {
            fork: async () => {
                throw new Error("fork boom")
            },
            prompt: async () => {
                throw new Error("prompt boom")
            },
        },
    })
    const failedAttempts = [
        ["list boom", () => broken.credential.list()],
        ["create boom", () => broken.credential.create({ integrationID: "o", label: "L", key: "k" })],
        ["activate boom", () => broken.credential.activate({ credentialID: "cred_1" })],
        ["remove boom", () => broken.credential.remove({ credentialID: "cred_1" })],
        ["fork boom", () => broken.session.fork({ sessionID: "s1" })],
        ["prompt boom", () => broken.session.prompt({ sessionID: "s1", text: "t" })],
    ]
    for (const [message, attempt] of failedAttempts) {
        const res = await attempt()
        assert.equal(res.ok, false)
        assert.equal(res.error.code, "call_failed")
        assert.equal(res.error.message, message)
    }

    // A partially-present client: present methods work, absent ones are unsupported.
    const partial = adaptTuiClient({ credential: { activate: async () => {} } })
    assert.deepEqual(await partial.credential.activate({ credentialID: "cred_1" }), { ok: true })
    assert.equal((await partial.credential.list()).error.code, "unsupported")
})

test("v2 adapter: the only environment read is the broadcast-window knob", async () => {
    const { readFile } = await import("node:fs/promises")
    const src = await readFile(new URL("../plugins/opencode-v2.js", import.meta.url), "utf8")
    // A credential value is read from `process.env[label]` at the consumer
    // (the TUI control consumer), never here: this module may only read the
    // broadcast-window knob by its literal name.
    const envReads = [...new Set([...src.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))]
    assert.deepEqual(envReads, ["OPENCODE_BROADCAST_WINDOW_MS"])
    assert.equal(/process\.env\s*\[/.test(src), false, "no dynamic process.env[...] credential lookup")
})
