/**
 * Every rendered piece of this surface has a stable, visible ADDRESS.
 *
 * Every exported component stamps `data-ui` on its root element, and the value
 * comes from HERE and from nowhere else, so a rename propagates in one edit and
 * a review can name an element (`ToolGroup.Summary`) instead of describing it.
 *
 * Dotted names are PARTS, not variants: `Turn.Prompt` is the prompt region
 * inside a `Turn`, whose own name is in the DOM above it.
 *
 * Ordered by where the eye lands: the frame, then the navigator's parts, then
 * the transcript top-down, then the input zone, then the primitives that appear
 * inside all of them.
 */
export const UI_NAMES = {
  /** The whole window: chrome + navigator slot + transcript + composer. */
  Console: "Console",
  /** A tonal surface — the window, a column, a recessed region. */
  Panel: "Panel",
  /** The sidebar's titlebar row: the drag surface beside the traffic lights. */
  SidebarHeader: "SidebarHeader",
  /** The main column's titlebar row: title plus one qualifying fact. */
  MainHeader: "MainHeader",
  /** The sidebar's one control: a line, not a box. */
  SearchLine: "SearchLine",
  /** The one selectable surface in the system. */
  Row: "Row",
  /** A group header that expands a region. */
  Disclosure: "Disclosure",

  /** The transcript column. */
  Timeline: "Timeline",
  /** One exchange: the Owner's message and everything that answered it. */
  Turn: "Turn",
  /** The Owner's own message — the right-aligned block. */
  TurnPrompt: "Turn.Prompt",
  /** One block of the agent's answer: a paragraph, a heading, a fence. */
  TurnResponse: "Turn.Response",
  /** The line that closes a response: wall time and elapsed. */
  TurnMeta: "Turn.Meta",
  /** A boundary in the ledger — a compaction, a resume. */
  EpochRule: "EpochRule",
  /** Rendered markdown: prose, bullets, a heading, or a fence. */
  MarkdownBlock: "MarkdownBlock",
  /** A code block: one quiet tonal step, bounded by a hairline. */
  CodeFence: "CodeFence",
  /** One numbered line inside a fence, with its change marker. */
  CodeFenceGutter: "CodeFence.Gutter",
  /** A run of adjacent tool calls. */
  ToolGroup: "ToolGroup",
  /** The fold's summary line: `6 tools · 3 read · 2 edit`. */
  ToolGroupSummary: "ToolGroup.Summary",
  /** One tool call, one line: the verb, the thing, the cost. */
  ToolRow: "ToolRow",
  /** The status clause at the end of a tool row: the mark and the word. */
  ToolRowStatus: "ToolRow.Status",

  /** The input zone's field and its meta lines. */
  Composer: "Composer",
  /** The auto-growing textarea itself. */
  ComposerInput: "Composer.Input",
  /** The send affordance. */
  ComposerSend: "Composer.Send",
  /** What the send affordance becomes while a turn is being interrupted. */
  ComposerStop: "Composer.Stop",
  /** The line under the field: what is answering, what the turn has cost. */
  ComposerMeta: "Composer.Meta",
  /** The pending-decision tray, docked above the composer. */
  ApprovalTray: "ApprovalTray",
  /** The screen's one accent-filled control. */
  ApprovalTrayApprove: "ApprovalTray.Approve",
  /** The quiet half of the pair. */
  ApprovalTrayDeny: "ApprovalTray.Deny",

  /** A square control whose only child is a glyph. */
  IconButton: "IconButton",
  /** The system's one moving element: a live claim, drawn. */
  Spinner: "Spinner",
  /** A drawn 6px status mark in a fixed 2ch column. */
  StatusDot: "StatusDot",
  /** Match emphasis inside a label, as weight only. */
  Highlight: "Highlight",
  /** The named scroll owner. */
  ScrollArea: "ScrollArea",
  /** Text on the shared type scale, bound to a tone. */
  Text: "Text",
  /** Text in one of the transcript's three voices. */
  Voice: "Voice",
  /** One syntax-toned run inside a fence. */
  CodeToken: "CodeToken",
  /** The tail of streaming output. */
  Caret: "Caret",
} as const;

