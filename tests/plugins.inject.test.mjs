/**
 * session.inject consumer suite — Python pushes live content, transport.js
 * delivers it into the active session via `client.session.promptAsync`.
 *
 * Covered: FIFO ordering per session, dedupe by inject id, fail-safe on
 * client errors (never throws into the push handler), and forwarding of the
 * optional A2A turn knobs (model/agent/system/tools/messageID).
 *
 * The brain is a minimal `node:net` server (bootstrap only); the SDK client
 * is mocked to record every promptAsync call.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-inject-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

const delivered = []
let brain
let clientSocket = null

const brainSend = (obj) => clientSocket?.write(JSON.stringify(obj) + "\n")

const waitForCount = (n, timeout = 3_000) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`delivered ${delivered.length}, expected ${n}`)),
            timeout,
        )
        const poll = setInterval(() => {
            if (delivered.length >= n) {
                clearInterval(poll)
                clearTimeout(timer)
                resolve()
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
                            capabilities: { pre: true },
                        }) + "\n",
                    )
                }
                // Other JS requests (events etc.) intentionally ignored.
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    const client = {
        session: {
            get: async () => ({ data: {}, error: undefined }),
            messages: async () => ({ data: [], error: undefined }),
            promptAsync: async ({ body, path }) => {
                delivered.push({ parts: body.parts, sessionID: path.id, noReply: body.noReply, extras: body })
                return { data: {}, error: undefined }
            },
        },
    }
    await (await import("../plugins/plugin-hooks.js")).server({ client })
    await new Promise((r) => setTimeout(r, 500)) // pool connect + bootstrap
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("session.inject delivers FIFO per session and dedupes by id", async () => {
    brainSend({ type: "push", channel: "session.inject", body: { id: "i1", sessionID: "s1", kind: "user", content: "one" } })
    brainSend({ type: "push", channel: "session.inject", body: { id: "i2", sessionID: "s1", kind: "system", content: "two" } })
    brainSend({ type: "push", channel: "session.inject", body: { id: "i3", sessionID: "s1", kind: "user", content: "three" } })
    await waitForCount(3)

    assert.deepEqual(delivered.map((d) => d.parts[0].text), ["one", "two", "three"])
    assert.ok(delivered.every((d) => d.sessionID === "s1" && d.noReply === true))
    assert.ok(delivered.every((d) => d.parts[0].synthetic === true))

    // Dedupe: replaying i2 must not deliver a 4th part.
    brainSend({ type: "push", channel: "session.inject", body: { id: "i2", sessionID: "s1", kind: "system", content: "two" } })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(delivered.length, 3)
})

test("session.inject forwards A2A turn knobs (model/agent/system/tools/messageID)", async () => {
    brainSend({
        type: "push",
        channel: "session.inject",
        body: {
            id: "i4",
            sessionID: "s1",
            kind: "user",
            content: "with knobs",
            messageID: "mid-1",
            model: "claude-opus",
            agent: "general",
            system: "custom system prompt",
            tools: ["bash", "read"],
        },
    })
    await waitForCount(4)
    const last = delivered[3]
    assert.equal(last.extras.messageID, "mid-1")
    assert.equal(last.extras.model, "claude-opus")
    assert.equal(last.extras.agent, "general")
    assert.equal(last.extras.system, "custom system prompt")
    assert.deepEqual(last.extras.tools, ["bash", "read"])
})

test("session.inject is fail-safe on client error (no throw, no crash)", async () => {
    // Replace the active client with one that throws on promptAsync.
    await (await import("../plugins/plugin-secrets.js")).server({
        client: {
            session: {
                get: async () => ({ data: {}, error: undefined }),
                messages: async () => ({ data: [], error: undefined }),
                promptAsync: async () => {
                    throw new Error("inject boom")
                },
            },
        },
    })
    brainSend({ type: "push", channel: "session.inject", body: { id: "i5", sessionID: "s2", kind: "user", content: "x" } })
    await new Promise((r) => setTimeout(r, 300))
    // The failing delivery is dropped; nothing crashed (unhandled rejection
    // would fail the test), and prior deliveries are untouched.
    assert.equal(delivered.length, 4)
})
