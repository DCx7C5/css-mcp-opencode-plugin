/**
 * Context interface plugin — full access to the session context surface:
 *
 *  - `experimental.session.compacting` — inject context items or replace the
 *    compaction prompt from the Python brain (capability "context"). The
 *    RPC body carries bounded session intel (`session.stats`, `session.recent`,
 *    `session.diff`, `session.todo` — see `transport.sessionIntel`) so the
 *    brain sees exactly what is about to be summarized before it decides:
 *    reply `{prompt}` to replace the compaction prompt, `{context}` to
 *    inject items that survive the compaction, or nothing for the default.
 *  - Event context syncs — session/file/todo/LSP events that change the
 *    live context are synced to the Python brain, which stores the result so
 *    it persists across compaction cycles (the only path that actually
 *    injects into the LLM).
 *  - Context READING — the Python brain can request the current session
 *    context at any time by pushing `session.context.read`
 *    (`{id, sessionID}`); transport.js fetches `client.session.get` +
 *    `client.session.messages` and replies `{id, ok: true, session, messages}`
 *    over the socket (reverse-RPC, fail-safe). Use it to diff what the model
 *    actually saw before deciding what to inject.
 *  - Session INTEL — bounded on-demand reads (`session.intel` reverse-RPC:
 *    `{id, sessionID, what?: ["stats","recent","diff","todo"]}`) and a
 *    forced summarization (`session.summarize`: `{id, sessionID, model?}`).
 *
 * Ownership: this plugin registers its own `event` hook ONLY for context
 * triggers; fire-and-forget event forwarding lives in plugin-events.js and
 * both hooks run in sequence.
 */

import {
    startBridge,
    directory,
    worktree,
    project,
    gateNonBlocking,
    rpc,
    okReply,
    sessionIntel,
    isContextTriggerEvent,
    timeouts,
    debugEnabled,
} from "./transport.js"

export const server = async ({ client: c, directory: dir, worktree: wt, project: proj }) => {
    startBridge({ client: c, directory: dir, worktree: wt, project: proj })
    const debug = debugEnabled()
    const log = (msg) => debug && console.debug("[python-bridge]", "[debug]", msg)

    return {
        // ── session compaction context ────────────────────────────────
        "experimental.session.compacting": async (input, output) => {
            log(`compacting: sessionID=${input?.sessionID}`)

            if (!gateNonBlocking("context")) {
                // Brain has no context capability → context unchanged.
                log("compacting: brain has no context capability, context unchanged")
                return
            }

            // Compaction handshake: give the brain bounded intel about what
            // is about to be summarized (stats/recent/diff/todo) so it can
            // decide the replacement prompt and what context must survive.
            const intel = await sessionIntel(input?.sessionID, ["stats", "recent", "diff", "todo"])

            const reply = okReply(await rpc(
                "context",
                {
                    reason: "compacting",
                    sessionID: input?.sessionID,
                    directory: directory() ?? dir,
                    worktree: worktree() ?? wt,
                    project: project()?.name || project()?.id || proj?.name || proj?.id,
                    session: intel,
                },
                timeouts.context,
            ))

            if (!reply) {
                log("compacting: no response, context unchanged")
                return
            }

            if (reply.prompt && typeof reply.prompt === "string") {
                log(`compacting: injecting prompt (${reply.prompt.length} chars)`)
                output.prompt = reply.prompt
                return
            }

            const ctx = reply.context
            if (!ctx) {
                log("compacting: empty context in reply")
                return
            }

            if (Array.isArray(ctx)) {
                log(`compacting: injecting ${ctx.length} context items`)
                output.context.push(...ctx)
            } else if (typeof ctx === "string") {
                log(`compacting: injecting context string (${ctx.length} chars)`)
                output.context.push(ctx)
            }
        },

        // ── context-trigger event syncs ────────────────────────────────
        event: async ({ event }) => {
            const type = event.type
            if (!isContextTriggerEvent(type)) return
            if (!gateNonBlocking("context")) return

            const properties = event.properties ?? event.data ?? {}
            log(`event: syncing context for ${type}`)

            rpc(
                "context",
                { reason: type, properties, directory: directory() ?? dir, worktree: worktree() ?? wt },
                timeouts.context,
                { wait: false },
            ).catch((err) => {
                log(`event: context sync failed for ${type}: ${err.message}`)
            })
        },
    }
}
