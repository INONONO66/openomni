import { type SectionRef, SectionNav } from "./section";
import { SystemPrinciples } from "./system-principles";
import { SystemPrimitives } from "./system-primitives";
import { SystemTokens } from "./system-tokens";
import { SystemTranscript } from "./system-transcript";

/**
 * The reference sheet: every token and every primitive, one page, both themes.
 *
 * A left index and a single scrolling content column — the same two-column
 * grammar the product uses, for the same reason: a page this long is jumped
 * into, not read down. This list is in DOM order and is the only declaration of
 * it, so the nav and the content cannot disagree about what exists or where.
 */
const SECTIONS: readonly SectionRef[] = [
  { id: "principles", title: "Principles" },
  { id: "surfaces", title: "Surfaces" },
  { id: "text", title: "Text tone" },
  { id: "ramp", title: "Neutral ramp" },
  { id: "accent", title: "The accent budget" },
  { id: "type", title: "Type scale" },
  { id: "numeric", title: "Numeric and mono" },
  { id: "space", title: "Space" },
  { id: "button", title: "Button" },
  { id: "state", title: "State" },
  { id: "row", title: "Row" },
  { id: "disclosure", title: "Disclosure" },
  { id: "input", title: "Input" },
  { id: "panel", title: "Panel" },
  { id: "anchor", title: "AnchorGutter" },
  { id: "code", title: "Code" },
  /* The transcript law. It replaced the glyph-grammar and TUI-pattern sections
     rather than joining them: those documented a vocabulary of drawn spines,
     connectors and status columns that the transcript no longer has, and a
     reference sheet for a deleted grammar is how a system grows a second one. */
  { id: "voices", title: "Three voices" },
  { id: "rhythm", title: "Turn rhythm" },
  { id: "transcript", title: "Transcript" },
  { id: "composer", title: "Composer" },
];

export function SystemView() {
  return (
    <div className="flex items-start">
      <SectionNav sections={SECTIONS} />
      {/* The rhythm here is looser than the product's: a reference sheet is
          scanned for a heading, and headings spaced like rows stop being
          findable. Two `section` steps is that looser step. */}
      <main className="flex min-w-0 flex-1 flex-col gap-[calc(var(--spacing-section)*2)] px-section py-section">
        <SystemPrinciples />
        <SystemTokens />
        <SystemPrimitives />
        <SystemTranscript />
      </main>
    </div>
  );
}
