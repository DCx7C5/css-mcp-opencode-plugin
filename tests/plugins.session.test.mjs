/**
 * Session-intel E2E test — exercises the `session.intel` reverse-RPC
 * (bounded stats/recent/diff/todo reads), the `session.summarize`
 * reverse-RPC (forced compaction kick-off), and the compaction handshake:
 * the `experimental.session.compacting` hook must ship that intel to the
 * brain so it can decide the replacement prompt / surviving context.
 *
 * The test brain is a minimal `node:net` server; the SDK client is mocked.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-sess-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

const replies = []
const contextOps = [] // captured `context` RPC bodies (compaction handshake)
let brain
let clientSocket = null
let failDiff = false
let ctx = null // plugin-context server instance (captured in before)

const brainSend = (obj) => clientSocket?.write(JSON.stringify(obj) + "\n")

const waitForReply = (id, timeout = 3000) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply for ${id}`)), timeout)
        const poll = setInterval(() => {
            const found = replies.find((r) => r.id === id)
            if (found) {
                clearInterval(poll)
                clearTimeout(timer)
                resolve(found)
            }
        }, 10)
    })

/** Mock SDK client with canned session data. */
const makeClient = () => ({
    session: {
        messages: async () => ({
            data: [
                { info: { role: "user", time: { updated: 10 } }, parts: [{ type: "text", text: "hello" }] },
                { info: { role: "assistant", time: { updated: 20 } }, parts: [{ type: "text", text: "hi there" }] },
                { info: { role: "user", time: { updated: 30 } }, parts: [{ type: "text", text: "bye" }] },
            ],
            error: undefined,
        }),
        diff: async () => {
            if (failDiff) throw new Error("diff boom")
            return {
                data: [{ file: "src/a.ts", before: "1", after: "2", additions: 1, deletions: 0 }],
                error: undefined,
            }
        },
        todo: async () => ({
            data: [{ id: "t1", content: "ship it", status: "in_progress", priority: "high" }],
            error: undefined,
        }),
        summarize: async ({ path, body }) => {
            makeClient.summaries.push({ path, body })
            return { data: true, error: undefined }
        },
    },
})
makeClient.summaries = []

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
                const msg = JSON.parse(line)
                if (msg.op === "bootstrap") {
                    socket.write(
                        JSON.stringify({
                            id: msg.id,
                            ok: true,
                            capabilities: { pre: true, permission: true, context: true },
                        }) + "\n",
                    )
                } else if (msg.op === "context") {
                    contextOps.push(msg.body)
                    socket.write(JSON.stringify({ id: msg.id, ok: true }) + "\n")
                } else if (msg.id !== undefined && "ok" in msg) {
                    // Reverse-RPC reply written by transport.js.
                    replies.push(msg)
                }
                // Other JS requests (events etc.) are intentionally ignored.
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    ctx = await (await import("../plugins/plugin-context.js")).server({ client: makeClient() })
    // Pool connect + bootstrap handshake.
    await new Promise((r) => setTimeout(r, 500))
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("session.intel replies with stats/recent/diff/todo", async () => {
    const pending = waitForReply("sid1")
    brainSend({ type: "push", channel: "session.intel", body: { id: "sid1", sessionID: "s1" } })
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.equal(reply.sessionID, "s1")
    assert.deepEqual(reply.stats, { total: 3, byRole: { user: 2, assistant: 1 }, lastUpdated: 30 })
    assert.equal(reply.recent, "hello\n\nhi there\n\nbye")
    assert.equal(reply.diff.length, 1)
    assert.equal(reply.diff[0].file, "src/a.ts")
    assert.equal(reply.todo.length, 1)
    assert.equal(reply.todo[0].content, "ship it")
})

test("session.intel respects the what filter", async () => {
    const pending = waitForReply("sid2")
    brainSend({ type: "push", channel: "session.intel", body: { id: "sid2", sessionID: "s1", what: ["diff"] } })
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.equal(reply.diff.length, 1)
    assert.equal("stats" in reply, false)
    assert.equal("todo" in reply, false)
})

test("session.intel is fail-safe per item (diff throws → null, others intact)", async () => {
    failDiff = true
    try {
        const pending = waitForReply("sid3")
        brainSend({ type: "push", channel: "session.intel", body: { id: "sid3", sessionID: "s1" } })
        const reply = await pending
        assert.equal(reply.ok, true)
        assert.equal(reply.diff, null)
        assert.equal(reply.stats.total, 3)
        assert.equal(reply.todo.length, 1)
    } finally {
        failDiff = false
    }
})

test("session.intel malformed body is ignored (no crash, no reply)", async () => {
    const before = replies.length
    brainSend({ type: "push", channel: "session.intel", body: { id: "sid-x" } }) // no sessionID
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(replies.length, before)
})

test("session.summarize kicks off with an optional model override", async () => {
    const pending = waitForReply("sid4")
    brainSend({
        type: "push",
        channel: "session.summarize",
        body: { id: "sid4", sessionID: "s1", model: { providerID: "anthropic", modelID: "opus" } },
    })
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.equal(reply.started, true)
    assert.equal(makeClient.summaries.length, 1)
    assert.deepEqual(makeClient.summaries[0].path, { id: "s1" })
    assert.deepEqual(makeClient.summaries[0].body, { providerID: "anthropic", modelID: "opus" })
})

test("session.summarize without a model omits the body", async () => {
    const pending = waitForReply("sid5")
    brainSend({ type: "push", channel: "session.summarize", body: { id: "sid5", sessionID: "s1" } })
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.equal(makeClient.summaries.length, 2)
    assert.equal(makeClient.summaries[1].body, undefined)
})

test("compaction handshake ships intel in the context RPC body", async () => {
    contextOps.length = 0
    const output = { context: [], prompt: undefined }
    await ctx["experimental.session.compacting"]({ sessionID: "s1" }, output)
    await new Promise((r) => setTimeout(r, 200))

    const op = contextOps.find((b) => b.reason === "compacting")
    assert.ok(op, "compacting context RPC fired")
    assert.equal(op.sessionID, "s1")
    assert.equal(op.session.stats.total, 3)
    assert.equal(op.session.stats.byRole.user, 2)
    assert.equal(op.session.recent.includes("hi there"), true)
    assert.equal(op.session.diff.length, 1)
    assert.equal(op.session.todo.length, 1)
    // No prompt/context in the brain reply → default compaction.
    assert.equal(output.prompt, undefined)
    assert.deepEqual(output.context, [])
})

test("session.intel with no active client replies no_client", async () => {
    await (await import("../plugins/plugin-secrets.js")).server({ client: null })
    const pending = waitForReply("sid6")
    brainSend({ type: "push", channel: "session.intel", body: { id: "sid6", sessionID: "s1" } })
    const reply = await pending
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, "no_client")
})
