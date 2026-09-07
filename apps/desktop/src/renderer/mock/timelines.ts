import type { OpenOmniUIMessage } from "../chat/message";
import type { SessionId } from "./console";

type TimelineMessage = OpenOmniUIMessage;

const ledgerTimeline = [
  {
    id: "e0",
    role: "assistant",
    parts: [{ type: "data-epoch", id: "e0", data: { label: "compacted" } }],
  },
  {
    id: "p1",
    role: "user",
    parts: [
      {
        type: "text",
        text: "The ledger append path takes the lease twice on the retry branch. Refactor it so the lease is acquired once per generation, then show me the fenced-write guard.",
      },
    ],
  },
  {
    id: "a0",
    role: "assistant",
    metadata: { startedAt: Date.UTC(2026, 8, 3, 14, 32, 0), elapsedMs: 18_400 },
    parts: [
      {
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "tool1",
        state: "output-available",
        input: { path: "packages/kernel/src/ledger/append.rs" },
        output: {
          lines: [
            "138  async fn append(&self, e: Entry) -> Result<Lsn> {",
            "139    let lease = self.lease.acquire().await?;",
            "140    // one writer per generation",
          ],
        },
      },
      {
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "tool2",
        state: "output-available",
        input: { path: "packages/kernel/src/lease/guard.rs" },
        output: { lines: ["generation guard definition"] },
      },
      {
        type: "dynamic-tool",
        toolName: "grep",
        toolCallId: "tool3",
        state: "output-available",
        input: { pattern: "lease.acquire" },
        output: { matches: [{ line: 139, text: "let lease = self.lease.acquire().await?;" }] },
      },
      {
        type: "text",
        text: "The retry branch re-enters acquire() while still holding the guard, so a fenced generation can commit twice. Checking what the test suite already covers before I touch it.",
      },
      {
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "tool4",
        state: "output-available",
        input: { path: "packages/kernel/tests/ledger.rs" },
        output: { lines: ["ledger tests"] },
      },
      {
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "tool5",
        state: "output-available",
        input: { path: "docs/kernel-contract.md" },
        output: { lines: ["kernel contract"] },
      },
      {
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "tool6",
        state: "output-available",
        input: { path: "packages/kernel/src/ledger/mod.rs" },
        output: { lines: ["ledger module"] },
      },
      {
        type: "dynamic-tool",
        toolName: "edit",
        toolCallId: "tool7",
        state: "output-available",
        input: { path: "packages/kernel/src/ledger/append.rs" },
        output: {
          diff: [
            { mark: "add", text: "  let lease = self.lease.acquire().await?;" },
            { mark: "remove", text: "  if lease.generation != self.g {" },
          ],
          code: {
            language: "rust",
            startLine: 138,
            lines: [
              { text: "async fn append(&self, e: Entry) -> Result<Lsn> {" },
              { mark: "add", text: "  let lease = self.lease.acquire().await?;" },
              { text: "  // one writer per generation" },
              { mark: "remove", text: "  if lease.generation != self.g {" },
              { text: "    return Err(Fenced { seen: 1487 });" },
              { text: "  }" },
              { text: '  Ok(lease.commit("entry.append"))' },
              { text: "}" },
            ],
          },
        },
      },
      {
        type: "dynamic-tool",
        toolName: "edit",
        toolCallId: "tool8",
        state: "output-available",
        input: { path: "packages/kernel/src/lease/guard.rs" },
        output: { changed: ["generation guard"] },
      },
      {
        type: "dynamic-tool",
        toolName: "shell",
        toolCallId: "tool9",
        state: "input-available",
        input: { command: "cargo test -p kernel ledger::" },
      },
      {
        type: "text",
        text: "Single lease per generation\n\nThe fix hoists the acquisition above the retry loop and compares the generation before any write touches the WAL.",
        state: "streaming",
      },
      {
        type: "dynamic-tool",
        toolName: "shell",
        toolCallId: "tool10",
        state: "approval-requested",
        input: { command: "npm test" },
        approval: { id: "approval-tool10", requestReason: "outside declared scope" },
      },
    ],
  },
] satisfies readonly TimelineMessage[];

const leaseTimeline = [
  {
    id: "lp1",
    role: "user",
    parts: [
      {
        type: "text",
        text: "리스 계약 조건을 문서에서 확인해서 정리해줘. 특히 generation 값이 어디서 증가하는지 알고 싶다.",
      },
    ],
  },
  {
    id: "la1",
    role: "assistant",
    metadata: { startedAt: Date.UTC(2026, 8, 3, 9, 18, 0), elapsedMs: 41_000 },
    parts: [
      {
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "ltool1",
        state: "output-available",
        input: { path: "docs/kernel-contract.md" },
        output: { sections: ["generation ownership"] },
      },
      {
        type: "text",
        text: "리스 계약 요약\n\ngeneration은 리스를 새로 획득할 때만 증가한다. 문서 기준으로 세대 값은 저장소가 아니라 리스 발급자가 소유하며, 쓰기 경로는 그 값을 비교만 한다.",
      },
    ],
  },
  {
    id: "lp2",
    role: "user",
    parts: [{ type: "text", text: "Then confirm the store never writes generation itself." }],
  },
  {
    id: "la2",
    role: "assistant",
    metadata: { startedAt: Date.UTC(2026, 8, 3, 9, 58, 0), elapsedMs: 6000 },
    parts: [
      {
        type: "dynamic-tool",
        toolName: "grep",
        toolCallId: "ltool2",
        state: "output-available",
        input: { pattern: "generation =" },
        output: { matches: [] },
      },
      {
        type: "text",
        text: "확인했다. 저장소 경로에는 generation을 대입하는 코드가 없고, 비교만 한다. That matches the contract: the issuer owns the value and the store is a reader of it.",
      },
    ],
  },
] satisfies readonly TimelineMessage[];

const heldTimeline = [
  {
    id: "ep1",
    role: "user",
    parts: [{ type: "text", text: "Hold here until I review the plan." }],
  },
  {
    id: "ep2",
    role: "assistant",
    parts: [{ type: "data-epoch", id: "ep2", data: { label: "resumed" } }],
  },
] satisfies readonly TimelineMessage[];

/** Keyed by session id so selection resolves a timeline without a lookup table. */
export const timelines: Readonly<Record<SessionId, readonly TimelineMessage[]>> = {
  "kernel-ledger": ledgerTimeline,
  "kernel-lease": leaseTimeline,
  "kernel-alarm": heldTimeline,
  "perimeter-router": heldTimeline,
  "perimeter-slack": ledgerTimeline,
  "atlas-schema": heldTimeline,
  "atlas-cutover": heldTimeline,
};
