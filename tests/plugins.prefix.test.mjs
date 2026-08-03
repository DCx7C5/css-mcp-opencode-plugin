/**
 * Per-plugin wire prefix tests — every JS→Python line carries the owning
 * plugin letter (`e:`/`c:`/`p:`/`t:`/`h:`); bridge-level bootstrap stays
 * plain JSON; Python→JS replies are never prefixed.
 *
 * A raw-line-capturing node:net brain records every line it receives and
 * replies to every op (never to `event`). Each plugin is driven through its
 * hook and the captured raw line is asserted to start with the plugin letter.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-prefix-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

let brain
const rawLines = []
let hooks
let task
let permission
let context
let events

/** The last captured raw wire line whose JSON body carried this op. */
const lastRawFor = (op) => {
    const lines = rawLines.filter((l) => {
        try {
            return JSON.parse(l.replace(/^[ecpths]:/, "")).op === op
        } catch {
            return false
        }
    })
    return lines[lines.length - 1] ?? ""
}

const flushWait = (ms = 300) => new Promise((r) => setTimeout(r, ms))

/** Mock SDK client: task-gate introspection + session intel surfaces. */
const makeClient = () => ({
    app: { agents: async () => ({ data: [], error: undefined }) },
    tool: { ids: async () => ({ data: ["bash", "task"], error: undefined }) },
    session: {
        messages: async () => ({ data: [], error: undefined }),
        diff: async () => ({ data: [], error: undefined }),
        todo: async () => ({ data: [], error: undefined }),
    },
})

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
                rawLines.push(line)
                // Strip the per-plugin wire prefix (<letter>:) before parsing.
                const msg = JSON.parse(line.replace(/^[ecpths]:/, ""))
                if (msg.op === "bootstrap") {
                    socket.write(
                        JSON.stringify({
                            id: msg.id,
                            ok: true,
                            capabilities: {
                                pre: true,
                                permission: true,
                                post: true,
                                shellEnv: true,
                                context: true,
                                eventPipeline: true,
                            },
                        }) + "\n",
                    )
                } else if (msg.op === "event") {
                    // Fire-and-forget: server MUST NOT reply (NO_REPLY op).
                } else {
                    socket.write(JSON.stringify({ id: msg.id, ok: true }) + "\n")
                }
            }
        })
    })
    brain.listen(sock)
    await once(brain, "listening")

    hooks = await (await import("../plugins/plugin-hooks.js")).server({ client: makeClient() })
    task = await (await import("../plugins/plugin-task.js")).server({ client: makeClient() })
    permission = await (await import("../plugins/plugin-permission.js")).server({ client: makeClient() })
    context = await (await import("../plugins/plugin-context.js")).server({ client: makeClient() })
    events = await (await import("../plugins/plugin-events.js")).server({ client: {} })

    await new Promise((r) => setTimeout(r, 500)) // pool connect + bootstrap
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    await new Promise((r) => setTimeout(r, 200))
    rmSync(dir, { recursive: true, force: true })
})

test("bootstrap handshake is plain JSON (no prefix)", () => {
    const line = rawLines.find((l) => {
        try {
            return JSON.parse(l.replace(/^[ecpths]:/, "")).op === "bootstrap"
        } catch {
            return false
        }
    })
    assert.ok(line, "expected a bootstrap line to be captured")
    assert.ok(line.startsWith("{"), `bootstrap must be unprefixed, got: ${line.slice(0, 40)}`)
})

test("plugin-hooks pre RPC is h-prefixed", async () => {
    const out = { args: { command: "ls" } }
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "h1" }, out)
    assert.ok(lastRawFor("pre").startsWith("h:"), `expected h: prefix, got: ${lastRawFor("pre").slice(0, 40)}`)
})

test("plugin-hooks post RPC is h-prefixed", async () => {
    const out = { title: "t", output: "o", metadata: {} }
    await hooks["tool.execute.after"]({ tool: "bash", args: {}, sessionID: "s", callID: "h2" }, out)
    assert.ok(lastRawFor("post").startsWith("h:"), `expected h: prefix, got: ${lastRawFor("post").slice(0, 40)}`)
})

test("plugin-hooks shell-env RPC is h-prefixed", async () => {
    const out = { env: {} }
    await hooks["shell.env"]({ cwd: "/tmp", sessionID: "s", callID: "h3" }, out)
    assert.ok(lastRawFor("shell-env").startsWith("h:"), `expected h: prefix, got: ${lastRawFor("shell-env").slice(0, 40)}`)
})

test("plugin-task pre RPC is t-prefixed", async () => {
    const out = { args: { prompt: "p", agent: "general" } }
    await task["tool.execute.before"]({ tool: "task", sessionID: "s", callID: "t1" }, out)
    assert.ok(lastRawFor("pre").startsWith("t:"), `expected t: prefix, got: ${lastRawFor("pre").slice(0, 40)}`)
})

test("plugin-permission RPC is p-prefixed", async () => {
    const out = { status: "ask" }
    await permission["permission.ask"]({ type: "bash", pattern: "ls", sessionID: "s", callID: "p1" }, out)
    assert.ok(lastRawFor("permission").startsWith("p:"), `expected p: prefix, got: ${lastRawFor("permission").slice(0, 40)}`)
})

test("plugin-context compacting RPC is c-prefixed", async () => {
    const out = { prompt: "orig", context: [] }
    await context["experimental.session.compacting"]({ sessionID: "s" }, out)
    assert.ok(lastRawFor("context").startsWith("c:"), `expected c: prefix, got: ${lastRawFor("context").slice(0, 40)}`)
})

test("plugin-events pipeline RPC is e-prefixed", async () => {
    const beforeCount = rawLines.length
    await events.event({ event: { type: "session.created", properties: { id: "s1" } } })
    await flushWait()
    const pipeline = rawLines.slice(beforeCount).find((l) => {
        try {
            return JSON.parse(l.replace(/^[ecpths]:/, "")).op === "event.pipeline"
        } catch {
            return false
        }
    })
    assert.ok(pipeline?.startsWith("e:"), `expected e: prefix, got: ${pipeline?.slice(0, 40) ?? "no pipeline line"}`)
})

test("plugin-events fire-and-forget event RPC is e-prefixed", async () => {
    const beforeCount = rawLines.length
    await events.event({ event: { type: "command.executed", properties: { id: "c1" } } })
    await flushWait()
    const evt = rawLines.slice(beforeCount).find((l) => {
        try {
            return JSON.parse(l.replace(/^[ecpths]:/, "")).op === "event"
        } catch {
            return false
        }
    })
    assert.ok(evt?.startsWith("e:"), `expected e: prefix, got: ${evt?.slice(0, 40) ?? "no event line"}`)
})

test("every captured wire line is well-formed JSON after stripping its prefix", () => {
    for (const line of rawLines) {
        const stripped = line.replace(/^[ecpths]:/, "")
        const msg = JSON.parse(stripped)
        assert.ok(msg.op, `expected op in ${stripped.slice(0, 40)}`)
        assert.ok(msg.id, `expected id in ${stripped.slice(0, 40)}`)
    }
})
