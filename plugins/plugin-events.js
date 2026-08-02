/**
 * Events-only plugin — subscribes to the opencode event bus and forwards
 * events to the Python brain. It is a pure observer on the JS side: no
 * blocking, no mutation, host never awaits (H3 spike verdict).
 *
 *  - Hookable events (session lifecycle, file edits, todo updates, tool
 *    execute, permission ask/reply) go through the `event.pipeline` RPC when
 *    the `eventPipeline` capability is registered — informational only; the
 *    result is never used to block.
 *  - All other tracked events are debounced fire-and-forget `event` RPCs
 *    (batched within a 50ms window, capped batch size).
 *  - Context-trigger events are handled by plugin-context.js's own event
 *    hook; both hooks run in sequence.
 */

import {
    startBridge,
    directory,
    worktree,
    isTrackedEvent,
    isHookableEvent,
    gateNonBlocking,
    rpc,
    okReply,
    pushEvent,
    timeouts,
    debugEnabled,
} from "../transport.js"

export const server = async ({ client, directory: dir, worktree: wt, project }) => {
    startBridge({ client, directory: dir, worktree: wt, project })
    const debug = debugEnabled()
    const log = (msg) => debug && console.debug("[python-bridge]", "[debug]", msg)

    return {
        event: async ({ event }) => {
            const type = event.type
            if (!isTrackedEvent(type)) return

            const properties = event.properties ?? event.data ?? {}
            log(`event: type=${type} keys=${Object.keys(properties).join(",") || "none"}`)

            // Context-trigger events additionally get a context sync RPC from
            // plugin-context.js's own event hook — not duplicated here.
            if (isHookableEvent(type)) {
                if (!gateNonBlocking("eventPipeline")) {
                    // Brain has no event.pipeline capability → skip pipeline.
                    log(`event: brain has no eventPipeline capability, skipping ${type}`)
                    return
                }
                // Synchronous pipeline: pre-hooks → store → post-hooks.
                // The host never awaits event hooks (H3 spike verdict), so
                // this RPC runs to its own deadline without blocking
                // OpenCode's event loop; results are informational only.
                const result = okReply(await rpc(
                    "event.pipeline",
                    { type, properties, directory: directory() ?? dir, worktree: worktree() ?? wt },
                    timeouts.pipeline,
                ))

                if (result?.blocked) {
                    log(`event: BLOCKED by pre-hook: ${type}`)
                    return
                }

                log(`event: pipeline ok, hooks_ran=${(result?.hooks_ran ?? []).join(",") || "none"}`)
            } else {
                // Non-hookable events: debounced fire-and-forget.
                pushEvent({ type, properties, directory: directory() ?? dir, worktree: worktree() ?? wt })
            }
        },
    }
}
