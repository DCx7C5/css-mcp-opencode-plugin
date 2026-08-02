/**
 * capabilities.update live re-apply suite — the Python brain can enable or
 * revoke hook capabilities at runtime with a push, without a reconnect.
 *
 * Setup: bootstrap registers ONLY `pre` (post absent). Then:
 *  - post hook must skip its RPC (no "post" op seen),
 *  - after `capabilities.update` adds post → the post hook sends the RPC,
 *  - after a second push removes post → the post hook skips again.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-caps-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

const ops = []
let brain
let clientSocket = null
let hooks

const brainSend = (obj) => clientSocket?.write(JSON.stringify(obj) + "\n")

const waitForOp = (op, timeout = 3_000) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${op} op received`)), timeout)
        const poll = setInterval(() => {
            if (ops.includes(op)) {
                clearInterval(poll)
                clearTimeout(timer)
                resolve()
            }
        }, 10)
    })

const postCount = () => ops.filter((o) => o === "post").length

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
                ops.push(msg.op)
                if (msg.op === "bootstrap") {
                    socket.write(
                        JSON.stringify({
                            id: msg.id,
                            ok: true,
                            capabilities: { pre: true }, // post NOT registered
                        }) + "\n",
                    )
                } else if (msg.op === "post") {
                    socket.write(JSON.stringify({ id: msg.id, ok: true }) + "\n")
                }
                // Other ops (events etc.) intentionally unanswered.
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    hooks = await (await import("../plugins/plugin-hooks.js")).server({})
    await new Promise((r) => setTimeout(r, 500)) // pool connect + bootstrap
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("post hook skips its RPC when the capability is not registered", async () => {
    await hooks["tool.execute.after"]({ tool: "bash", args: {}, sessionID: "s", callID: "c1" }, { title: "t", output: "o" })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(postCount(), 0)
})

test("capabilities.update push enables the post hook live", async () => {
    brainSend({ type: "push", channel: "capabilities.update", body: { pre: true, post: true } })
    await new Promise((r) => setTimeout(r, 100))
    const before = postCount()
    await hooks["tool.execute.after"]({ tool: "bash", args: {}, sessionID: "s", callID: "c2" }, { title: "t", output: "o" })
    await waitForOp("post")
    assert.equal(postCount(), before + 1)
})

test("capabilities.update push can revoke the capability live", async () => {
    brainSend({ type: "push", channel: "capabilities.update", body: { pre: true } }) // post removed
    await new Promise((r) => setTimeout(r, 100))
    const before = postCount()
    await hooks["tool.execute.after"]({ tool: "bash", args: {}, sessionID: "s", callID: "c3" }, { title: "t", output: "o" })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(postCount(), before)
})
