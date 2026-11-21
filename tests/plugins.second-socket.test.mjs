/**
 * Second-socket isolation — two plugin processes, two sockets, one handshake each.
 *
 * `plugins/transport.js` resolves `OPENCODE_PYTHON_SOCK` at module load, the
 * ESM singleton's creation point, so every opencode process picks its own
 * socket: the host client keeps `hooks.sock`, the fixnet tether process uses
 * `hooks-tether.sock`. This suite proves that selection with REAL Unix
 * sockets and real child processes — no mocks:
 *
 *  - the parent listens on two `net.createServer` sockets in a temp dir,
 *  - it spawns two child Node processes, each with its own
 *    `OPENCODE_PYTHON_SOCK`, each importing `plugins/transport.js` and
 *    issuing exactly one `bootstrap` handshake on the socket its module load
 *    resolved,
 *  - each server must see exactly one frame — the bootstrap, as the first
 *    NDJSON line — carrying its own child's pid, and must never see the other
 *    child's connection.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const transportUrl = pathToFileURL(join(root, "plugins", "transport.js")).href

/** Child source: import the shared transport, handshake once, report readiness. */
const CHILD_SOURCE = `
import { rpc } from ${JSON.stringify(transportUrl)}

const sock = process.env.OPENCODE_PYTHON_SOCK
const reply = await rpc("bootstrap", { protocol: "v0.4", part: "server", pid: process.pid }, 5000)
if (!reply || reply.ok !== true) {
    console.error("bootstrap failed:", JSON.stringify(reply))
    process.exit(1)
}
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, sock }) + "\\n")
`

/**
 * A minimal real brain on one socket: records every connection and NDJSON
 * frame, answers the bootstrap handshake so the child's rpc completes.
 */
const makeBrain = (path) => {
    const state = { path, connections: 0, frames: [], pids: [], sockets: [] }
    const server = createServer((socket) => {
        state.connections += 1
        state.sockets.push(socket)
        let buf = ""
        socket.on("data", (chunk) => {
            buf += chunk.toString()
            let idx
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx)
                buf = buf.slice(idx + 1)
                if (!line.trim()) continue
                // Strip the per-plugin wire prefix (<letter>:) from JS→Py lines.
                const msg = JSON.parse(line.replace(/^[ecpths]:/, ""))
                state.frames.push(msg)
                if (msg.op === "bootstrap") {
                    state.pids.push(msg.body?.pid ?? null)
                    socket.write(
                        JSON.stringify({ id: msg.id, ok: true, capabilities: {} }) + "\n",
                    )
                }
            }
        })
    })
    return { state, server }
}

const listen = (server, path) =>
    new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(path, () => resolve())
    })

const spawnChild = (script, sock) =>
    spawn(process.execPath, [script], {
        env: { ...process.env, OPENCODE_PYTHON_SOCK: sock, OPENCODE_BOOTSTRAP_TIMEOUT: "5000" },
        stdio: ["ignore", "pipe", "pipe"],
    })

/** Wait for the child's `{ready:true, pid, sock}` line; fail on early exit. */
const waitForReady = (child, timeout = 10_000) =>
    new Promise((resolve, reject) => {
        let buf = ""
        let stderr = ""
        const timer = setTimeout(
            () => reject(new Error(`child ${child.pid} never reported ready (stderr: ${stderr})`)),
            timeout,
        )
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString()
        })
        child.stdout.on("data", (chunk) => {
            buf += chunk.toString()
            let idx
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx)
                buf = buf.slice(idx + 1)
                if (!line.trim()) continue
                const msg = JSON.parse(line)
                if (msg.ready === true) {
                    clearTimeout(timer)
                    resolve(msg)
                    return
                }
            }
        })
        child.once("exit", (code, signal) => {
            clearTimeout(timer)
            reject(new Error(`child ${child.pid} exited early code=${code} signal=${signal} stderr=${stderr}`))
        })
    })

const stopChild = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once("exit", resolve))
    child.kill("SIGKILL")
    await exited
}

const closeBrain = async (brain) => {
    for (const socket of brain.state.sockets) socket.destroy()
    await new Promise((resolve) => brain.server.close(resolve))
}

test("each process handshakes on its own socket, identified by peer pid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "css-mcp-second-sock-"))
    const hostSock = join(dir, "hooks.sock")
    const tetherSock = join(dir, "hooks-tether.sock")
    const host = makeBrain(hostSock)
    const tether = makeBrain(tetherSock)
    const children = []
    try {
        await Promise.all([listen(host.server, hostSock), listen(tether.server, tetherSock)])

        const childScript = join(dir, "child.mjs")
        writeFileSync(childScript, CHILD_SOURCE)
        const hostChild = spawnChild(childScript, hostSock)
        const tetherChild = spawnChild(childScript, tetherSock)
        children.push(hostChild, tetherChild)

        const [hostReady, tetherReady] = await Promise.all([
            waitForReady(hostChild),
            waitForReady(tetherChild),
        ])

        // The module-load resolution picked the env socket in each child.
        assert.equal(hostReady.sock, hostSock)
        assert.equal(tetherReady.sock, tetherSock)
        assert.equal(hostReady.pid, hostChild.pid)
        assert.equal(tetherReady.pid, tetherChild.pid)
        assert.notEqual(hostChild.pid, tetherChild.pid)

        // Completed handshake on the correct socket — never absence alone.
        assert.equal(host.state.frames.length, 1, "host socket: exactly one frame")
        assert.equal(host.state.frames[0].op, "bootstrap")
        assert.equal(host.state.connections, 1)
        assert.deepEqual(host.state.pids, [hostChild.pid])

        assert.equal(tether.state.frames.length, 1, "tether socket: exactly one frame")
        assert.equal(tether.state.frames[0].op, "bootstrap")
        assert.equal(tether.state.connections, 1)
        assert.deepEqual(tether.state.pids, [tetherChild.pid])

        // Neither server saw the other child's connection.
        assert.ok(!host.state.pids.includes(tetherChild.pid), "host socket saw the tether child")
        assert.ok(!tether.state.pids.includes(hostChild.pid), "tether socket saw the host child")
    } finally {
        await Promise.all(children.map(stopChild))
        await Promise.all([closeBrain(host), closeBrain(tether)])
        rmSync(dir, { recursive: true, force: true })
    }
})
