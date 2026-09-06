# #937 R1: rejection-safe timed ownership settlement

## Delivered scope

Task `st_01a07689`, additive to `625b173f8ee512f352effc2be7e1bf68d81b5347` on `kernel/937-integration`. Only the R1 retention defect in `REVIEW-WAVE-R3.md` is corrected. Full #937 remains open; no A4+ implementation or acceptance claim.

`packages/agent/src/tool-body.ts` now splits the actual definition promise from its result conversion. The ownership-only promise maps **both raw fulfillment and raw rejection to undefined**, independently of `toError`. The existing conversion and timeout race still receive the original raw outcome. This is seven added/four removed production lines, with no new manager or changes to executor, dispatcher, scheduler, session ownership, heartbeat, lease release, or late-commit fences.

The previous R3 report's claim that result conversion always fulfills ownership was incorrect: `String({toString: 0})` throws. That conversion remains unchanged. Before timeout, a cell still propagates its conversion `TypeError`, a wave still reports `execution_failed`, and ordinary Error rejection still produces the existing error outcome. After timeout, late failure cannot replace the frozen `timed_out` result. Normalizing ownership does not normalize the result path into success.

## Failing-first regression and exact results

Evidence **E**: `.omo/evidence/937/wave-r4/`.

The exact reviewer probe `.omo/evidence/937/review-wave-r3/st_01a0767a/timed-retention-rejection.test.ts` was read and adapted into the existing `packages/agent/test/core/execution/tool-wave.test.ts` **before production edits**. All existing test bodies are preserved.

Twelve added cases:

- Eight real executor/dispatcher/scheduler cases: cell/wave x Error/plain-value x bound/inherited owner. The actual timed definition rejects with the legal JSON value `{toString: 0}`, not an injected ownership promise. The recording ledger is the existing deterministic helper.
- The retention observer preserves the session owner's fulfillment-only deletion, but separately records rejection so the diagnostic neither leaks an unhandled descendant nor enters the nonterminating session drain.
- Bound ownership competes with distinct ambient and dispatcher retainers; inherited ownership competes with the dispatcher retainer. Foreign retentions remain zero.
- The definition subscribes to the exact zero-duration timeout before awaiting the raw gate. After timeout and caller detachment, the raw definition is still gated and exactly one ownership promise remains. Opening the gate must fulfill that promise and empty the set, with no rejected ownership, no late commits, and unchanged frozen results.
- Four before-timeout controls preserve the existing caller/result error contracts. Microtask settlement, not a delay threshold, selects the result path.

| Execution, on each Bun 1.3.6 and 1.4.1 | Exact result | Evidence |
| --- | --- | --- |
| Final regression + unchanged R3 probe, original production | **18 pass / 6 fail, 140 assertions, 24 tests / 2 files** | `red-final-<version>.txt` |
| Same regression + unchanged R3 and captured-timeout R2 probes, fixed production | **26 pass / 0 fail, 174 assertions, 3 files** | `focused-<version>.txt` |
| Related app/agent/provider tests | **416 pass / 0 fail, 1,470 assertions, 59 files** | `related-<version>.txt` |
| Process-isolated existing stream-argument tests | **10 pass / 0 fail, 44 assertions, 1 file** | `stream-args-<version>.txt` |

The six RED failures are exactly four new bound/inherited cell/wave plain-value cases and the two original reviewer plain-value cases. Every ordinary-Error control passes. The unchanged reviewer receipt changes from:

```json
{"door":"cell","reason":"plain-value","rawSettled":true,"foreignRetentions":0,"settlement":["rejected"],"rejectedOwnership":["TypeError"],"stillRetained":1,"lateCommits":0}
```

to:

```json
{"door":"cell","reason":"plain-value","rawSettled":true,"foreignRetentions":0,"settlement":["fulfilled"],"rejectedOwnership":[],"stillRetained":0,"lateCommits":0}
```

Wave receipts are identical except for `door`. The fixed focused command contains the same 24 RED cases, now all passing, plus two real captured-timeout probes. The focused test file also appears in the related run; these counts must not be summed as distinct tests.

### Preserved real-surface proof

Both final related runs pass all eight existing timed current/captured cell/wave fulfillment/rejection cases and all seven ordinary transitive-retention cases. These exercise the real app, authenticated WebSocket, public SDK interruption, Anthropic SDK/local SSE, independent SQLite reads, and gated filesystem effects. Timeout wrapper and SDK interruption complete before the raw gate opens; contender acquisition is refused while held. After the effect settles, the lease releases and the next fence can be acquired; stale body starts/actions remain zero.

The unmodified captured-cell/wave reviewer probes also pass in both final focused runs. Each records 33 persisted actions, `wrapperError=true`, `contender.ok=false`, `reason=held`, marker absent before gate release, marker present afterward, and zero stale starts. `contenderReleased=false` in their cleanup receipt is expected: the contender was refused and acquired nothing to release.

Prior provider-return ordering, staged preflight, reverse completion/positional results, approval and boundary tests pass. Related logs retain real SSE compaction receipts (six requests/two summaries), G034 archive/verify/dispose exit-0 receipts, heartbeat/fencing tests, and interpreter/socket cleanup. These are fresh runs, not inherited claims. No full-app ownership hang was deliberately induced.

## Verification and disclosed failed attempts

Installed TypeScript checks for agent tests, llm tests, app tests, and the original R3 probe pass. LSP was attempted on both changed TS files before build; every attempt returned daemon-unreachable, so no clean-LSP claim. Forced build passes **6/6 tasks, 0 cached**. Biome checks both changed TS files without suppressions or fixes; `git diff --check` passes. Compiler/LSP preceded build, and build preceded GREEN execution.

All final process partitions above pass in one execution per runtime, with no retries inside the command, sleeps, polling, skipped cases, or increased deadlines. Earlier failed attempts are preserved rather than relabeled green:

1. `red-<version>.txt`: 17 pass / 7 fail, 138 assertions. One early-result fixture incorrectly expected cell conversion failure as a result rather than a thrown TypeError. Corrected before production edits; `red-2-<version>.txt` then has the semantic 18/6 result.
2. `lint.txt`: empty observation callback and two direct non-Error throws were rejected by Biome. The callback now returns undefined; the actual definition uses `Promise.reject({toString: 0})`, without a lint suppression. The fix patch was temporarily removed, and final lint-clean tests re-proved RED against original production (`red-final-*`) before restoring the identical production patch.
3. `green-<version>.txt`: a combined 62-file command has 420 pass / 12 fail, 1,515 assertions. Ten stream-argument cases saw an undefined `ai` capture; two captured-timeout probes hit their signal deadline before entering their raw definitions.
4. `green-final-<version>.txt` is an intermediate filename, **not the final acceptance run**: removing only stream-argument tests still gives 420 pass / 2 fail, 1,512 assertions. Inspection found the other process-global `mock.module("ai")` in unchanged `packages/agent/test/agent.test.ts:117`. Neither this existing mock nor unrelated tests were edited. Final commands isolate mock-based unit tests from the real-provider probes, and isolate the competing stream-argument mock from the agent suite. The command-composition failures are not claimed fixed or claimed as baseline-reproduced source defects.

No full-repository suite, hosted CI, or new global dependency/mutation/coverage gate is claimed. Exact commands and artifact chronology are in `E/commands.txt`.

## Preservation, cleanup, and hashes

The reserved `/Users/ino/Develop/openomni-wt-937` was only read. Before/after snapshots exactly match the prior R3 snapshot: tracked diff SHA-256 `6d5ce7f8953b3911e61b35f21e597bee1a8a3436d58411ca59ccab4de52a8bb7`, all ten untracked hashes unchanged. Prior R3 evidence manifest verifies in full; review documents and both original probes are unchanged. All prior commits remain ancestors. Only `tool-body.ts`, the focused test, and this report belong to the additive commit.

Finally blocks release raw gates and await wrapper, ownership and observer settlement. Real-app tests/probes assert directory removal, closed sockets and port rebind; app regressions explicitly release acquired contender leases. Cleanup census finds no remaining Bun test process or `openomni-937-*` effect/DB directory. No background process was launched or killed; unrelated processes were untouched. The task-specific build cache is removed; requested ignored evidence is retained.

| E artifact | SHA-256 |
| --- | --- |
| `red-final-1.3.6.txt` | `e37a8bd5191a462280d4008b917a7ac13e515583730df7cf0493ee664d58599e` |
| `red-final-1.4.1.txt` | `717e88ff23f95112df7a8e0be8000d76594fabcca551e8e7ab56dec40b4ce974` |
| `focused-1.3.6.txt` | `b23f2d24521e7322d2600aba7c49bffc1f3ba69fd2b03f0cbab179cc31994791` |
| `focused-1.4.1.txt` | `42f0c1062ecbf048f97fdff4030a42b5d2faa0f753d45f8c86fc944123f8527c` |
| `related-1.3.6.txt` | `dcc1e532c4cdd14805d6ae2741a3d5fd3b7ddf68750d152dfdaef070a45e3a21` |
| `related-1.4.1.txt` | `82872f0af0670b11d940f9c2738070ee406ae1ba17258bc52fd0949fe6f0bce0` |
| `stream-args-1.3.6.txt` | `5cc7deff3c0a87c3d3207cb764856acc25bb48b4ecba83103139a61b65bec265` |
| `stream-args-1.4.1.txt` | `51bd9ebf3cd04a1b8007fa2c24b3131c1e14c29308ebf460404006bbd405270b` |
| `build.txt` | `11b19ce749dec1b6e9a160f13886121a6d89bc3becaca8b4840e8f3d362ef7cd` |
| `source-SHA256SUMS` | `020288372b6c5293f5a8509c5009cfc41f3c3ee79cf1fc5c26105af23136bfee` |

`E/SHA256SUMS` inventories evidence, `fix.patch` and `regression.patch` record the exact source delta, and `E/commit.txt` records the resulting commit/tree hashes. Existing untracked `REVIEW-R2.md`, `REVIEW-WAVE.md`, `REVIEW-WAVE-R2.md`, and `REVIEW-WAVE-R3.md` remain outside the commit. No push, PR, comment, original-worktree edit, or history rewrite.

**Assumption resolved from scope:** keep existing fallible error conversion and result contracts unchanged; correct only its coupling to timed ownership. R1 is ready for incremental review. Full #937 remains open.
