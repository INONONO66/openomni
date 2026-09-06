import { useState } from "react";
import {
  BLOCK_GAP,
  Composer,
  PAIR_GAP,
  PARAGRAPH_GAP,
  TURN_GAP,
  Text,
  Timeline,
  Voice,
} from "../../src";
import type { PendingApproval, TranscriptNode, TurnCost } from "../../src";
import { Section, Spec } from "./section";

/**
 * The transcript law, as specimens.
 *
 * These sections replaced the TUI-pattern and glyph-grammar sections, and the
 * replacement is the point: those documented a vocabulary of drawn characters —
 * spines, connectors, boxes, status columns — that the transcript no longer
 * has. Keeping a reference sheet for a deleted grammar is how a system grows a
 * second one.
 */
export function SystemTranscript() {
  return (
    <>
      <Voices />
      <Rhythm />
      <TranscriptSpecimen />
      <ComposerSpecimen />
    </>
  );
}

/**
 * Three voices, and there is no fourth.
 *
 * They are shown at the same measure and in reading order, because the claim is
 * about the RELATIONSHIP between them: prose is the largest because it is what
 * the reader came for, code is one step down because it is quoted material, and
 * meta is small and dimmed so a block of receipts recedes as one texture.
 */
function Voices() {
  return (
    <Section
      id="voices"
      note="The transcript sets three sizes and no others. Every additional size dilutes the one signal telling a reader which kind of material they are looking at."
      title="Three voices"
    >
      <Spec detail="14/21 sans" name="prose">
        <Voice voice="prose">The retry branch re-entered acquire after the fence check.</Voice>
      </Spec>
      <Spec detail="13/20 mono" name="code">
        <Voice voice="code">let lease = self.lease.acquire().await?;</Voice>
      </Spec>
      <Spec detail="12/18 mono · 70%" name="meta">
        <Voice voice="meta">read packages/kernel/src/ledger/append.rs · 71ms</Voice>
      </Spec>
    </Section>
  );
}

/**
 * The four gaps, drawn to scale.
 *
 * A number in a doc is not checkable by eye; a stack of bars at the real
 * heights is. The ratios are what matter — the turn step has to beat the pair
 * step by enough that a boundary is found without reading, and the paragraph
 * step has to sit under the block step so paragraphs read as continuous.
 *
 * The heights are the CONSTANTS, not copies of them. A specimen that spelled its
 * own numbers would keep drawing 28px bars under a law that had moved to 40 — a
 * reference sheet disagreeing with the surface it documents, which is worse than
 * no reference sheet at all.
 */
function Rhythm() {
  const steps = [
    { name: "turn", px: TURN_GAP, note: "between turns" },
    { name: "pair", px: PAIR_GAP, note: "user to response" },
    { name: "block", px: BLOCK_GAP, note: "prose beside tools" },
    { name: "paragraph", px: PARAGRAPH_GAP, note: "between paragraphs" },
  ] as const;

  return (
    <Section
      id="rhythm"
      note="Whitespace is the only grouping mechanism in the column: no rules, no boxes, no backgrounds. These four steps are the entire structure."
      title="Turn rhythm"
    >
      {steps.map((step) => (
        <Spec detail={`${step.px}px`} key={step.name} name={step.name}>
          {/* The bar is the specimen: it is the gap itself, at its real height,
              so the ratios can be checked by eye rather than by arithmetic. The
              tone comes from `Text` rather than a color utility, because the
              showcase is a CONSUMER of this system and naming a token here would
              fork it exactly the way a renderer component would. */}
          <div className="flex items-center gap-gutter">
            <Text
              aria-hidden
              className="block w-16"
              style={{ height: `${step.px}px` }}
              tone="faint"
            >
              <span className="block h-full w-full bg-current opacity-30" />
            </Text>
            <Voice voice="meta">{step.note}</Voice>
          </div>
        </Spec>
      ))}
    </Section>
  );
}

/**
 * A miniature transcript: the interleave, the fold, the blocked row, and the
 * turn boundary.
 *
 * TWO turns, deliberately, and they differ in exactly one thing: the first is
 * still running and the second has closed. That pairing is what makes the
 * specimen document §8 — a closed turn ends on its `14:07 · 2m 14s`, and a live
 * one prints no time at all, because there is no elapsed to report until there
 * is a response to have elapsed against. A single running turn showed neither,
 * which left the reference sheet silent about the one line the law now requires.
 *
 * It is also what puts the 40px boundary on this page at true scale, beside the
 * bar that claims it.
 */
const SPECIMEN: readonly TranscriptNode[] = [
  { kind: "prompt", id: "sp", text: "Refactor the append path so the lease is taken once." },
  {
    kind: "tool",
    id: "s1",
    tool: "read",
    target: "src/ledger/append.rs",
    duration: "71ms",
    payload: ["138  async fn append(&self, e: Entry) -> Result<Lsn> {"],
  },
  { kind: "tool", id: "s2", tool: "grep", target: "acquire\\(", duration: "18ms" },
  {
    kind: "assistant",
    id: "sa0",
    streaming: false,
    blocks: [{ kind: "p", text: "The retry branch re-enters acquire while holding the guard." }],
  },
  { kind: "tool", id: "s3", tool: "read", target: "tests/ledger.rs", duration: "44ms" },
  { kind: "tool", id: "s4", tool: "read", target: "docs/contract.md", duration: "31ms" },
  { kind: "tool", id: "s5", tool: "edit", target: "src/ledger/append.rs", duration: "12ms" },
  { kind: "tool", id: "s6", tool: "shell", target: "cargo test", status: "running" },
  {
    kind: "assistant",
    id: "sa1",
    streaming: false,
    blocks: [
      { kind: "p", text: "The lease is acquired once, above the retry, and held across it." },
    ],
  },
  { kind: "prompt", id: "sp2", text: "Good. Ship it once the suite is green." },
  { kind: "tool", id: "s8", tool: "shell", target: "cargo test", duration: "2.4s" },
  {
    kind: "assistant",
    id: "sa2",
    streaming: false,
    blocks: [{ kind: "p", text: "Suite is green. The fence holds on both paths." }],
  },
];

/**
 * The specimen's clock readings, and only for the turn that has one.
 *
 * Turn 1 is deliberately absent: its `cargo test` is still `running`, so an
 * elapsed printed under it would be the surface claiming a finish that has not
 * happened. The gap in this record is the rule.
 */
const SPECIMEN_COSTS: Readonly<Record<number, TurnCost>> = {
  2: { at: "14:07", elapsed: "2.4s" },
};

function TranscriptSpecimen() {
  return (
    <Section
      id="transcript"
      note="One centered column. The user's message is right-aligned and the agent's is not — that single asymmetry tells two speakers apart with no label, no avatar, no fill and no border. A closed turn ends on its time; the running one above it has none to report yet."
      title="Transcript"
    >
      <div className="max-w-measure" data-density="shell">
        <Timeline
          costs={SPECIMEN_COSTS}
          emptyLabel="Nothing here."
          nodes={SPECIMEN}
          sessionId="specimen"
        />
      </div>
    </Section>
  );
}

const PENDING: readonly PendingApproval[] = [
  { toolId: "s7", summary: "shell wants to run npm test", reason: "outside declared scope" },
];

/**
 * The composer, with the tray docked above it.
 *
 * They are one specimen because they are one surface: the tray exists where it
 * does precisely so that the decision sits where the Owner's hands already are.
 * Showing it separately would document the arrangement the transcript rejected.
 */
function ComposerSpecimen() {
  const [draft, setDraft] = useState("");
  const [decided, setDecided] = useState(false);

  return (
    <Section
      id="composer"
      note="Enter sends, Shift+Enter breaks a line, ⌘↩ approves and ⌘⌫ denies. Approve is the only accent-filled control on the screen — if exactly one thing is chromatic, it should be the thing blocking work."
      title="Composer and approval tray"
    >
      <div data-density="shell">
        <Composer
          hint="claude-sonnet-4-6"
          meta="39.8k · 2 turns"
          onApprove={() => setDecided(true)}
          onDeny={() => setDecided(true)}
          onSubmit={() => setDraft("")}
          onValueChange={setDraft}
          pending={decided ? [] : PENDING}
          value={draft}
        />
      </div>
      {/* The same composer with a turn in flight, because the primary action is
          not the same control in both states and the swap is the thing worth
          reviewing: the field is locked, send would be dead, and the slot is
          holding Stop instead. This is also the only place `Composer.Stop` can
          be looked at — the Shell tab's console is idle by construction. */}
      <div className="pt-section" data-density="shell">
        <Text className="px-section pb-2" level="micro" mono tone="subtle">
          sending, with a stop handler
        </Text>
        <Composer
          hint="claude-sonnet-4-6"
          meta="streaming"
          onStop={() => undefined}
          onSubmit={() => undefined}
          onValueChange={() => undefined}
          sending
          value=""
        />
      </div>
    </Section>
  );
}
