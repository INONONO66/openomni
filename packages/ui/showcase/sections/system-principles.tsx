import { Text } from "../../src";
import { Section } from "./section";

/**
 * The five rules the system is. One line each: a principle that needs a
 * paragraph is not a principle a reviewer can hold while reading a diff.
 */
const PRINCIPLES = [
  "Text and whitespace carry the design — no decoration, no gradients, no shadows.",
  "Hierarchy is typography: size, weight, spacing. Not lines, not boxes, not fills.",
  "One chromatic accent, spent on the live and the actionable. Everything else is achromatic.",
  "The default view is the result; process is collapsed behind at most two disclosures.",
  "Focus is protected — nothing auto-switches, animates for attention, or badges.",
] as const;

/** The five one-liners, at the top of the sheet: the rules before the parts. */
export function SystemPrinciples() {
  return (
    <Section
      id="principles"
      note="The contract is apps/desktop/DESIGN.md. These five are what it enforces."
      title="Principles"
    >
      <ul className="flex max-w-measure flex-col gap-inset">
        {PRINCIPLES.map((principle, index) => (
          <li className="flex gap-gutter" key={principle}>
            <Text className="shrink-0" level="meta" mono numeric tone="faint">
              {index + 1}
            </Text>
            <Text level="body" tone="muted">
              {principle}
            </Text>
          </li>
        ))}
      </ul>
    </Section>
  );
}
