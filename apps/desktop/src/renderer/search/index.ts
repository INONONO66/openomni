/**
 * The sidebar's search engine.
 *
 * Pure TypeScript, like `renderer/attention` next to it: a scorer, a filter
 * that preserves the tree, and the keyboard contract as a reducer. No React, no
 * DOM, no clock — so the whole behavior is replayable in a test, and the view
 * is left with nothing but translating events and painting runs.
 *
 * It lives in `apps/desktop` and not in `packages/ui` because every type here
 * names a session or a project. The design system may own a search LINE; it may
 * not know what is being searched.
 */
export type { Filtered, FilteredSession, SearchFields } from "./filter";
export { filterOrdered, highlightRuns } from "./filter";
export type { Effect, Intent, SearchState } from "./keyboard";
export { INITIAL, intentFor, reduce } from "./keyboard";
export { scoreFields, scoreText } from "./score";
