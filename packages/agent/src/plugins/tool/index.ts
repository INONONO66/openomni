/**
 * The `plugins/tool` capability band (#1316): dispatcher construction moved
 * out of the core. `createDispatcher` builds a dispatcher over the composed
 * `ToolCatalog`; `createTurnDispatcher` composes the per-turn durable
 * executor with that dispatcher. Both reach the core only through
 * `core/api.ts`; the `Bundle` namespace barrel surfaces them to the app.
 */
export { createDispatcher, createTurnDispatcher } from "./dispatch";
