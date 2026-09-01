/**
 * Secrets hardblock plugin — a LOCAL, always-on safety invariant that
 * protects `.env*` files (and friends) from being read, edited, or otherwise
 * exposed to the model or tool output. This is the official opencode .env
 * protection pattern (docs "Examples → .env protection") generalized across
 * every file-touching tool.
 *
 * Design decisions:
 *  - LOCAL: this plugin never consults Python, never waits on bootstrap, and
 *    is NOT capability-gated. Safety invariants must hold even while the
 *    bridge is inert or the brain is lost — a secret leak is a fail-closed
 *    concern on the JS side by construction.
 *  - FIRST: it registers `tool.execute.before` independently, so opencode
 *    runs it in sequence before the general tool gate. List it first in
 *    opencode.json for deterministic ordering.
 *  - ALLOW `.env.example` / `.env.example.*`: example files are meant to be
 *    shared; the hardblock deliberately does not flag them.
 *  - Bash detection is token-based: a command containing a `.env` token
 *    (cat/less/curl/source …) is blocked rather than risk a leak.
 *  - TOOL-AGNOSTIC: unknown / MCP / custom tools are scanned fail-closed —
 *    every string leaf in args (depth ≤ 3) is tested as both a path and a
 *    shell token. Only explicitly allowlisted tools (e.g. `task`) are exempt.
 */

import { startBridge } from "./transport.js"

/** Basename like `.env`, `.env.local`, `.env_backup`, `.env.production` or glob
 * forms (`.env*`, `.env?`). `.env.example*` is excluded (see EXAMPLE_FILE_RE).
 * NOTE: the leading boundary includes `/` — `cat /proj/.env` must be blocked. */
const SECRET_FILE_RE = /(^|[/\\])\.env(?!\.example)[A-Za-z0-9_.*?\-]*$/
/** Example files are safe to read — never flag them (also glob forms). */
const EXAMPLE_FILE_RE = /\.env\.example(?:\.[A-Za-z0-9_*?\-]+)?[*]?$/i
/** A `.env` basename token inside a shell command (word- or path-bounded).
 * Both boundaries include `/`: `.env` after a path separator is exactly the
 * secret file (`cat /proj/.env`, `cat "$HOME/.env"`, `ls /etc/.env`). */
const BASH_SECRET_TOKEN_RE = /(^|[/\s"'=&|;()])\.env(?!\.example)(?:[A-Za-z0-9_.\-]*)?($|[/\s"'=&|;()])/

/** Which tools take a file path (in args.filePath / args.path / args.pattern). */
const FILE_PATH_TOOLS = new Set(["read", "edit", "write", "glob", "grep", "list"])
/** Bash may touch the filesystem through a shell command. */
const BASH_TOOLS = new Set(["bash"])
/** Tools explicitly exempt from the generic scan (handled elsewhere). */
const ALLOWED_UNKNOWN_TOOLS = new Set(["task"])

/** Normalize a path-ish value: expand leading ~, strip quotes. */
const normalizePath = (value) => {
    if (typeof value !== "string") return ""
    let next = value.trim().replace(/^~\/|^~\$/, "")
    if (next.startsWith("'") && next.endsWith("'")) next = next.slice(1, -1)
    if (next.startsWith('"') && next.endsWith('"')) next = next.slice(1, -1)
    return next
}

/** True when a path string names a protected secret file. */
const isSecretPath = (value) => {
    const next = normalizePath(value)
    if (!next || EXAMPLE_FILE_RE.test(next)) return false
    return SECRET_FILE_RE.test(next)
}

/** True when a shell command contains a protected secret token. */
const hasSecretToken = (command) => {
    if (typeof command !== "string") return false
    const cleaned = command.replace(EXAMPLE_FILE_RE, "")
    return BASH_SECRET_TOKEN_RE.test(cleaned)
}

/** Collect every candidate path-ish value from tool args. */
const candidateValues = (args) => {
    if (!args || typeof args !== "object") return []
    const out = []
    for (const key of ["filePath", "path", "pattern", "include", "exclude", "files"]) {
        const value = args[key]
        if (typeof value === "string") out.push(value)
        else if (Array.isArray(value)) out.push(...value.filter((v) => typeof v === "string"))
    }
    return out
}

/** Collect every string leaf from a value tree (depth-limited). */
const collectStrings = (node, depth = 0, out = [], maxDepth = 3) => {
    if (depth > maxDepth) return out
    if (typeof node === "string") { out.push(node); return out }
    if (node && typeof node === "object") {
        for (const v of Object.values(node)) collectStrings(v, depth + 1, out, maxDepth)
    }
    return out
}

export const server = async ({ client, directory, worktree, project }) => {
    startBridge({ client, directory, worktree, project })

    return {
        "tool.execute.before": async (input, output) => {
            const tool = input.tool
            if (FILE_PATH_TOOLS.has(tool)) {
                for (const candidate of candidateValues(output.args)) {
                    if (isSecretPath(candidate)) {
                        console.error(
                            `[python-bridge] [error] secrets: BLOCKED ${tool} on ${candidate} (hardblock)`,
                        )
                        throw new Error(
                            `Refusing to ${tool} ${candidate}: secret files (.env*) are hardblocked.`,
                        )
                    }
                }
                return
            }
            if (BASH_TOOLS.has(tool)) {
                if (hasSecretToken(output.args?.command)) {
                    console.error(
                        `[python-bridge] [error] secrets: BLOCKED bash referencing .env (hardblock)`,
                    )
                    throw new Error(
                        "Refusing bash command that references a .env secret file (hardblock).",
                    )
                }
                return
            }
            // Tool-agnostic fallback: unknown/MCP/custom tools are scanned
            // fail-closed. Every string leaf is treated as both a path and a
            // shell token; allowlisted tools (e.g. task) are exempt.
            if (!ALLOWED_UNKNOWN_TOOLS.has(tool)) {
                for (const s of collectStrings(output.args)) {
                    if (isSecretPath(s) || hasSecretToken(s)) {
                        console.error(
                            `[python-bridge] [error] secrets: BLOCKED ${tool} (hardblock)`,
                        )
                        throw new Error(
                            `Refusing to ${tool}: secret files (.env*) are hardblocked.`,
                        )
                    }
                }
            }
        },

        // Deny permission prompts that name protected files, even when the
        // permission system (not a tool arg) is the access path.
        "permission.ask": async (input, output) => {
            const pattern = input.pattern ?? ""
            if (isSecretPath(pattern) || (input.type === "bash" && hasSecretToken(pattern))) {
                console.error(
                    `[python-bridge] [error] secrets: DENIED permission for ${pattern} (hardblock)`,
                )
                output.status = "deny"
            }
        },
    }
}
