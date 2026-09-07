/* @openomni/ui — the UI package apps/desktop consumes. Tokens live in
   ./styles.css. The barrel exports exactly what the renderer imports: the one
   `Console` composition, the chrome and primitives the session navigator is
   built from, and the transcript types the chat adapter targets. */

export { SearchLine, SidebarHeader } from "./chrome";
export { Console } from "./console";
export { Disclosure } from "./primitives/disclosure";
export { Highlight } from "./primitives/highlight";
export { Row } from "./primitives/row";
export { ScrollArea } from "./primitives/scroll-area";
export type { StateTier, StatusShape } from "./primitives/state";
export { StatusDot } from "./primitives/state";
export { Panel, Text } from "./primitives/surface";
export type { PendingApproval, TranscriptNode, TurnCost } from "./timeline/model";
export { Timeline } from "./timeline/timeline";
export { segmentTurns } from "./timeline/turns";
