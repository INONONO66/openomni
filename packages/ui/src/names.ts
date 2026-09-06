/**
 * Every rendered piece of this surface has a stable, visible ADDRESS.
 *
 * The Owner reviews this design system by looking at it and naming what is
 * wrong. Without addresses that review is "the thing under the tool list, the
 * grey one" — a description that has to be decoded before it can be acted on,
 * and that decodes differently depending on which screen the reader is looking
 * at. With addresses it is `ToolGroup.Summary`, which is a fact.
 *
 * So every exported component stamps `data-ui` on its root element, and the
 * value comes from HERE and from nowhere else. Three properties follow, and all
 * three are gated by `test/names.test.tsx`:
 *
 *   1. **One owner.** `UI_NAMES` is the only place a name is spelled. A call
 *      site writing `data-ui="ToolRow"` as a literal is a second spelling, and
 *      the second spelling is where a rename silently stops propagating — the
 *      component gets the new name, the doc keeps the old one, and the Owner's
 *      word addresses neither.
 *   2. **The doc and the DOM are 1:1.** Every name in `UI_NAMES` appears in
 *      `COMPONENTS.md` and every row of that table is a name in `UI_NAMES`. A
 *      documented name with no element is an address the Owner can say and
 *      nobody can find; an element with no row is a piece of the surface the
 *      Owner has no word for.
 *   3. **Every name is REACHABLE.** Each one must appear in the rendered
 *      Console fixture at least once, or be declared conditional with the
 *      condition that makes it appear. An address that never renders is not an
 *      address.
 *
 * ## Dotted names are PARTS, not variants
 *
 * `Turn.Prompt` means "the prompt part of a Turn": a named region INSIDE a
 * component, whose parent's name is also in the DOM above it. That is what
 * makes the inspector's chain (`Turn.Response › ToolGroup › ToolRow.Status`)
 * readable as containment. A dot is never a variant — `Button` at three
 * variants is one name, because the Owner says "the secondary Button" and the
 * variant is already on `data-variant`.
 */

/**
 * The name of every addressable element in the system.
 *
 * Ordered by where the eye lands: the frame, then the navigator's parts, then
 * the transcript top-down, then the input zone, then the primitives that appear
 * inside all of them. Reading the const in order should read like reading the
 * screen.
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
  /** A status WORD inside a row — `running`, `waiting`. Never a badge. */
  RowStatus: "Row.Status",
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

  /** A control with a word in it. */
  Button: "Button",
  /** A square control whose only child is a glyph. */
  IconButton: "IconButton",
  /** A text field. */
  Input: "Input",
  /** The system's one moving element: a live claim, drawn. */
  Spinner: "Spinner",
  /** A drawn 6px status mark in a fixed 2ch column. */
  StatusDot: "StatusDot",
  /** Match emphasis inside a label, as weight only. */
  Highlight: "Highlight",
  /** The named scroll owner. */
  ScrollArea: "ScrollArea",
  /** A row's address, revealed on hover. */
  AnchorGutter: "AnchorGutter",
  /** Text on the shared type scale, bound to a tone. */
  Text: "Text",
  /** Text in one of the transcript's three voices. */
  Voice: "Voice",
  /** One syntax-toned run inside a fence. */
  CodeToken: "CodeToken",
  /** The tail of streaming output. */
  Caret: "Caret",
  /** The column-split hairline, standalone. */
  Rule: "Rule",
} as const;

/** Every name, as the values the DOM actually carries. */
export type UiName = (typeof UI_NAMES)[keyof typeof UI_NAMES];

/**
 * The names that do NOT appear in the idle Console fixture, and what makes each
 * one appear.
 *
 * This list is the escape hatch for the reachability gate, and it is
 * deliberately expensive to add to: a name here is a name the Owner cannot see
 * by opening the Shell tab, so it has to come with the exact condition that
 * renders it. "Sometimes" is not a condition, and neither is "on the System
 * page" on its own — the entry has to say what state produces the element.
 *
 * Every one of these is still REACHABLE, on the System page's specimens. The
 * gate that reads this list checks both halves: the console for the
 * unconditional names, and the System page for these.
 */
export const CONDITIONAL_NAMES: Readonly<Partial<Record<UiName, string>>> = {
  [UI_NAMES.Button]:
    "a control with a word in it. The console's own controls are all named parts — Composer.Send, ApprovalTray.Approve — so a bare Button appears only on the System page",
  [UI_NAMES.Input]:
    "a bordered form field. The console's two fields are SearchLine and Composer.Input, both of which own their own geometry",
  [UI_NAMES.RowStatus]:
    "a Row whose surface passes a State word. The navigator's second line is currently plain Text, so this renders on the System page only",
  [UI_NAMES.Caret]: "the tail of an assistant block while it is STREAMING",
  [UI_NAMES.ComposerStop]:
    "the composer while a turn is in flight AND the surface passed a stop handler. It takes Composer.Send's place rather than sitting beside it, so the idle console never shows both",
  [UI_NAMES.Rule]:
    "a vertical split inside a flex row. The console splits its columns with a Panel edge instead",
  [UI_NAMES.AnchorGutter]: "a transcript row whose surface passes an anchor-copy handler",
};
