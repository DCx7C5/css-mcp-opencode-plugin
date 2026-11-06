/**
 * session.abort consumer — Python pushes {id, sessionIDs}; transport aborts
 * each listed session exactly once through `client.session.abort` and never
 * replies (the push channel is fire-and-forget).
 *
 * Assertions:
 *  - every listed id aborts once, with the SDK call shape `{ path: { id } }`;
 *  - duplicate ids collapse to one abort;
 *  - an empty list is a no-op (the SDK is never called);
 *  - no active client warns instead of throwing;
 *  - a rejecting `client.session.abort` is logged, never thrown.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-abort-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

/** Every argument passed to `client.session.abort`, in call order. */
const abortCalls = []
let brain
let client
let clientSocket = null
const brainSend = (obj) => clientSocket?.write(JSON.stringify(obj) + "\n")
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

const makeClient = () => ({
    session: {
        abort: async (args) => {
            abortCalls.push(args)
            return { data: {}, error: undefined }
        },
    },
})

/** Capture console.error lines written while `fn` runs. */
const captureErrors = async (fn) => {
    const lines = []
    const original = console.error
    console.error = (...a) => lines.push(a.join(" "))
    try {
        await fn()
    } finally {
        console.error = original
    }
    return lines
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
                const msg = JSON.parse(line.replace(/^[ecpths]:/, ""))
                if (msg.op === "bootstrap") {
                    socket.write(JSON.stringify({ id: msg.id, ok: true, capabilities: {} }) + "\n")
                }
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    client = makeClient()
    await (await import("../plugins/plugin-hooks.js")).server({ client })
    await settle(500)
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("aborts every listed session with the SDK call shape", async () => {
    abortCalls.length = 0
    brainSend({ type: "push", channel: "session.abort", body: { id: "a1", sessionIDs: ["s-1", "s-2"] } })
    await settle()
    assert.deepEqual(abortCalls, [{ path: { id: "s-1" } }, { path: { id: "s-2" } }])
})

test("duplicate ids abort once", async () => {
    abortCalls.length = 0
    brainSend({
        type: "push",
        channel: "session.abort",
        body: { id: "a2", sessionIDs: ["s-1", "s-1", "s-2", "s-1"] },
    })
    await settle()
    assert.deepEqual(abortCalls, [{ path: { id: "s-1" } }, { path: { id: "s-2" } }])
})

test("empty list is a no-op that does not call the SDK", async () => {
    abortCalls.length = 0
    brainSend({ type: "push", channel: "session.abort", body: { id: "a3", sessionIDs: [] } })
    await settle()
    assert.deepEqual(abortCalls, [])
})

test("a rejecting abort does not throw", async () => {
    await (await import("../plugins/plugin-hooks.js")).server({
        client: {
            session: {
                abort: async () => {
                    throw new Error("abort boom")
                },
            },
        },
    })
    abortCalls.length = 0
    const lines = await captureErrors(async () => {
        brainSend({ type: "push", channel: "session.abort", body: { id: "a4", sessionIDs: ["s-1"] } })
        await settle()
    })
    assert.ok(lines.some((line) => line.includes("session.abort: abort boom")), lines.join("\n"))
})

test("no active client warns instead of throwing", async () => {
    // Nulls the shared activeClient (same pattern as the task-launch suite).
    await (await import("../plugins/plugin-secrets.js")).server({ client: null })
    const lines = await captureErrors(async () => {
        brainSend({ type: "push", channel: "session.abort", body: { id: "a5", sessionIDs: ["s-1"] } })
        await settle()
    })
    assert.ok(lines.some((line) => line.includes("session.abort: no active client")), lines.join("\n"))
})
