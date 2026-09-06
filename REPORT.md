# Issue 937 integration report

## Outcome

**Partial implementation; full #937 is not complete.** Delegated authority was consumed and implementation proceeded. There is no renewed authorization blocker. The delivered work fixes the reviewed compaction countercase and wires admitted, reversible compaction persistence through the existing executor. The deterministic model/tool loop, approval and worker cutover remain unfinished.

## Implementation commits

| Commit | Delivered behavior |
| --- | --- |
| `3eac3253` | Zero protected-tail compaction retains an unchanged original atomic entry. |
| `f51375da` | Corrected adoption of pure range/hash/revert primitives; full-rewrite and elision projections restore exact originals; revert evidence is snapshotted. |
| `5d7a703e` | Existing executor admits compaction through pinned `turn.post/compaction`, commits result/revert before completed observation and projection, and propagates cancellation into the summarizer. Real SSE app/SQLite regression added. |
| `7fdec624` | Removes the new unused error-class export; no baseline growth. |

No push, PR, merge or tracker comment was performed.

## Verification

- Unchanged baseline `5251f3a1`: full workspace types/build passed, followed by 111 selected session/ledger/compaction/channel tests under Bun 1.3.6.
- Semantic RED: `increment-1-red.txt`, `increment-2-record-red.txt`, `increment-3-red.txt`, `increment-3-policy-red.txt`, `increment-3-abort-red.txt`. These show actual wrong original boundary, non-reversible/mutable records, missing durable commit, bypass of the existing policy point, and missing abort forwarding.
- Final affected-path run: **187 pass, 0 fail** under both Bun 1.3.6 and Bun 1.4.1 (`increment-3-abort-{green,compat}.txt`). Includes original channel/G034 archive/disposition regression unchanged.
- One final ten-command gate chain passes under Bun 1.3.6: build, workspace types, script compiler, dependency rules, import cycles, lint, tool lint, Ultracite, dead exports, full tests. `clean-chain.json` records exact commands and all ten exit codes. Full tests: **2,724 pass, 0 fail**, 8,126 assertions, 297 files, with the repository coverage configuration enabled. No skipped tests were reported.
- LSP was attempted on every changed TypeScript file before installed compiler/build. Results were intermittently clean, refresh timeouts, or an inferred test project missing Bun/modern library declarations. No clean global LSP result is claimed. The installed repository compilers, including test configurations, passed.
- Process-entry EOF smoke exits **78** (`process-eof.txt`). This is a negative entry-point check, not a spawned worker success/ACK proof.

### Real surface

`apps/openomni/test/session-loop-e2e.test.ts` boots the actual app, file-backed SQLite, authenticated WebSocket subprotocol and a loopback Anthropic SSE provider. Only catalog resolution is injected; the installed provider SDK, LLM processor, session, executor and compaction strategy are real. Four public channel prompts produce a reversible compaction action visible through the session store and an independent read-only SQLite connection. The probe reports six provider requests (four responses and two summary requests from existing speculative/synchronous behavior). It closes the app/socket/provider/database, verifies directory removal and rebinds both ports.

This does **not** prove inline/process worker migration, typed approval, replayed compaction after reopen, or the future per-step loop.

### Failed validation attempts retained

- Initial SSE fixture expected trailing whitespace that the response surface trims; corrected the expected fixture value.
- Its initial 1,000-token model window removed the whole old assistant input before summarization. The 10,000-token fixture now exercises the actual summary path; this was not counted as behavioral RED.
- A new denial test first used an unregistered `compaction.pre` compiler kind. Corrected it to the existing `turn.post/compaction` contract, captured a genuine bypass RED, then fixed executor admission mapping. The compiler was not recreated or edited.
- Direct Ultracite invocation lacked local `biome` on PATH. The corrected local invocation and final clean chain pass.
- Dead-export census caught the new unused `CompactionExecutionError` export; it was removed in `7fdec624`. No suppression or baseline increase was used.

## Preservation and adoption

Original `/Users/ino/Develop/openomni-wt-937` remains unchanged. Before/after capture matches: tracked binary diff SHA-256 `6d5ce7f8953b3911e61b35f21e597bee1a8a3436d58411ca59ccab4de52a8bb7`; all ten untracked SHA-256 values match. Full patch and both inventories are in this worktree's evidence directory.

`ADOPTION.json` lists all 46 dirty paths with original/base/main/integration hashes and explicit disposition. Only sound pure compaction primitives were reused. The raw-ledger wrapper, full-rewrite fallback and unrelated incomplete executor/LLM candidates were not copied. Most of the reserved changes are still unadopted, not approved or discarded. `#974-978` remain in branch ancestry; processor/sink, archive/disposition and channel code were not changed. No migrations, historical action rows or other worktrees were edited.

The new result payload uses the existing generic encoded action and revert contracts. Original history is retained. Durable session hydration does not yet consume the new compaction record or preserve canonical tool-bearing IDs across turns; that reader/writer migration remains required.

## Remaining acceptance and limits

`ACCEPTANCE.json` maps every supplied A1-A10 oracle to implemented/partial/unimplemented status and actual evidence. No clause is claimed complete merely because existing tests pass.

- Actual session-owned per-model-step drains and deterministic tool waves.
- Whole-wave all-pre ordering, authenticated exact-invocation suspension/answer, positional results, sequential barriers and noncooperative tool release with late-commit/lease fencing.
- Sole executor retry admission, post-visible no-replay and canonical model/auth consumer migration.
- Durable compaction hydration/recovery, durable original-entry identity and summarizer attempt admission; current implementation proves in-run reversible persistence only.
- Pinned policy-row stop chain, effect-based progress, real open-intent and live-wait behavior.
- Atomic resident/inline/process adoption and worker/drive deletion; real approval/cancel/restart and reopened-SQLite identity proofs.
- Responsibility decomposition: compact.ts remains 972 LOC and turn.ts 620 LOC. E1 is not met. New durable planner/execution units are 135/77 LOC; executor is 487 LOC.
- Full mutation, 100% coverage, zero any/unknown/duplication, complexity and other campaign-wide quality thresholds are **not** proven by the green existing gate chain. Independent ultrabrain re-review has not occurred.

`REVIEW.md` retains the independent REQUEST_CHANGES verdict. R5's concrete planner countercase is fixed and the exact SDK probe is RED/GREEN; this does not resolve R1-R4 or approve full #937. Historical empty-submission artifacts remain raw evidence, explicitly superseded by this report.
