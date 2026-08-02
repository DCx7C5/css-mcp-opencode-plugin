/**
 * Lost-brain FAIL-OPEN suite — same setup as plugins.failclosed.test.mjs but
 * with OPENCODE_FAIL_OPEN=1: after the brain dies, blocking ops must PROCEED
 * (pre allows, permission stays on the default ask flow). The opt-out is read
 * at module load, so this file must run in its own process (node --test does).
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = mkdtempSync(join(tmpdir(), "css-mcp-failopen-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock
process.env.OPENCODE_BOOTSTRAP_TIMEOUT = "5000"
process.env.OPENCODE_FAIL_OPEN = "1" // opt out of fail-closed

let brain
let hooks
let permission

const killBrain = () => {
    try {
        process.kill(-brain.pid, "SIGINT") // detached → whole process group
    } catch {
        // ESRCH: already dead.
    }
}

const waitFor = async (pred, what, timeout = 10_000) => {
    const start = Date.now()
    while (!pred()) {
        if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 50))
    }
}

before(async () => {
    brain = spawn("uv", ["run", "python", "scripts/client.py", "--serve", "--socket", sock], {
        cwd: root,
        stdio: ["ignore", "pipe", "inherit"],
        detached: true,
    })
    await waitFor(() => existsSync(sock), "brain socket")

    hooks = await (await import(`${root}plugins/plugin-hooks.js`)).server({})
    permission = await (await import(`${root}plugins/plugin-permission.js`)).server({})
    await new Promise((r) => setTimeout(r, 600)) // bootstrap settle

    killBrain()
    await waitFor(() => !existsSync(sock), "brain socket removal")
    await new Promise((r) => setTimeout(r, 1500)) // breaker opens
})

after(async () => {
    killBrain()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("pre proceeds (FAIL_OPEN) after the brain dies", async () => {
    const pre = { args: { command: "ls" } }
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, pre)
    assert.equal(pre.args.command, "ls")
})

test("permission stays on the default ask flow (FAIL_OPEN)", async () => {
    const out = { status: "ask" }
    await permission["permission.ask"]({ type: "bash", pattern: "ls", sessionID: "s", callID: "c2" }, out)
    assert.equal(out.status, "ask")
})
