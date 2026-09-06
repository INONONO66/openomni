import type { ReactNode } from "react";
import { Panel, Row, Text } from "../../src";

/**
 * A documentation section: overline label, an optional one-line note, then the
 * specimens. No card, no border — the same rule the product surface follows, so
 * the showcase cannot demonstrate a structure the system forbids.
 *
 * The vertical rhythm here is deliberately looser than the product's: a
 * reference sheet is read by scanning for a heading, and headings that sit as
 * close together as rows do stop being findable.
 */
export function Section({
  id,
  title,
  note,
  children,
}: {
  /** Anchor for the left nav. */
  readonly id: string;
  readonly title: string;
  readonly note?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex scroll-mt-titlebar flex-col gap-gutter" id={id}>
      <div className="flex flex-col gap-1">
        <Text level="overline" tone="subtle">
          {title}
        </Text>
        {note && (
          <Text as="p" className="max-w-measure" level="meta" tone="faint">
            {note}
          </Text>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * A labelled specimen row: what it is on the left, the live thing on the right.
 * The token or state name is mono because it is machine truth about the
 * specimen; the specimen itself is not.
 */
export function Spec({
  name,
  detail,
  children,
}: {
  readonly name: string;
  readonly detail?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-row items-center gap-gutter">
      <Text className="w-44 shrink-0 truncate" level="micro" mono tone="subtle">
        {name}
      </Text>
      {detail && (
        <Text className="w-48 shrink-0 truncate" level="micro" mono numeric tone="faint">
          {detail}
        </Text>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The left section nav.
 *
 * A reference sheet this long is not read top to bottom, it is jumped into — so
 * the sections get an index. It is `Row`s on a sunken column, the same
 * primitive the product's navigator uses, because that is what this column is:
 * a list of places to navigate to. No scroll-spy and no active highlight — a
 * highlight that tracks the scroll position is motion the reader did not ask
 * for, and the browser's own focus ring already says where the keyboard is.
 *
 * Hidden below `lg`, not `md`: at 768 the index would leave a 456px content
 * column, narrower than the token rows it exists to index. An index that
 * squeezes the thing it points at is worse than no index.
 */
export function SectionNav({ sections }: { readonly sections: readonly SectionRef[] }) {
  return (
    <Panel
      aria-label="Sections"
      as="nav"
      className="sticky top-titlebar hidden h-[calc(100vh-var(--spacing-titlebar))] w-tree shrink-0 flex-col overflow-y-auto px-inset py-section lg:flex"
      edge="right"
      tone="sunken"
    >
      {sections.map((section) => (
        <Row key={section.id} onClick={() => document.getElementById(section.id)?.scrollIntoView()}>
          <Text className="min-w-0 flex-1 truncate" level="meta" tone="muted">
            {section.title}
          </Text>
        </Row>
      ))}
    </Panel>
  );
}

export interface SectionRef {
  readonly id: string;
  readonly title: string;
}
