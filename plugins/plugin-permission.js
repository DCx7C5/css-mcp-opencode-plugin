/**
 * Permission / human-in-the-chain plugin — the blocking authority over
 * `permission.ask`. The yes/no popups (TUI, IDE integrations like PyCharm,
 * web) ARE the `permission.ask` hook: opencode shows the prompt when the
 * hook leaves `output.status` as `"ask"`, and the human's answer is the
 * final gate. This plugin:
 *
 *  1. Forwards every permission prompt to the Python brain (capability
 *     "permission"), which decides allow / ask / deny from its rules.
 *  2. Maps the brain's reply onto `output.status` (v0.4 `{status}` with
 *     backwards-compat `{allow: bool}` from the minimal test brain).
 *  3. Fail-closes to deny when the brain was connected and is lost; stays
 *     on the default ask flow when no brain ever connected.
 *
 * Human-in-the-chain: when Python says "ask", opencode renders the native
 * prompt to the human (the popup). Python can also drive richer flows by
 * pushing a `user`-kind part via `session.inject` (see transport.js) — that
 * injects a question into the active session and the human's answer resumes
 * the chain. The `client.postSessionIdPermissionsPermissionId` SDK method is
 * available here for answering prompts programmatically when Python decides
 * to auto-approve/deny after the fact.
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
} from "./transport.js"

export const server = async ({ client: c, directory: dir, worktree: wt, project: proj }) => {
    startBridge({ client: c, directory: dir, worktree: wt, project: proj })
    const debug = debugEnabled()
    const log = (msg) => debug && console.debug("[python-bridge]", "[debug]", msg)

    return {
        "permission.ask": async (input, output) => {
            log(`permission.ask: type=${input.type} title="${input.title?.slice(0, 60)}"`)

            pushEvent({
                type: "permission.asked",
                properties: {
                    type: input.type,
                    pattern: input.pattern,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    title: input.title,
                },
                directory: directory() ?? dir,
                worktree: worktree() ?? wt,
            })

            const gate = await gateBlocking("permission")
            if (gate.kind === "skip") {
                // Brain is up but has no permission capability → proceed with
                // the default ask flow (deterministic fast path).
                log("permission.ask: brain has no permission capability, default ask")
                return
            }
            if (gate.kind === "inert") {
                // No brain ever connected → plugin is a no-op; default ask.
                warnInert()
                log("permission.ask: inert, default ask")
                return
            }
            if (gate.kind === "failed") {
                if (!FAIL_OPEN) {
                    console.error("[python-bridge] [error] permission.ask: DENYING — python server unreachable (fail-closed)")
                    output.status = "deny"
                    return
                }
                log("permission.ask: FAIL-OPEN — python server unreachable, default ask")
                return
            }

            const decision = okReply(await rpc(
                "permission",
                {
                    id: input.id,
                    type: input.type,
                    pattern: input.pattern,
                    sessionID: input.sessionID,
                    messageID: input.messageID,
                    callID: input.callID,
                    title: input.title,
                    metadata: input.metadata,
                    directory: directory() ?? dir,
                },
                timeouts.permission,
            ))

            if (!decision) {
                if (!FAIL_OPEN) {
                    console.error("[python-bridge] [error] permission.ask: DENYING — python server unreachable (fail-closed)")
                    output.status = "deny"
                    return
                }
                log("permission.ask: FAIL-OPEN — no reply, default ask")
                return
            }

            // Brain reply: {status: "allow"|"ask"|"deny"} (v0.4), with
            // backwards-compat {allow: bool} from the minimal test brain.
            const status = decision.status
                ?? (decision.allow === false ? "deny" : decision.allow === true ? "allow" : "ask")
            if (status === "allow" || status === "ask" || status === "deny") {
                log(`permission.ask: brain says ${status} (${input.type})`)
                output.status = status
            } else {
                log(`permission.ask: unknown status=${status}, default ask`)
            }
        },
    }
}
