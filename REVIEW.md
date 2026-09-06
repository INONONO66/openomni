# #937 independent review

## Verdict: REQUEST_CHANGES

Reviewed on 2026-09-06 for task `st_01a07593`. This is a rejection of the submitted integration deliverable, not approval of the unchanged baseline or closure of the campaign.

## Findings recorded during review

### R1 - Blocking: no #937 implementation was delivered

`REPORT.md:3-12,29` explicitly reports "blocked before adoption" and no source adoption/build/fix. Independently, `git status --short` initially showed only `?? REPORT.md`; `git diff HEAD --` was empty. HEAD is `5251f3a16f5ccd333839973d780e84c80d341bff`, tree `2a16cf6be7a385f2176450466fa6c9b8ce32e529`; the empty tracked binary diff hashes to `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Live issue #937 was read using `gh issue view 937 --json title,body,state,url,updatedAt,comments` (OPEN, updated `2026-09-05T17:52:51Z`). Its full scope and Owner-approved lifecycle amendment remain binding: session-owned per-step loop, whole-wave all-pre and exact-invocation approval, positional results/sequential barriers, abort-release, executor-owned attempt actions, canonical LLM ownership, reversible compaction, ordered policy-row stop judgment, and real Resident/worker consumers. None can be accepted as implemented by an empty delta. The worker/drive files still exist in the reviewed tree.

Required correction: the assigned deep implementation owner must implement the full authorized scope in this worktree, salvage/reconcile the reserved dirty tree without restoring retired authority, and return a frozen source delta plus failing-first and real-surface receipts for independent re-review. Do not defer the working #930 baseline approval path to #966.

### R2 - Blocking: the report applies superseded decision blockers

`REPORT.md:5-12,29` and `.omo/evidence/937/blocker.json:3-12` require lead-owned signed artifact files before implementation. The assigned authority, `/Users/ino/Develop/openomni-kernel-campaign/.omo/campaign/DELEGATED-DECISIONS.md:3-15,31`, explicitly delegates the handoff, specifies immediate abort release, existing seeded limits/compaction, typed authenticated approval evidence, and says the two former decision blockers are resolved. The report cannot use their absence to substitute a blocked handoff receipt for the requested implementation. Preservation and authorization constraints still apply; no second kernel or invented weaker contract is permitted. D937's full acceptance still applies, but its historical `implementationAuthorized: false` is not a new veto over the latest delegation. Adoption/evidence receipts must be produced, not cited as permissions the Owner still owes.

Required correction: consume the delegated decisions, record concrete implementation/adoption choices as evidence, and complete the loop rather than request the previously resolved permission again.

### R3 - Blocking: actual source contradicts the core acceptance criteria

These are existing baseline defects left unresolved by this submission, not regressions introduced by a patch. The exact acceptance source read was `/Users/ino/Develop/openomni-d937-decision/DECISION.json:170-180` (A1-A10), including the full artifact and its verification/deletion clauses. Its raw D937 result is an analysis-only receipt; it does not claim implementation or runtime verification.

| Criterion | Independently observed blocker or remaining proof |
| --- | --- |
| A1: actual per-step drains | `packages/agent/src/session-chat-runner.ts:47-61` awaits the whole `ChatAgent.create(...).run()` before both `after_llm` and `after_tools`. Three named boundaries around a completed chat run do not establish an interrupt before that model step's tools. |
| A2: wave/approval | `packages/agent/src/executor.ts:173-176,422-434` treats `require_approval` as `blocked_pre`, like denial. It is not nonterminal exact-invocation suspension. No whole-wave pre/approval/order/sequential implementation was delivered. |
| A3: cancel/late callbacks | No tool-wave cancellation implementation or signal-driven proof was delivered. Immediate boundary release with canceled positional slots and late-commit fencing, without unsafe lease release, remains unverified. |
| A4: attempts/retry | Deletion command finds `handleAttemptFailure`, `Retry.decide`, and `runAttempts` in `packages/llm/src/processor/index.ts:153,169,200`, plus agent-local classification/backoff. Existing attempt topology is not proof of exclusive retry ownership, post-visible no-replay, overflow routing, or interruptible readmission. |
| A5: canonical LLM/D5 | Legacy resolution remains at `packages/agent/src/core/execution/run.ts:268,454,545`, auth interpretation at `turn.ts:246`, and cell resolver at `apps/openomni/src/tools/execution/llm.ts:110-112,174`. Canonical consumer convergence is not delivered; no new D5 preservation runtime proof exists. |
| A6: compaction | No adopted reversible/content-addressed executor-owned compaction delta or required `compaction-node.test.ts` exists here. Pair safety, reconstruction, commit-before-project, and concurrent prompt preservation cannot be accepted from the reserved dirty work alone. |
| A7: stop | `apps/openomni/src/delegation/drive-loop.ts:10-13,60-66` still owns 8/3/3/3 constants and stop decisions. It has not been replaced by the session loop's pinned policy-row chain. Completion/openIntent/live-wait behavior remains unverified. |
| A8: resume | The requested real reopened-SQLite proof of crash-open same IDs/pinned generation versus terminal-interrupted new IDs/latest generation did not run. No claim that the existing resume behavior is broken is made. Approval must not be implemented via either resume path. |
| A9: real consumers/deletion | `apps/openomni/src/index.ts:53,253` and `delegation/process-entry.ts:7,113` still consume `createInlineWorkerRunner`; `worker-loop.ts:134,162` still consumes the drive state/decision. Both source files and both obsolete drive test files remain. No salvage/adoption occurred. |
| A10: quality/decomposition | Measured current production files: `core/execution/run.ts` 578 LOC, `turn.ts` 615, `compaction/compact.ts` 960. Build/types cannot load; no responsibility manifest or behavioral RED/GREEN/mutation receipt was delivered. |

The approval countercase sought was an actual compiled `require_approval` decision retaining its original invocation as a nonterminal pending operation rather than returning `blocked_pre`. Source proves the refusal path above; both attempted source-loaded SDK probes failed during module loading, so **no runtime result from those probes is claimed**. Approving an empty patch because some existing session tests might pass was rejected: source-level A1/A2 violations and executed deletion failures independently defeat that argument.

### R4 - Blocking: no runnable acceptance or behavioral RED was supplied

`REPORT.md:27,29` and the raw `.omo/evidence/937/characterization-main.txt` are candid about missing dependencies. That is an environment failure, not the machine-oracle RED required by D937 `DECISION.json:190`. The fresh checkout has no `node_modules`; no reviewer install or dependency links were created under the report-only write restriction.

The required new files are absent: all five `packages/agent/test/core/execution/{run-agent-loop,tool-wave,llm-attempts,compaction-node,stop-chain}.test.ts`, `packages/llm/test/model-auth-resolution.test.ts`, and `apps/openomni/test/session-loop-e2e.test.ts`. Existing test files are not a substitute for the missing behavior and real-surface proofs.

Required correction: the deep owner must prepare dependencies, record deterministic failing-first behavioral cases, implement and migrate coverage without suppressions/deletions-to-green, and supply the complete required validators plus real app/SDK/process/SQLite receipts at the actual resulting hashes. The reviewer did not repair the environment or source and did not weaken acceptance to missing-module tests.

### R5 - Blocking for adoption: real compaction SDK countercase fails in the salvage candidate

This finding applies to the preserved source, **not to a nonexistent integration patch**. In `/Users/ino/Develop/openomni-wt-937/packages/agent/src/compaction/durable.ts:69-75`, a full rewrite with no shared original suffix chooses `replacement[0]` as `firstKeptEntryId`. At `:114-116`, restore then treats that synthesized ID as an original suffix boundary and appends the new anchor after all removed originals. This violates A6's original first-kept boundary and exact reversible projection. The implementation must retain a real original pair-safe anchor (per the delegated strategy/D937 contract) and make restoration reproduce original content exactly.

A read-only **actual SDK execution** in the reserved tree (which has its own installed dependencies) called those production functions directly, with no mocks, storage adapter, sleeps, or polling. It returned the following machine values and failed the invariant with exit 1:

```json
{
  "priorIds": ["original-1", "original-2"],
  "firstKeptEntryId": "new-anchor",
  "firstKeptIsOriginal": false,
  "restoredIds": ["original-1", "original-2", "new-anchor"],
  "restoredExactOriginal": false
}
```

This was the strongest **executed** countercase: a valid returned plan fails exact restoration at the full-rewrite boundary. It is not counted as successful integration/SQLite verification or as a worker-authored failing-first receipt.

Exact executable probe (executed with the equivalent expanded JSON diagnostic output):

```bash
cd /Users/ino/Develop/openomni-wt-937
bun --config=/dev/null - <<'JS'
import { createCompactionPlan, restoreCompactionProjection } from "./packages/agent/src/compaction/durable.ts";
const entry = (id, text) => ({
  info: { id, sessionID: "review937-compaction", role: "user", time: { created: 1 }, agent: "resident", model: { providerID: "test", modelID: "test" } },
  parts: [{ id: `${id}-part`, messageID: id, sessionID: "review937-compaction", type: "text", text }],
});
const prior = [entry("original-1", "first input"), entry("original-2", "second input")];
const replacement = [entry("new-anchor", "summary")];
const plan = createCompactionPlan(prior, replacement, 20);
const restored = restoreCompactionProjection(plan.projection, plan.record);
console.log(JSON.stringify({
  surface: "reserved dirty source compaction SDK, not integration tree",
  priorIds: prior.map(entry => entry.info.id),
  firstKeptEntryId: plan.record.firstKeptEntryId,
  firstKeptIsOriginal: prior.some(entry => entry.info.id === plan.record.firstKeptEntryId),
  restoredIds: restored.map(entry => entry.info.id),
  restoredExactOriginal: JSON.stringify(restored) === JSON.stringify(prior),
  cleanup: "pure calls only; no database, file, session, socket, timer, or spawned child",
}, null, 2));
if (!prior.some(entry => entry.info.id === plan.record.firstKeptEntryId) || JSON.stringify(restored) !== JSON.stringify(prior)) {
  console.error("FAIL A6 salvage countercase: full rewrite names a new anchor as first-kept and restore retains the synthesized anchor");
  process.exitCode = 1;
}
JS
```

Additional adoption risks independently read in the raw dirty executor diff/current dirty source: `executor.ts:329-350,781` still denies approval and waits on every body; `llm/src/run.ts:423-449` retains a retry loop; `llm/src/processor/index.ts:84,229-230` forwards the retired public `onFact`. Reuse useful staged/pre-order and range/hash primitives only after correcting these violations and reconciling current main. Copying the dirty tree wholesale is rejected, as is discarding its working parts without the required adoption census. The raw original diff was sampled around executor changes; the whole dirty implementation was not exhaustively reviewed or approved.

## Commands actually executed and outcomes

All integration commands ran from `/Users/ino/Develop/openomni-937-integration` on macOS arm64, Bun `1.4.1 (4661e494f)`.

```bash
git status --short --untracked-files=all
git rev-parse HEAD HEAD^{tree}
git diff HEAD --
git diff --binary HEAD | shasum -a 256
gh issue view 937 --json title,body,state,url,updatedAt,comments
bun test --config=/dev/null --timeout 15000 packages/agent/test/session-handle.test.ts packages/agent/test/session-chat-runner.test.ts packages/ledger/test/session/kernel.test.ts
bun run check-types
bun run build
bun apps/openomni/src/delegation/process-entry.ts < /dev/null
```

The empty config only disables the repository's coverage-file output for this report-only review; it does not skip cases or suppress failures. Actual characterization output:

```text
Cannot find module '@openomni/ledger' from .../packages/agent/test/session-chat-runner.test.ts
Cannot find module '@openomni/ledger' from .../packages/agent/test/session-handle.test.ts
Cannot find package 'zod' from .../packages/protocol/src/error/index.ts
0 pass
3 fail
3 errors
Ran 3 tests across 3 files. [57.00ms]
characterization_exit=1
```

Both type/build commands failed with `turbo: command not found`, exit 127. The real process entry failed to load `@openomni/ledger`, exit 1; this is **not** D937's expected EOF exit 78 and is not a working-process proof. Full quality, full tests, mutations, real app/channel success, and reopened-SQLite acceptance were not run successfully. No new code exists to diagnose; no production diagnostics pass is claimed.

Reviewer command failures are retained explicitly: the initial `bun test --coverage=false ...` invocation was rejected because `--coverage` takes no value, before loading tests. It was corrected to the empty-config command above, which ran once and failed as shown. Two `NODE_PATH=/Users/ino/Develop/openomni-kernel-campaign/node_modules bun --config=/dev/null -` inline probes attempted current-source SDK loading without installing anything. The first failed on `@openomni/policy` from the agent barrel; the narrower compiler/executor probe failed on `@openomni/protocol` from `row-compiler.ts`. Neither reached its assertions, session setup, or SQLite initialization. External dependency resolution alone is not workspace/application verification.

### Executed deletion census

The review loaded D937's JSON and executed **every literal `deletions[].grep`** with Python `subprocess.run(..., shell=True, capture_output=True, text=True)`, printing stdout, stderr, exit code, and exact-path presence. Expected exit is 1 with empty output, not an execution error.

| D937 gate | Actual exit | Result |
| --- | ---: | --- |
| DEL-WORKER | 0 | FAIL: live imports/drive constants and both source paths present |
| DEL-WORKER-TEST | 0 | FAIL: imports and both old tests present |
| DEL-PROCESSOR-RETRY | 0 | FAIL: nested retry symbols/cap suite present |
| DEL-RESOLVERS | 0 | FAIL: agent/cell/auth sites present |
| DEL-AGENT-RETRY | 0 | FAIL: agent-owned classification/backoff/default policy present |
| DEL-APP-ASSEMBLY | 1 | PASS already at baseline; not a new deletion |
| G-AG1 | 0 | FAIL: `checkBudget` remains at `core/budget.ts:120` |
| G-AG2 | 1 | PASS already at baseline; not a new un-export |
| G-LLM1-3 | 0 | FAIL: `RunDependencies`, `LegacyError`, runtime `Outcome` remain at `llm/src/run.ts:77,116,122,131` |

This is **seven failed gates and two pre-existing passes**, correcting the shorthand progress message that said all deletion greps failed. No source interpretation of a successful grep was inflated into runtime acceptance.

## Preservation, hashes, and chronology

The reviewer independently read the preservation capture, recomputed `git diff --binary` over the original reserved tree, counted its tracked/untracked inventory, and compared every untracked SHA-256 against that capture using Python `hashlib` and `git ls-files --others --exclude-standard -z`.

```text
original HEAD: 5f3a75ffa2ca234765acc30de703036e85082469
tracked changed: 36
untracked files: 10
tracked binary diff SHA-256: 6d5ce7f8953b3911e61b35f21e597bee1a8a3436d58411ca59ccab4de52a8bb7
all 10 untracked hashes: MATCH
PRESERVATION_MATCH=PASS
original diffstat: 1802 insertions(+), 3297 deletions(-)
```

The current reserved bytes match the captured hashes. This verifies preservation, **not salvage correctness**: none of the 46 dirty paths was adopted or given a delivered reuse/reject disposition. No approval is transferred from candidate dirty code, including its retired-public-fact-tap intersection, to this empty integration tree.

`stat -f '%Sm %N' -t '%Y-%m-%dT%H:%M:%S%z'` observed this local chronology (UTC+09:00): delegated decisions 16:11:14; original preservation capture 16:14:20; characterization 16:14:33; blocker JSON 16:15:38; worker REPORT 16:15:57. These are file timestamps, not tamper-proof event attestations. The only worker-supplied raw test attempt is an import failure; there is no behavioral RED followed by an implementation GREEN to inspect. The reviewer SDK failure above is a separate review-time counterexample. After that execution, the original binary-diff hash and all ten untracked hashes were recomputed again and remained identical.

Current worker-evidence SHA-256 values:

```text
REPORT.md                              16f3a66eea4c06e9b01f4c7aa9777c0304e36b0d6b4c1eac617359dbada2a750
.omo/evidence/937/blocker.json           3ff505a35b626701c6dfd6671c3725b4c4911cc3af2830483d25a3fd2ab3d3ff
.omo/evidence/937/characterization-main.txt df6d76d11e14c22dc28d38621be22eefd8dc09649d78a9181b5c2aa6fd8c57d8
.omo/evidence/937/original-preservation.txt a739274552d8053089c9b40d4db1581be58af9e2660330b729ed02f3715f91b3
```

## Cleanup, limits, and disposition

Only `REVIEW.md` was written by this reviewer. Final tracked diff remains empty; status lists only the pre-existing `REPORT.md` and new `REVIEW.md`. The reserved worktree was never edited. No code, tests, installed dependencies, commits, pushes, PRs, campaign contracts, or shared configuration were changed. Integration runtime attempts failed before initializing review sessions, databases, listeners, or child workers; the reserved-tree SDK probe completed pure compaction calls only and created none of those resources. All invoked commands exited; the final `ps -axo pid,ppid,stat,command` filter found no matching Bun test/process-entry/review937 executable. No external effect or controlling lease was released.

**Return to the deep implementation owner, then re-review the actual implementation.** The unresolved work is the full A1-A10 scope and its required preservation/adoption, deterministic regression, real-surface, deletion, and quality evidence, not a request for the Owner to re-decide delegated choices. No new kernel, false successful waiting result, approval actor-string shortcut, source restoration of retired authority, or deferred #930 baseline acceptance is acceptable. Hosted CI, integration/merged-tree receipts, and global campaign closure remain lead-owned and active; this review closes none of them.

### Implementation response (increment 1)

The producer full-rewrite countercase now has a semantic RED/GREEN regression in compaction-node.test.ts: zero protected messages still keeps an unchanged original atomic entry. The preserved durable planner counterexample was reproduced independently; corrected planner adoption and executor persistence remain pending. This is a partial correction, not review approval or A6 completion. See REPORT.md and raw increment-1 evidence.

### Implementation response through 7fdec624

R5's exact full-rewrite SDK countercase is now corrected in the integration branch: firstKeptEntryId is original-2 and restoration is exactly original-1/original-2. Raw RED/GREEN probes are under .omo/evidence/937/review-countercase-{red,green}.txt. The existing executor now admits and persists compaction before projection/completion observation; in-flight summarizer cancellation is wired. A real local SSE provider, app WebSocket and file-backed SQLite case passes alongside the unchanged channel/G034 archive regression.

The final ten-command existing gate chain is green; 2,724 tests pass, and 187 affected tests pass on Bun 1.3.6 and 1.4.1. See REPORT.md for failed attempts, LSP limitations and exact evidence. Full #937 remains unfinished: this response is not independent review approval, R1-R4 closure, complete A6 recovery, or satisfaction of E1/global quality. No original-worktree source was changed.
