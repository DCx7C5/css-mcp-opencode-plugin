/**
 * Plugin inert-path tests — no Python brain ever connects.
 *
 * With no brain, the bridge must be a no-op: every blocking hook proceeds
 * (opencode fully functional), permissions stay on the default ask flow, and
 * the local secrets hardblock is the ONLY thing that still blocks.
 *
 * Env is set BEFORE importing the plugins: transport.js reads
 * OPENCODE_PYTHON_SOCK / OPENCODE_BOOTSTRAP_TIMEOUT at module load, and each
 * test file runs in its own process under `node --test`.
 */
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "css-mcp-inert-"))
process.env.OPENCODE_PYTHON_SOCK = join(dir, "missing.sock") // never created
process.env.OPENCODE_BOOTSTRAP_TIMEOUT = "400" // fast inert settle
process.env.OPENCODE_FAIL_OPEN = "" // default fail-closed, but never-connected → inert

after(async () => {
    const { closeBridge } = await import("../plugins/transport.js")
    closeBridge()
    rmSync(dir, { recursive: true, force: true })
})

import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
/** Load a plugin's server and invoke it once → the hooks object. */
const load = async (rel) => (await import(`${root}${rel}`)).server({})

/** Import order: secrets first so the first gate call (400ms) is shared. */

test("secrets: blocks .env file reads even with no brain (local invariant)", async () => {
    const hooks = await load("plugins/plugin-secrets.js")
    await assert.rejects(
        () => hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: "/proj/.env" } }),
        /hardblock/,
    )
    await assert.rejects(
        () => hooks["tool.execute.before"]({ tool: "edit" }, { args: { filePath: ".env.local" } }),
        /hardblock/,
    )
    await assert.rejects(
        () => hooks["tool.execute.before"]({ tool: "glob" }, { args: { pattern: ".env*" } }),
        /hardblock/,
    )
    await assert.rejects(
        () => hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "cat .env" } }),
        /hardblock/,
    )
})

test("secrets: allows .env.example and non-secret paths", async () => {
    const hooks = await load("plugins/plugin-secrets.js")
    const out = { args: { filePath: ".env.example" } }
    await hooks["tool.execute.before"]({ tool: "read" }, out)
    assert.equal(out.args.filePath, ".env.example")

    const bash = { args: { command: "cat .env.example" } }
    await hooks["tool.execute.before"]({ tool: "bash" }, bash)
    assert.equal(bash.args.command, "cat .env.example")

    const normal = { args: { filePath: "src/main.py" } }
    await hooks["tool.execute.before"]({ tool: "edit" }, normal)
    assert.equal(normal.args.filePath, "src/main.py")
})

test("secrets: blocks .env through paths/vars — no boundary bypass", async () => {
    const hooks = await load("plugins/plugin-secrets.js")

    // Regression: a .env basename after a path separator or inside a var
    // expansion used to slip past the bash token regex.
    for (const cmd of [
        "cat /proj/.env",
        'cat "$HOME/.env"',
        "ls -la /etc/.env",
        "cat /a/.env.local",
        "cat /a/.env_backup",
        "cat /a/.env.production",
    ]) {
        await assert.rejects(
            () => hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: cmd } }),
            /hardblock/,
            `expected bash block for: ${cmd}`,
        )
    }
    // File-path variants with full paths / backup names.
    for (const filePath of ["/proj/.env", "/proj/.env_backup", "/etc/.env.production"]) {
        await assert.rejects(
            () => hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath } }),
            /hardblock/,
            `expected read block for: ${filePath}`,
        )
    }
    // .env.example still allowed anywhere; os.environ/URLs not over-blocked.
    const okExample = { args: { command: "cat /proj/.env.example" } }
    await hooks["tool.execute.before"]({ tool: "bash" }, okExample)
    assert.equal(okExample.args.command, "cat /proj/.env.example")

    const okEnv = { args: { command: 'python -c "import os; print(os.environ)"' } }
    await hooks["tool.execute.before"]({ tool: "bash" }, okEnv)
    assert.equal(okEnv.args.command, 'python -c "import os; print(os.environ)"')

    const okUrl = { args: { command: "curl https://api.example.com/v1/env" } }
    await hooks["tool.execute.before"]({ tool: "bash" }, okUrl)
    assert.equal(okUrl.args.command, "curl https://api.example.com/v1/env")
})

test("secrets: permission.ask denies secret patterns, leaves others ask", async () => {
    const hooks = await load("plugins/plugin-secrets.js")
    const denied = { status: "ask" }
    await hooks["permission.ask"]({ type: "read", pattern: ".env" }, denied)
    assert.equal(denied.status, "deny")

    const deniedBash = { status: "ask" }
    await hooks["permission.ask"]({ type: "bash", pattern: "cat .env.local" }, deniedBash)
    assert.equal(deniedBash.status, "deny")

    const allowed = { status: "ask" }
    await hooks["permission.ask"]({ type: "bash", pattern: "ls" }, allowed)
    assert.equal(allowed.status, "ask")
})

test("hooks: pre/post/shell-env proceed inert (args/env untouched)", async () => {
    const hooks = await load("plugins/plugin-hooks.js")
    const pre = { args: { command: "ls" } }
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, pre)
    assert.equal(pre.args.command, "ls")

    const post = { title: "t", output: "o" }
    await hooks["tool.execute.after"]({ tool: "bash", args: {}, sessionID: "s", callID: "c" }, post)
    assert.equal(post.output, "o")

    const env = { env: {} }
    await hooks["shell.env"]({ cwd: "/tmp", sessionID: "s", callID: "c" }, env)
    assert.deepEqual(env.env, {})
})

test("task: non-task tools pass through, task launch allowed inert", async () => {
    const hooks = await load("plugins/plugin-task.js")
    const other = { args: { command: "ls" } }
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, other)
    assert.equal(other.args.command, "ls")

    const task = { args: { prompt: "p", agent: "general" } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "s", callID: "c" }, task)
    assert.equal(task.args.prompt, "p")
})

test("permission: inert leaves the default ask flow", async () => {
    const hooks = await load("plugins/plugin-permission.js")
    const out = { status: "ask" }
    await hooks["permission.ask"]({ type: "bash", pattern: "ls", sessionID: "s", callID: "c" }, out)
    assert.equal(out.status, "ask")
})

test("context: compacting is a no-op without a brain", async () => {
    const hooks = await load("plugins/plugin-context.js")
    const out = { prompt: "orig", context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: "s" }, out)
    assert.equal(out.prompt, "orig")
    assert.deepEqual(out.context, [])
})

test("events: hookable + non-hookable events never throw without a brain", async () => {
    const hooks = await load("plugins/plugin-events.js")
    await hooks.event({ event: { type: "todo.updated", properties: { id: "t1" } } })
    await hooks.event({ event: { type: "command.executed", properties: { id: "c1" } } })
    await hooks.event({ event: { type: "message.created", properties: {} } }) // untracked
    await hooks.event({ event: { type: "session.idle", properties: { id: "s1" } } })
})
