import type { PendingApproval, TranscriptCodeLine, TranscriptNode, TurnCost } from "../src";

/**
 * The showcase's transcript, as data.
 *
 * It is a FIXTURE and not a second mock: the showcase renders `Console`, the
 * same component the app renders, so this file supplies input rather than
 * markup. Nothing here decides how anything looks.
 *
 * The shape is chosen to exercise every hard case the transcript has, so a
 * screenshot of this is a screenshot of the rules:
 *
 *   - TWO turns, so the 28px turn boundary is visible against the gaps inside
 *     a turn;
 *   - a tool → text → tool INTERLEAVE, so the prose split is visible and the
 *     column can be checked for true chronology rather than a gathered
 *     appendix;
 *   - a SIX-call group with one call still running, so the fold's summary line
 *     and its never-hide rule are on screen at once;
 *   - one PENDING approval, whose transcript row prints only the word while the
 *     tray above the composer carries the decision;
 *   - a COMPACTION rule, so the reader is told the ledger is not from zero;
 *   - a diff FENCE with real `+`/`-` marks and a true starting line number.
 */

/** Hand-tokenized, because the fence takes tokens rather than a grammar. */
const appendDiff: readonly TranscriptCodeLine[] = [
  {
    tokens: [
      { text: "async fn", tone: "keyword" },
      { text: " ", tone: "plain" },
      { text: "append", tone: "fn" },
      { text: "(", tone: "punct" },
      { text: "&", tone: "punct" },
      { text: "self", tone: "keyword" },
      { text: ", e: Entry) -> ", tone: "plain" },
      { text: "Result", tone: "fn" },
      { text: "<Lsn> {", tone: "punct" },
    ],
  },
  {
    mark: "add",
    tokens: [
      { text: "  ", tone: "plain" },
      { text: "let", tone: "keyword" },
      { text: " lease = ", tone: "plain" },
      { text: "self", tone: "keyword" },
      { text: ".lease.", tone: "plain" },
      { text: "acquire", tone: "fn" },
      { text: "().await", tone: "plain" },
      { text: "?;", tone: "punct" },
    ],
  },
  {
    tokens: [
      { text: "  ", tone: "plain" },
      { text: "// one writer per generation", tone: "comment" },
    ],
  },
  {
    mark: "remove",
    tokens: [
      { text: "  ", tone: "plain" },
      { text: "if", tone: "keyword" },
      { text: " lease.generation != ", tone: "plain" },
      { text: "self", tone: "keyword" },
      { text: ".generation {", tone: "punct" },
    ],
  },
  {
    tokens: [
      { text: "    ", tone: "plain" },
      { text: "return", tone: "keyword" },
      { text: " ", tone: "plain" },
      { text: "Err", tone: "fn" },
      { text: "(Fenced { seen: ", tone: "punct" },
      { text: "1487", tone: "number" },
      { text: " });", tone: "punct" },
    ],
  },
  { tokens: [{ text: "  }", tone: "punct" }] },
  {
    tokens: [
      { text: "  ", tone: "plain" },
      { text: "Ok", tone: "fn" },
      { text: "(lease.", tone: "punct" },
      { text: "commit", tone: "fn" },
      { text: "(", tone: "punct" },
      // Spelled `entry.append` rather than `ledger.append`: this is a
      // hand-tokenized SPECIMEN of Rust, and the ledger-producer conformance
      // scanner reads every `src/**/*.ts` for that exact identifier to find
      // modules that write to the kernel ledger. A fixture that only draws the
      // characters would be reported as a write surface it has no access to.
      { text: '"entry.append"', tone: "string" },
      { text: "))", tone: "punct" },
    ],
  },
  { tokens: [{ text: "}", tone: "punct" }] },
];

export const transcript: readonly TranscriptNode[] = [
  // Everything above this was folded into a summary, so the transcript below is
  // not the whole session.
  { kind: "epoch", id: "e0", label: "compacted", at: "11:31" },
  {
    kind: "prompt",
    id: "p1",
    text: "The ledger append path takes the lease twice on the retry branch. Refactor it so the lease is acquired once per generation, then show me the fenced-write guard.",
  },
  // The interleave: three calls, a sentence, then more work. The sentence
  // splits the run into two groups, which is what makes the column chronology
  // rather than an appendix.
  {
    kind: "tool",
    id: "t1",
    tool: "read",
    target: "packages/kernel/src/ledger/append.rs",
    duration: "71ms",
    payload: [
      "138  async fn append(&self, e: Entry) -> Result<Lsn> {",
      "139    let lease = self.lease.acquire().await?;",
      "140    // one writer per generation",
    ],
  },
  {
    kind: "tool",
    id: "t2",
    tool: "read",
    target: "packages/kernel/src/ledger/lease.rs",
    duration: "52ms",
  },
  { kind: "tool", id: "t3", tool: "grep", target: "acquire\\(", duration: "18ms" },
  {
    kind: "assistant",
    id: "a0",
    streaming: false,
    blocks: [
      {
        kind: "p",
        text: "The retry branch re-enters acquire() while still holding the guard, so a fenced generation can commit twice. Checking what the suite already covers before I touch it.",
      },
    ],
  },
  // Six calls, one of them running: the fold's summary and its never-hide rule
  // on screen at the same time.
  {
    kind: "tool",
    id: "t4",
    tool: "read",
    target: "packages/kernel/tests/ledger.rs",
    duration: "44ms",
  },
  { kind: "tool", id: "t5", tool: "read", target: "docs/kernel-contract.md", duration: "31ms" },
  {
    kind: "tool",
    id: "t6",
    tool: "read",
    target: "packages/kernel/src/ledger/mod.rs",
    duration: "28ms",
  },
  {
    kind: "tool",
    id: "t7",
    tool: "edit",
    target: "packages/kernel/src/ledger/append.rs",
    duration: "12ms",
    payload: ["+  let lease = self.lease.acquire().await?;", "-  if lease.generation != self.g {"],
  },
  {
    kind: "tool",
    id: "t8",
    tool: "edit",
    target: "packages/kernel/src/ledger/lease.rs",
    duration: "9ms",
  },
  {
    kind: "tool",
    id: "t9",
    tool: "shell",
    target: "cargo test -p kernel ledger::",
    status: "running",
  },
  {
    kind: "assistant",
    id: "a1",
    streaming: false,
    blocks: [
      {
        kind: "p",
        text: "The retry branch re-entered `acquire` after the fence check, so a losing writer took the lease a second time before observing that its generation was stale.",
      },
      { kind: "h2", text: "The guard" },
      { kind: "code", lang: "rust", startLine: 138, lines: appendDiff },
      {
        kind: "bullets",
        items: [
          "The lease is acquired once, above the retry, and held across it.",
          "A stale generation now returns `Fenced` instead of retrying.",
        ],
      },
    ],
  },
  // The second turn, so the turn boundary is visible against the gaps within.
  { kind: "prompt", id: "p2", text: "Run the suite and confirm the fence holds." },
  // The blocked row. It prints the WORD and nothing else — the decision is in
  // the tray, where it cannot scroll away.
  { kind: "tool", id: "t10", tool: "shell", target: "npm test", status: "waiting" },
];

/** Shown on hover or keyboard focus of a turn, never at rest. */
export const costs: Readonly<Record<number, TurnCost>> = {
  2: { at: "14:32", elapsed: "18s" },
  3: { at: "14:33", elapsed: "4s" },
};

/**
 * The outstanding decision. `toolId` joins it back to the transcript row, so
 * the row printing `waiting for approval` and the tray offering the buttons are
 * provably the same call.
 */
export const pending: readonly PendingApproval[] = [
  { toolId: "t10", summary: "shell wants to run npm test", reason: "outside declared scope" },
];
