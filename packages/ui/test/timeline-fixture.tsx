import type { TranscriptNode, TurnCost } from "../src/timeline/model";
import { costs as ledgerCosts, transcript } from "./fixture";

/**
 * Transcript fixtures for the timeline tests, keyed like a session store.
 *
 * These tests moved here with the components they pin: what a collapsed group
 * hides, how far apart two blocks sit, and what a row's address is are all
 * presentation law, so they belong to the package that now owns it. What they
 * needed from `apps/desktop` was never the app — it was a body of realistic
 * transcript DATA, which is exactly what a design system is allowed to keep as
 * a fixture.
 *
 * `kernel-ledger` is the shared transcript from `./fixture`, so every timeline
 * test pins the SAME input.
 */

/** A second session: two complete turns, forty minutes apart. */
const lease: readonly TranscriptNode[] = [
  {
    kind: "prompt",
    id: "lp1",
    text: "Check the lease contract in the docs and summarise it. I want to know where the generation value is incremented.",
  },
  {
    kind: "tool",
    id: "ltool1",
    tool: "read",
    target: "docs/kernel-contract.md",
    duration: "34ms",
  },
  {
    kind: "assistant",
    id: "la1",
    streaming: false,
    blocks: [
      { kind: "h2", text: "Lease contract" },
      {
        kind: "p",
        text: "The generation only advances when a lease is newly acquired. Per the contract the value is owned by the lease issuer rather than the store, and the write path only ever compares it.",
      },
      {
        kind: "bullets",
        items: [
          "generation is owned by the lease issuer, never by the store",
          "the write path compares, it never increments",
          "a fenced write reports the last generation it saw",
        ],
      },
    ],
  },
  // A second turn, so the 28px turn boundary has something to be measured
  // against the gaps inside a turn.
  {
    kind: "prompt",
    id: "lp2",
    text: "Then confirm the store never writes generation itself.",
  },
  {
    kind: "tool",
    id: "ltool2",
    tool: "grep",
    target: "generation =",
    duration: "88ms",
  },
  {
    kind: "assistant",
    id: "la2",
    streaming: false,
    blocks: [
      {
        kind: "p",
        text: "Confirmed. Nothing in the store path assigns generation; every reference is a comparison.",
      },
      {
        kind: "p",
        text: "That matches the contract: the issuer owns the value and the store is a reader of it.",
      },
    ],
  },
];

/**
 * The shared transcript, with its last answer left STREAMING.
 *
 * The caret assertions need a live turn and the rest need a settled one, so the
 * two fixtures here deliberately differ in exactly that.
 *
 * A trailing PROSE block is appended, because the caret rides the tail of the
 * last block and only prose and headings carry one — a blinking cursor welded
 * to the end of a bullet or inside a code fence would claim the list item or
 * the line is still being written, which is not what streaming means. The
 * shared transcript ends on bullets, so without this the streaming fixture
 * would render no caret and the assertion would be pinning the wrong thing.
 */
const ledger: readonly TranscriptNode[] = transcript.map((node) =>
  node.kind === "assistant"
    ? {
        ...node,
        streaming: true,
        blocks: [...node.blocks, { kind: "p" as const, text: "Re-running the cancelled test now" }],
      }
    : node,
);

export const timelines: Readonly<Record<string, readonly TranscriptNode[]>> = {
  "kernel-ledger": ledger,
  "kernel-lease": lease,
};

export const turnCosts: Readonly<Record<string, Readonly<Record<number, TurnCost>>>> = {
  "kernel-ledger": ledgerCosts,
  "kernel-lease": {
    1: { at: "09:18", elapsed: "41s" },
    2: { at: "09:58", elapsed: "6s" },
  },
};
