# COMPONENTS.md — the Owner's address book

Every rendered piece of this surface carries `data-ui="<Name>"`. This table is the complete list of
those names, and it is checked against the DOM in both directions by
`packages/ui/test/names.test.tsx`: every name here renders, and everything that renders is named
here.

**How to use it.** Say the name. `ToolGroup.Summary is too dim`, `Turn.Meta wants more air above it`,
`ApprovalTray.Deny reads as loud as Approve`. That is a complete instruction — it names one element,
and the element it names can be found by `document.querySelector('[data-ui="ToolGroup.Summary"]')`.

**How to find it.** Hold **Alt/Option** on the showcase and move the pointer. The hovered element is
outlined and its ancestor chain is printed — `Turn.Response › ToolGroup › ToolRow.Status` — with its
size. Click while Alt is held to copy the chain. Alt only; release hides it.

**Dotted names are PARTS, not variants.** `Turn.Prompt` is a named region inside a `Turn`, and the
parent's name is in the DOM above it. A variant is not a name: `Button` at three variants is one
address, because `data-variant` already sits beside it.

**What the Owner may say about it** is the vocabulary each row actually answers to. A note outside
that column is not wrong, it just means the fix lands somewhere else — "ToolRow is in the wrong
order" is a `Timeline` note, because ordering is not something a row decides about itself.

## The table

| Name | File | What it is | What the Owner may say about it |
| --- | --- | --- | --- |
| `Console` | `src/console.tsx` | The whole window: chrome, navigator slot, transcript, composer | Column widths, which band scrolls, the density of the whole screen |
| `Panel` | `src/primitives/surface.tsx` | A tonal surface — the window, a column, a recessed region | Tone (`bg`/`sunken`/`raised`), whether a column edge is drawn |
| `SidebarHeader` | `src/chrome.tsx` | The sidebar's titlebar row, beside the traffic lights | Height, where the create control sits, its inset |
| `MainHeader` | `src/chrome.tsx` | The main column's title and its one qualifying fact | Title size and weight, the gap to the detail, the shared measure |
| `SearchLine` | `src/chrome.tsx` | The sidebar's one control: a line, not a box | Underline on focus, the `⌘K`/`esc` hint, the count line's tone |
| `Row` | `src/primitives/row.tsx` | The one selectable surface in the system | Height, indent per level, the selected fill and its hairline, hover |
| `Row.Status` | `src/primitives/state.tsx` | A status WORD inside a row — never a badge | Which tier takes the accent, how quiet `settled` is |
| `Disclosure` | `src/primitives/disclosure.tsx` | A group header that expands a region | Label case and tone, chevron size, the gap before the first row |
| `Timeline` | `src/timeline/timeline.tsx` | The transcript column | Turn order, the measure, the empty state's sentence |
| `Turn` | `src/timeline/timeline.tsx` | One exchange: a message and everything that answered it | The 40px boundary above it — the loudest gap in the column |
| `Turn.Prompt` | `src/timeline/timeline.tsx` | The Owner's own message, right-aligned | Alignment, the 82% width cap, the `you` label's tone |
| `Turn.Response` | `src/timeline/timeline.tsx` | One block of the agent's answer, and the gap above it | Spacing between blocks; the type inside is `MarkdownBlock` |
| `Turn.Meta` | `src/timeline/timeline.tsx` | The line that closes a response: wall time and elapsed | Its 40% dim, the 8px above it, that it sits last and flush left |
| `EpochRule` | `src/primitives/epoch-rule.tsx` | A boundary in the ledger — a compaction, a resume | Stroke weight, the label's position in the line, the run-out length |
| `MarkdownBlock` | `src/timeline/markdown-block.tsx` | Rendered markdown: a paragraph, a heading, or bullets | Prose size and leading, heading weight, bullet indent and mark |
| `CodeFence` | `src/primitives/code.tsx` | A code block: one quiet tonal step, bounded by a hairline | Fill, border, radius, padding, the language label's tone |
| `CodeFence.Gutter` | `src/primitives/gutter.tsx` | One numbered line in a fence, with its change marker | Number tone, the 2px marker bar, the diff hues, the row tint |
| `ToolGroup` | `src/timeline/tool-rows.tsx` | A run of adjacent tool calls | The 16px indent, the 2px between rows, when the block folds |
| `ToolGroup.Summary` | `src/timeline/tool-rows.tsx` | The fold's line: `6 tools · 3 read · 2 edit` | Its tone, its chevron, that it shares the rows' left edge |
| `ToolRow` | `src/timeline/tool-rows.tsx` | One tool call, one line: the verb, the thing, the cost | The meta voice, the dim on `target` and `duration`, the payload |
| `ToolRow.Status` | `src/timeline/tool-rows.tsx` | The status clause at a row's end: the mark and the word together | Which statuses take the accent, the word's wording, the mark's shape |
| `Composer` | `src/composer.tsx` | The input zone: the hairline, the field, the meta line | The hairline above it, its padding, that it shares the transcript's measure |
| `Composer.Input` | `src/composer.tsx` | The auto-growing textarea | Placeholder tone, prose voice, the one-to-eight-line growth |
| `Composer.Send` | `src/composer.tsx` | The send affordance | Its 40% rest tone, that it is disabled rather than hidden when empty |
| `Composer.Meta` | `src/composer.tsx` | The line under the field: what is answering, what the turn cost | Its dim, the space above and below, left/right split |
| `ApprovalTray` | `src/composer.tsx` | The pending-decision tray, docked above the composer | Its one-line shape, the `+N` queue count, the gap to the field |
| `ApprovalTray.Approve` | `src/composer.tsx` | The screen's ONE accent-filled control | The fill, its size, the printed `⌘↩` beside it |
| `ApprovalTray.Deny` | `src/composer.tsx` | The quiet half of the pair | How quiet it is — the asymmetry against Approve is the design |
| `Button` | `src/primitives/button.tsx` | A control with a word in it | Variant tones, both heights, hover/press/focus/disabled |
| `IconButton` | `src/primitives/button.tsx` | A square control whose only child is a glyph | Its square size, the glyph's size inside it, its rest tone |
| `Input` | `src/primitives/input.tsx` | A text field | Its raised rest surface, the accent underline on focus, both heights |
| `Spinner` | `src/primitives/spinner.tsx` | The system's one moving element: a live claim, drawn | Dot size, step speed, its tone, the reduced-motion readout |
| `StatusDot` | `src/primitives/state.tsx` | A drawn 6px status mark in a fixed 2ch column | The four shapes, the column's width, which tier takes the accent |
| `Highlight` | `src/primitives/highlight.tsx` | Match emphasis inside a label, as weight only | The matched weight and tone; that there is no fill and no color |
| `ScrollArea` | `src/primitives/scroll-area.tsx` | The named scroll owner | Thumb width and tone, when it appears, whether a column pins to its end |
| `AnchorGutter` | `src/primitives/anchor-gutter.tsx` | A row's address, revealed on hover | Its 4ch column, its faint tone, that it holds its space at rest |
| `Text` | `src/primitives/surface.tsx` | Text on the shared type scale, bound to a tone | Any level's size or weight, any tone's lightness, mono vs sans |
| `Voice` | `src/timeline/voice.tsx` | Text in one of the transcript's three voices | Prose 14/21, code 13/20, meta 12/18 at 70% — and that there is no fourth |
| `CodeToken` | `src/primitives/code.tsx` | One syntax-toned run inside a fence | The achromatic syntax ramp — which kinds read darker or lighter |
| `Caret` | `src/primitives/surface.tsx` | The tail of streaming output | Its 2px width, the accent, that it blinks only while streaming |
| `Rule` | `src/primitives/surface.tsx` | The column-split hairline, standalone | Its tone and that it is one device pixel |

## Conditional names

These do not appear in the Shell tab's idle Console. Each renders on the System page's specimens,
and the condition is what makes it appear in the product surface. The list lives in
`CONDITIONAL_NAMES` in `src/names.ts`; this section is checked against it.

| Name | Condition |
| --- | --- |
| `Button` | a control with a word in it. The console's own controls are all named parts — Composer.Send, ApprovalTray.Approve — so a bare Button appears only on the System page |
| `Input` | a bordered form field. The console's two fields are SearchLine and Composer.Input, both of which own their own geometry |
| `Row.Status` | a Row whose surface passes a State word. The navigator's second line is currently plain Text, so this renders on the System page only |
| `Caret` | the tail of an assistant block while it is STREAMING |
| `Rule` | a vertical split inside a flex row. The console splits its columns with a Panel edge instead |
| `AnchorGutter` | a transcript row whose surface passes an anchor-copy handler |

## Two elements are deliberately unnamed

- **A fenced markdown block renders no `MarkdownBlock`.** The fence IS the block, so the chain is
  `Turn.Response › CodeFence`. Wrapping it to make the name appear would insert a layout-free box
  between the turn's gap and the fence's border — a box the Owner could then address and nobody
  could style.
- **`composerKey`, `expansionFor`, `spacingClass`, `segmentTurns`, `anchorId`,
  `summarize` and the rest of the pure functions have no name**, because they render nothing. They
  are the law behind what the named elements do, and the Owner addresses the element.
