/**
 * Push-consumer registry, bootstrap `part` identity and reply-prefix tests.
 *
 * A raw-line-capturing `node:net` brain plays the Python side: it records
 * every JS→Py line, answers every request (`{id, ok:true}`) and can push
 * frames to the plugin. Each harness case imports a FRESH transport module
 * instance (`?case=N` — a distinct ESM specifier reloads the file), so the
 * `part` identity never leaks between cases.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

process.env.OPENCODE_BRIDGE_DEBUG = "1"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = mkdtempSync(join(tmpdir(), "css-mcp-push-"))
let seq = 0

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms))

/** Parse a captured wire line, stripping the per-plugin prefix. */
const parseLine = (line) => JSON.parse(line.replace(/^[a-z]:/, ""))

/**
 * Start a minimal brain on its own socket and load a fresh transport
 * instance pointed at it.
 * @param {object} [input] extra startBridge input (e.g. `{ part: "server" }`)
 */
async function harness(input = {}) {
    const caseId = ++seq
    const sock = join(dir, `hooks-${caseId}.sock`)
    const lines = []
    const sockets = []
    const brain = createServer((socket) => {
        sockets.push(socket)
        let buf = ""
        socket.on("data", (chunk) => {
            buf += chunk.toString()
            let idx
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx)
                buf = buf.slice(idx + 1)
                if (!line.trim()) continue
                lines.push(line)
                const msg = parseLine(line)
                // A JS→Py reply line (`{id, ok, ...payload}`) has no op and is
                // never answered; requests get the standard ok reply.
                if (!msg.op) continue
                if (msg.op === "event") continue // NO_REPLY op
                socket.write(`${JSON.stringify({ id: msg.id, ok: true })}\n`)
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    process.env.OPENCODE_PYTHON_SOCK = sock
    const mod = await import(`../plugins/transport.js?case=${caseId}`)
    mod.startBridge({ client: {}, ...input })
    await wait(400)
    return { mod, brain, sockets, lines }
}

/** Shut the fresh instance down and drop its brain + sockets. */
async function closeHarness(h) {
    h.mod.closeBridge()
    for (const socket of h.sockets) socket.destroy()
    h.brain.close()
    await wait(50)
}

/**
 * Push one frame from the brain to the live plugin connection.
 * @param {object} h harness
 * @param {string} channel
 * @param {object} body
 * @param {string} [envelopeID] reverse-RPC id at ENVELOPE level — the shape
 *   Python's `push_request` uses (`{type:"push", channel, body, id}`)
 */
function pushToBrain(h, channel, body, envelopeID) {
    const socket = h.sockets.findLast((s) => !s.destroyed)
    assert.ok(socket, "expected a live plugin connection")
    const frame = { type: "push", channel, body }
    if (envelopeID !== undefined) frame.id = envelopeID
    socket.write(`${JSON.stringify(frame)}\n`)
}

/** Every bootstrap request body captured by the brain. */
const bootstrapBodies = (h) => h.lines
    .map((line) => parseLine(line))
    .filter((msg) => msg.op === "bootstrap")
    .map((msg) => msg.body)

test("bootstrap omits part when the caller never names one", async () => {
    const h = await harness()
    try {
        assert.deepEqual(bootstrapBodies(h), [{ protocol: "v0.4" }])
    } finally {
        await closeHarness(h)
    }
})

test("bootstrap carries part: server", async () => {
    const h = await harness({ part: "server" })
    try {
        assert.deepEqual(bootstrapBodies(h), [{ protocol: "v0.4", part: "server" }])
    } finally {
        await closeHarness(h)
    }
})

test("bootstrap carries part: tui", async () => {
    const h = await harness({ part: "tui" })
    try {
        assert.deepEqual(bootstrapBodies(h), [{ protocol: "v0.4", part: "tui" }])
    } finally {
        await closeHarness(h)
    }
})

test("an unknown part is ignored — the handshake omits the field", async () => {
    const h = await harness({ part: "worker" })
    try {
        assert.deepEqual(bootstrapBodies(h), [{ protocol: "v0.4" }])
    } finally {
        await closeHarness(h)
    }
})

// ── server-part claim from every plugin module ────────────────────────
// The seven plugin modules import the BARE `./transport.js` specifier (a
// relative import drops any query), so an in-process reload cannot give each
// module its own bridge — `bridgeEnv.part` is sticky on the shared singleton.
// Each case therefore loads one plugin module in a fresh child process with a
// fresh module registry, and asserts the bootstrap body that module produced.

/** The seven per-concern plugin modules that claim the server side. */
const PLUGIN_MODULES = [
    "plugin-secrets.js",
    "plugin-hooks.js",
    "plugin-task.js",
    "plugin-permission.js",
    "plugin-context.js",
    "plugin-events.js",
    "plugin-signals.js",
]

/**
 * Child probe: start a minimal brain, load ONE plugin module (fresh registry),
 * drive its v1 `server()` export and print the bootstrap request body.
 */
const PROBE_SCRIPT = String.raw`
import { createServer } from "node:net"
import { once } from "node:events"

const sockets = []
let printed = false
const brain = createServer((socket) => {
    sockets.push(socket)
    let buf = ""
    socket.on("data", (chunk) => {
        buf += chunk.toString()
        let idx
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx)
            buf = buf.slice(idx + 1)
            if (!line.trim()) continue
            const msg = JSON.parse(line.replace(/^[a-z]:/, ""))
            if (msg.op === "bootstrap" && !printed) {
                printed = true
                process.stdout.write(JSON.stringify(msg.body) + "\n")
            }
            if (msg.op && msg.op !== "event") {
                socket.write(JSON.stringify({ id: msg.id, ok: true, capabilities: {} }) + "\n")
            }
        }
    })
})
brain.listen(process.env.PROBE_SOCK)
await once(brain, "listening")
process.env.OPENCODE_PYTHON_SOCK = process.env.PROBE_SOCK
const { server } = await import(process.env.PLUGIN_URL)
await server({ client: {} })
const deadline = Date.now() + 5000
while (!printed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
const { closeBridge } = await import(process.env.TRANSPORT_URL)
closeBridge()
for (const socket of sockets) socket.destroy()
brain.close()
if (!printed) process.exitCode = 2
`

/** Run the probe for one plugin module and return its bootstrap body. */
function bootstrapBodyFor(file) {
    const caseId = ++seq
    const sock = join(dir, `probe-${caseId}.sock`)
    const out = execFileSync(process.execPath, ["--input-type=module", "--eval", PROBE_SCRIPT], {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
            ...process.env,
            // Nothing but the probe's JSON may reach stdout (console.debug
            // writes there when the bridge debug flag is on).
            OPENCODE_BRIDGE_DEBUG: "0",
            OPENCODE_DEBUG: "",
            OPENCODE_BOOTSTRAP_TIMEOUT: "3000",
            PROBE_SOCK: sock,
            PLUGIN_URL: fileURLToPath(new URL(`../plugins/${file}`, import.meta.url)),
            TRANSPORT_URL: fileURLToPath(new URL("../plugins/transport.js", import.meta.url)),
        },
    })
    const line = out.trim().split("\n").findLast((candidate) => candidate.startsWith("{"))
    assert.ok(line, `probe for ${file} printed no bootstrap body (stdout: ${out.slice(0, 200)})`)
    return JSON.parse(line)
}

for (const file of PLUGIN_MODULES) {
    test(`bootstrap from ${file} carries part: server`, () => {
        assert.deepEqual(bootstrapBodyFor(file), { protocol: "v0.4", part: "server" })
    })
}

// ── push-consumer registry (one shared instance) ──────────────────────

let h

before(async () => {
    h = await harness({ part: "server" })
})

after(async () => {
    await closeHarness(h)
})

test("onPush registers a per-channel consumer and dispatch delivers the push body", async () => {
    const seen = []
    h.mod.onPush("test.dispatch", (body, reply) => {
        seen.push({ body, reply })
    })
    pushToBrain(h, "test.dispatch", { id: "d-1", value: 42 })
    await wait(150)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].body, { id: "d-1", value: 42 })
    assert.equal(typeof seen[0].reply, "function")
})

test("an envelope-only push id reaches the consumer body and its reply", async () => {
    const seen = []
    h.mod.onPush("test.envelope-id", (body, reply) => {
        seen.push(body)
        reply(body.id, true, { echoed: true })
    })
    pushToBrain(h, "test.envelope-id", { value: 1 }, "env-id-only")
    await wait(150)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], { value: 1, id: "env-id-only" })
    const replyLine = h.lines
        .map(parseLine)
        .find((msg) => msg.op === undefined && msg.id === "env-id-only")
    assert.ok(replyLine, "expected a reply line carrying the envelope id")
    assert.deepEqual(replyLine, { id: "env-id-only", ok: true, echoed: true })
})

test("a body-level push id wins over a different envelope id", async () => {
    const seen = []
    h.mod.onPush("test.body-id-wins", (body, reply) => {
        seen.push(body)
        reply(body.id, true, { echoed: true })
    })
    pushToBrain(h, "test.body-id-wins", { id: "body-id-wins", value: 2 }, "env-id-loses")
    await wait(150)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], { id: "body-id-wins", value: 2 })
    const replies = h.lines.map(parseLine).filter((msg) => msg.op === undefined)
    assert.ok(replies.some((msg) => msg.id === "body-id-wins"), "expected the body id on the reply")
    assert.ok(!replies.some((msg) => msg.id === "env-id-loses"), "the envelope id must not overwrite a body id")
})

test("a duplicate registration for the same channel throws", () => {
    h.mod.onPush("test.duplicate", () => {})
    assert.throws(
        () => h.mod.onPush("test.duplicate", () => {}),
        /channel "test\.duplicate" already has a handler/,
    )
})

test("onPush rejects a missing channel and a non-function handler", () => {
    assert.throws(() => h.mod.onPush("", () => {}), TypeError)
    assert.throws(() => h.mod.onPush(undefined, () => {}), TypeError)
    assert.throws(() => h.mod.onPush("test.invalid", null), TypeError)
})

test("credential.remove/install and session.fork replies are c-prefixed {id, ok, ...payload}", async () => {
    const channels = ["credential.remove", "credential.install", "session.fork"]
    for (const channel of channels) {
        h.mod.onPush(channel, (body, reply) => {
            reply(body.id, true, { channel })
        })
    }
    for (const [index, channel] of channels.entries()) {
        const id = `reply-${index}`
        pushToBrain(h, channel, { id })
        await wait(150)
        const line = h.lines.find((candidate) => {
            try {
                return parseLine(candidate).id === id
            } catch {
                return false
            }
        })
        assert.ok(line, `expected a reply line for ${channel}`)
        assert.ok(line.startsWith("c:"), `expected c: prefix for ${channel}, got: ${line.slice(0, 40)}`)
        assert.deepEqual(JSON.parse(line.slice(2)), { id, ok: true, channel })
    }
})

test("tabs.switch is fire-and-forget — no reply line is written", async () => {
    const seen = []
    h.mod.onPush("tabs.switch", (body) => {
        seen.push(body)
    })
    pushToBrain(h, "tabs.switch", { id: "tab-1", moves: [{ fromSessionID: "a", toSessionID: "b" }] })
    await wait(150)
    assert.equal(seen.length, 1)
    assert.ok(
        !h.lines.some((line) => line.includes('"id":"tab-1"')),
        "tabs.switch must stay fire-and-forget",
    )
})

test("an unregistered channel keeps the no-consumer debug log", async () => {
    const logged = []
    const original = console.debug
    console.debug = (...args) => {
        logged.push(args.map(String).join(" "))
    }
    try {
        pushToBrain(h, "test.unknown", { hello: "world" })
        await wait(150)
    } finally {
        console.debug = original
    }
    assert.ok(
        logged.some((line) => line.includes("push channel=test.unknown (no consumer)")),
        `expected the no-consumer debug line, got: ${logged.filter((l) => l.includes("push")).slice(-3).join(" | ")}`,
    )
})

test("a rejected handler is logged and never escapes into the pool", async () => {
    const errors = []
    const original = console.error
    console.error = (...args) => {
        errors.push(args.map(String).join(" "))
    }
    try {
        h.mod.onPush("test.async", async () => {
            throw new Error("boom")
        })
        pushToBrain(h, "test.async", { id: "a-1" })
        await wait(150)
    } finally {
        console.error = original
    }
    assert.ok(
        errors.some((line) => line.includes("push channel=test.async: handler rejected: boom")),
        `expected the rejected-handler log, got: ${errors.slice(-3).join(" | ")}`,
    )
})

process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
