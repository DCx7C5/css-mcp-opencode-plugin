/**
 * Hook interface plugin — the general tool gate, post enrichment, and shell
 * env injection. This is the "wire" that connects opencode's generic hook
 * surface to the Python brain over the shared transport.
 *
 * Ownership: `tool.execute.before` here handles EVERY tool EXCEPT `task`
 * (the task interface plugin owns task tools — see plugin-task.js). That way
 * exactly one authority gates each tool type and the Python brain receives a
 * single `pre` RPC per invocation.
 */

import {
    startBridge,
    directory,
    worktree,
    gateBlocking,
    gateNonBlocking,
    rpc,
    okReply,
    pushEvent,
    timeouts,
    warnInert,
    FAIL_OPEN,
    debugEnabled,
} from "../transport.js"

export const server = async ({ client, directory: dir, worktree: wt, project: proj }) => {
    startBridge({ client, directory: dir, worktree: wt, project: proj })
    const debug = debugEnabled()
    const log = (msg) => debug && console.debug("[python-bridge]", "[debug]", msg)

    return {
        // ── pre-hook (blocking gate; task tools owned by plugin-task.js) ──
        "tool.execute.before": async (input, output) => {
            if (input.tool === "task") {
                // Task-tool authority lives in plugin-task.js.
                return
            }

            log(`pre-hook: tool=${input.tool} callID=${input.callID}`)

            pushEvent({
                type: "tool.execute.before",
                properties: { tool: input.tool, callID: input.callID },
                directory: directory() ?? dir,
                worktree: worktree() ?? wt,
            })

            const gate = await gateBlocking("pre")
            if (gate.kind === "skip") {
                // Brain is up but has no pre capability → proceed immediately.
                log(`pre-hook: brain has no pre capability, allowing tool=${input.tool}`)
                return
            }
            if (gate.kind === "inert") {
                // No brain ever connected → plugin is a no-op; proceed normally.
                warnInert()
                log(`pre-hook: inert, allowing tool=${input.tool}`)
                return
            }
            if (gate.kind === "failed") {
                if (!FAIL_OPEN) {
                    console.error(
                        `[python-bridge] [error] pre-hook: BLOCKING tool=${input.tool} — python server unreachable (fail-closed)`,
                    )
                    throw new Error(
                        `Python pre-hook unreachable — tool "${input.tool}" blocked (fail-closed mode). `
                        + `Set OPENCODE_FAIL_OPEN=1 to allow through.`,
                    )
                }
                log(`pre-hook: FAIL-OPEN tool=${input.tool} — python server unreachable, allowing through`)
                return
            }

            const decision = okReply(await rpc(
                "pre",
                {
                    tool: input.tool,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    args: output.args,
                    directory: directory() ?? dir,
                },
                timeouts.pre,
            ))

            if (!decision) {
                if (!FAIL_OPEN) {
                    console.error(
                        `[python-bridge] [error] pre-hook: BLOCKING tool=${input.tool} — python server unreachable (fail-closed)`,
                    )
                    throw new Error(
                        `Python pre-hook unreachable — tool "${input.tool}" blocked (fail-closed mode). `
                        + `Set OPENCODE_FAIL_OPEN=1 to allow through.`,
                    )
                }
                log(`pre-hook: FAIL-OPEN tool=${input.tool} — python server unreachable, allowing through`)
                return
            }

            if (decision.args && typeof decision.args === "object") {
                const keys = Object.keys(decision.args)
                log(`pre-hook: modifying args for tool=${input.tool}, keys=${keys.join(",")}`)
                Object.assign(output.args, decision.args)
            }
            if (decision.allow === false) {
                log(`pre-hook: DENIED tool=${input.tool} reason="${decision.reason ?? "no reason"}"`)
                throw new Error(decision.reason || "Blocked by Python pre-hook")
            }
            log(`pre-hook: ALLOWED tool=${input.tool}`)
        },

        // ── post-hook (non-blocking enrichment) ─────────────────────────
        "tool.execute.after": async (input, output) => {
            log(`post-hook: tool=${input.tool} callID=${input.callID}`)

            pushEvent({
                type: "tool.execute.after",
                properties: { tool: input.tool, callID: input.callID },
                directory: directory() ?? dir,
                worktree: worktree() ?? wt,
            })

            if (!gateNonBlocking("post")) {
                // Brain has no post capability → leave output unchanged.
                log(`post-hook: brain has no post capability, leaving output unchanged`)
                return
            }

            const decision = okReply(await rpc(
                "post",
                {
                    tool: input.tool,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    args: input.args,
                    title: output.title,
                    output: output.output,
                    metadata: output.metadata,
                    directory: directory() ?? dir,
                },
                timeouts.post,
            ))

            if (!decision) {
                log(`post-hook: no response for tool=${input.tool}, leaving output unchanged`)
                return
            }

            if (decision.title !== undefined) {
                log(`post-hook: replacing title for tool=${input.tool}`)
                output.title = decision.title
            }
            if (decision.output !== undefined) {
                log(`post-hook: replacing output for tool=${input.tool} (${String(decision.output).length} chars)`)
                output.output = decision.output
            }
            if (decision.metadata && typeof decision.metadata === "object") {
                const keys = Object.keys(decision.metadata)
                log(`post-hook: merging metadata for tool=${input.tool}, keys=${keys.join(",")}`)
                output.metadata = { ...(output.metadata || {}), ...decision.metadata }
            }
        },

        // ── shell env injection ─────────────────────────────────────────
        "shell.env": async (input, output) => {
            log(`shell-env: cwd=${input.cwd}`)

            pushEvent({
                type: "shell.env",
                properties: { cwd: input.cwd },
                directory: directory() ?? dir,
                worktree: worktree() ?? wt,
            })

            if (!gateNonBlocking("shellEnv")) {
                // Brain has no shell-env capability → env unchanged.
                log("shell-env: brain has no shellEnv capability, env unchanged")
                return
            }

            const reply = okReply(await rpc(
                "shell-env",
                {
                    cwd: input.cwd,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    directory: directory() ?? dir,
                },
                timeouts.short,
            ))

            if (!reply) {
                log("shell-env: no response, env unchanged")
                return
            }

            if (reply.env && typeof reply.env === "object") {
                const keys = Object.keys(reply.env)
                log(`shell-env: injecting ${keys.length} env vars: ${keys.join(",")}`)
                Object.assign(output.env, reply.env)
            }
        },
    }
}
