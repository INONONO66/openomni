import type {
  PendingApproval,
  TranscriptCodeLine as CodeLine,
  TranscriptNode as TimelineNode,
  TurnCost,
} from "@openomni/ui";
import type { SessionId } from "./console";

/**
 * The fixture speaks the design system's transcript vocabulary directly.
 *
 * It used to declare its own `TimelineNode` carrying a `PolicyVerdict` and
 * per-call `phases`. Nothing read either one: the transcript lays out who spoke
 * and how a call ended, and a policy verdict is neither. Keeping them here
 * meant the fixture was asserting a shape the surface did not have, so they are
 * gone rather than mapped.
 *
 * What the app still owns is the WORDS. `shell wants to run npm test` and
 * `outside declared scope` are the product's sentences, and the tray prints
 * what it is handed — `@openomni/ui` never composes a sentence about a tool.
 */
export type { PendingApproval, TimelineNode, TurnCost };

/**
 * The patched append path, as a DIFF rather than a snapshot.
 *
 * Two lines carry a `+`/`-` mark, so the fence demonstrates the gutter doing
 * its actual job: showing what changed, in characters, with the surrounding
 * context intact. The change is encoded in the mark column only — no tint, no
 * second tone — which is what keeps it readable in grayscale and on copy.
 */
const ledgerCode: readonly CodeLine[] = [
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

const ledgerTimeline: readonly TimelineNode[] = [
  // A real boundary: everything above this point was folded into a summary, so
  // the transcript below is not the whole session. Marking it is what stops a
  // reader from concluding the session began at 11:42.
  { kind: "epoch", id: "e0", label: "compacted", at: "11:31" },
  {
    kind: "prompt",
    id: "p1",
    text: "The ledger append path takes the lease twice on the retry branch. Refactor it so the lease is acquired once per generation, then show me the fenced-write guard.",
  },
  // THREE calls, then prose, then more work. The prose is what makes this the
  // interleave case: it splits one run of six into two groups, so the column
  // shows the order the agent actually thought in — look, say, look again —
  // rather than gathering every receipt into one appendix at the top.
  {
    kind: "tool",
    id: "tool1",
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
    id: "tool2",
    tool: "read",
    target: "packages/kernel/src/lease/guard.rs",
    duration: "52ms",
  },
  {
    kind: "tool",
    id: "tool3",
    tool: "grep",
    target: "lease.acquire",
    duration: "18ms",
  },
  {
    kind: "assistant",
    id: "a0",
    streaming: false,
    blocks: [
      {
        kind: "p",
        text: "The retry branch re-enters acquire() while still holding the guard, so a fenced generation can commit twice. Checking what the test suite already covers before I touch it.",
      },
    ],
  },
  // SIX consecutive calls, which is what the fold exists for. One of them is
  // still running, so the collapsed state has to report `6 tools` AND keep that
  // row on screen — a fold that could hide a live call would make the quiet
  // state a lie.
  {
    kind: "tool",
    id: "tool4",
    tool: "read",
    target: "packages/kernel/tests/ledger.rs",
    duration: "44ms",
  },
  {
    kind: "tool",
    id: "tool5",
    tool: "read",
    target: "docs/kernel-contract.md",
    duration: "31ms",
  },
  {
    kind: "tool",
    id: "tool6",
    tool: "read",
    target: "packages/kernel/src/ledger/mod.rs",
    duration: "28ms",
  },
  {
    kind: "tool",
    id: "tool7",
    tool: "edit",
    target: "packages/kernel/src/ledger/append.rs",
    duration: "12ms",
    payload: ["+  let lease = self.lease.acquire().await?;", "-  if lease.generation != self.g {"],
  },
  {
    kind: "tool",
    id: "tool8",
    tool: "edit",
    target: "packages/kernel/src/lease/guard.rs",
    duration: "9ms",
  },
  // The one row in the surface allowed to carry the spinner.
  {
    kind: "tool",
    id: "tool9",
    tool: "shell",
    target: "cargo test -p kernel ledger::",
    status: "running",
  },
  {
    kind: "assistant",
    id: "a1",
    streaming: true,
    blocks: [
      { kind: "h2", text: "Single lease per generation" },
      {
        kind: "p",
        text: "The fix hoists the acquisition above the retry loop and compares the generation before any write touches the WAL.",
      },
      {
        kind: "bullets",
        items: [
          "acquire() moved above the retry loop — one lease per call",
          "generation compared before write_all, not after",
          "Fenced carries the last seen generation for the alarm path",
        ],
      },
      // Numbered from the real file offset, not from 1.
      { kind: "code", lang: "rust", lines: ledgerCode, startLine: 138 },
    ],
  },
  // The row the tray is blocked on. It prints the WORD and nothing else — the
  // two buttons live above the composer, where they cannot scroll away.
  {
    kind: "tool",
    id: "tool10",
    tool: "shell",
    target: "npm test",
    status: "waiting",
  },
];

/**
 * The decisions the agent is blocked on, keyed by session.
 *
 * `toolId` is the join back to the transcript row, so the row printing
 * `waiting for approval` and the tray offering the buttons are provably the
 * same call rather than two independent claims that a decision exists.
 */
export const approvals: Readonly<Record<SessionId, readonly PendingApproval[]>> = {
  "kernel-ledger": [
    {
      toolId: "tool10",
      summary: "shell wants to run npm test",
      reason: "outside declared scope",
    },
  ],
};

const leaseTimeline: readonly TimelineNode[] = [
  {
    kind: "prompt",
    id: "lp1",
    text: "리스 계약 조건을 문서에서 확인해서 정리해줘. 특히 generation 값이 어디서 증가하는지 알고 싶다.",
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
      { kind: "h2", text: "리스 계약 요약" },
      {
        kind: "p",
        text: "generation은 리스를 새로 획득할 때만 증가한다. 문서 기준으로 세대 값은 저장소가 아니라 리스 발급자가 소유하며, 쓰기 경로는 그 값을 비교만 한다.",
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
  // A second turn. It is here to exercise the turn boundary — the largest gap
  // in the column, and the only whitespace that says "a new exchange starts
  // here".
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
        text: "확인했다. 저장소 경로에는 generation을 대입하는 코드가 없고, 비교만 한다.",
      },
      {
        kind: "p",
        text: "That matches the contract: the issuer owns the value and the store is a reader of it.",
      },
    ],
  },
];

const heldTimeline: readonly TimelineNode[] = [
  { kind: "prompt", id: "ep1", text: "Hold here until I review the plan." },
  // A resume is the other boundary kind: the session was suspended and picked
  // back up, which the timestamps alone would report as an eight-hour pause.
  { kind: "epoch", id: "ep2", label: "resumed", at: "08:04" },
];

/**
 * What each turn cost, keyed by session and then by turn number.
 *
 * Turn numbers are 1-based and follow the prompts in ledger order — the same
 * numbering the anchors use, so `t2.4` and that turn's time are talking about
 * the same turn without a mapping table between them.
 *
 * This is shown on HOVER only. The fact is occasionally load-bearing; the
 * permanent column of clock readings that used to print it was the single
 * loudest thing making the transcript read as a log file.
 */
export const turnCosts: Readonly<Record<SessionId, Readonly<Record<number, TurnCost>>>> = {
  "kernel-ledger": {
    1: { at: "14:32", elapsed: "18s" },
    2: { at: "14:33", elapsed: "54s" },
  },
  "kernel-lease": {
    1: { at: "09:18", elapsed: "41s" },
    2: { at: "09:58", elapsed: "6s" },
  },
  "perimeter-slack": { 1: { at: "11:42", elapsed: "54s" } },
  "kernel-alarm": { 1: { at: "08:02", elapsed: "2s" } },
  "perimeter-router": { 1: { at: "08:02", elapsed: "2s" } },
  "atlas-schema": { 1: { at: "08:02", elapsed: "2s" } },
  "atlas-cutover": { 1: { at: "08:02", elapsed: "2s" } },
};

/** Keyed by session id so selection resolves a timeline without a lookup table. */
export const timelines: Readonly<Record<SessionId, readonly TimelineNode[]>> = {
  "kernel-ledger": ledgerTimeline,
  "kernel-lease": leaseTimeline,
  "kernel-alarm": heldTimeline,
  "perimeter-router": heldTimeline,
  "perimeter-slack": ledgerTimeline,
  "atlas-schema": heldTimeline,
  "atlas-cutover": heldTimeline,
};
