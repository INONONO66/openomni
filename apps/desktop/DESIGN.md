# DESIGN.md — OpenOmni desktop design system

Normative. `packages/ui` is the only implementation — including the transcript and the `Console`
composition; `apps/desktop` supplies data, ordering, search, and selection, and names no color.

## 1. Premise

The Owner runs many agents at once. Attention is the scarce resource, not screen space. Every
element must justify the attention it takes.

Therefore:

- **Text and whitespace carry the design.** No decoration, no gradients, no shadows, no emoji.
- **Hierarchy is typography** — size, weight, spacing. Not lines, not boxes, not fills.
- **Whitespace separates.** A border is used only where two columns meet.
- **One chromatic accent**, spent on the live and the actionable. Everything else is achromatic.
- **The default view is the result.** Process is collapsed behind at most two levels of disclosure.
- **Focus is protected.** Nothing auto-switches, nothing animates to get noticed, nothing badges.

## 2. Color

Dark is the default. `:root[data-theme="light"]` re-points the same semantic tokens; no component
knows which theme is active.

### Neutral ramp

`--color-neutral-0 … --color-neutral-1000`, all `oklch(L 0 0)` — zero chroma at every step.
Components never name a ramp step. Only the semantic layer below may.

The mid-range carries four steps rather than a symmetric two, because the two themes do not read
the same tone at the same distance from their surface: dark needs its quiet tones lighter than light
needs its quiet tones dark. Every step is placed to clear a measured floor and no step is spare.

### Semantic tokens

| Token | Role |
|---|---|
| `--color-bg` | The window |
| `--color-sunken` | A recessed region: sidebar, code fence |
| `--color-raised` | An elevated region: the selected row |
| `--color-hover` / `--color-active` | Interaction overlays (alpha, not a ramp step) |
| `--color-fg` | Primary text |
| `--color-fg-muted` | Secondary text — the default for body prose |
| `--color-fg-subtle` | Supporting metadata |
| `--color-fg-faint` | Ambient: timestamps, reasons, syntax punctuation |
| `--color-line` | The one hairline: a rule that SEPARATES regions (epoch rules, the sidebar's edge) |
| `--color-line-surface` | The hairline that gives a quiet surface an EDGE: rows, code fences |
| `--color-accent` | The single chromatic value |
| `--color-accent-fg` | Text on the accent — **theme-dependent**: black on dark's accent, white on light's |
| `--color-focus` | Focus ring — an alias of the accent |

`--color-ok`, `--color-warn`, `--color-danger`, `--color-info` **do not exist**. State is text.

**Why two line tokens.** They answer different questions and want different weights. `--color-line`
divides — it must be findable, because missing it means missing a boundary. `--color-line-surface`
only needs to say "this fill has an edge", and it is drawn around *every* row, so at dividing
strength the surface becomes a stack of boxes. It is measured into a **1.05–2.0:1** band against
whatever it sits on (dark 1.35:1 vs `bg`, 1.12:1 vs `raised`; light 1.23:1 / 1.09:1) and a test
pins it below **half** the `fg-faint` ratio, so nobody can quietly reach for the text tone. Pairing
it with a fill is one decision: the border is what lets a fence drop to `sunken` (~1.05:1, barely a
tint) and still read as a region — without an edge the fill alone has to do that work, and a fill
strong enough to define a region unaided is a grey box.

### Contrast floors — normative

Every tone is measured against **all three surfaces it can land on** (`bg`, `sunken`, `raised`), in
**both themes**, and asserted numerically in `packages/ui/test/tokens.test.ts`. A tone that clears
the floor on the window but not on a selected row fails exactly where the Owner is looking.

| Token | Floor | Why |
|---|---|---|
| `--color-fg` / `--color-fg-muted` / `--color-fg-subtle` | **4.5:1** | Carries meaning |
| `--color-fg-faint` | **3:1** | Ambient tier — timestamps, durations, reason lines, syntax punctuation. Quiet by design; below 3:1 it is not quiet, it is missing |
| `--color-accent` as text | **4.5:1** | `running` is rendered on all three surfaces |
| `--color-accent-fg` on `--color-accent` | **4.5:1** | The primary button is the accent as a fill |

Surfaces have no floor — they have a **ceiling**: `sunken` and `raised` must stay **under 1.4:1**
from `bg`. Past that a step stops reading as elevation and starts reading as a filled box, which is
what made light mode's selected row and every code fence read grey. `--color-line` and
`--color-raised` must also be **separate ramp steps** in light: a border and a surface are different
jobs, and sharing one step is what made a selected row look outlined.

The light accent is `oklch(53% 0.19 257.4)` — `#0266d6`, Moroly's `#007AFF` **darkened in oklch
from 60.3% to 53%**. At 60.3% it measured 4.13:1 on white and 3.6:1 on a selected row, so `running`
failed in the two places it is actually read. Dark keeps `#0984ff`.

### The accent budget

The accent may appear in exactly three roles:

1. A `running` session — the only claim about *right now*.
2. A primary action the Owner must take.
3. The focus ring and the focused input underline.

Nothing else. No accent on selection, no accent in code, no accent on hover.

### The one exception: diff semantics

`--color-diff-add` and `--color-diff-remove` are the single scoped exception to the one-accent law,
admitted because green-is-added / red-is-removed is the **universal diff convention** the Owner
already reads every diff through — it is quoted, not invented, and an achromatic diff is the one
place refusing color makes a surface harder to read than the convention it quotes.

The scope is the whole of the exception: the two tokens are spent **only inside a code block's diff
rows**, and only on the change marker bar, the `+`/`-` sign, and an optional row tint held at ≤6%
alpha. Never on the code text — the syntax ramp stays achromatic, because tinting a row would make
a fence the loudest region on a text-first surface and would re-encode the meaning in the one
channel a colorblind reader cannot use. The literal `+`/`-` character is what carries the claim; the
hue is a supplement to it. Both tones clear **4.5:1** on all three surfaces in both themes and are
held at or below the accent's chroma, so quoted material never out-shouts a live claim.
Enforced by `packages/ui/test/transcript-law.test.tsx`, which fails if either token is named outside
`primitives/gutter.tsx` or spent on an element that is not a diff row.

## 3. Type

Two families: **Pretendard** (`--font-sans`) for language, **JetBrains Mono Variable**
(`--font-mono`) for machine truth — paths, tool names, durations, ids, state.

The shell density scope sets **mono as the inherited default**, because most of what the shell
shows is machine truth. Prose therefore opts *out*, per element, via `<Text sans>` — never by
re-pointing the density block's `--font-*`, which a test forbids precisely so the split stays a
per-element decision that can be read off the call site.

| Surface | Family | Why |
|---|---|---|
| Markdown paragraphs, bullets, headings | sans | Language the model wrote for a person |
| A prompt the Owner typed | sans | Language |
| A wait reason ("needs your approval") | sans | Language |
| Session and worker names | mono | An identifier, and the column has to align |
| Tool name and target, paths, ids | mono | Machine truth |
| Run state, durations, timestamps, counts | mono | Machine truth, and it must not reflow |
| Code fences and diffs | mono | Machine truth |
| The main header's title | sans | It is the one thing the view is about |

### Scale

| Level | Role |
|---|---|
| `display` | The one thing a view is about |
| `title` | A section that owns a region |
| `heading` | A heading inside prose |
| `body` | Prose, at `1.7` line height |
| `label` | A row's own name |
| `meta` | Supporting metadata, second lines |
| `micro` | Ambient: timestamps, durations, counts |
| `overline` | Group headers — uppercase, tracked out |

### Weight

`400` normal, `500` medium, `590` semibold. **`700` is forbidden** — past `590` Pretendard adds
noise, not rank. Medium weight is a selection or emphasis signal and is rationed accordingly.

### Numbers

Anything numeric uses `tabular-nums`. A column of digits that jitters as it updates costs attention
for no information.

## 4. Space

Named tokens only; no ad-hoc pixel values in components. **One 8px baseline** — every vertical step
is a multiple of it, so sidebar rows, headers, and timeline blocks land on one grid instead of
three. Off-grid values are invisible per element and visible as drift down a column of forty rows.

`--spacing-inset` 8 · `--spacing-row-inset` 8 · `--spacing-group-gap` 8 · `--spacing-gutter` 16 ·
`--spacing-section` 24 · `--spacing-row` 32 · `--spacing-control-sm` 24 · `--spacing-control-md` 32 ·
`--spacing-titlebar` 56 · `--spacing-tree` 264 · `--spacing-detail` 320 · `--spacing-measure` 68ch ·
`--spacing-indent` 12 · `--spacing-indent-slot` 16

`--spacing-group-gap` is the one step spent between a group header and its first row — looser than
the gap between rows, because grouping here cannot be a box or a line, so it must be whitespace.

`--spacing-indent` is the one HORIZONTAL rhythm: one step per level of tree depth. It is the only
value allowed to express hierarchy in the navigator, because this system has no tree lines and no
icons to draw one with — the depth has to be in the geometry or it is not there at all.
`--spacing-indent-slot` is the chevron column, reserved at EVERY level whether a chevron lands in
it or not, so text x within a level is one value rather than two.

`--spacing-measure` is the transcript's measure: 68ch, centered, sides deliberately clear. The
header and the composer share it (§5.1).

Radius: `--radius-sm` 4 · `--radius-md` 6. **Nothing larger exists.** `--radius-elbow` is retired
with the tree connectors it softened.

| Radius | Where | Why |
|---|---|---|
| `--radius-sm` 4 | Buttons, inputs, the gutter | A control is smaller than a surface and a 6px corner on a 24px control reads as a pill |
| `--radius-md` 6 | Rows, tool rows, code fences, the focus ring | Everything that is *a surface* takes one answer to "how round is a surface here" — a fence is a bigger rectangle than a row but the same kind of thing, and a bespoke corner for the big one reads as inconsistency long before it reads as hierarchy |

The focus ring shares the surface radius deliberately: it is `box-shadow: inset 0 0 0 1px`, not
`outline`. An outline with a positive offset spills past an indented row's fill and over the
column's edge, does not follow `border-radius` reliably at 1px, and at 2px outranks the selected
row's own fill — so the ring is drawn *inside* the shape it belongs to, exactly on its corner.

### Density

`[data-density="shell"]` re-points the type scale and vertical rhythm **only**. It touches no color
token. A surface cannot acquire a second palette by changing density.

The shell scale is **mono-first and anchored on a 13px body**, because the transcript is a ledger of
machine truth read in long columns, not prose: paths, tool names, durations, and code are the
majority of its glyphs. Three sizes carry it, and the steps between them are normative:

| Role | Size | Carries |
|---|---:|---|
| `body` / `label` / `heading` | **13px** | The transcript's text, and a row's own name. `heading` ranks by WEIGHT, not size |
| `meta` | **12px** | A tool row, a reason line, a second line — exactly one step quieter than body |
| `micro` | 10px | Ambient numerics: timestamps, durations, counts |
| `title` | **14px** | The session name heading the column — body **+ one step**, never more |

Four properties are normative and asserted in `packages/ui/test/density.test.ts` and
`apps/desktop/test/shell-density.test.tsx`:

1. **`title` is at most one step above `body`.** A session name is a label on the column it heads,
   not a headline. Past one step it stops ranking the header and starts shouting over the content.
2. **`meta` is exactly one step under `body`.** A row's second line must read as supporting the
   first, and there is no tone change or indent available to carry that — the step is the mechanism.
3. **Leading is ledger-tight (1.3–1.45), never prose.** Mono glyphs have uniform advance and no
   descender relief to buy back, so the sans ramp's `1.7` spends a third of the column on air. `body`
   holds 13px in BOTH scales; shell buys its density from leading and from the headline roles.
4. **The density scope is declared once, on the window root.** The navigator and the transcript are
   one surface at one density; scoping it lower leaves whichever column was missed on the System
   scale, which is exactly how this regressed once.

Every text node names its own type level. A node that declares a tone but no level inherits the
document's 16px default — a value no token here names, and one that ignores the density scope
entirely. `Row` and `Highlight` therefore set `label` as their baseline; a child wanting another
level says so. The one exception is a `CodeFence`, where the `<pre>` owns one size for the whole
block and its syntax tokens carry tone only.

The System surface keeps its own **Pretendard** reading of the same tokens and does not enter this
scope.

## 5. Transcript law

Normative. Derived from `.omo/reports/transcript-layout-refs-20260906.md` §5. It replaces the glyph
grammar that stood here, which is deleted rather than amended — see "What this replaced" below.

The column is a **conversation**, and everything in it is subordinate to reading one. The reference
surfaces this is drawn from share one property: at rest they are text on a background, and the only
things that break that plane are the two or three facts that are genuinely live.

### 1. One measure, centered

**68ch, centered, shared by the header, the transcript, and the composer.** Prose set to the full
width of a desktop window is prose nobody finishes a line of. The three regions share the measure so
the session name, the first line of an answer, and the caret in the composer all hang on one left
edge; a composer at full width under a 68ch transcript reads as a different document.

### 2. Three voices, and no fourth

| Voice | Size | Face | Carries |
|---|---|---|---|
| prose | 14px / 21px | sans | What was said — the Owner's prompts, the agent's answers |
| code | 13px / 20px | mono | Quoted material: fences, diffs, payloads |
| meta | 12px / 18px @ 70% | mono | Machine truth: tool rows, group summaries, times, the tray |

These three are declared **once**, as literal pixel pairs, in `packages/ui/src/timeline/voice.tsx`.
They are deliberately NOT routed through the shared type scale, and that is the one place in the
system where a raw size is correct: the scale is re-pointed by density scope, and a transcript whose
prose changed size with the sidebar's density would acquire a fourth and fifth voice without anyone
declaring one. Every additional size dilutes the single signal these three exist to send — *which
kind of material am I looking at*.

Enforced by `apps/desktop/test/shell-density.test.tsx`, which fails on any size in the column that is
not one of the three, and on any scale class that leaks in.

### 3. Whitespace is the only grouping mechanism

Four steps, and the ratios are the design:

| Step | Gap | Between |
|---|---|---|
| turn | 40px | One exchange and the next |
| pair | 16px | A prompt and its response |
| block | 8px | A change of voice inside a turn |
| paragraph | 6px | Two paragraphs of one answer |

A turn boundary must beat the gap inside a turn by enough that the eye finds it **without reading**,
and the paragraph step must sit under the block step or a continuous answer reads as separate blocks.

**The turn step is 40px, and it was 28px.** 28 is only 1.75x the pairing gap, and in the rendered
column that was not enough: the Owner read the next turn's `you` as the tail of the previous answer
rather than as a new exchange. The gap inside a turn is unchanged — the defect was never that a turn
read as too loose internally, it was that its boundary did not read as a boundary. At 40px the
boundary is **2.5x** the largest gap inside a turn, which is the asymmetry this rule was always
asserting and only now spends.

The number lives in exactly two places, and they are checked against each other: `TURN_GAP` in
`spacing.ts`, and the literal `"mt-[40px]"` in the same file's class table (Tailwind scans source
statically, so an interpolated class compiles to nothing — see the pass 9 defect). Every other
consumer, including the System page's rhythm specimen, reads the constant.
The gap is a fact about a PAIR of adjacent parts, so it is neither a flex `gap` on the column nor a
fixed margin on a block — one number applied to every pair is the flat rhythm that made a paragraph
break look like a turn boundary.

Declared once in `packages/ui/src/timeline/spacing.ts`; enforced by `packages/ui/test/transcript-law.test.tsx`.

### 4. No boxes, no rules, no fills

The column draws **nothing**. No card behind a message, no border around a turn, no full-width rule
between exchanges, no background on a tool row. The order of the column already says what a
separator would say, and every drawn edge competes with the one or two things that are actually live.

Two exceptions, both earned:

- **The code fence** takes a `sunken` fill and a hairline, because it is quoted material from
  somewhere else and needs an edge to be quoted BY.
- **The `EpochRule`** draws a hairline, because a compaction or a resume is a ledger EVENT that
  happened to the session — not a separator the layout inserted between two turns.

### 5. Speakers are told apart by geometry, not decoration

The Owner's message is **right-aligned, max 82% of the measure, with its text set left**, under a
faint `you` label. The agent's answer is plain markdown on the background, full measure, no label.

No bubbles, no avatars, no name badges, no fills. The asymmetry alone is enough — it is how every
messaging surface the Owner already reads distinguishes two speakers — and the text inside the block
stays left-set because right-set prose is decoration applied to something a person wrote.

The previous law made the prompt "the only box." That was the single loudest element in the rejected
transcript and it is gone.

### 6. Tool calls are one quiet line each

A tool call is one line in the meta voice, indented 16px, with a **drawn** 12px SVG chevron:

```
  ›  read  src/auth.ts · 34ms
```

No row height, no two-line layout, no right-aligned status column, no fixed-width status field. Those
belonged to the grammar this replaces, and each one turned the transcript's densest element into its
most decorated one. A status word appears only when there is something to say — `running`, `waiting
for approval`, `failed`, `denied` — and a settled call says nothing at all, because "it worked" is
the default and printing it costs a line of attention on every row.

**Adjacent calls group; prose splits the group.** Grouping follows chronology and nothing else.
Sorting every call in a turn into one block at the top would be tidier and would be a lie about the
order the agent worked in.

### 7. A group of four or more folds, and never hides a claim

At four calls a run starts reading as a wall, so it folds to a summary:

```
  6 tools · 4 read · 2 edit · 1.8s
```

The summary tallies most-frequent-first, so it reads as a shape rather than a log.

**The summary sits on the rows' own text edge.** It takes the same 12px chevron slot every tool row
takes — with a drawn chevron in it, because the summary *is* the group's expand toggle — so `6 tools`
and the `shell` beneath it hang on one x. The slot is declared once in `tool-rows.tsx` and both call
sites read it from there; two spellings of the same indent is how the two edges drifted apart in the
first place, leaving the summary hanging 12px left of everything it summarised.

**Never-hide is absolute.** Any call that is not settled-and-successful stays on screen inside a
folded group: `running`, `waiting`, `failed`, `denied`. A summary reporting `6 tools` while one of
them is silently blocked on the Owner is the exact failure this rule exists to prevent.

Expansion is scoped to the session and reset when it changes.

### 8. The time closes the response, at rest

Every answered turn ends with one meta line: **`14:32 · 18s`** — wall time, then elapsed. It is the
**last child of the agent's block**, flush with the agent text edge, 8px above it (the block step,
taken from the spacing law rather than written as its own margin), in the meta voice at 40%
foreground.

**Visible at rest.** The previous law hid it behind `:hover` and `:focus-within` with `opacity: 0`,
positioned absolutely so revealing it could not reflow. That mechanism is **deleted**, and the reason
is not that hiding it was ugly: a fact that only exists while the pointer is inside the turn has no
resting placement, so a ruling about *where* it sits is unanswerable. It is on screen, and it is kept
quiet by type and tone — 12px mono at 40% — rather than by absence.

**Flush left, never indented and never right-set.** The fact belongs to the answer, and the answer's
edge is the column's left edge. Indenting it to the tool block's 16px would attach it to the last
tool call; right-setting it to the measure would open a second vertical axis in a column whose whole
structure is one left edge.

**It closes the response rather than opening it.** That is the reading order of the fact: the answer
lands, then it is stamped. A time above the first paragraph is a header the reader passes through on
the way to the content; a time under the last one is a receipt they arrive at once the content is
spent.

**Never on the Owner's own message.** The Owner does not need to be told when they typed — they were
there — so a timestamp over a prompt is metadata printed at the one place in the column with no
reader for it. A turn that is still only a prompt shows no time at all, which is correct: there is no
elapsed to report until there is a response to have elapsed against.

One line per turn is the ceiling. The turn footer that reported elapsed time and tokens under every
exchange stays deleted — that was a bracketed block of totals, not a line.

### 9. Decisions dock, they never scroll

An approve/deny pair rendered inline **scrolls away**: the agent keeps writing, the decision moves up
the column, and the Owner is left with a stalled run and no visible control. So the decision lives in
a tray docked above the composer, and the matching tool row says only `waiting for approval`.

The tray is one line: what wants to run, why it stopped, `Approve`, `Deny`, and the shortcuts. Deny
is quiet and Approve takes the system's only accent fill — two equally weighted buttons make the
Owner choose between two equal-looking options, while one filled and one plain says which is the path
forward without arguing for it. Multiple pending decisions show a count and a `next`, never a stack.

**The transcript opens on its newest turn and stays there** as the agent writes, releasing when the
Owner scrolls up to read history and resuming when they return to the end. Docking the tray is only
half this rule: a tray reading `Approve` is worth nothing if the tool row it refers to is below the
fold, which is exactly where the last turn sat while the column opened at the top — the Owner saw a
lone `you` label above the composer and no sign that anything was waiting. The scroll owner holds
this, since nothing above it can set `scrollTop` on a viewport it does not render, and it is opt-in:
the navigator's newest material is wherever the ranking put it, not at the bottom. Gated in a real
browser by `showcase:probe-transcript-tail`, which asserts the last row's bottom clears the
composer's top in both themes with the tray both docked and dismissed.

### 10. Marks are drawn, never typed

Structural marks are SVG or borders aligned to the character grid. Never characters.

This is the one rule that survives from the grammar this section replaces, and the replacement is
**stricter**: the old law permitted any character on a frozen allowlist, and the allowlist is why the
rejected transcript accumulated a `❯` prompt marker, a left spine, and a column of tree connectors —
all rendering at whatever weight the reader's mono font happened to have. There is no allowlist now.
The single exception is a **keyboard legend** (`⌘K`, `⌘↩`, `⌘⌫`), which is not a mark the interface
draws but the name of a key, quoted from the keycap in front of the Owner.

Enforced by `apps/desktop/test/design-tokens.test.ts`.

### What this replaced

The transcript this law replaces was rejected in full. Deleted to grep-zero, with their tests,
showcase sections, and rules: the tree and connector primitives and `WorkerTree`; left spines on work
groups; the boxed user prompt and its drawn `❯`; right-aligned status and meta columns, including the
11ch status field; inline approve/deny in the column; visible timestamps and the turn footer;
`Banner`, `Sparkline`, and `Progress`.

The pattern across all of them is one mistake: **structure was drawn instead of implied.** Each mark
was individually defensible and the sum was a surface that looked like a system diagram of a
conversation rather than a conversation.

## 6. Motion

**One token, one owner: `--motion-fast`** (`120ms cubic-bezier(0.2, 0, 0, 1)`, composed from
`--motion-fast-duration` and `--motion-fast-ease`). Every transition on the surface spends this and
nothing else. The earlier `--duration-quiet` / `--ease-out-quiet` pair is **retired** — a second
timing token is how a system starts having opinions about which interactions deserve more time,
and the answer here is that none of them do. A test asserts the retired names do not come back.

Motion acknowledges an interaction the Owner started; it never announces something they did not.
`prefers-reduced-motion` disables all of it — including the status dot's pulse and the streaming
caret's blink, both of which are pinned to full opacity rather than merely slowed, so a live mark
stays *visible* when its motion is removed.

The spinner is the one exception to "nothing animates on its own", and it is bounded by rule 5: it
runs only on a row the Owner started, it is a discrete `steps(6, end)` advance rather than a
continuous transform, it animates `opacity` and nothing else — the one property the compositor can
drive without touching layout or paint — and under `prefers-reduced-motion` it collapses to a static
dot beside the word `running`. Nothing else in the transcript moves.

## 7. Primitives

`packages/ui` exports these and only these. A surface that needs something else changes the design
system, not its own file.

| Primitive | Contract |
|---|---|
| `Panel` | Tones `bg`/`sunken`/`raised`; `edge` is `none`/`right`/`left` — a hairline where a column splits, never a box |
| `Text` | `level` × `tone`, plus `mono` and `numeric`. The only way text acquires size or color |
| `Row` | A selectable line. `current` = raised surface + medium weight. **No marker bar**. `level` 0–2 is depth: an outside MARGIN, so the row's own fill starts at its indent and the highlight reports depth instead of erasing it. `chevronSlot` reserves the glyph column on a row that has no chevron |
| `State` | The words `running`/`waiting`/`done`/`interrupted`, for the NAVIGATOR. The transcript's tool rows own their own status words (§5.6). `running` is accent; the rest are muted. No dot, no fill, no border |
| `Disclosure` | Overline label, one rotating chevron in a fixed slot, optional trailing metadata, optional `collapsedCount`. `level` and its margin geometry match `Row`'s exactly, so a header and a row at one level share a text x. `tone` is `subtle` for a root group and `faint` for a nested one. The only grouping mechanism |
| `Button` | `primary`/`secondary`/`ghost` × `sm`/`md`. Only `primary` spends the accent. None draws a border |
| `IconButton` | Square, `label` required — an unlabelled icon control is not shippable |
| `Input` | A quiet `raised` surface at rest — the elevation IS the affordance, so there is no icon. Borderless until focus, which draws the accent underline and nothing else. Used for real form fields; the sidebar's search is NOT one (see §8) |
| `CodeFence` / `CodeToken` | A `raised` block, no border. Every tone is achromatic |
| `ScrollArea` | The single scrolling element for a column, with `overscroll-contain` |
| `Caret` / `Rule` | The streaming cursor, the hairline |

The transcript primitives (§5) are data-blind and dependency-free:

| Primitive | Contract |
|---|---|
| `Voice` | The three sizes, declared once. The only place a font size is written in the column |
| `ToolRow` | One meta-voice line: drawn chevron, tool, target, and a status word only when there is one |
| `ToolGroup` | Adjacency grouping, the ≥4 fold, and the never-hide rule |
| `EpochRule` | A short faint rule marking a ledger boundary — compaction and resume only |
| `StatusDot` | A drawn mark inline after a tool row's status word. `live`/`waiting`/`failed`/`denied` only |
| `Spinner` | Six SVG circles stepping on opacity; `prefers-reduced-motion` renders the word alone |
| `Composer` | Hairline, auto-grow field, drawn send icon, the keyboard contract |
| `ApprovalTray` | One line, two decisions, the queue depth. The only accent fill on screen |
| `Gutter` | Right-aligned faint tabular line numbers, a literal `+`/`-` column, and the change marker bar drawn immediately left of the number (≤4px gap, inside the gutter) in the scoped diff tones |

Deleted and not to return: `Tree`, `TreeView`, `WorkerTree`, `WorkSpine`, `PromptBox`, `TurnFooter`,
`Banner`, `Sparkline`, `Progress`, `GLYPH`, `Rail`, `Chip`, `Dot`, `Card`, `AgentRow`, `Shelf`,
`Tabs`, `Menu`, `Tooltip`, and every status bar.

## 8. Chrome

`SidebarHeader` (one new-session control), `SidebarSearch` (the only permanent sidebar control),
`MainHeader` (the session and its agent, in type).

### SidebarSearch

A **line, not a box**, and deliberately not an `Input`. A filled rectangle at the top of the column
is the loudest thing in a surface whose whole hierarchy is quiet type on quiet whitespace, and it
spends that volume announcing a control the operator reaches by keyboard anyway.

| Property | Value |
|---|---|
| Rest | No fill, no border, no radius, no glyph. `Search` in `fg-faint` |
| Shortcut | `⌘K` right-aligned, `fg-faint`, mono + `tabular-nums`, `aria-hidden`, not focusable |
| Focus | A `--color-line` hairline underline appears. **Not** the accent — a search field is none of the accent's three roles |
| Caret | `fg`. The placeholder survives focus, because here the placeholder IS the label |
| Geometry | One row high, text on the **L0 text x** — the same left edge as a project header, so the control introduces no second edge above the tree |

The shortcut is the affordance: `⌘K` states "reached by keyboard" more precisely than a surface or
a magnifier glyph could, and it is the same fact the deleted `raised` fill was spending a tonal
step to imply.

There is no status bar, no badge, no unread pill, and no toggle row. Counts belong to the row that
owns them.

## 9. Shell layout

Two columns: the session navigator (`--spacing-tree`) and the transcript. A third column that is
empty by design spends a fifth of the window on nothing.

### Navigator

**PROJECT → SESSION → SETTLED**, at three explicit depths, one `--spacing-indent` step apart:

| Level | Element | Fill x | Text x |
|---|---|---:|---:|
| L0 | project header — a real row: chevron, name in overline caps, a muted `· N` while closed | 8 | 32 |
| L1 | a session row, and the `settled · N` header (a sibling of the live rows) | 20 | 44 |

Settled sessions sit at **L1, alongside the live ones**, behind a `settled · N` disclosure. They
used to be indented to an L2 as children of that header, which said a finished session is a
different KIND of thing from a running one. It is not — it is the same thing, later, and the
disclosure already carries "these are put away." The third depth bought nothing and cost every
settled row 12px of its name.

Sessions are the only rows that navigate; the two header kinds expand. Three properties are
normative and asserted in `apps/desktop/test/search-tree.test.tsx`:

1. **The indent is a margin, not padding.** A hovered or selected row's fill therefore starts at
   that row's own indent. A fill spanning the full column paints all three levels the same shape
   and erases the depth exactly where the highlight is loudest.
2. **The chevron slot is reserved at every level.** Without it a session row's name hangs 16px left
   of its own group label, so one level reads as two.
3. **The two overline labels are not peers.** The project takes `fg-subtle`, the settled tail
   `fg-faint` — one tone quieter, so two caps labels in one column cannot read as siblings.

Whitespace sits ABOVE a group header and not below it (`mt-section`, none on the first), so each
group reads top-down as a block instead of a header having equal claim on the group above it.

Each session row is two lines:

1. The session name, with its `State` on the right.
2. The ordering engine's **reason**, in the faint tone.

An order the Owner cannot interrogate is one they must re-derive by opening things. The reason line
is what makes the ranking answerable.

Settled sessions collapse into a per-project `settled · N` disclosure at L1: finished work stays
reachable without spending a row of attention. A closed group prints the count it is hiding and an
open one does not — an open group's rows ARE the count.

### Ordering

`apps/desktop/src/renderer/attention/` — pure TypeScript, `now` injected, zero React and zero IO.
Class rank decides first (`pinned` → `waiting` → `interrupted` → `finished` → `running` →
`settled`), then a recency-and-residue score within the class.

A new order is adopted **only at a focus boundary** (a selection change, or measured idle). Between
boundaries the shown order is held and drift is reported as a count. A list that reflows under the
cursor costs more attention than any ranking saves.

### Transcript

Ledger order, no clustering, on the 68ch centered measure the main header and the composer share.
The full law is §5; this section states only what the SHELL contributes to it.

The column scrolls; the composer is pinned below it and does not. That split is why `Console` owns
the scroll region rather than `Timeline` — a composer inside the scroll region is a composer that
leaves the screen when the Owner scrolls up to re-read something, which is exactly when they are
most likely to want to type.

Every row keeps a stable address on `data-anchor`, exposed by the anchor gutter: faint, tabular,
`user-select: none`, invisible until the row is hovered or the number focused. The address is never
text in the row, so selecting a paragraph copies the paragraph, and expanding a group never
renumbers the rows below it — an address that changes when a disclosure opens is an address nobody
can cite.

The streaming caret appears **only while streaming**. It is the one blinking element in the system
and it exists only while there is something to blink about; a cursor on a finished turn is
motion-shaped decoration on a static fact.

### Composer

A hairline top border, an auto-growing field of 1–8 lines, and a drawn send icon. No card, no
rounded well, no shadow: the composer is where the column ends, and a `border-t` says that in one
pixel.

The field grows by **measuring**, not by counting newlines — a wrapped long line takes two rows on
screen and one in the string, so a field sized from the string clips exactly the prompts long enough
to need the room.

Enter sends and Shift+Enter takes a newline. `⌘↩` and `⌘⌫` approve and deny the pending decision,
and they are read on the FIELD rather than the document: a global `⌘↩` would approve a shell command
from whatever input the Owner happened to be typing in. Both fall through to their normal meaning
when nothing is pending.

A hint sits left and a meta line right — the surface's words, not the design system's. The composer
prints what it is handed and knows nothing about models or context windows.

## 10. Boundaries

- `apps/desktop/src/renderer` and `packages/ui/showcase` **must not name a color utility**.
  Enforced by `apps/desktop/test/design-tokens.test.ts`. Layout and spacing utilities are allowed:
  they are structure, not surface.
- **The navigator may not name a raw font size; the transcript may name exactly three.** In the
  sidebar, sizes come from the scale or they are drift — an arbitrary-value size class is how one
  row escapes the density scope. The transcript is the deliberate exception and its three voices are
  literal pixel pairs precisely BECAUSE they must not be re-pointable by a density scope (§5.2).
  Both halves are enforced by `apps/desktop/test/shell-density.test.tsx`, as two separate
  assertions; the scale's token VALUES are pinned in `packages/ui/test/density.test.ts`.
- `packages/ui` must not import from `apps/desktop`. The showcase carries its own fixtures.
- **`packages/ui` owns the transcript's presentation; `apps/desktop` owns ordering, search, and
  data.** The timeline, the tool rows and their folding, the three voices, the composer, the
  approval tray, the anchor gutter, the markdown block, and the pure logic under them (`gapAbove`,
  `segmentTurns`, `collapses`, `summarize`, `expansionFor`, anchor ids) are the design system's.
  The attention ordering engine, the search engine, the mock fixtures, Electron wiring, draft and
  decision state, and session selection are the app's.

  The seam is the product's **vocabulary**: `@openomni/ui` receives a resolved `StatusShape` and
  `StateTier`, never a run state, and every product word (`waiting for you`, `settled · N`, the
  composer's hint and meta line, the empty state's sentence) arrives as a prop. The one exception is
  the tool row's own status words (`running`, `waiting for approval`, `failed`, `denied`), which are
  the design system's because they are the rendering of a `ToolStatus` it already owns — the word
  and the mark beside it are one decision, and splitting them across the seam is how they drift.
- **One composition, rendered twice.** `Console` — chrome + a navigator SLOT + the transcript — is
  the whole screen, and both `apps/desktop/src/renderer/app.tsx` and the showcase's Shell tab
  render it. Neither may assemble a second one. The navigator is a slot because the tree renders
  the attention and search engines, whose every type names a session; the app passes a live tree
  and the showcase a fixture one. Enforced by `packages/ui/test/drift.test.ts`, which is the gate
  on a real defect: the Shell tab was once a hand-assembled copy and stayed green through an
  entire redesign of the surface it claimed to document.
- The showcase (`bun run --cwd packages/ui showcase`) renders every token and primitive in both
  themes: a left section index, the five principles as one-liners, then each token row as swatch +
  name + resolved value + **measured contrast against the floor it must clear**, then every
  primitive with its states labelled. A primitive reviewed only at rest is a primitive whose hover,
  press, focus, and disabled treatments were never looked at. A primitive that is not in the
  showcase is not reviewable, and therefore not done.
