import { Input as BaseInput } from "@base-ui/react/input";
import { Plus } from "lucide-react";
import { type Ref, useId } from "react";
import { UI_NAMES } from "./names";
import { IconButton } from "./primitives/button";
import { Text } from "./primitives/surface";

/**
 * Custom window chrome. The native title bar is hidden (Electron
 * `titleBarStyle: "hiddenInset"`), so these rows are the drag surfaces:
 * `SidebarHeader` sits beside the inset traffic lights, `MainHeader` tops the
 * timeline column. Interactive children opt out of dragging via `no-drag`.
 *
 * Chrome declares no color of its own — it composes @openomni/ui primitives and
 * contributes frame geometry only. There is no status bar and no badge chrome:
 * counts belong to the rows that own them, not to the frame (protect focus).
 */

export function SidebarHeader({
  createLabel,
  onCreate,
}: {
  /**
   * The accessible name of the create action. The frame owns the BUTTON — its
   * position beside the traffic lights, its size, its drag opt-out — and the
   * surface owns what creating means, because "session" is the app's word.
   */
  readonly createLabel: string;
  readonly onCreate?: (() => void) | undefined;
}) {
  return (
    <div
      className="drag-region flex h-titlebar shrink-0 items-center justify-end px-inset"
      data-ui={UI_NAMES.SidebarHeader}
    >
      <IconButton className="no-drag" label={createLabel} onClick={onCreate} size="sm">
        <Plus className="size-4" strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}

/**
 * The sidebar's one control. Search is the only feature that earns permanent
 * chrome here, because it is how a keyboard-first operator navigates; everything
 * else is reachable from the menu (Moroly: "기능은 숨어있다").
 *
 * It is a LINE, not a box. A filled rectangle at the top of the column is the
 * loudest thing in a surface whose entire hierarchy is quiet type on quiet
 * whitespace, and it spends that volume announcing a control the operator
 * reaches by keyboard anyway. So: no fill, no border, no glyph — the word
 * `Search` in the ambient tone with its shortcut right-aligned beside it, and a
 * hairline that appears only while the field is actually taking input.
 *
 * The shortcut is the affordance. `⌘K` says "this is reached by keyboard"
 * more precisely than any surface or magnifier could, and it is the same fact a
 * raised fill was previously spending a tonal step to imply. Once a query is
 * live the hint switches to `esc`, because at that point the operator's next
 * question is how to get OUT, not how to get in.
 *
 * It sits on one row height and hangs on the L0 text x — the same left edge as
 * a project header — so the column has one left edge above the tree instead of
 * a second one introduced by its own control.
 *
 * The primitive is HEADLESS-BACKED and data-blind: it owns the line, the
 * shortcut hint, the result count, and the combobox wiring, and it knows nothing
 * about what is being searched. The query, the filtering, and the keyboard
 * semantics belong to the surface that has the data.
 */
export function SearchLine({
  label,
  value,
  onValueChange,
  onKeyDown,
  inputRef,
  controlsId,
  activeDescendantId,
  resultLabel,
}: {
  /**
   * The field's accessible name. Supplied by the surface, because naming what
   * is being searched is the one thing this line must not know — it owns the
   * geometry, the hint, and the combobox wiring, and nothing about the data.
   */
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** The consumer focuses the field imperatively — ⌘K is a document-level fact. */
  readonly inputRef: Ref<HTMLInputElement>;
  /** The element this field filters, for `aria-controls`. */
  readonly controlsId: string;
  /** The active result's element id, or undefined when the field owns the caret. */
  readonly activeDescendantId?: string | undefined;
  /**
   * A count line under the field, e.g. `4 results` — or the zero-result
   * sentence. Rendered only when present: an always-on count is chrome that
   * spends a row saying nothing while the field is at rest.
   */
  readonly resultLabel?: string | undefined;
}) {
  const controlId = useId();
  const active = value.length > 0;

  return (
    <div className="px-inset pb-section" data-ui={UI_NAMES.SearchLine}>
      {/* The underline is on the WRAPPER and transparent at rest, so focus
          changes a color rather than adding a box — nothing reflows, and the
          hairline lands under the whole line instead of under the glyph run. */}
      <label
        className="flex h-row items-center gap-2 border-b border-b-transparent px-row-inset ps-[calc(var(--spacing-row-inset)+var(--spacing-indent-slot))] transition-quiet focus-within:border-b-line"
        htmlFor={controlId}
      >
        <span className="sr-only">{label}</span>
        <BaseInput
          aria-activedescendant={activeDescendantId}
          aria-autocomplete="list"
          aria-controls={controlsId}
          aria-expanded={active}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-fg text-label caret-fg outline-none selection:bg-accent selection:text-accent-fg placeholder:text-fg-faint"
          id={controlId}
          onKeyDown={onKeyDown}
          onValueChange={onValueChange}
          placeholder="Search"
          ref={inputRef}
          role="combobox"
          // `type="search"` would add the platform's own clear affordance —
          // a second control for what Esc already does, drawn by the OS in a
          // style this system does not own.
          type="text"
          value={value}
        />
        {/* The hint is not a button: pressing it is not how it is used, and a
            second focus stop in front of the field would cost the keyboard
            operator a tab for nothing. It reports the NEXT key, so it swaps to
            `esc` the moment there is a query to escape from. */}
        <Text aria-hidden className="shrink-0" level="micro" mono numeric tone="faint">
          {active ? "esc" : "⌘K"}
        </Text>
      </label>
      {/* The count replaces nothing and adds no chrome of its own: one ambient
          line, on the field's own text x, present only while filtering. */}
      {resultLabel !== undefined && (
        <Text
          aria-live="polite"
          className="block ps-[calc(var(--spacing-row-inset)*2+var(--spacing-indent-slot))] pt-inset"
          level="micro"
          numeric
          tone="faint"
        >
          {resultLabel}
        </Text>
      )}
    </div>
  );
}

/**
 * The main column's header: a title, then one qualifying fact in the muted
 * ramp. Two strings, set in type — no icons, no chips, no toggles.
 *
 * The props are `title`/`detail` rather than `session`/`agent` because this
 * module is the window frame: it owns the drag region, the titlebar height, and
 * the shared measure, and it must not know that the thing being titled is a
 * session or that the fact beside it is a model name. The surface supplies
 * both, so the frame stays reusable for any titled column.
 */
export function MainHeader({
  title,
  detail,
}: {
  readonly title: string;
  /** Set mono: it is machine truth about the titled thing, not prose. */
  readonly detail: string;
}) {
  return (
    <header className="drag-region flex h-titlebar shrink-0 items-center" data-ui={UI_NAMES.MainHeader}>
      {/* The header text hangs on the SAME measure as the content beneath it,
          so the title and the first line of prose share one left edge. A header
          pinned to the window's own gutter while the content is centered puts
          two different left edges in one column. */}
      <div className="mx-auto flex w-full max-w-measure items-baseline gap-2 px-section">
        {/* Sans, and MEDIUM rather than the title level's own 590. A session
            title is a name someone wrote, not machine truth, so it takes the
            prose face — and beside a mono model id at the same baseline, 590
            made the header read as a headline over a page instead of a label on
            a column. 500 is the weight that says "this is the thing you are
            looking at" without announcing it. */}
        <Text className="truncate font-medium" level="title" sans tone="fg">
          {title}
        </Text>
        <Text className="shrink-0" level="meta" mono tone="faint">
          {detail}
        </Text>
      </div>
    </header>
  );
}
