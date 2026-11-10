/**
 * TUI control consumers — quota-credential cycling, session control and
 * whole-strip tab forking.
 *
 * These channels run in the TUI plugin process: it is the only context whose
 * `process.env` carries the `OPENCODE_API_KEY*` values, so credential
 * install/remove must be answered here, and the only one that owns a tab
 * strip, so `tabs.fork` and `tabs.close` are answered here too. The server
 * process never sees those values, which is also why a key never crosses the
 * wire:
 * `credential.install` reads it from the local environment and only ever
 * sends it straight to the adapter's `credential.create`; `credential.remove`
 * discovers its target from the adapter listing and never accepts an id or a
 * label from the request.
 *
 * The module deliberately imports no runtime-only package — `onPush` comes
 * from the shared transport — so `node --test` can drive every branch with a
 * fake client and a fake environment.
 *
 * Secrets: a credential value enters this module only from
 * `process.env[label]` (install) or an adapter listing (remove). It is never
 * copied into a reply, a log line or an error message; credential replies are
 * rebuilt from `id`/`label`/`integrationID`, so an adapter's `value` can never
 * ride along. Adapter error messages are scrubbed of every secret this module
 * knows at the point of the failure.
 */
import { onPush } from "./transport.js"

/** The only labels whose values may be installed from the TUI environment. */
const KEY_LABELS = new Set([
    "OPENCODE_API_KEY",
    "OPENCODE_API_KEY_1",
    "OPENCODE_API_KEY_2",
    "OPENCODE_API_KEY_3",
    "OPENCODE_API_KEY_4",
    "OPENCODE_API_KEY_5",
    "OPENCODE_API_KEY_6",
])

const OPENCODE_INTEGRATION = "opencode"

/** @param {unknown} value */
const isObject = (value) => typeof value === "object" && value !== null

/** @param {object} payload */
const success = (payload) => ({ ok: true, payload })

/**
 * @param {string} code
 * @param {Record<string, unknown>} [detail] merged into `error`
 * @param {Record<string, unknown>} [extra] merged into the reply payload
 */
const failure = (code, detail = {}, extra = {}) => ({
    ok: false,
    payload: { error: { code, ...detail }, ...extra },
})

/** @param {unknown} error */
function messageOf(error) {
    if (typeof error === "string" && error) return error
    if (isObject(error) && typeof error.message === "string" && error.message) return error.message
    return "adapter call failed"
}

/**
 * Replace every known secret in an adapter message. A client is free to echo
 * whatever it was given; this module must not forward that echo.
 * @param {unknown} error
 * @param {string[]} secrets
 */
function sanitize(error, secrets) {
    let text = messageOf(error)
    for (const secret of secrets) {
        if (typeof secret === "string" && secret.length > 0) text = text.split(secret).join("[redacted]")
    }
    return text
}

/**
 * Await one adapter call and turn the v2 adapter's resolved `{error}` shape
 * into a rejection, so a caller has a single failure path.
 * @param {() => Promise<unknown>} operation
 */
async function call(operation) {
    const result = await operation()
    if (isObject(result) && result.error) throw new Error(messageOf(result.error))
    return result
}

/** @param {unknown} result */
function listedEntries(result) {
    if (Array.isArray(result)) return result
    if (isObject(result) && Array.isArray(result.data)) return result.data
    return []
}

/**
 * Every credential value the listing exposed, for message scrubbing only.
 * @param {unknown[]} entries
 * @returns {string[]}
 */
function credentialSecrets(entries) {
    const secrets = []
    for (const entry of entries) {
        const value = isObject(entry) ? entry.value : null
        if (typeof value === "string") secrets.push(value)
        else if (isObject(value) && typeof value.key === "string") secrets.push(value.key)
    }
    return secrets
}

/** @param {unknown} created */
function createdId(created) {
    if (!isObject(created)) return null
    const direct = typeof created.id === "string" && created.id ? created.id : null
    if (direct) return direct
    const wrapped = isObject(created.data) ? created.data.id : null
    return typeof wrapped === "string" && wrapped ? wrapped : null
}

/** @param {unknown} result */
function forkedSessionId(result) {
    for (const candidate of [result, isObject(result) ? result.data : null]) {
        if (!isObject(candidate)) continue
        if (typeof candidate.id === "string" && candidate.id) return candidate.id
        if (typeof candidate.sessionID === "string" && candidate.sessionID) return candidate.sessionID
    }
    return null
}

const isActiveOpencode = (entry) =>
    isObject(entry) && entry.active === true && entry.integrationID === OPENCODE_INTEGRATION

/**
 * Remove the single active opencode credential.
 *
 * The request body is deliberately ignored: the Python caller pushes `{}` and
 * names no id and no label, because only the adapter listing knows which
 * credential is active and only this process knows which labels it can
 * re-provision from the local environment. Listing therefore decides the
 * target, so a retry after a lost reply can never delete something the brain
 * never saw.
 *
 * The guards are ordered before any mutation: a foreign active identity, an
 * ambiguous opencode set or a label this side cannot manage must leave every
 * credential exactly as it was. Zero active entries is the normal state of a
 * retried command whose first reply was lost, so the reply carries the (empty)
 * `activeOpenCodeIds` snapshot for the brain to reconcile.
 *
 * @param {object} client
 * @param {(message: string) => void} debug
 */
async function removeCredential(client, debug) {
    let entries
    try {
        entries = listedEntries(await call(() => client.credential.list()))
    } catch (error) {
        return failure("call_failed", { message: messageOf(error) })
    }
    const secrets = credentialSecrets(entries)
    const active = entries.filter((entry) => isObject(entry) && entry.active === true)
    const opencodeActive = active.filter(isActiveOpencode)

    if (active.length === 0) {
        debug("credential.remove: no active credential")
        return failure("no_active", {}, { activeOpenCodeIds: [] })
    }
    if (opencodeActive.length === 0) {
        debug("credential.remove: active credential belongs to another integration")
        return failure("foreign_integration")
    }
    if (opencodeActive.length > 1) {
        debug(`credential.remove: ambiguous active opencode credentials count=${opencodeActive.length}`)
        return failure("ambiguous_active")
    }

    const target = opencodeActive[0]
    const label = typeof target.label === "string" ? target.label : ""
    if (!KEY_LABELS.has(label)) {
        debug("credential.remove: the active label is outside the managed set")
        return failure("foreign_label")
    }
    const key = typeof process.env[label] === "string" ? process.env[label] : ""
    if (!key) {
        debug("credential.remove: the active label has no value in the TUI environment")
        return failure("no_env")
    }

    try {
        await call(() => client.credential.remove({ credentialID: target.id }))
    } catch (error) {
        return failure("call_failed", { message: sanitize(error, secrets) })
    }

    debug(`credential.remove: removed credentialID=${String(target.id)}`)
    return success({
        credential: { id: target.id, label, integrationID: target.integrationID },
    })
}

/**
 * Install (or reuse) the credential for one label.
 *
 * Idempotent: a retry after a lost reply lists first and activates the entry
 * that already carries the same label/integration instead of creating a
 * duplicate. The key comes from the local environment only — a key in the
 * request body is ignored on purpose.
 *
 * @param {object} client
 * @param {object} body
 * @param {(message: string) => void} debug
 */
async function installCredential(client, body, debug) {
    const label = typeof body?.label === "string" ? body.label : ""
    const integrationID =
        typeof body?.integrationID === "string" && body.integrationID ? body.integrationID : OPENCODE_INTEGRATION
    const key = label && typeof process.env[label] === "string" ? process.env[label] : ""
    if (!key) {
        debug("credential.install: label has no value in the TUI environment")
        return failure("no_env")
    }
    const secrets = [key]

    let entries
    try {
        entries = listedEntries(await call(() => client.credential.list()))
    } catch (error) {
        return failure("call_failed", { message: sanitize(error, secrets) })
    }

    const existing = entries.find(
        (entry) =>
            isObject(entry) &&
            entry.label === label &&
            entry.integrationID === integrationID &&
            typeof entry.id === "string" &&
            entry.id.length > 0,
    )
    if (existing) {
        try {
            await call(() => client.credential.activate({ credentialID: existing.id }))
        } catch {
            return failure("activate_failed", { credentialID: existing.id })
        }
        debug(`credential.install: reused credentialID=${existing.id}`)
        return success({ credential: { id: existing.id, label }, reused: true })
    }

    let created
    try {
        created = await call(() => client.credential.create({ integrationID, label, value: { type: "key", key } }))
    } catch (error) {
        return failure("call_failed", { message: sanitize(error, secrets) })
    }
    const credentialID = createdId(created)
    if (!credentialID) {
        return failure("call_failed", { message: "credential.create returned no credential id" })
    }

    try {
        await call(() => client.credential.activate({ credentialID }))
    } catch {
        return failure("activate_failed", { credentialID })
    }

    debug(`credential.install: created credentialID=${credentialID}`)
    return success({ credential: { id: credentialID, label } })
}

/** @param {object} client @param {object} body */
async function forkSession(client, body) {
    const sessionID = typeof body?.sessionID === "string" ? body.sessionID : ""
    if (!sessionID) return failure("call_failed", { message: "session.fork: sessionID is required" })

    const params = { sessionID }
    if (body?.before !== undefined) params.before = body.before
    const result = await call(() => client.session.fork(params))
    const forkedID = forkedSessionId(result)
    if (!forkedID) return failure("call_failed", { message: "session.fork returned no session id" })
    return success({ sessionID: forkedID })
}

/** @param {object} client @param {object} body */
async function promptSession(client, body) {
    const sessionID = typeof body?.sessionID === "string" ? body.sessionID : ""
    if (!sessionID) return failure("call_failed", { message: "session.prompt: sessionID is required" })
    await call(() => client.session.prompt({ sessionID, text: body?.text }))
    return success({})
}

/** How long a strip gets to apply a queued close before it is re-read. */
const TAB_CLOSE_SETTLE_MS = 150

/** @param {number} ms */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The reason the strip still lists a closed id, or `null` when it is gone.
 *
 * The re-read after `close()` is what makes a move provable: a strip that
 * queues the removal — or silently refuses it — still lists the old id, and
 * that tab never moved. A strip that cannot be read at all counts as unclosed
 * for the same reason: an unproven close must never pass a tab off as moved,
 * because the brain would then prompt the fork and abandon the live old tab.
 *
 * @param {object} tabs
 * @param {string} sessionID
 * @returns {string | null}
 */
function closeLeftover(tabs, sessionID) {
    let list
    try {
        list = tabs.list()
    } catch {
        return "the tab strip is unreadable after close"
    }
    if (!Array.isArray(list)) return "the tab strip returned no list after close"
    const listed = list.some((tab) => tabSessionID(tab) === sessionID)
    return listed ? `tab ${sessionID} is still listed after close` : null
}

/**
 * Close one old tab and prove it left the strip.
 *
 * `tabs.close(sessionID)` is the documented plugin path and stays the primary
 * mechanism — there is no close route on the TUI HTTP API. Its resolution is
 * not proof (a strip may queue the removal, or answer `false` and keep the
 * tab), so the strip is re-read and the close retried once after a short
 * settle. Only then is the last resort used: focus the old tab — a refused
 * focus skips the command, because it would close whichever tab currently has
 * focus — and run the TUI's own `session.tab.close` command (the default
 * `<leader>w` action), then re-read once more. The v2 SDK exposes that as
 * `client.tui.executeCommand`; on a client without it the fallback is skipped
 * rather than invented.
 *
 * Returns the remaining reason the tab is still listed, or `null` when it is
 * provably gone, plus the mechanism that closed it for the caller's debug line.
 *
 * @param {object} client
 * @param {object} tabs
 * @param {string} sessionID
 * @param {(message: string) => void} debug
 * @returns {Promise<{ leftover: string | null, mechanism: "tabs.close" | "execute-command" | null }>}
 */
async function closeTab(client, tabs, sessionID, debug) {
    /** @type {"tabs.close" | "execute-command" | null} */
    let mechanism = null

    /** @param {"tabs.close"} label */
    const attempt = async (label) => {
        try {
            if ((await tabs.close(sessionID)) === false) return `tabs.close refused ${sessionID}`
        } catch (error) {
            return messageOf(error)
        }
        const leftover = closeLeftover(tabs, sessionID)
        if (leftover === null) mechanism = label
        return leftover
    }

    let leftover = await attempt("tabs.close")
    if (leftover === null) return { leftover: null, mechanism }
    debug(`tabs.fork: ${sessionID} not closed by tabs.close (${leftover}), retrying once`)
    await settle(TAB_CLOSE_SETTLE_MS)
    leftover = await attempt("tabs.close")
    if (leftover === null) return { leftover: null, mechanism }

    const executeCommand = client?.tui?.executeCommand
    if (typeof executeCommand !== "function") {
        debug(`tabs.fork: ${sessionID} still open; this client has no execute-command`)
        return { leftover, mechanism: null }
    }
    debug(`tabs.fork: ${sessionID} still open; focusing it for the TUI close command`)
    try {
        if ((await tabs.focus(sessionID)) === false) {
            // `session.tab.close` closes whichever tab is focused: sending it
            // without the old tab focused would close a different one.
            return {
                leftover: `${leftover}; tabs.focus refused ${sessionID}, so the close command was not sent`,
                mechanism: null,
            }
        }
        await call(() => executeCommand.call(client.tui, { command: "session.tab.close" }))
    } catch (error) {
        return { leftover: `${leftover}; execute-command failed: ${messageOf(error)}`, mechanism: null }
    }
    leftover = closeLeftover(tabs, sessionID)
    if (leftover === null) mechanism = "execute-command"
    return { leftover, mechanism }
}

/**
 * Close one tab by session id and prove it left the strip.
 *
 * The brain's fork undo needs the strip to lose a duplicate the session tree
 * alone cannot remove (row 2572): a re-parented copy carries the fork marker,
 * so `isSubagentSession` still reads it as a tab and the next rotation would
 * fork it again. This channel is the wire path that removes it, and it reuses
 * `closeTab` — the same verified close `tabs.fork` runs per tab — so the strip
 * has one close mechanism, never a second.
 *
 * Idempotent on purpose: an id the strip no longer lists is the goal state,
 * not a refusal, so a retry after a lost reply answers `ok` instead of
 * reporting `tabs.close refused`. A strip that is off or unreadable answers
 * `tabs_disabled`, exactly like `tabs.fork`.
 *
 * @param {object} client
 * @param {object | null | undefined} tabs
 * @param {object} body
 * @param {(message: string) => void} debug
 */
async function closeSessionTab(client, tabs, body, debug) {
    const sessionID = typeof body?.sessionID === "string" ? body.sessionID : ""
    if (!sessionID) return failure("call_failed", { message: "tabs.close: sessionID is required" })

    let listed
    try {
        if (typeof tabs?.enabled !== "function" || !tabs.enabled()) {
            debug("tabs.close: the tab strip is disabled")
            return failure("tabs_disabled", {}, { sessionID })
        }
        const list = tabs.list()
        if (!Array.isArray(list)) {
            debug("tabs.close: the tab strip returned no list")
            return failure("tabs_disabled", {}, { sessionID })
        }
        listed = list.some((tab) => tabSessionID(tab) === sessionID)
    } catch {
        debug("tabs.close: the tab strip is not readable")
        return failure("tabs_disabled", {}, { sessionID })
    }
    if (!listed) {
        debug(`tabs.close: ${sessionID} is not on the strip`)
        return success({ sessionID, mechanism: null })
    }

    const closed = await closeTab(client, tabs, sessionID, debug)
    if (closed.leftover) {
        debug(`tabs.close: ${sessionID} still open: ${closed.leftover}`)
        return failure("close_unverified", { message: closed.leftover }, { sessionID })
    }
    debug(`tabs.close: ${sessionID} closed (via ${closed.mechanism})`)
    return success({ sessionID, mechanism: closed.mechanism })
}

/**
 * Fork every open tab's session and move its tab onto the fork.
 *
 * The body is ignored — the strip is this side's state, so the brain only
 * sends `{}`. A draft tab has no session and is not a target. A subagent child
 * session is skipped and its tab stays exactly where it is (never forked, never
 * closed); a session that carries a `fork` marker is NOT a child for this
 * purpose, because an earlier fork already moved a tab onto it.
 *
 * A move is three measured steps — `open`, `focus`, `close` — and a tab only
 * lands in `moves` when all three succeeded AND a re-read of the strip no
 * longer lists the old id. A step that throws or answers `false` is that
 * step's failure. `close()` resolving is not proof: a strip may queue
 * the removal or answer `false` and keep the tab, so while the old id is still
 * there the close is retried once after a short settle, and only then does the
 * last resort run — focus the old tab and execute the TUI's own
 * `session.tab.close` command (there is no close route on the TUI HTTP API).
 * The per-tab debug line names which mechanism closed the tab
 * (`tabs.close` / `execute-command`). A tab that could not be moved is
 * reported in `failed` with the step it stopped at (`{fromSessionID,
 * toSessionID, step, error}`) and in `unclosed` — its old tab is still open,
 * so the brain must continue that one instead of the fork. A fork that never
 * produced a new tab has no step and is `{fromSessionID, error}` only.
 *
 * One tab's failure never aborts the strip: the loop continues with the
 * remaining tabs.
 *
 * @param {object} client
 * @param {object | null | undefined} tabs
 * @param {object | null | undefined} data
 * @param {(message: string) => void} debug
 */
async function forkTabs(client, tabs, data, debug) {
    let list
    try {
        if (typeof tabs?.enabled !== "function" || !tabs.enabled()) {
            debug("tabs.fork: the tab strip is disabled")
            return failure("tabs_disabled")
        }
        list = tabs.list()
    } catch {
        debug("tabs.fork: the tab strip is not readable")
        return failure("tabs_disabled")
    }
    if (!Array.isArray(list)) {
        debug("tabs.fork: the tab strip returned no list")
        return failure("tabs_disabled")
    }

    const moves = []
    const failed = []
    const unclosed = []
    const skipped = []
    for (const tab of list) {
        const fromSessionID = tabSessionID(tab)
        if (!fromSessionID) continue
        if (isSubagentSession(data, fromSessionID)) {
            skipped.push(fromSessionID)
            continue
        }

        let toSessionID
        try {
            toSessionID = forkedSessionId(await call(() => client.session.fork({ sessionID: fromSessionID })))
        } catch (error) {
            debug(`tabs.fork: fork failed for ${fromSessionID}: ${messageOf(error)}`)
            failed.push({ fromSessionID, error: messageOf(error) })
            continue
        }
        if (!toSessionID) {
            debug(`tabs.fork: fork returned no session id for ${fromSessionID}`)
            failed.push({ fromSessionID, error: "session.fork returned no session id" })
            continue
        }

        // Open and focus are measured steps: the one that threw or answered
        // `false` is where the tab stopped, and the old tab is still open
        // either way. A `false` from `open` means no new tab exists; a `false`
        // from `focus` means the fork tab is open but was not focused.
        let opened = false
        let focused = false
        let stoppedAt = null
        let reason = null
        try {
            if ((await tabs.open(toSessionID)) === false) {
                stoppedAt = "open"
                reason = `tabs.open refused ${toSessionID}`
            } else {
                opened = true
                debug(`tabs.fork: ${fromSessionID} → ${toSessionID} open=ok`)
                if ((await tabs.focus(toSessionID)) === false) {
                    stoppedAt = "focus"
                    reason = `tabs.focus refused ${toSessionID}`
                } else {
                    focused = true
                    debug(`tabs.fork: ${fromSessionID} → ${toSessionID} open=ok focus=ok`)
                }
            }
        } catch (error) {
            stoppedAt = opened ? "focus" : "open"
            reason = messageOf(error)
        }
        if (stoppedAt) {
            debug(
                `tabs.fork: ${fromSessionID} → ${toSessionID} stopped at ${stoppedAt} (open=${opened} focus=${focused}): ${reason}`,
            )
            failed.push({ fromSessionID, toSessionID, step: stoppedAt, error: reason })
            unclosed.push({ fromSessionID, toSessionID, step: stoppedAt, error: reason })
            continue
        }

        // Close is verified, never trusted: the strip may queue the removal or
        // refuse silently. `closeTab` re-reads, retries once, and falls back to
        // the TUI's own close command before calling the tab unclosed.
        const closed = await closeTab(client, tabs, fromSessionID, debug)
        if (closed.leftover) {
            debug(`tabs.fork: ${fromSessionID} → ${toSessionID} still open: ${closed.leftover}`)
            failed.push({ fromSessionID, toSessionID, step: "close", error: closed.leftover })
            unclosed.push({ fromSessionID, toSessionID, step: "close", error: closed.leftover })
            continue
        }
        debug(`tabs.fork: ${fromSessionID} → ${toSessionID} open=ok focus=ok close=ok (via ${closed.mechanism})`)
        moves.push({ fromSessionID, toSessionID })
    }

    debug(
        `tabs.fork: moves=${moves.length} failed=${failed.length} ` +
            `unclosed=${unclosed.length} skipped=${skipped.length}`,
    )
    return success({ moves, failed, skipped, unclosed })
}

/**
 * The tab's session id. The measured 2.2.5 TUI keeps it at `tab.sessionID`,
 * the GUI window context at `tab.session?.id`; a draft tab has neither.
 * @param {object | null | undefined} tab
 */
function tabSessionID(tab) {
    if (typeof tab?.sessionID === "string" && tab.sessionID) return tab.sessionID
    const nested = isObject(tab?.session) ? tab.session.id : undefined
    return typeof nested === "string" ? nested : ""
}

/**
 * True when the tab's session is a subagent child the strip must not fork.
 * A classifier that is absent or throws is not evidence of a child: the tab
 * stays a target rather than silently dropping out of the fork.
 * @param {object | null | undefined} data
 * @param {string} sessionID
 */
function isSubagentSession(data, sessionID) {
    try {
        const session = data?.session?.get?.(sessionID)
        if (!isObject(session)) return false
        return Boolean(session.parentID) && session.fork === undefined
    } catch {
        return false
    }
}

/**
 * One reply for every outcome, and no escape hatch: a handler failure or a
 * dead reply socket never throws into the transport dispatch.
 * @param {(body: object) => Promise<{ ok: boolean, payload: object }>} implementation
 */
const handlerFor = (implementation) => async (body, reply) => {
    let outcome
    try {
        outcome = await implementation(body ?? {})
    } catch (error) {
        outcome = failure("call_failed", { message: messageOf(error) })
    }
    try {
        reply?.(body?.id, outcome.ok, outcome.payload)
    } catch {
        // A dead connection is the normal no-brain state; never escape.
    }
}

/**
 * Build the channel handlers without touching the shared registry (tests).
 *
 * `tabs` and `data` are the TUI context's own tab strip (`ui.tabs`) and state
 * bus: `tabs.fork` mutates the strip and classifies each tab's session through
 * `data.session.get`; `tabs.close` removes one id from it. Without them the
 * channels answer `tabs_disabled` instead of throwing — a missing strip is a
 * state the brain is told about, never a crash in the TUI.
 *
 * @param {{ client?: object, tabs?: object, data?: object, log?: { debug?: (message: string) => void } }} [input]
 * @returns {Record<string, (body: object, reply: (id: string, ok: boolean, payload?: object) => void) => Promise<void>>}
 */
export function createTuiControlHandlers({ client, tabs, data, log } = {}) {
    const debug = (message) => {
        try {
            log?.debug?.(`[tui-control] ${message}`)
        } catch {
            // Logging may never break a handler.
        }
    }
    return {
        "credential.remove": handlerFor(() => removeCredential(client, debug)),
        "credential.install": handlerFor((body) => installCredential(client, body, debug)),
        "session.fork": handlerFor((body) => forkSession(client, body)),
        "session.prompt": handlerFor((body) => promptSession(client, body)),
        "tabs.close": handlerFor((body) => closeSessionTab(client, tabs, body, debug)),
        "tabs.fork": handlerFor(() => forkTabs(client, tabs, data, debug)),
    }
}

/**
 * Register the TUI control consumers on their onPush channels.
 * @param {{ client?: object, tabs?: object, data?: object, log?: { debug?: (message: string) => void } }} [input]
 * @returns {ReturnType<typeof createTuiControlHandlers>}
 */
export function registerTuiControl(input = {}) {
    const handlers = createTuiControlHandlers(input)
    for (const [channel, handler] of Object.entries(handlers)) onPush(channel, handler)
    return handlers
}
