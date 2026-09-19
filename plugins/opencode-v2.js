/**
 * opencode v2 adapter layer.
 *
 * opencode 2.x loads plugins via a DEFAULT export: an object `{ id, setup }`
 * where `setup(ctx)` registers hooks through the plugin context (domain
 * hook APIs like `ctx.tool.hook("execute.before", ...)`), NOT by returning
 * a v1 hook map. This module bridges the two worlds:
 *
 *  - `definePlugin(id, setup)` — builds the v2 default-export definition.
 *  - `bridgeHooksV2(ctx, servers)` — runs each v1 `server({client, ...})`
 *    against the v2 context (adapting the context into the v1-shaped SDK
 *    client the transport expects: `client.session.promptAsync`,
 *    `client.app.agents()`, `client.postSessionIdPermissionsPermissionId`
 *    and friends all get v2 domain equivalents), then registers every
 *    returned v1 hook map key onto the matching v2 domain hook with an
 *    event adapter that translates the v2 event into the v1 `(input,
 *    output)` pair and writes mutations back.
 *
 * The per-concern plugins keep their named `server` export (v1 loader +
 * `npm test` rely on it) and gain a `default` export built here. The
 * aggregator (`plugins/index.js`) exposes a single default that registers
 * all six concerns in order.
 */

/** Build an opencode v2 plugin definition: `{ id, setup }`. */
export const definePlugin = (id, setup) => ({ id, setup })

/** Best-effort sync wrapper: never let a missing/mocking ctx surface throw. */
const safe = async (fn, fallback) => {
    try {
        return (await fn()) ?? fallback
    } catch {
        return fallback
    }
}

/**
 * Adapt the v2 plugin context into the v1-shaped SDK client the transport
 * and the plugin gates call (session.promptAsync, session.get/messages,
 * session.create/prompt/abort/summarize, app.agents, tool.ids,
 * postSessionIdPermissionsPermissionId). Every surface maps to a v2 domain
 * method where one exists; surfaces with no v2 equivalent resolve
 * fail-safe (log-level degradation, never a crash).
 * @param {object} ctx — v2 plugin context.
 */
const adaptClient = (ctx) => {
    const session = ctx?.session ?? {}
    const textOf = (parts) =>
        (Array.isArray(parts) ? parts.findLast((p) => p?.type === "text")?.text : "") ?? ""

    return {
        app: {
            agents: () => safe(async () => ({ data: await ctx.agent.list() }), { data: [] }),
        },
        tool: {
            ids: () =>
                safe(async () => ({ data: (await ctx.tool.list()).map((t) => t?.id) }), {
                    data: [],
                }),
        },
        session: {
            get: ({ path }) =>
                safe(async () => ({ data: await session.get({ sessionID: path.id }) }), {
                    data: null,
                }),
            messages: ({ path }) =>
                safe(async () => ({ data: await session.context({ sessionID: path.id }) }), {
                    data: [],
                }),
            create: ({ body = {}, query }) =>
                safe(
                    async () => {
                        const data = await session.create({
                            title: body.title,
                            ...(body.parentID ? { parentID: body.parentID } : {}),
                        })
                        return { data }
                    },
                    { error: { message: "session.create unavailable (v2 ctx)" } },
                ),
            prompt: ({ path, body = {} }) =>
                safe(
                    async () => {
                        const res = await session.prompt({
                            sessionID: path.id,
                            text: textOf(body.parts),
                            ...(body.agent ? { agent: body.agent } : {}),
                            ...(body.model ? { model: body.model } : {}),
                            ...(body.system ? { system: body.system } : {}),
                            ...(body.tools ? { tools: body.tools } : {}),
                        })
                        // v2 prompt returns '{ user, session, parts }'.
                        return {
                            info: res?.user?.message,
                            parts: res?.parts ?? [],
                            error: res?.error,
                        }
                    },
                    { error: { message: "session.prompt unavailable (v2 ctx)" } },
                ),
            // The injector used v1 promptAsync (fire-and-forget synthetic
            // part). v2 has a first-class `session.synthetic` for exactly this.
            promptAsync: ({ path, body = {} }) =>
                safe(
                    async () => {
                        await session.synthetic({ sessionID: path.id, text: textOf(body.parts) })
                        return {}
                    },
                    { error: { message: "session.synthetic unavailable (v2 ctx)" } },
                ),
            // v2 has no forced-summarize surface; degrade gracefully so the
            // reverse-RPC answers 'not supported' rather than hanging.
            summarize: () =>
                Promise.resolve({
                    error: { message: "session.summarize is not available in opencode v2" },
                }),
            abort: ({ path }) =>
                safe(async () => session.interrupt({ sessionID: path.id, continue: false }), {}),
        },
        // v1 'reject' maps 1:1 to v2 Permission.Reply ('once'|'always'|'reject').
        postSessionIdPermissionsPermissionId: ({ path, body = {} }) =>
            safe(
                async () =>
                    ctx.permission.reply({
                        sessionID: path.id,
                        requestID: path.permissionId,
                        reply: body.response,
                    }),
                { ok: false },
            ),
    }
}

/**
 * A v1 hook event gets translated into the v1 `(input, output)` pair the
 * existing hook bodies expect; after the callback the adapter writes any
 * mutations back onto the (mutable) v2 event.
 */
const HOOK_ADAPTERS = {
    "tool.execute.before": (e) => ({
        input: { tool: e.tool, callID: e.id, sessionID: e.sessionID },
        output: { args: e.input },
        sync() {
            // v1 put the (possibly replaced) args on output.args.
            e.input = this.output.args
        },
    }),
    "tool.execute.after": (e) => ({
        input: { tool: e.tool, callID: e.id, sessionID: e.sessionID, args: e.input },
        output: {},
        sync() {
            if (e.status !== "completed") return
            // v2 Tool.Result has {output?, content?, metadata?}; post-hook
            // also set a title which has no v2 slot, so it is dropped.
            const prev = e.result ?? {}
            const next = { ...prev }
            if (this.output.output !== undefined) next.output = this.output.output
            if (this.output.metadata && typeof this.output.metadata === "object")
                next.metadata = { ...(prev.metadata ?? {}), ...this.output.metadata }
            e.result = next
        },
    }),
    "permission.ask": (e) => ({
        input: {
            id: e.source?.id,
            type: e.action,
            pattern: e.resources?.[0],
            sessionID: e.sessionID,
            messageID: e.source?.messageID,
            callID: e.source?.callID,
            title: e.message,
            metadata: e.metadata,
        },
        output: { status: e.effect },
        sync() {
            e.effect = this.output.status
        },
    }),
    "shell.env": (e) => ({
        input: { cwd: e.cwd, sessionID: undefined, callID: undefined },
        output: { env: e.env },
        sync() {
            e.env = this.output.env
        },
    }),
    "experimental.session.compacting": (e) => ({
        input: { sessionID: e.sessionID },
        output: { prompt: undefined, context: [] },
        sync() {
            // v1 let the brain replace the compaction prompt or inject
            // context that survives. v2's lever is result.summary: setting
            // it records the compaction and skips the model summarization.
            if (typeof this.output.prompt === "string") {
                e.result = { summary: this.output.prompt }
            } else if (Array.isArray(this.output.context) && this.output.context.length > 0) {
                e.result = { summary: this.output.context.join("\n\n") }
            }
        },
    }),
}

/** v1 hook key → [v2 domain, v2 hook name, adapter factory]. */
const REGISTRY = {
    "tool.execute.before": ["tool", "execute.before", HOOK_ADAPTERS["tool.execute.before"]],
    "tool.execute.after": ["tool", "execute.after", HOOK_ADAPTERS["tool.execute.after"]],
    "permission.ask": ["permission", "evaluate", HOOK_ADAPTERS["permission.ask"]],
    "shell.env": ["shell", "create.before", HOOK_ADAPTERS["shell.env"]],
    "experimental.session.compacting": [
        "session",
        "compaction",
        HOOK_ADAPTERS["experimental.session.compacting"],
    ],
}

/**
 * Register one v1 hook callback onto its v2 domain hook. Returns a
 * Registration-like `{ dispose }` or null when the domain surface is
 * missing (fail-open: the concern simply does not run in that build).
 */
async function registerV1Hook(ctx, v1Name, v1cb) {
    const [domain, hookName, makeAdapter] = REGISTRY[v1Name] ?? []
    const domainApi = ctx?.[domain]
    if (!domain || !domainApi?.hook || typeof domainApi.hook !== "function") return null
    try {
        const registration = await domainApi.hook(hookName, (event) => {
            const adapter = makeAdapter(event)
            return v1cb(adapter.input, adapter.output).finally(() => adapter.sync())
        })
        return registration ?? null
    } catch {
        return null
    }
}

/**
 * Run v1 `server()` functions against the v2 plugin context and register
 * every returned hook map onto the v2 domain hooks. `event` hooks (the v1
 * `{event}` signature) are wired into a single `ctx.event.subscribe()`
 * loop. Returns the v2 cleanup function.
 *
 * @param {object} ctx — v2 plugin context.
 * @param {Array<Function>} servers — v1 `server({client, directory, worktree, project})` fns.
 */
export async function bridgeHooksV2(ctx, servers) {
    const location = ctx?.location ?? {}
    const client = adaptClient(ctx)
    const dir = location.directory
    const proj = location.project
    const eventCbs = []
    const disposers = []

    for (const serverFn of servers) {
        const hooks = await serverFn({ client, directory: dir, worktree: null, project: proj })
        for (const [name, cb] of Object.entries(hooks ?? {})) {
            if (name === "event") {
                eventCbs.push(cb)
                continue
            }
            const registration = await registerV1Hook(ctx, name, cb)
            if (registration?.dispose) disposers.push(registration.dispose)
        }
    }

    if (eventCbs.length > 0 && typeof ctx?.event?.subscribe === "function") {
        const ac = new AbortController()
        disposers.push(() => ac.abort())
        ;(async () => {
            try {
                for await (const event of ctx.event.subscribe({ signal: ac.signal })) {
                    for (const cb of eventCbs) {
                        try {
                            await cb({ event })
                        } catch (err) {
                            console.error("[python-bridge] [error] event hook failed:", err.message)
                        }
                    }
                }
            } catch {
                // Subscription ended (plugin unload / ctx teardown) — ignore.
            }
        })()
    }

    return async () => {
        for (const dispose of disposers) {
            try {
                await dispose()
            } catch {
                // best-effort cleanup
            }
        }
    }
}

