# #937 A1-A3 model-step and tool-wave increment

## Outcome

The session-owned per-model-step/tool-wave vertical slice is implemented and verified on `kernel/937-integration`. Provider I/O returns pending ordered calls and has no tool execution capability. The existing session/executor owns the three drains, all-pre barrier, whole-wave authenticated approval, positional settlements, sequential barriers, immediate cancellation release and late-commit fencing. Resident and existing native worker callers consume this path.

Review found that the original `5c96d522` increment did not retain nested raw bodies transitively. The additive R1 correction and failing-first proof are recorded in `REPORT-WAVE-R2.md`; incremental re-review remains required. This is not full #937. Retry/model ownership, stop-chain migration, durable history recovery and worker/drive deletion remain subsequent work. Original compaction commits are preserved. No root config/CI, other worktrees, shared builds, push, PR or comments were touched.

## Contract and implementation

| Responsibility | Implementation |
| --- | --- |
| One model step, schemas only, original wire-name mapping/native fold/billed usage retained | `packages/llm/src/run.ts`, `processor/index.ts`, `processor/stream-events.ts`; `RunInput.toolExecutor` removed with all readers migrated |
| Session-owned before_llm, after_llm, after_tools; one core invocation, original prompt IDs, assistant-before-continuation ordering | `session-chat-runner.ts`, `session-handle.ts`, `core/execution/{run,turn,state}.ts`, `core/message-factory.ts` |
| All pre decisions, then original intent creation, then approval barrier, then scheduling, then positional post-policy/results | existing `executor.ts`; staged algorithm salvaged from the reserved executor and corrected rather than copied wholesale |
| Record-before-observe over existing fenced ledger | `executor-record.ts`; no new action store |
| Typed exact-invocation suspension and answer | `executor-approval.ts`, `executor-contract.ts`, existing session handle's `approvals` capability |
| Body scheduling/cancellation and original assistant result slots | `core/execution/tool-wave.ts`; no policy or persistence authority |
| Pinned catalog, parse/body/output/render and inherited nested executor | `tool-dispatcher.ts`, `tool-body.ts`; visibility/placement refusals remain enforced at both single and wave doors |
| Actual app authority and callers | `apps/openomni/src/{index,resident}.ts`, `delegation/worker-loop.ts` |

Approval captures the original action ID, call ID, parsed invocation/hash, actual turn/session, pinned policy/tools generation and hash, pre-decision ID and revision. The app binds approval evidence to its existing Owner-tier WebSocket token via constant-time credential comparison, never caller actor prose or an authenticated boolean. Wrong credentials, altered requests, duplicate answers, canceled requests and inclusive-deadline answers fail closed. Configured deadlines refuse only the pending slot; no implicit timeout value is invented. The injected scheduler test advances the exact expiry event without sleeping. Approval never invokes the model again or uses session resume.

Cancellation freezes unsettled slots at the abort event, cooperatively signals bodies, releases the wave immediately, and commits canceled slots in original order. A body resolving from the abort callback cannot replace its canceled slot. With the R1 correction, the per-turn executor binds cancellation and raw-effect retention, and nested execution inherits both capabilities. The existing session retains its heartbeat/lease until those raw bodies settle, rather than until their abort-raced wrappers settle. Real current/captured executor regressions now prove contender refusal before raw settlement and acquisition afterward, with immediate SDK interruption and zero stale body starts/commits. This does not claim to roll back an external effect.

## Real surfaces and clause map

`apps/openomni/test/session-wave-e2e.test.ts` uses the real app, public authenticated WebSocket and SDK session handles, file-backed SQLite, local Anthropic SSE and installed provider SDK. Only catalog resolution is supplied; no fake LLM.run drives these scenarios. Custom test tool definitions are normal supplied app definitions executed by the real dispatcher.

| Clause | Named proof |
| --- | --- |
| Provider returns calls before bodies | `real provider returns calls before any app tool body starts` |
| Interrupt at model return, zero bodies | `after-model SDK interrupt starts zero bodies and seals one interrupted terminal` |
| Actual after_llm inbox drain, not eager local abort alone | `a durable after-model inbox interrupt drains before tools without an eager local signal` |
| All-pre, parallel reverse completion, sequential D, ordered ledger and next-provider input | `all pre decisions precede A B C and reverse completion preserves ledger/provider order across D`; independent read-only SQLite query checks result ordinals |
| Approval B holds A/C, original invocation, refuse only B | authenticated approve/refuse table cases; wrong credential/altered hash/duplicate answer assertions |
| Interrupt pending approval cancels every unstarted slot | `interrupting pending B cancels every unstarted positional slot` |
| Noncooperative wave release, retained lease, late nested commit rejection | `noncooperative bodies release the wave but retain the lease and cannot commit late` |
| Transitive raw-body retention, including captured out-of-context doors | Six `nested raw effects retain the lease through ...` cases; `REPORT-WAVE-R2.md` records RED, mutation discrimination and both Bun versions |
| Prompt IDs/order survive approval wait and enter next model | `approval-time prompts retain durable identities and enter the next model separately in order` |
| Exact timeout refuses only B | `an exact approval deadline refuses only B and cannot grant late authority` |
| After-wave drain precedes another model step | `an interrupt after wave results drains before another provider step` |
| Abort-event late completion and both sides of a sequential barrier | `packages/agent/test/core/execution/tool-wave.test.ts` |
| Placement/alias refusal at both execution doors | `packages/agent/test/core/execution/tool-placement.test.ts` |

All waits are exact subscriptions/deferred signals with bounded failure deadlines. Real surface teardown closes sockets/app/provider/SQLite; the ordered-wave case verifies directory removal and app/provider port rebind. The unchanged G034 archive/disposition fixtures remain in the migrated channel regression. Resident/worker wiring, inline delegation, real machine/code-mode nested transport, and the isolated real-provider fact-tap probe pass with provider fixtures now returning calls rather than executing them.

## RED/GREEN and validators

Raw evidence: `.omo/evidence/937/wave/`.

- `red-real-sdk-owner.txt`: original SDK execution restored temporarily, expected bodies at provider return 0, actual 1. The patch was reversed; original reserved worktree was never written.
- `placement-red.txt`: four wave-path alias/placement countercases failed, then passed after shared refusal enforcement.
- `deadline-red.txt`: expected captured expiry 101, received absent; exact deadline refusal now passes.
- `abort-linearization-red.txt`: expected canceled slot, received late fulfilled value from abort callback; now passes.
- `focused-mutations.json`: four killed mutants, raw `mutant-*.txt` and reversible patches: omitted after-model drain, lost abort linearization, removed sequential barrier, reversed result commit order. This is focused evidence, not full global mutation coverage.
- `verified-types.txt` and `verified-build.txt`: full installed compiler and build exit 0, sequentially before final tests.
- `verified-full.txt`: authoritative **Bun 1.3.6: 2,742 pass, 0 fail**, 8,208 assertions, 299 files, repository coverage enabled. No tests skipped to pass.
- `verified-compat.txt`: **Bun 1.4.1: 582 pass, 0 fail**, 1,596 assertions, 68 affected files.
- `verified-gates.json`: script compiler, dependencies, cycles, lint, tool lint, Ultracite and dead-export census all exit 0. No baseline growth.
- LSP attempted for every changed TypeScript file before compiler/build. Production files were clean. Some test checks initially used an inferred project missing Bun/modern globals or timed out; later touched-test checks were clean, and the installed test compilers passed. No blanket clean-LSP claim is made for timed-out checks.

The first full run found one legacy SDK-closure test still simulating tool execution in provider I/O; migrated it to emit a pending call. Final full run passes in one execution. Initial native provision fixtures omitted the nested `operation` field: those setup failures are retained but not counted as semantic RED. A budget fixture using the retired fake provider callback also required migration. Dead-export census found unused re-exports after responsibility extraction; they were removed, not baselined. No failure was skipped or suppressed.

## Preservation, ownership and remaining #937 work

`original-before.json`/`original-after.json` retain the reserved tracked patch digest and all ten untracked hashes. The original tracked diff remains `6d5ce7f8953b3911e61b35f21e597bee1a8a3436d58411ca59ccab4de52a8bb7`. Merged #974-978 and completed compaction commits remain ancestors; no onFact, legacy Session/WorkItem or compatibility worker was recreated.

New responsibility units are substantive: executor policy/orchestration 414 LOC, capability contract 152, approval suspension 159, ledger/observations 179, dispatcher 441, body execution 95, wave 162, placement/catalog 166; turn is 500 LOC. Existing session-handle and retry-heavy run/compaction hotspots remain above the full-issue E1 bound and are not claimed closed by this increment. No quality-lane/root configuration files were changed.

Remaining acceptance is A4/A5 exclusive attempts and canonical model/auth; A6 durable replay/reader history; A7 pinned policy stop/openIntent/live-wait; A8 reopened identity proof; A9 atomic worker/drive deletion and spawned process acceptance; remaining E1/global quality/mutation and independent review. Existing green gates are not proof of those unimplemented clauses. REVIEW-R2's broader REQUEST_CHANGES verdict is not overridden by this implementation receipt.
