/**
 * TUI part (`package.json` `exports["./tui"]`).
 *
 * The TUI is the only opencode plugin context with a tab strip; the server
 * part cannot see it. This entry only wires the definition from
 * `tui-tabs.js` into the runtime — `Plugin.define` is an identity function
 * in `@opencode/plugin` 2.2.5, and the split keeps the testable logic free
 * of the runtime-only import.
 */
import { Plugin } from "@opencode/plugin/tui"
import { createTabsDefinition } from "./tui-tabs.js"

export default Plugin.define(createTabsDefinition())
