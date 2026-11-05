/**
 * session.broadcast consumer — Python pushes {id, prompt}; transport prompts
 * every session that ran during the incident window (runtime running set ∪
 * recently updated sessions) or one explicit sessionID.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-broadcast-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

const now = Date.now()
const SESSIONS = [
    { id: "s-recent", time: { updated: now - 60_000 } },
    { id: "s-recent-2", time: { updated: now - 5 * 60_000 } },
    { id: "s-stale", time: { updated: now - 3 * 60 * 60_000 } },
    { id: "s-archived", time: { updated: now - 60_000, archived: now - 60_000 } },
    { id: "s-child", parentID: "s-recent", time: { updated: now - 60_000 } },
]

const delivered = []
let brain
let client
let clientSocket = null
const brainSend = (obj) => clientSocket?.write(JSON.stringify(obj) + "\n")
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

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
                    socket.write(JSON.stringify({ id: msg.id, ok: true, capabilities: { pre: true } }) + "\n")
                }
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    client = {
        session: {
            list: async () => ({ data: SESSIONS, error: undefined }),
            promptAsync: async ({ body, path }) => {
                delivered.push({ text: body.parts[0].text, sessionID: path.id, synthetic: body.parts[0].synthetic })
                return { data: {}, error: undefined }
            },
        },
    }
    await (await import("../plugins/plugin-hooks.js")).server({ client })
    await settle(500)
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("broadcast prompts every recently active session, skips stale and archived", async () => {
    delete client.session.active
    delete client.session.status
    brainSend({ type: "push", channel: "session.broadcast", body: { id: "b1", prompt: "standup" } })
    await settle()
    assert.deepEqual(delivered.map((d) => d.sessionID).sort(), ["s-recent", "s-recent-2"])
    assert.ok(delivered.every((d) => d.text === "standup" && d.synthetic === undefined))
})

test("a sessionID targets one session regardless of age", async () => {
    delete client.session.active
    delete client.session.status
    delivered.length = 0
    brainSend({ type: "push", channel: "session.broadcast", body: { id: "b2", prompt: "ping", sessionID: "s-stale" } })
    await settle()
    assert.deepEqual(delivered, [{ text: "ping", sessionID: "s-stale", synthetic: undefined }])
})

test("running set is unioned with recently active sessions", async () => {
    delivered.length = 0
    delete client.session.status
    client.session.active = async () => ({
        data: { "s-live": { type: "running" }, "s-child": { type: "running" } },
    })
    brainSend({ type: "push", channel: "session.broadcast", body: { id: "b3", prompt: "resume" } })
    await settle()
    assert.deepEqual(delivered.map((d) => d.sessionID).sort(), ["s-live", "s-recent", "s-recent-2"])
})

test("session.status fallback: busy/retry sessions are prompted, idle is not", async () => {
    delivered.length = 0
    delete client.session.active
    client.session.status = async () => ({
        data: {
            "s-busy": { type: "busy" },
            "s-retry": { type: "retry", attempt: 1, message: "429", next: 0 },
            "s-idle": { type: "idle" },
        },
    })
    brainSend({ type: "push", channel: "session.broadcast", body: { id: "b4", prompt: "resume" } })
    await settle()
    assert.deepEqual(delivered.map((d) => d.sessionID).sort(), ["s-busy", "s-recent", "s-recent-2", "s-retry"])
})
