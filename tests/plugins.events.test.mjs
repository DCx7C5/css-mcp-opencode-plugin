/**
 * Event-forwarding completeness E2E — verifies plugin-events.js forwards
 * EVERY event type in the SDK's `Event` union to the Python brain, and that
 * delivery is fire-and-forget (never blocks opencode's event loop, never
 * waits for a brain reply).
 *
 *  - Hookable events go through the `event.pipeline` RPC only when the
 *    `eventPipeline` capability is registered; otherwise they fall back to
 *    the debounced fire-and-forget `event` RPC (they are never dropped).
 *  - Non-hookable events always go through the fire-and-forget `event` RPC.
 *  - Untracked event types (not in the SDK union / not hook-synthesized)
 *    are ignored silently.
 *
 * The test brain is a minimal `node:net` server; the SDK client is a no-op
 * stub (events never touch the SDK). The plugin instance is loaded once in
 * `before` — re-invoking `server()` would re-run the bootstrap handshake
 * and race the non-blocking capability gate.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-events-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

const eventRPCs = [] // captured `event` (fire-and-forget) RPC bodies
const pipelineOps = [] // captured `event.pipeline` RPC bodies
let brain
let clientSocket = null
let pipelineCapability = false
let eventsHook = null // plugin-events server instance (captured in before)

const brainSend = (obj) => clientSocket?.write(JSON.stringify(obj) + "\n")

// Every `type` literal in the SDK Event union (types.gen.d.ts line ~602).
const SDK_EVENT_TYPES = [
    "server.instance.disposed",
    "installation.updated",
    "installation.update-available",
    "lsp.client.diagnostics",
    "lsp.updated",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
    "permission.updated",
    "permission.replied",
    "session.status",
    "session.idle",
    "session.compacted",
    "file.edited",
    "todo.updated",
    "command.executed",
    "session.created",
    "session.updated",
    "session.deleted",
    "session.diff",
    "session.error",
    "file.watcher.updated",
    "vcs.branch.updated",
    "tui.prompt.append",
    "tui.command.execute",
    "tui.toast.show",
    "pty.created",
    "pty.updated",
    "pty.exited",
    "pty.deleted",
    "server.connected",
]

// Hook-synthesized events the bridge emits itself (pre/permission/shell-env
// hooks) — these are also forwarded even though the SSE bus does not emit
// them with these exact names.
const HOOK_SYNTHESIZED_TYPES = ["permission.asked", "tool.execute.before", "tool.execute.after", "shell.env"]

const flushWait = (ms = 300) => new Promise((r) => setTimeout(r, ms))

/** Flatten captured event RPCs: single bodies + `event.batch` members. */
const capturedEventTypes = () => {
    const types = []
    for (const body of eventRPCs) {
        if (body.type === "event.batch") types.push(...body.events.map((e) => e.type))
        else types.push(body.type)
    }
    return types.sort()
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
                if (msg.op === "bootstrap") {
                    socket.write(
                        JSON.stringify({
                            id: msg.id,
                            ok: true,
                            capabilities: { pre: true, permission: true, eventPipeline: pipelineCapability },
                        }) + "\n",
                    )
                } else if (msg.op === "event") {
                    eventRPCs.push(msg.body)
                    // Fire-and-forget: server MUST NOT reply (NO_REPLY op).
                } else if (msg.op === "event.pipeline") {
                    pipelineOps.push(msg.body)
                    socket.write(JSON.stringify({ id: msg.id, ok: true, hooks_ran: [] }) + "\n")
                }
                // Anything else: intentionally ignored.
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    eventsHook = (await (await import("../plugins/plugin-events.js")).server({ client: {} })).event
    // Pool connect + bootstrap handshake (eventPipeline:false default).
    await new Promise((r) => setTimeout(r, 500))
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("every SDK Event type is tracked by the bridge", async () => {
    const { isTrackedEvent } = await import("../plugins/transport.js")
    for (const type of SDK_EVENT_TYPES) {
        assert.equal(isTrackedEvent(type), true, `expected ${type} to be tracked`)
    }
    for (const type of HOOK_SYNTHESIZED_TYPES) {
        assert.equal(isTrackedEvent(type), true, `expected ${type} to be tracked`)
    }
})

test("hookable events without eventPipeline capability fall back to fire-and-forget event RPC", async () => {
    eventRPCs.length = 0
    pipelineOps.length = 0
    // Brain bootstrapped with eventPipeline:false (pipelineCapability default).
    await eventsHook({ event: { type: "todo.updated", properties: { id: "t1" } } })
    await flushWait()
    assert.equal(pipelineOps.length, 0, "no pipeline RPC without the capability")
    const types = capturedEventTypes()
    assert.deepEqual(types, ["todo.updated"], "todo.updated must still reach the brain via fire-and-forget")
})

test("non-hookable events are fire-and-forgotten regardless of capabilities", async () => {
    eventRPCs.length = 0
    await eventsHook({ event: { type: "command.executed", properties: { id: "c1" } } })
    await flushWait()
    await eventsHook({ event: { type: "vcs.branch.updated", properties: { branch: "main" } } })
    await flushWait()
    assert.deepEqual(capturedEventTypes(), ["command.executed", "vcs.branch.updated"])
})

test("hookable events use the pipeline RPC when the capability is present", async () => {
    // Turn the capability on live via capabilities.update push.
    pipelineCapability = true
    brainSend({ type: "push", channel: "capabilities.update", body: { eventPipeline: true } })
    await flushWait()

    pipelineOps.length = 0
    await eventsHook({ event: { type: "session.created", properties: { id: "s1" } } })
    await flushWait()
    assert.equal(pipelineOps.length, 1, "session.created must go through the pipeline")
    assert.equal(pipelineOps[0].type, "session.created")
    assert.equal(pipelineOps[0].properties.id, "s1")
})

test("untracked event types are ignored (never forwarded, never throw)", async () => {
    eventRPCs.length = 0
    pipelineOps.length = 0
    await eventsHook({ event: { type: "message.created", properties: {} } })
    await eventsHook({ event: { type: "some.future.event", properties: {} } })
    await flushWait()
    assert.equal(eventRPCs.length, 0)
    assert.equal(pipelineOps.length, 0)
})

test("event hooks never await a reply — no pending RPC is left behind", async () => {
    // The `event` op is NO_REPLY: server intentionally ignores it, so after
    // the debounce window there must be zero pending entries in the pool.
    eventRPCs.length = 0
    await eventsHook({ event: { type: "message.updated", properties: { id: "m1" } } })
    await flushWait(500)
    assert.ok(eventRPCs.length >= 1)
    const { poolStats } = await import("../plugins/transport.js")
    const stats = poolStats()
    assert.equal(stats.pending, 0, "fire-and-forget events must not leave pending entries")
})
