import { CodeFence, CodeToken } from "../../src";
import { Section, Spec } from "./section";

/**
 * One specimen per syntax tone, each highlighting only the fragment that tone
 * is responsible for so the difference is visible against plain context.
 */
const CODE_TONES = [
  { tone: "plain", before: "", token: "ledger", after: '.append("lsn", 1487)' },
  { tone: "keyword", before: "", token: "let", after: ' entry = ledger.append("lsn")' },
  { tone: "string", before: "ledger.append(", token: '"lsn"', after: ", 1487)" },
  { tone: "number", before: 'ledger.append("lsn", ', token: "1487", after: ")" },
  { tone: "comment", before: "", token: "// fenced generation", after: "" },
  { tone: "fn", before: "ledger.", token: "append", after: '("lsn", 1487)' },
  { tone: "punct", before: 'ledger.append("lsn", 1487', token: ");", after: "" },
] as const;

/**
 * The token each tone resolves to, not a restatement of its name.
 *
 * `string` and `number` sit one step below `plain` and are meant to be nearly
 * indistinguishable at this size: syntax here is not color-coded, so literals
 * recede by a single step rather than announcing themselves. Naming the token
 * is what makes that a decision on the page instead of a tone that looks broken.
 */
const CODE_TONE_NOTES: Record<(typeof CODE_TONES)[number]["tone"], string> = {
  plain: "fg-muted · identifiers",
  keyword: "fg + medium · weight, not color",
  string: "fg-subtle · one step below plain",
  number: "fg-subtle · one step below plain",
  comment: "fg-faint · the ambient tier",
  fn: "fg · weight, not color",
  punct: "fg-faint · recedes",
};

/** The fence, plus one specimen per syntax tone. */
export function SystemCode() {
  return (
    <Section
      id="code"
      note="A fence is one tonal step off the transcript column, no border. Syntax reads by tone and weight alone: the accent is reserved for live state, so a fence never becomes the loudest region on the surface."
      title="Code"
    >
      <Spec detail="raised, borderless" name="fence">
        <CodeFence lang="rust">
          <CodeToken tone="keyword">let</CodeToken>
          <CodeToken tone="plain"> lease = </CodeToken>
          <CodeToken tone="keyword">self</CodeToken>
          <CodeToken tone="plain">.lease.</CodeToken>
          <CodeToken tone="fn">acquire</CodeToken>
          <CodeToken tone="punct">().await?;</CodeToken>
        </CodeFence>
      </Spec>
      {/* Each row tones ONLY the fragment it names and leaves the rest plain.
          Toning the whole line per row made seven rows that looked alike and
          proved nothing — a tone is only visible next to the tone it differs
          from. */}
      {CODE_TONES.map(({ tone, before, token, after }) => (
        <Spec detail={CODE_TONE_NOTES[tone]} key={tone} name={tone}>
          <span className="font-mono text-meta">
            <CodeToken tone="plain">{before}</CodeToken>
            <CodeToken tone={tone}>{token}</CodeToken>
            <CodeToken tone="plain">{after}</CodeToken>
          </span>
        </Spec>
      ))}
    </Section>
  );
}
