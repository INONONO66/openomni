/* @openomni/ui — the UI package apps/desktop consumes. Tokens live in
   ./styles.css. The barrel exports exactly what the renderer imports: the one
   `Console` composition, the sidebar column's rows the app composes into its
   slot, the width contract the app's store clamps against, and the transcript
   types the chat adapter targets. */

export { Console, type ConsoleShell, type ConsoleStrip } from "./console";
export { Highlight } from "./primitives/highlight";
export { ScrollArea } from "./primitives/scroll-area";
export { Text } from "./primitives/surface";
export { clampSidebarWidth, Sidebar, SIDEBAR_WIDTH } from "./sidebar";
export {
  NavItem,
  SectionHeader,
  SectionSearchInput,
  SidebarFooter,
  SidebarHeader,
  SidebarNav,
  SidebarSection,
} from "./sidebar-nav";
export type { WindowPlatform } from "./tab-strip";
export type { PendingApproval, TranscriptNode, TurnCost } from "./timeline/model";
export { Timeline } from "./timeline/timeline";
export { segmentTurns } from "./timeline/turns";
export { TreeRow } from "./tree-row";
