/**
 * Task-launch E2E test — exercises the `task.launch` reverse-RPC: Python
 * pushes a launch request, transport.js replicates the opencode `task` tool
 * over the SDK client (`session.create` + `session.prompt`) and replies
 * `{id, ok, sessionID, info, parts, text}` over the socket.
 *
 * The test brain is a minimal `node:net` server that answers bootstrap and
 * records every `{id, ok, ...}` reply line. The SDK client is mocked.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-task-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock

const replies = []
const preOps = [] // captured `pre` RPC bodies (task gate)
let brain
let clientSocket = null
let failPrompt = false
let hangPrompt = false

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

/** Mock SDK client recording every create/prompt/abort call. */
const makeClient = () => ({
    session: {
        create: async ({ body, query }) => {
            makeClient.calls.created.push({ body, query })
            return { data: { id: `sess-${makeClient.calls.created.length}` }, error: undefined }
        },
        prompt: async ({ path, body }) => {
            makeClient.calls.prompts.push({ path, body })
            if (hangPrompt) await new Promise(() => {}) // never resolves
            if (failPrompt) return { info: undefined, parts: [], error: { message: "run failed" } }
            return {
                info: { id: "msg-1", role: "assistant" },
                parts: [
                    { type: "text", text: "planning" },
                    { type: "tool", name: "bash" },
                    { type: "text", text: "final answer" },
                ],
                error: undefined,
            }
        },
        abort: async ({ path }) => {
            makeClient.calls.aborted.push(path.id)
        },
    },
    app: {
        agents: async () => ({
            data: [
                {
                    name: "code-reviewer",
                    description: "Reviews diffs",
                    mode: "subagent",
                    builtIn: false,
                    model: { providerID: "anthropic", modelID: "opus" },
                },
                { name: "explore", description: "Finds files", mode: "subagent", builtIn: true },
            ],
            error: undefined,
        }),
    },
    tool: {
        ids: async () => ({ data: ["bash", "read", "task", "write"], error: undefined }),
    },
})
makeClient.calls = { created: [], prompts: [], aborted: [] }

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
                            capabilities: { pre: true, permission: true, context: true },
                        }) + "\n",
                    )
                } else if (msg.op === "pre") {
                    preOps.push(msg.body)
                    socket.write(JSON.stringify({ id: msg.id, ok: true }) + "\n")
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

    // Start the bridge with the mock client (activeClient is set here).
    await (await import("../plugins/plugin-hooks.js")).server({ client: makeClient() })
    // Pool connect + bootstrap handshake.
    await new Promise((r) => setTimeout(r, 500))
})

after(async () => {
    brain?.close()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("task.launch creates a child session, prompts the agent, replies result", async () => {
    const pending = waitForReply("tid1")
    brainSend({
        type: "push",
        channel: "task.launch",
        body: {
            id: "tid1",
            prompt: "do it",
            agent: "code-reviewer",
            model: { providerID: "anthropic", modelID: "opus" },
            system: "be strict",
            tools: { bash: true, task: false },
            title: "review the diff",
            parentSessionID: "parent-1",
            directory: "/proj",
        },
    })
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.equal(reply.sessionID, "sess-1")
    assert.equal(reply.info.role, "assistant")
    assert.equal(reply.text, "final answer")
    assert.equal(reply.parts.length, 3)

    const created = makeClient.calls.created[0]
    assert.deepEqual(created.body, { parentID: "parent-1", title: "review the diff" })
    assert.deepEqual(created.query, { directory: "/proj" })

    const prompted = makeClient.calls.prompts[0]
    assert.equal(prompted.path.id, "sess-1")
    assert.deepEqual(prompted.body, {
        parts: [{ type: "text", text: "do it" }],
        agent: "code-reviewer",
        model: { providerID: "anthropic", modelID: "opus" },
        system: "be strict",
        tools: { bash: true, task: false },
    })
})

test("task.launch omits optional knobs when absent", async () => {
    const pending = waitForReply("tid2")
    brainSend({ type: "push", channel: "task.launch", body: { id: "tid2", prompt: "just prompt" } })
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.equal(reply.sessionID, "sess-2")

    const created = makeClient.calls.created[1]
    assert.deepEqual(created.body, {})
    const prompted = makeClient.calls.prompts[1]
    assert.deepEqual(prompted.body, { parts: [{ type: "text", text: "just prompt" }] })
})

test("task.launch prompt error replies ok:false with client_error", async () => {
    failPrompt = true
    try {
        const pending = waitForReply("tid3")
        brainSend({ type: "push", channel: "task.launch", body: { id: "tid3", prompt: "will fail" } })
        const reply = await pending
        assert.equal(reply.ok, false)
        assert.equal(reply.error.code, "client_error")
        assert.equal(reply.error.message, "run failed")
        assert.equal(reply.error.sessionID, "sess-3")
    } finally {
        failPrompt = false
    }
})

test("task.launch missing prompt replies invalid_request", async () => {
    const pending = waitForReply("tid4")
    brainSend({ type: "push", channel: "task.launch", body: { id: "tid4", prompt: "   " } })
    const reply = await pending
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, "invalid_request")
})

test("task.launch timeout aborts the session and replies timeout", async () => {
    hangPrompt = true
    try {
        const pending = waitForReply("tid5", 3000)
        brainSend({
            type: "push",
            channel: "task.launch",
            body: { id: "tid5", prompt: "slow", timeoutMs: 150 },
        })
        const reply = await pending
        assert.equal(reply.ok, false)
        assert.equal(reply.error.code, "timeout")
        const sessionID = reply.error.sessionID
        assert.equal(sessionID, `sess-${makeClient.calls.created.length}`)
        // The abort call must target the launched session.
        assert.ok(makeClient.calls.aborted.includes(sessionID))
    } finally {
        hangPrompt = false
    }
})

test("task.launch with no active client replies no_client", async () => {
    await (await import("../plugins/plugin-secrets.js")).server({ client: null })
    const pending = waitForReply("tid6")
    brainSend({ type: "push", channel: "task.launch", body: { id: "tid6", prompt: "hi" } })
    const reply = await pending
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, "no_client")
})

test("task.launch malformed body is ignored (no crash, no reply)", async () => {
    const before = replies.length
    brainSend({ type: "push", channel: "task.launch", body: { prompt: "no id" } })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(replies.length, before)
})

test("task gate pre RPC ships available_agents + tool_ids enrichment", async () => {
    // Restore the bridge client (secrets plugin nulled activeClient above).
    await (await import("../plugins/plugin-hooks.js")).server({ client: makeClient() })
    await new Promise((r) => setTimeout(r, 500))

    preOps.length = 0
    const gate = (await (await import("../plugins/plugin-task.js")).server({ client: makeClient() }))[
        "tool.execute.before"
    ]
    const output = {
        args: { prompt: "find the bug", agent: "code-reviewer", subagent_type: undefined },
    }
    await gate({ tool: "task", callID: "c-1", sessionID: "s-1" }, output)

    const body = preOps[0]
    assert.equal(body.tool, "task")
    assert.deepEqual(body.task, {
        prompt: "find the bug",
        agent: "code-reviewer",
    })
    assert.deepEqual(body.available_agents, [
        {
            name: "code-reviewer",
            description: "Reviews diffs",
            mode: "subagent",
            builtIn: false,
            model: { providerID: "anthropic", modelID: "opus" },
        },
        { name: "explore", description: "Finds files", mode: "subagent", builtIn: true, model: null },
    ])
    assert.deepEqual(body.tool_ids, ["bash", "read", "task", "write"])
    // Gate passed (brain replied ok:true, no throw).
})

test("task gate enrichment is fail-safe when SDK introspection throws", async () => {
    preOps.length = 0
    const brokenClient = {
        app: { agents: async () => { throw new Error("agents boom") } },
        tool: { ids: async () => ({ error: { message: "ids boom" } }) },
    }
    const gate = (await (await import("../plugins/plugin-task.js")).server({ client: brokenClient }))[
        "tool.execute.before"
    ]
    const output = { args: { prompt: "do it", agent: "explore" } }
    await gate({ tool: "task", callID: "c-2", sessionID: "s-2" }, output)

    const body = preOps[0]
    assert.equal(body.available_agents, null)
    assert.equal(body.tool_ids, null)
    assert.equal(body.task.agent, "explore")
})
