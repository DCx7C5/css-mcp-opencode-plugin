/**
 * Task interface plugin — authority over `tool === "task"` (subagent
 * launches). opencode has no plugin API that launches subagents, so the
 * pre-hook gate on the `task` tool is the only place Python's TaskManager
 * rules can interpose. This plugin surfaces the subagent request fields
 * explicitly (prompt/description/agent/model) so the Python gate decides
 * without re-parsing opaque args.
 *
 * Ownership: this hook returns immediately for every non-task tool; the
 * general tool gate in plugin-hooks.js handles those. Exactly one `pre`
 * RPC per tool invocation.
 */

import {
    startBridge,
    directory,
    worktree,
    gateBlocking,
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
        "tool.execute.before": async (input, output) => {
            if (input.tool !== "task") {
                // Not a subagent launch — the general hook interface owns it.
                return
            }

            log(`task-gate: subagent launch callID=${input.callID} agent=${output.args?.agent ?? output.args?.subagent_type ?? "default"}`)

            pushEvent({
                type: "tool.execute.before",
                properties: {
                    tool: "task",
                    callID: input.callID,
                    agent: output.args?.agent ?? output.args?.subagent_type,
                },
                directory: directory() ?? dir,
                worktree: worktree() ?? wt,
            })

            const gate = await gateBlocking("pre")
            if (gate.kind === "skip") {
                log(`task-gate: brain has no pre capability, allowing task agent=${input.tool}`)
                return
            }
            if (gate.kind === "inert") {
                warnInert()
                log("task-gate: inert, allowing task")
                return
            }
            if (gate.kind === "failed") {
                if (!FAIL_OPEN) {
                    console.error(
                        "[python-bridge] [error] task-gate: BLOCKING subagent launch — python server unreachable (fail-closed)",
                    )
                    throw new Error(
                        "Python TaskManager unreachable — subagent launch blocked (fail-closed mode). "
                        + "Set OPENCODE_FAIL_OPEN=1 to allow through.",
                    )
                }
                log("task-gate: FAIL-OPEN — python server unreachable, allowing task")
                return
            }

            const decision = okReply(await rpc(
                "pre",
                {
                    tool: "task",
                    sessionID: input.sessionID,
                    callID: input.callID,
                    args: output.args,
                    directory: directory() ?? dir,
                    // Task-tool authority: the explicit subagent fields the
                    // Python TaskManager gate needs.
                    task: {
                        prompt: output.args?.prompt,
                        description: output.args?.description,
                        agent: output.args?.agent ?? output.args?.subagent_type,
                        model: output.args?.model,
                    },
                },
                timeouts.pre,
            ))

            if (!decision) {
                if (!FAIL_OPEN) {
                    console.error(
                        "[python-bridge] [error] task-gate: BLOCKING subagent launch — python server unreachable (fail-closed)",
                    )
                    throw new Error(
                        "Python TaskManager unreachable — subagent launch blocked (fail-closed mode). "
                        + "Set OPENCODE_FAIL_OPEN=1 to allow through.",
                    )
                }
                log("task-gate: FAIL-OPEN — python server unreachable, allowing task")
                return
            }

            if (decision.args && typeof decision.args === "object") {
                const keys = Object.keys(decision.args)
                log(`task-gate: modifying args for task, keys=${keys.join(",")}`)
                Object.assign(output.args, decision.args)
            }
            if (decision.allow === false) {
                log(`task-gate: DENIED agent="${output.args?.agent ?? output.args?.subagent_type ?? "default"}" reason="${decision.reason ?? "no reason"}"`)
                throw new Error(decision.reason || "Blocked by Python TaskManager")
            }
            log("task-gate: ALLOWED subagent launch")
        },
    }
}
