/* @openomni/ui — the UI package apps/desktop consumes. Tokens live in
   ./styles.css. The barrel exports exactly what the renderer imports — the one
   `Console` composition, the sidebar column's rows the app composes into its
   slot, the width contract the app's store clamps against, and the transcript
   types the chat adapter targets — and apps/desktop/test/ui-barrel.test.ts
   fails on any name here that the app does not import. */

export { Console, type ConsoleShell, type ConsoleStrip } from "./console";
export { Highlight } from "./primitives/highlight";
export { Text } from "./primitives/surface";
export { clampSidebarWidth, SIDEBAR_WIDTH } from "./sidebar";
export {
  NavItem,
  SectionHeader,
  SectionList,
  SectionSearchInput,
  SidebarFooter,
  SidebarNav,
  SidebarSection,
} from "./sidebar-nav";
export type { WindowPlatform } from "./tab-strip";
export type { PendingApproval, TranscriptNode, TurnCost } from "./timeline/model";
export { Timeline } from "./timeline/timeline";
export { segmentTurns } from "./timeline/turns";
export { TreeRow } from "./tree-row";
