/**
 * Lost-brain FAIL-CLOSED suite — a brain connects, then is killed.
 *
 * This is the hardest guarantee in the protocol: once a brain has taken over
 * authority and vanishes, blocking ops must fail closed (`pre` throws,
 * `permission` denies) instead of silently becoming permissive. The circuit
 * breaker (3 consecutive failed reconnect cycles) makes that fast instead of
 * waiting for every individual 5s RPC deadline.
 *
 * Env: OPENCODE_FAIL_OPEN is intentionally UNSET here — the fail-open opt-out
 * is exercised in plugins.failopen.test.mjs (separate process, env set at
 * module load).
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = mkdtempSync(join(tmpdir(), "css-mcp-failclosed-"))
const sock = join(dir, "hooks.sock")
process.env.OPENCODE_PYTHON_SOCK = sock
process.env.OPENCODE_BOOTSTRAP_TIMEOUT = "5000"
process.env.OPENCODE_FAIL_OPEN = "" // default: fail-closed after a lost brain

let brain
let hooks
let permission

const killBrain = () => {
    try {
        // detached → kill the whole process group (uv run does not forward
        // SIGINT to the python child by default, so -pid reaches both).
        process.kill(-brain.pid, "SIGINT")
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

    // Prove the brain is authoritative first (RPC path works).
    const pre = { args: { command: "ls" } }
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c0" }, pre)
    assert.equal(pre.args.command, "ls")

    // Kill the brain and wait for the socket to disappear, then let the pool
    // go through its failed reconnect cycles until the breaker opens
    // (100 + 200 + 400ms ≈ 700ms).
    killBrain()
    await waitFor(() => !existsSync(sock), "brain socket removal")
    await new Promise((r) => setTimeout(r, 1500))
})

after(async () => {
    killBrain()
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

test("pre fails closed fast after the brain dies (circuit breaker)", async () => {
    const start = Date.now()
    await assert.rejects(
        () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "ls" } }),
        /fail-closed/,
    )
    const elapsed = Date.now() - start
    assert.ok(elapsed < 4_000, `expected breaker fast-fail, took ${elapsed}ms`)
})

test("permission denies after the brain dies", async () => {
    const out = { status: "ask" }
    await permission["permission.ask"]({ type: "bash", pattern: "ls", sessionID: "s", callID: "c2" }, out)
    assert.equal(out.status, "deny")
})
