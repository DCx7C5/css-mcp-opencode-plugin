/**
 * Plugin E2E tests — against the real Python test brain
 * (`scripts/client.py --serve`). The brain registers every capability,
 * never denies `pre`/`permission`, and replies bare `ok` to `post`,
 * `shell-env`, and `context`.
 *
 * Assertions:
 *  - bootstrap + capability gate work (RPC path taken, not inert),
 *  - `pre` / task gate allow and leave args untouched,
 *  - `permission` maps the brain's `status: "allow"`,
 *  - `post` / `shell-env` / compacting leave output unchanged (no payloads),
 *  - secrets still hardblocks `.env` even with a brain (local invariant).
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = mkdtempSync(join(tmpdir(), "css-mcp-e2e-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock
process.env.OPENCODE_BOOTSTRAP_TIMEOUT = "5000"

let brain
let secrets
let hooks
let task
let permission
let context

const waitForSocket = async (path, timeout = 10_000) => {
    const start = Date.now()
    while (!existsSync(path)) {
        if (Date.now() - start > timeout) throw new Error(`socket ${path} never appeared`)
        await new Promise((r) => setTimeout(r, 50))
    }
}

before(async () => {
    brain = spawn("uv", ["run", "python", "scripts/client.py", "--serve", "--socket", sock], {
        cwd: root,
        stdio: ["ignore", "pipe", "inherit"],
        detached: true,
    })
    await waitForSocket(sock)

    secrets = await (await import(`${root}plugins/plugin-secrets.js`)).server({})
    hooks = await (await import(`${root}plugins/plugin-hooks.js`)).server({})
    task = await (await import(`${root}plugins/plugin-task.js`)).server({})
    permission = await (await import(`${root}plugins/plugin-permission.js`)).server({})
    context = await (await import(`${root}plugins/plugin-context.js`)).server({})

    // Allow connect + bootstrap handshake to settle.
    await new Promise((r) => setTimeout(r, 600))
})

after(async () => {
    try {
        process.kill(-brain.pid, "SIGINT") // detached → whole process group
    } catch {
        // ESRCH: already dead.
    }
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    await new Promise((r) => setTimeout(r, 200))
    rmSync(dir, { recursive: true, force: true })
})

test("bootstrap registered pre/permission and pre allows (RPC path)", async () => {
    const pre = { args: { command: "ls" } }
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, pre)
    assert.equal(pre.args.command, "ls")
})

test("task gate allows subagent launch through the brain", async () => {
    const out = { args: { prompt: "p", agent: "general" } }
    await task["tool.execute.before"]({ tool: "task", sessionID: "s", callID: "c2" }, out)
    assert.equal(out.args.agent, "general")
})

test("permission maps brain allow", async () => {
    const out = { status: "ask" }
    await permission["permission.ask"]({ type: "bash", pattern: "ls", sessionID: "s", callID: "c3" }, out)
    assert.equal(out.status, "allow")
})

test("post leaves output unchanged (bare ok reply)", async () => {
    const out = { title: "t", output: "o", metadata: { m: 1 } }
    await hooks["tool.execute.after"]({ tool: "bash", args: {}, sessionID: "s", callID: "c4" }, out)
    assert.equal(out.output, "o")
    assert.deepEqual(out.metadata, { m: 1 })
})

test("shell.env leaves env unchanged (empty env reply)", async () => {
    const out = { env: {} }
    await hooks["shell.env"]({ cwd: "/tmp", sessionID: "s", callID: "c5" }, out)
    assert.deepEqual(out.env, {})
})

test("compacting leaves context unchanged (bare ok reply)", async () => {
    const out = { prompt: "orig", context: [] }
    await context["experimental.session.compacting"]({ sessionID: "s" }, out)
    assert.equal(out.prompt, "orig")
    assert.deepEqual(out.context, [])
})

test("secrets hardblock still applies with a brain connected", async () => {
    await assert.rejects(
        () => secrets["tool.execute.before"]({ tool: "read" }, { args: { filePath: ".env" } }),
        /hardblock/,
    )
    const out = { status: "ask" }
    await secrets["permission.ask"]({ type: "read", pattern: ".env" }, out)
    assert.equal(out.status, "deny")
})
