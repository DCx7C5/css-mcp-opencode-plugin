/**
 * TUI part (`package.json` `exports["./tui"]`).
 *
 * The TUI is the only opencode plugin context with a tab strip and the only
 * one whose `process.env` carries the `OPENCODE_API_KEY*` values. This entry
 * only wires the definition from `tui-tabs.js` into the runtime — it boots the
 * bridge as `part: "tui"` with no client, registers the control channels, then
 * publishes the strip. `Plugin.define` is an identity function in
 * `@opencode/plugin` 2.2.5, and the split keeps the testable logic free of the
 * runtime-only import.
 */
import { Plugin } from "@opencode/plugin/tui"
import { createTuiDefinition } from "./tui-tabs.js"

export default Plugin.define(createTuiDefinition())
