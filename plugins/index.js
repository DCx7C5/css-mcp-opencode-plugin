/**
 * Aggregator — loads every per-concern plugin from a SINGLE entry.
 *
 * opencode's legacy loader iterates all exports of a module and treats every
 * `server`-shaped export as a separate plugin ("A plugin is a module that
 * exports one or more plugin functions"). So pointing opencode at this file
 * registers all six plugins while sharing one transport instance.
 *
 * This is also the repo's npm/GitHub default (`package.json` `main`). For
 * finer-grained control use the per-file entries listed in
 * .opencode/opencode.json. Behavior is identical either way.
 */

export { server as hookInterface } from "./plugin-hooks.js"
export { server as taskInterface } from "./plugin-task.js"
export { server as permission } from "./plugin-permission.js"
export { server as context } from "./plugin-context.js"
export { server as secrets } from "./plugin-secrets.js"
export { server as events } from "./plugin-events.js"
