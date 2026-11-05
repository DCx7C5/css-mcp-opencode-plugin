/**
 * Aggregator — every per-concern plugin from a SINGLE entry.
 *
 * opencode 2.x loads one plugin per module via the DEFAULT export: an
 * object `{ id, setup(ctx) }`. This file's default registers all seven
 * concerns (secrets hardblock first, then hooks, task, permission, context,
 * events, signals) through the shared transport singleton (see
 * opencode-v2.js).
 *
 * The named `server` re-exports are retained for the v1 loader and for
 * direct imports (tests); the v2 loader uses `default` only.
 *
 * This is also the repo's npm/GitHub default (`package.json` `main`). For
 * finer-grained control use the per-file entries listed in
 * .opencode/opencode.json — each file carries its own v2 default.
 */

import { definePlugin, bridgeHooksV2 } from "./opencode-v2.js"
import { server as secrets } from "./plugin-secrets.js"
import { server as hookInterface } from "./plugin-hooks.js"
import { server as taskInterface } from "./plugin-task.js"
import { server as permission } from "./plugin-permission.js"
import { server as context } from "./plugin-context.js"
import { server as events } from "./plugin-events.js"
import { server as signals } from "./plugin-signals.js"

export { server as secrets } from "./plugin-secrets.js"
export { server as hookInterface } from "./plugin-hooks.js"
export { server as taskInterface } from "./plugin-task.js"
export { server as permission } from "./plugin-permission.js"
export { server as context } from "./plugin-context.js"
export { server as events } from "./plugin-events.js"
export { server as signals } from "./plugin-signals.js"

export default definePlugin("css-mcp-opencode-plugin", (ctx) =>
    bridgeHooksV2(ctx, [secrets, hookInterface, taskInterface, permission, context, events, signals]),
)
