/* @openomni/ui — the design system for OpenOmni desktop surfaces.
   Tokens live in ./styles.css; the contract is apps/desktop/DESIGN.md. */

export { MainHeader, SearchLine, SidebarHeader } from "./chrome";
/* The input zone. Data-blind: it takes strings and calls back, and knows
   nothing about sessions, models, or what sending a message does. */
export { ApprovalTray, type ComposerAction, Composer, composerKey } from "./composer";
/* The one composition: chrome + navigator slot + transcript + composer. Both
   the desktop renderer and the showcase render THIS, so the surface cannot
   fork again. */
export { Console } from "./console";
/* The single owner of every component's ADDRESS. Components stamp `data-ui`
   from here; COMPONENTS.md documents the same list; the Owner reviews by
   speaking one of these names. */
export type { UiName } from "./names";
export { CONDITIONAL_NAMES, UI_NAMES } from "./names";
export { AnchorGutter } from "./primitives/anchor-gutter";
export { Button, IconButton } from "./primitives/button";
export { CodeFence, CodeToken } from "./primitives/code";
export { Disclosure } from "./primitives/disclosure";
export { Highlight } from "./primitives/highlight";
export { Input } from "./primitives/input";
export { Row } from "./primitives/row";
export { ScrollArea } from "./primitives/scroll-area";
export type { StateTier, StatusShape } from "./primitives/state";
export { State, StatusDot } from "./primitives/state";
export { Caret, Panel, Rule, Text } from "./primitives/surface";
/* The transcript: components and the pure presentation logic under them.

   All of it is UI presentation law rather than product judgment — what a
   collapsed group may hide, how far apart two blocks sit, what a row's address
   is, and how a flat ledger becomes turns. The app decides what work happened;
   these decide how a ledger of it reads. */
export type {
  PendingApproval,
  TranscriptCodeLine,
  TranscriptNode,
  TurnCost,
} from "./timeline/model";
export type { PartKind } from "./timeline/spacing";
export {
  BLOCK_GAP,
  gapAbove,
  PAIR_GAP,
  PARAGRAPH_GAP,
  spacingClass,
  TURN_GAP,
} from "./timeline/spacing";
export { type Expansion, Timeline, expansionFor } from "./timeline/timeline";
export { segmentTurns } from "./timeline/turns";
/* The three type voices, and the only place a font-size lives in the
   transcript. A test greps the transcript's markup for size classes and must
   find them here and nowhere else. */
export { Voice } from "./timeline/voice";
export { COLLAPSE_AFTER, collapses, isLoud, summarize, summaryLabel } from "./timeline/work-group";
