/**
 * Context-reading E2E test — exercises the `session.context.read` reverse-RPC:
 * Python pushes a read request, transport.js fetches the session + messages
 * from the SDK client and replies `{id, ok, ...}` over the socket.
 *
 * The test brain is a minimal `node:net` server: it answers bootstrap and
 * records every `{id, ok, ...}` reply line the JS side writes back.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-ctx-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

const replies = []
let brain
let clientSocket = null
let context

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
                if (msg.op === "bootstrap") {
                    socket.write(
                        JSON.stringify({
                            id: msg.id,
                            ok: true,
                            capabilities: { pre: true, permission: true, context: true },
                        }) + "\n",
                    )
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

    context = (await import("../plugins/plugin-context.js")).server
    await context({
        client: {
            session: {
                get: async ({ path }) => ({ data: { id: path.id, title: "T" }, error: undefined }),
                messages: async () => ({
                    data: [{ id: "m1" }, { id: "m2" }],
                    error: undefined,
                }),
            },
        },
    })
    // Pool connect + bootstrap handshake.
    await new Promise((r) => setTimeout(r, 500))
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("session.context.read replies with session + messages", async () => {
    const pending = waitForReply("rid1")
    brainSend({ type: "push", channel: "session.context.read", body: { id: "rid1", sessionID: "s1" } })
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.equal(reply.session.id, "s1")
    assert.equal(reply.session.title, "T")
    assert.deepEqual(reply.messages.map((m) => m.id), ["m1", "m2"])
})

test("session.context.read error path replies ok:false (client throws)", async () => {
    // Replace the active client with one that fails.
    await (await import("../plugins/plugin-secrets.js")).server({
        client: {
            session: {
                get: async () => {
                    throw new Error("boom")
                },
                messages: async () => {
                    throw new Error("boom")
                },
            },
        },
    })
    const pending = waitForReply("rid2")
    brainSend({ type: "push", channel: "session.context.read", body: { id: "rid2", sessionID: "s2" } })
    const reply = await pending
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, "client_error")
    assert.equal(reply.error.message, "boom")
})

test("session.context.read malformed body is ignored (no crash, no reply)", async () => {
    brainSend({ type: "push", channel: "session.context.read", body: { id: "rid3" } }) // no sessionID
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(replies.some((r) => r.id === "rid3"), false)
})

test("session.context.read with no active client replies no_client", async () => {
    await (await import("../plugins/plugin-hooks.js")).server({ client: null })
    const pending = waitForReply("rid4")
    brainSend({ type: "push", channel: "session.context.read", body: { id: "rid4", sessionID: "s4" } })
    const reply = await pending
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, "no_client")
})
