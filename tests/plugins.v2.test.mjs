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
            create: async (input) => ({ id: "s-new" }),
            prompt: async () => ({ user: { message: { role: "assistant", parts: [] } }, parts: [{ type: "text", text: "done" }] }),
            synthetic: async () => ({}),
            interrupt: async () => ({}),
        },
        event: { subscribe: async function* () {} },
    }
    return { ctx, registrations }
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

test("context: compaction hook maps prompt reply onto result.summary", async () => {
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

test("aggregator: index.js default registers all six concerns", async () => {
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
