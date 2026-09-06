import {
  AnchorGutter,
  Button,
  Disclosure,
  IconButton,
  Input,
  Panel,
  Row,
  Rule,
  State,
  Text,
} from "../../src";
import { Section, Spec } from "./section";
import { SystemCode } from "./system-code";

/**
 * The primitive half of the reference sheet.
 *
 * Every primitive appears with its STATES labelled, because a primitive
 * reviewed only at rest is a primitive whose hover, press, focus, and disabled
 * treatments were never looked at — and those are where a design system
 * actually leaks. The labels are the specimen's name, not decoration on it.
 */

export function SystemPrimitives() {
  return (
    <>
      <Section
        id="button"
        note="Three variants, two sizes. Only primary spends the accent; none of them draws a border. Hover, press, focus, and disabled are declared once per variant."
        title="Button"
      >
        <Spec detail="rest · hover · press" name="primary">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary">
              approve
            </Button>
            <Button size="md" variant="primary">
              approve
            </Button>
          </div>
        </Spec>
        <Spec detail="raised surface" name="secondary">
          <Button variant="secondary">deny</Button>
        </Spec>
        <Spec detail="no surface at rest" name="ghost">
          <Button variant="ghost">cancel</Button>
        </Spec>
        <Spec detail="40% opacity, no pointer" name="disabled">
          <div className="flex items-center gap-2">
            <Button disabled variant="primary">
              approve
            </Button>
            <Button disabled variant="secondary">
              deny
            </Button>
          </div>
        </Spec>
        <Spec detail="label required" name="icon">
          <div className="flex items-center gap-2">
            <IconButton label="New session" size="sm">
              <PlusGlyph />
            </IconButton>
            <IconButton label="Send" size="md">
              <ArrowGlyph />
            </IconButton>
          </div>
        </Spec>
      </Section>

      <Section
        id="state"
        note="A status word, not a dot. Exactly one tier is a claim about right now, and only that tier gets the accent. The primitive takes the LABEL from the surface — it owns the tonal rule, not the vocabulary."
        title="State"
      >
        {(
          [
            { label: "running", tier: "live" },
            { label: "waiting", tier: "attention" },
            { label: "interrupted", tier: "attention" },
            { label: "done", tier: "settled" },
          ] as const
        ).map((specimen) => (
          <Spec detail={specimen.tier} key={specimen.label} name={specimen.label}>
            <State label={specimen.label} tier={specimen.tier} />
          </Spec>
        ))}
      </Section>

      <Section
        id="row"
        note="Selection is a raised surface plus the only medium-weight text in the column. No marker bar. A selected row drops the hover surface it already occupies. `level` indents the row from OUTSIDE its own fill, so the highlight starts at the row's depth instead of the column's edge."
        title="Row"
      >
        <Spec detail="one line" name="rest / selected">
          <Panel className="w-tree px-inset" tone="sunken">
            <Row>ledger append path</Row>
            <Row current>lease generation guard</Row>
            <Row>alarm replay</Row>
            <Row disabled>archived · read-only</Row>
          </Panel>
        </Spec>
        <Spec detail="two lines" name="name + reason">
          <Panel className="w-tree px-inset" tone="sunken">
            <Row lines="two">
              <Text className="w-full truncate" level="label" tone="muted">
                router backpressure
              </Text>
              <Text className="w-full truncate" level="meta" tone="faint">
                waiting for you · 12m
              </Text>
            </Row>
            <Row current level={1} lines="two" chevronSlot>
              <Text className="w-full truncate" level="label" tone="fg">
                ledger append path
              </Text>
              <Text className="w-full truncate" level="meta" tone="accent">
                running
              </Text>
            </Row>
          </Panel>
        </Spec>
        {/* The point of the depth prop is what selection does at each level:
            three fills that start at three different x values. A fill spanning
            the full column at every level is what flattens a tree. */}
        <Spec detail="selected at each level" name="L0 / L1 / L2">
          <Panel className="w-tree px-inset" tone="sunken">
            <Row current chevronSlot>
              openomni-kernel
            </Row>
            <Row current level={1} chevronSlot>
              ledger append path
            </Row>
            <Row current level={2} chevronSlot>
              schema drift audit
            </Row>
          </Panel>
        </Spec>
      </Section>

      <Section
        id="disclosure"
        note="One rotating chevron in a fixed slot, an overline label, optional trailing metadata, and one rhythm step of air before the first row. The only grouping mechanism in the system. A nested group takes `level` and the quieter `faint` tone, so two caps labels in one column cannot read as peers."
        title="Disclosure"
      >
        <Spec detail="open · collapsed" name="project group">
          <Panel className="w-tree px-inset" tone="sunken">
            <Disclosure
              label="openomni-kernel"
              trailing={
                <Text level="micro" numeric tone="faint">
                  3
                </Text>
              }
            >
              <Row level={1} chevronSlot>
                ledger append path
              </Row>
              <Row level={1} chevronSlot>
                lease generation guard
              </Row>
            </Disclosure>
            <Disclosure defaultOpen={false} label="settled · 4" level={1} tone="faint">
              <Row level={2} chevronSlot>
                schema drift audit
              </Row>
            </Disclosure>
          </Panel>
        </Spec>
        {/* A closed group prints what it is hiding; an open one does not, since
            its rows are the count. */}
        <Spec detail="closed prints a count, open drops it" name="collapsed count">
          <Panel className="w-tree px-inset" tone="sunken">
            <Disclosure collapsedCount={3} defaultOpen={false} label="atlas-migration">
              <Row level={1} chevronSlot>
                cutover rehearsal
              </Row>
            </Disclosure>
            <Disclosure collapsedCount={3} label="atlas-migration">
              <Row level={1} chevronSlot>
                cutover rehearsal
              </Row>
            </Disclosure>
          </Panel>
        </Spec>
      </Section>

      <Section
        id="input"
        note="A quiet raised surface at rest — no icon, because an icon would be a second affordance for a fact the surface already gives. Focus draws the accent underline and nothing else."
        title="Input"
      >
        <Spec detail="rest" name="search field">
          <div className="w-tree">
            <Input label="Search sessions" placeholder="Search" type="search" />
          </div>
        </Spec>
        <Spec detail="value present" name="filled">
          <div className="w-tree">
            <Input defaultValue="ledger" label="Filter sessions" />
          </div>
        </Spec>
        <Spec detail="50% opacity, no pointer" name="disabled">
          <div className="w-tree">
            <Input disabled label="Disabled field" placeholder="Search" />
          </div>
        </Spec>
      </Section>

      <Section
        id="panel"
        note="Three tonal steps. An edge exists only where a column splits — a hairline, never a box."
        title="Panel"
      >
        <Spec detail="bg · sunken · raised" name="tones">
          <div className="flex">
            <Panel className="flex-1 px-gutter py-inset text-center" tone="sunken">
              <Text level="micro" mono tone="faint">
                sunken
              </Text>
            </Panel>
            <Panel className="flex-1 px-gutter py-inset text-center" tone="bg">
              <Text level="micro" mono tone="faint">
                bg
              </Text>
            </Panel>
            <Panel className="flex-1 px-gutter py-inset text-center" tone="raised">
              <Text level="micro" mono tone="faint">
                raised
              </Text>
            </Panel>
          </div>
        </Spec>
        <Spec detail="column split only" name="hairline">
          <div className="w-tree">
            <Rule />
          </div>
        </Spec>
      </Section>

      <Section
        id="anchor"
        note="A row's address, held at `opacity: 0` so revealing it shifts nothing. It is the same treatment a line of code gets, because a paragraph and a source line are the same kind of addressable thing. Hover the specimen row — the number is invisible at rest by design."
        title="AnchorGutter"
      >
        <Spec detail="hover to reveal" name="t3.7">
          {/* `group/anchored` is the hover scope the primitive reads. Without a
              scoped ancestor the number can never appear, which is exactly the
              state this specimen exists to let a reviewer check. */}
          <div className="group/anchored flex items-baseline gap-cell">
            <AnchorGutter anchor="t3.7" onCopy={() => undefined} row={7} />
            <Text level="meta" tone="muted">
              the paragraph this address points at
            </Text>
          </div>
        </Spec>
      </Section>

      <SystemCode />
    </>
  );
}

/**
 * The two glyphs the showcase needs to demonstrate `IconButton`, drawn inline
 * rather than pulled from an icon package: this system spends a glyph only
 * where it replaces a word that would not fit, and a whole icon set as a
 * dependency for two control demos is not that.
 */
function PlusGlyph() {
  return (
    // aria-hidden, not <title>: the IconButton wrapping this already carries the
    // accessible name, and a titled glyph inside it announces the label twice.
    <svg
      aria-hidden
      fill="none"
      role="presentation"
      height="14"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 14 14"
      width="14"
    >
      <path d="M7 2.5v9M2.5 7h9" strokeLinecap="round" />
    </svg>
  );
}

function ArrowGlyph() {
  return (
    <svg
      aria-hidden
      fill="none"
      role="presentation"
      height="14"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 14 14"
      width="14"
    >
      <path d="M7 11.5v-9M3 6.5 7 2.5l4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
