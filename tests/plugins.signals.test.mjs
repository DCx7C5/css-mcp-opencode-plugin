/**
 * Signal detector tests — a minimal `node:net` brain captures the `signal`
 * op emitted by `plugins/plugin-signals.js`.
 *
 * Assertions:
 *  - the free-limit signal fires from the runtime v2 events the plugin hook
 *    actually receives (`session.text.ended`, `session.step.failed`,
 *    `session.execution.failed`, `tui.toast.show`);
 *  - the real 429 payload (`error.type = provider.free-limit`) matches, even
 *    when the textual phrase is absent — the TUI sentence is client-rendered
 *    and never appears on the wire;
 *  - the 10-minute cooldown is per signal/session;
 *  - the op is sent on the `e:` prefix with the expected body and never
 *    waits for the brain reply.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-signals-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

/** The wire text of a free-quota rejection. */
const PHRASE = "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models."

/** The verbatim error opencode persisted on 2026-11-05 22:20:47. */
const FREE_LIMIT_ERROR = {
    type: "provider.free-limit",
    message: PHRASE,
    status: 429,
    response: {
        body: JSON.stringify({
            type: "error",
            error: {
                type: "FreeUsageLimitError",
                message: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
            },
        }),
    },
    retryAfterMs: 10376000,
}

const signalBodies = []
const signalLines = []
let brain
let signalsHook = null

const flushWait = (ms = 250) => new Promise((r) => setTimeout(r, ms))

before(async () => {
    brain = createServer((socket) => {
        let buf = ""
        socket.on("data", (chunk) => {
            buf += chunk
            let idx
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx).toString()
                buf = buf.slice(idx + 1)
                if (!line.trim()) continue
                // Strip the per-plugin wire prefix (`e:` here) before decoding.
                const msg = JSON.parse(line.replace(/^[ecpths]:/, ""))
                if (msg.op === "bootstrap") {
                    socket.write(JSON.stringify({ id: msg.id, ok: true, capabilities: {} }) + "\n")
                } else if (msg.op === "signal") {
                    signalLines.push(line)
                    signalBodies.push(msg.body)
                    socket.write(JSON.stringify({ id: msg.id, ok: true, body: { accepted: true } }) + "\n")
                }
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    signalsHook = (await (await import("../plugins/plugin-signals.js")).server({ client: {} })).event
    // Let the pool connect and finish the bootstrap handshake.
    await new Promise((r) => setTimeout(r, 500))
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("detects the wire phrase in completed assistant text", async () => {
    signalBodies.length = 0
    signalLines.length = 0
    await signalsHook({
        event: {
            type: "session.text.ended",
            data: { sessionID: "s1", assistantMessageID: "m1", text: PHRASE },
        },
    })
    await flushWait()
    assert.equal(signalBodies.length, 1)
    assert.ok(signalLines[0].startsWith("e:"), `expected the e: prefix, got: ${signalLines[0].slice(0, 20)}`)
    assert.equal(signalBodies[0].signal, "free_messages_exhausted")
    assert.equal(signalBodies[0].sessionID, "s1")
    assert.equal(signalBodies[0].messageID, "m1")
    assert.ok(signalBodies[0].excerpt.includes("Free usage limit reached"))
})

test("still reads the properties envelope", async () => {
    signalBodies.length = 0
    await signalsHook({
        event: { type: "session.text.ended", properties: { sessionID: "s1b", text: PHRASE } },
    })
    await flushWait()
    assert.equal(signalBodies.length, 1)
})

test("detects the real 429 free-limit step failure", async () => {
    signalBodies.length = 0
    await signalsHook({
        event: {
            type: "session.step.failed",
            data: { sessionID: "s3", assistantMessageID: "m3", error: FREE_LIMIT_ERROR },
        },
    })
    await flushWait()
    assert.equal(signalBodies.length, 1, "the production 429 payload must fire the signal")
    assert.equal(signalBodies[0].signal, "free_messages_exhausted")
    assert.equal(signalBodies[0].sessionID, "s3")
    assert.ok(signalBodies[0].excerpt.includes("provider.free-limit"))
})

test("detects the same error on session.execution.failed", async () => {
    signalBodies.length = 0
    await signalsHook({
        event: {
            type: "session.execution.failed",
            data: { sessionID: "s3b", error: FREE_LIMIT_ERROR },
        },
    })
    await flushWait()
    assert.equal(signalBodies.length, 1)
})

test("structured error type matches without the textual phrase", async () => {
    signalBodies.length = 0
    await signalsHook({
        event: {
            type: "session.step.failed",
            data: {
                sessionID: "s4",
                error: { type: "provider.free-limit", message: "quota gone", status: 429 },
            },
        },
    })
    await flushWait()
    assert.equal(signalBodies.length, 1)
})

test("detects the phrase in a TUI toast", async () => {
    signalBodies.length = 0
    await signalsHook({
        event: {
            type: "tui.toast.show",
            data: { message: PHRASE, variant: "error" },
        },
    })
    await flushWait()
    assert.equal(signalBodies.length, 1)
})

test("suppresses repeated matches in the same session", async () => {
    signalBodies.length = 0
    const event = {
        type: "session.text.ended",
        data: { sessionID: "s2", text: PHRASE },
    }
    await signalsHook({ event })
    await flushWait()
    await signalsHook({ event })
    await flushWait()
    assert.equal(signalBodies.length, 1, "the 10-minute cooldown must suppress the second match")
})

test("a different session is not suppressed", async () => {
    signalBodies.length = 0
    await signalsHook({
        event: { type: "session.text.ended", data: { sessionID: "s2b", text: PHRASE } },
    })
    await flushWait()
    assert.equal(signalBodies.length, 1)
    assert.equal(signalBodies[0].sessionID, "s2b")
})

test("ignores unrelated text and unwatched events", async () => {
    signalBodies.length = 0
    await signalsHook({
        event: { type: "session.text.ended", data: { sessionID: "s7", text: "hello" } },
    })
    await signalsHook({
        event: {
            type: "session.step.failed",
            data: { sessionID: "s7b", error: { type: "provider.server", message: "boom", status: 500 } },
        },
    })
    await signalsHook({
        // SDK alias — never emitted on the plugin hook surface.
        event: { type: "session.next.text.ended", data: { sessionID: "s7c", text: PHRASE } },
    })
    await flushWait()
    assert.equal(signalBodies.length, 0)
})
