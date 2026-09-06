import { Button, Caret, Input, Panel, State, Text } from "../../src";
import { Section, Spec } from "./section";
import { Swatch } from "./swatch";

/**
 * The token half of the reference sheet: surfaces, the ramp, the accent budget,
 * and the type system — each row carrying the value the browser resolved and,
 * where a tone lands on a surface, the contrast it measured against the floor
 * it has to clear.
 */

/** The three surfaces plus the hairline, measured against the window. */
const SURFACES = ["--color-bg", "--color-sunken", "--color-raised", "--color-line"] as const;

/**
 * Text tones with the surfaces they actually appear on and their WCAG floor.
 * `faint` is the ambient tier — timestamps, durations, reason lines — so it
 * takes 3:1; everything that carries meaning takes 4.5:1.
 */
const TEXT_TONES = [
  { token: "--color-fg", floor: 4.5 },
  { token: "--color-fg-muted", floor: 4.5 },
  { token: "--color-fg-subtle", floor: 4.5 },
  { token: "--color-fg-faint", floor: 3 },
] as const;

const MEASURED_AGAINST = ["--color-bg", "--color-sunken", "--color-raised"] as const;

const RAMP = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] as const;

const LEVELS = [
  { level: "display", role: "the one thing a view is about" },
  { level: "title", role: "a section that owns a region" },
  { level: "heading", role: "a heading inside prose" },
  { level: "body", role: "prose" },
  { level: "label", role: "a row's own name" },
  { level: "meta", role: "second lines" },
  { level: "micro", role: "timestamps, durations" },
  { level: "overline", role: "group headers" },
] as const;

export function SystemTokens() {
  return (
    <>
      <Section
        id="surfaces"
        note="Four quiet steps: the window, a recessed region, an elevated one, and the single hairline — each within 1.4:1 of the window, enough to separate a region but not to read as a filled box. Dark shares one step between `raised` and `line`, which is why both measure the same here; light must split them, because a fill and a border on one step is what makes a selected row look outlined."
        title="Surfaces"
      >
        {/* No floor here: the number is an elevation delta, and a surface has
            no floor to clear — it has a ceiling not to cross. Past ~1.4:1 a
            step stops reading as elevation and starts reading as a filled box,
            which is asserted in test/tokens.test.ts. */}
        {SURFACES.map((token) => (
          <Swatch against="--color-bg" key={token} token={token} />
        ))}
      </Section>

      <Section
        id="text"
        note="Four tones of quiet. Every tone is measured on every surface it can land on — the window, the sidebar, and a selected row — because a tone that clears the floor on the window but not on the row fails exactly where the Owner is looking."
        title="Text tone"
      >
        {TEXT_TONES.map(({ token, floor }) => (
          <div className="flex flex-col" key={token}>
            {MEASURED_AGAINST.map((surface) => (
              <Swatch against={surface} floor={floor} key={surface} token={token} />
            ))}
          </div>
        ))}
      </Section>

      <Section
        id="ramp"
        note="Achromatic, zero chroma at every step, monotone in oklch. Dark and light re-point the semantic layer onto this same ramp, and no step is spare: a test fails if one stops being claimed."
        title="Neutral ramp"
      >
        <div className="grid grid-cols-1 gap-x-section lg:grid-cols-2">
          {RAMP.map((step) => (
            <Swatch key={step} token={`--color-neutral-${step}`} />
          ))}
        </div>
      </Section>

      <Section
        id="accent"
        note="One chromatic value, spent on three things and nothing else. As text it clears 4.5:1 on all three surfaces; as a fill, its own foreground clears 4.5:1 on it. Light is #007AFF darkened in oklch to 53% — at 60.3% `running` read 3.6:1 on a selected row."
        title="The accent budget"
      >
        <Swatch against="--color-bg" floor={4.5} token="--color-accent" />
        <Swatch against="--color-raised" floor={4.5} token="--color-accent" />
        <Swatch against="--color-accent" floor={4.5} token="--color-accent-fg" />
        <Spec detail="1 · live state" name="running session">
          <State label="running" tier="live" />
        </Spec>
        <Spec detail="2 · commit action" name="primary action">
          <Button size="sm" variant="primary">
            approve
          </Button>
        </Spec>
        <Spec detail="3 · focus" name="focus underline">
          {/* Held to the sidebar width rather than the specimen column: a field
              stretched across a page reads as a bar, not a field. */}
          <div className="w-tree">
            <Input label="Accent underline demo" placeholder="focus me" />
          </div>
        </Spec>
      </Section>

      <Section
        id="type"
        note="Hierarchy is size, weight, and spacing. Weight stops at 590 — past it Pretendard adds noise, not rank — and there is no 700 anywhere in the system."
        title="Type scale"
      >
        {LEVELS.map(({ level, role }) => (
          <Spec detail={role} key={level} name={level}>
            <Text level={level} tone="fg">
              Attention is the scarce resource
            </Text>
          </Spec>
        ))}
      </Section>

      <Section
        id="numeric"
        note="Machine truth uses the mono family; anything numeric uses tabular figures, so a column of digits stops jittering as it updates."
        title="Numeric and mono"
      >
        <Spec detail="tabular-nums" name="numeric">
          <Text level="body" numeric tone="muted">
            1487 · 0.982 · 71ms
          </Text>
        </Spec>
        <Spec detail="JetBrains Mono" name="mono">
          <Text level="meta" mono tone="muted">
            fs.write packages/kernel/src/ledger/append.rs
          </Text>
        </Spec>
        <Spec detail="only while streaming" name="streaming caret">
          <Text level="body" tone="muted">
            still writing
            <Caret />
          </Text>
        </Spec>
      </Section>

      <Section
        id="space"
        note="One 8px baseline. Every vertical step is a multiple of it, so rows, headers, and timeline blocks land on one grid instead of three."
        title="Space"
      >
        {(
          [
            ["--spacing-inset", "8", "w-inset"],
            ["--spacing-gutter", "16", "w-gutter"],
            ["--spacing-section", "24", "w-section"],
            ["--spacing-row", "32", "w-row"],
            ["--spacing-titlebar", "56", "w-titlebar"],
          ] as const
        ).map(([token, value, width]) => (
          <Spec detail={`${value}px`} key={token} name={token}>
            <Panel className={`h-1 ${width}`} tone="raised" />
          </Spec>
        ))}
      </Section>
    </>
  );
}
