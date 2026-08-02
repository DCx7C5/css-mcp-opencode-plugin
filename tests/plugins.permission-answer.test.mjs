/**
 * Permission-answer E2E test — exercises the `permission.answer` reverse-RPC:
 * Python settles a pending permission prompt programmatically via
 * `client.postSessionIdPermissionsPermissionId` (`response: once|always|reject`)
 * without showing the human prompt. Pairs with the `permission.asked` event
 * (which now ships the permission `id` so Python can correlate).
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

const dir = mkdtempSync(join(tmpdir(), "css-mcp-perm-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

const replies = []
const answers = [] // recorded postSessionIdPermissionsPermissionId calls
const eventOps = [] // captured fire-and-forget `event` RPC bodies
let brain
let clientSocket = null
let failAnswer = false

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

/** Mock SDK client recording every permission answer call. */
const makeClient = () => ({
    postSessionIdPermissionsPermissionId: async ({ body, path, query }) => {
        answers.push({ body, path, query })
        if (failAnswer) return { data: false, error: { message: "permission not found" } }
        return { data: true, error: undefined }
    },
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
                const msg = JSON.parse(line)
                if (msg.op === "bootstrap") {
                    socket.write(
                        JSON.stringify({
                            id: msg.id,
                            ok: true,
                            capabilities: { pre: true, permission: true },
                        }) + "\n",
                    )
                } else if (msg.op === "permission") {
                    // Brain decision: allow.
                    socket.write(JSON.stringify({ id: msg.id, ok: true, status: "allow" }) + "\n")
                } else if (msg.op === "event") {
                    eventOps.push(msg.body)
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

    await (await import("../plugins/plugin-permission.js")).server({ client: makeClient() })
    // Pool connect + bootstrap handshake.
    await new Promise((r) => setTimeout(r, 500))
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("permission.answer settles a prompt via the SDK (once)", async () => {
    answers.length = 0
    const pending = waitForReply("pid1")
    brainSend({
        type: "push",
        channel: "permission.answer",
        body: { id: "pid1", permissionID: "perm-1", sessionID: "s-1", response: "once" },
    })
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.equal(reply.permissionID, "perm-1")
    assert.equal(reply.response, "once")
    assert.equal(answers.length, 1)
    assert.deepEqual(answers[0].body, { response: "once" })
    assert.deepEqual(answers[0].path, { id: "s-1", permissionID: "perm-1" })
    assert.equal(answers[0].query, undefined)
})

test("permission.answer supports always/reject and optional directory", async () => {
    answers.length = 0
    for (const [id, response] of [["pid2", "always"], ["pid3", "reject"]]) {
        const pending = waitForReply(id)
        brainSend({
            type: "push",
            channel: "permission.answer",
            body: { id, permissionID: `perm-${id}`, sessionID: "s-1", response, directory: "/proj" },
        })
        const reply = await pending
        assert.equal(reply.ok, true)
        assert.equal(reply.response, response)
    }
    assert.equal(answers.length, 2)
    assert.deepEqual(answers[0].body, { response: "always" })
    assert.deepEqual(answers[1].body, { response: "reject" })
    assert.deepEqual(answers[1].query, { directory: "/proj" })
})

test("permission.answer invalid response is rejected", async () => {
    answers.length = 0
    const pending = waitForReply("pid4")
    brainSend({
        type: "push",
        channel: "permission.answer",
        body: { id: "pid4", permissionID: "perm-4", sessionID: "s-1", response: "maybe" },
    })
    const reply = await pending
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, "invalid_request")
    assert.equal(answers.length, 0)
})

test("permission.answer missing permissionID is rejected", async () => {
    answers.length = 0
    const pending = waitForReply("pid5")
    brainSend({
        type: "push",
        channel: "permission.answer",
        body: { id: "pid5", sessionID: "s-1", response: "once" },
    })
    const reply = await pending
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, "invalid_request")
    assert.equal(answers.length, 0)
})

test("permission.answer client error is surfaced", async () => {
    failAnswer = true
    try {
        answers.length = 0
        const pending = waitForReply("pid6")
        brainSend({
            type: "push",
            channel: "permission.answer",
            body: { id: "pid6", permissionID: "perm-6", sessionID: "s-1", response: "always" },
        })
        const reply = await pending
        assert.equal(reply.ok, false)
        assert.equal(reply.error.code, "client_error")
    } finally {
        failAnswer = false
    }
})

test("permission.answer with no active client replies no_client", async () => {
    // Null out the bridge client (secrets plugin init with null).
    await (await import("../plugins/plugin-secrets.js")).server({ client: null })
    const pending = waitForReply("pid7")
    brainSend({
        type: "push",
        channel: "permission.answer",
        body: { id: "pid7", permissionID: "perm-7", sessionID: "s-1", response: "once" },
    })
    const reply = await pending
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, "no_client")
    // Restore the client for the remaining test.
    await (await import("../plugins/plugin-permission.js")).server({ client: makeClient() })
    await new Promise((r) => setTimeout(r, 500))
})

test("permission.asked event ships the permission id for correlation", async () => {
    // The permission.ask hook forwards `id` in the permission.asked event so
    // Python can correlate with a later permission.answer. Drive the hook
    // directly and assert the debounced event body.
    eventOps.length = 0
    const hook = (await (await import("../plugins/plugin-permission.js")).server({ client: makeClient() }))[
        "permission.ask"
    ]
    const input = { id: "perm-9", type: "bash", pattern: "rm -rf *", sessionID: "s-1", callID: "c-1", title: "run?" }
    const output = { status: undefined }
    await hook(input, output)
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(output.status, "allow")
    const asked = eventOps.find((e) => e.type === "permission.asked")
    assert.ok(asked, "permission.asked event must be forwarded")
    assert.equal(asked.properties.id, "perm-9")
    assert.equal(asked.properties.sessionID, "s-1")
})
