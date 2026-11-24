/**
 * v2 after-hook result contract — the adapter hands the v1 post-hook the REAL
 * tool result, and a null echo can never blank it.
 *
 * Incident this pins (row 3207): the v2 `tool.execute.after` adapter sent
 * `output: {}`, so the post-hook body saw `output.output === undefined`. The
 * bash secret scrub never matched (nothing to scrub) and a brain that echoed
 * the absent result answered `null`, which `sync()` wrote back into
 * `e.result.output` — every Code Mode tool then resolved null.
 *
 * Harness: a real UNIX-socket brain (same shape as
 * `plugins.capabilities.test.mjs`) plus the v2 domain-hook registrations from
 * `plugin-hooks.js`, so the assertions cover the whole
 * adapter → v1 hook → brain → sync path.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-post-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock
process.env.OPENCODE_BOOTSTRAP_TIMEOUT = "2000"

/** Every JS→Py body the brain received, in order. */
const seen = []
/** Reply body the brain answers for the NEXT `post` op. */
let nextPost = { output: null }
let clientSocket = null
let brain
let registrations
let cleanup

const postBodies = () => seen.filter((m) => m.op === "post")

const waitForPosts = (count, timeout = 3_000) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`only ${postBodies().length}/${count} post ops received`)), timeout)
        const poll = setInterval(() => {
            if (postBodies().length >= count) {
                clearInterval(poll)
                clearTimeout(timer)
                resolve()
            }
        }, 10)
    })

/** Stub v2 plugin context: captures every domain-hook registration. */
function makeCtx() {
    /** @type {Record<string, Function>} */
    const regs = {}
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
    const register = (domain) => async (hookName, cb) => {
        regs[`${domain}:${hookName}`] = cb
        return { dispose: async () => {} }
    }
    const ctx = {
        location: { directory: "/proj", project: { id: "proj" } },
        agent: { list: async () => [{ name: "a1", description: "", mode: "subagent", builtIn: false, model: "m" }] },
        tool: { hook: register("tool"), list: async () => [{ id: "read" }, { id: "bash" }] },
        permission: { hook: register("permission"), reply: async () => ({ ok: true }) },
        shell: { hook: register("shell") },
        session: {
            hook: register("session"),
            get: async ({ sessionID }) => ({ id: sessionID, directory: "/proj" }),
            context: async () => [{ id: "msg1" }],
            list: async () => [{ id: "s1", time: { updated: Date.now() } }],
            create: async () => ({ id: "s-new" }),
            prompt: async () => ({ user: { message: { role: "assistant", parts: [] } }, parts: [] }),
            synthetic: async () => ({}),
            interrupt: async () => ({}),
        },
        event: { subscribe },
    }
    return { ctx, regs, pushEvent }
}

before(async () => {
    brain = createServer((socket) => {
        clientSocket = socket
        let buf = ""
        socket.on("data", (chunk) => {
            buf += chunk
            let idx
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx).toString()
                buf = buf.slice(idx + 1)
                if (!line.trim()) continue
                // Strip the per-plugin wire prefix (<letter>:) from JS→Py lines.
                const msg = JSON.parse(line.replace(/^[ecpths]:/, ""))
                seen.push(msg)
                if (msg.op === "bootstrap") {
                    socket.write(
                        JSON.stringify({
                            id: msg.id,
                            ok: true,
                            capabilities: { pre: true, post: true },
                        }) + "\n",
                    )
                } else if (msg.op === "post") {
                    socket.write(JSON.stringify({ id: msg.id, ok: true, ...nextPost }) + "\n")
                }
                // Other ops (events etc.) intentionally unanswered.
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    const { ctx, regs } = makeCtx()
    registrations = regs
    const def = (await import("../plugins/plugin-hooks.js")).default
    cleanup = await def.setup(ctx)
    await new Promise((r) => setTimeout(r, 600)) // pool connect + bootstrap
})

after(async () => {
    await cleanup?.()
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

/** Drive one completed v2 after-event through the registered domain hook. */
async function runAfter(result) {
    const cb = registrations["tool:execute.after"]
    assert.ok(cb, "tool.execute.after registered")
    const evt = {
        tool: "bash",
        sessionID: "s1",
        agent: "a",
        messageID: "m",
        id: `c-${seen.length}`,
        input: { command: "ls" },
        status: "completed",
        result,
    }
    const before = postBodies().length
    await cb(evt)
    await waitForPosts(before + 1)
    return evt
}

test("the post-hook receives the real v2 result, not a blank", async () => {
    const evt = await runAfter({ output: "orig", metadata: { a: 1 } })
    const body = postBodies().at(-1).body
    assert.equal(body.output, "orig", "the brain must see the tool output it is asked to scrub")
    assert.deepEqual(body.metadata, { a: 1 })
    // A brain echoing the absent result answers null; the real output survives.
    assert.equal(evt.result.output, "orig")
})

test("a null echo never blanks the tool result", async () => {
    nextPost = { output: null }
    const evt = await runAfter({ output: "orig", metadata: { a: 1 } })
    assert.equal(evt.result.output, "orig")
    assert.deepEqual(evt.result.metadata, { a: 1 })
})

test("a scrubbed output replaces the tool result", async () => {
    nextPost = { output: "sk-***" }
    const evt = await runAfter({ output: "key sk-live-1234", metadata: { a: 1 } })
    assert.equal(evt.result.output, "sk-***")
})

test("metadata is merged, never replaced, and the output is untouched", async () => {
    nextPost = { metadata: { b: 2 } }
    const evt = await runAfter({ output: "orig", metadata: { a: 1 } })
    assert.deepEqual(evt.result.metadata, { a: 1, b: 2 })
    assert.equal(evt.result.output, "orig")
})
