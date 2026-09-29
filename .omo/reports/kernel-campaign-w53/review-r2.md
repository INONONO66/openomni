# PR #1240 adversarial review, round 2

**Verdict: NO-GO.**

**Findings: 1 blocker (Owner STOP), 5 majors, 1 minor.**

Reviewed the complete 17-commit, 209-file `git diff origin/main...HEAD` in
`/Users/ino/Develop/openomni-w53`, at
`19c9d856c4763063fbf3b77b84d22591c4e8cb94`, against
`8390912c5b08f97611295a9a2586135a52830adf`.
Read `review-r2-brief.md` first, then A1-A6, A2b, A4b,
W4-1112-receipt, review-r1, F1/F2, C1/C2/C3, D-docs, and B-verify.
The seven round-1 findings are not re-raised as unfixed.

## Findings

1. **Blocker / Owner STOP: an existing accepted receipt gained a field.**
   `packages/channels/src/websocket.ts:220-233`;
   `apps/openomni/src/index.ts:666`;
   `packages/protocol/src/gateway/session-read.ts:61-65`.

   The base sends `{type:"receipt",status:"accepted"}` for a text request.
   This branch forwards the admission result and adds `result` to that
   existing frame. The brief permits additive *frames*
   (`session_read/session_snapshot/session_page/session_gap`), and explicitly
   makes **any existing-frame shape change** a STOP finding. Optionality and
   compatibility with the old permissive desktop parser do not satisfy that
   stronger requirement.

   **Executed evidence:** the production `WebSocketHandler.handleFrame`,
   supplied an executed admission, emitted:

   ```json
   {"type":"receipt","status":"accepted","result":{"status":"executed","handle":{"messageId":"in-1","target":"durable-1"},"delivery":{"kind":"session"}}}
   ```

   `git show 8390912c:packages/channels/src/websocket.ts` confirmed the former
   return has exactly the two original keys. The existing real-app
   `session-cursor.test.ts` also passed its new receipt-result assertion.
   Round 1's narrower check for removed/renamed/retyped fields missed this
   addition; it is not a repeat of a landed finding.

   **Minimal fix:** preserve the original accepted receipt unchanged and
   carry durable binding through an authorized additive frame, with explicit
   correlation. Alternatively, obtain an explicit Owner amendment to the
   frozen-frame rule before treating this addition as allowed.

2. **Major: baseline and candidate compilers disagree about valid source.**
   `script/run-quality-mutations.ts:790-794`;
   consumers `script/quality-mutation-compiler.ts:73-78,121-128,160-165`.

   The new baseline path filters diagnostics to a project's root files.
   The persistent candidate compiler still collects every diagnostic from
   every importer, including frozen projects. Therefore a diagnostic that
   this PR deliberately removes from baseline admission returns during
   candidate checking. `run-quality-mutations.ts:1492-1496` then classifies the
   candidate as `invalid`, without executing its tests.

   **Executed evidence:** reused the new test's contract: project A has
   `lib:["ES2022"]` and imports B through a paths alias; project B has
   `lib:["ES2022","DOM"]` and exports `document.title`. Both source files are
   native roots in their own projects. `analyze(...).sourceDiagnostics` is
   `[]`, but `FrozenMutationCompiler.check()` on B's **unchanged original
   bytes**, with matching original/source/tree hashes, returns:

   ```text
   originalValid: false
   b/value.ts(1,22): error TS2584: Cannot find name 'document'.
   ```

   Thus the check rejects code the baseline just accepted; no actual mutation
   is necessary. The existing baseline regression passes because it never
   invokes the candidate checker on that fixture.

   **Minimal fix:** give baseline and candidate checks one diagnostic
   ownership rule, including frozen and incrementally rebuilt projects.
   Preserve errors attributed to real consumer root files. Extend this
   regression through the candidate compiler, proving unchanged bytes valid
   and a genuinely invalid mutation invalid.

   **Limit:** the real checkout's unfiltered native compiler baseline also
   returned zero diagnostics on this Mac. This is a demonstrated contract
   defect, not a claim that current HEAD's local candidate set is all invalid
   or that a full mutation campaign was run.

3. **Major: the scheduled audit cannot read its existing summary history.**
   `script/quality-audit.ts:57-64`;
   consumer `script/quality-audit-issues.ts:12-16,29-32,174-175`.

   Adding required `cyclomatic`, `halstead`, and `crap` fields to the shared
   totals schema also changes the parser for the persisted version-1 summary.
   That existing summary does not contain the new dimensions. The next audit
   throws before planning a publication instead of comparing and preserving
   its existing history.

   **Executed evidence:** fetched the actual
   [summary issue #1119](https://github.com/INONONO66/openomni/issues/1119)
   read-only. Its machine-consumed footer is:

   ```json
   {"version":1,"head":"5b925d12bbfa154c40c84ddaed3652c999984251","totals":{"coverage":3116,"complexity":17,"clones":280,"types":2779}}
   ```

   Passing that exact body to `previousAudit()` produced three
   `invalid_type` errors at `totals.cyclomatic`, `totals.halstead`, and
   `totals.crap`; the probe exited 1.

   **Minimal fix:** separate historical-summary decoding from current-output
   validation. Accept the existing version-1 dimensions and explicitly treat
   the newly introduced dimensions as not previously measured, rather than
   inventing historical zeros or resetting the summary. Add the actual old
   footer shape to the publisher regression.

4. **Major: overlapping reads lose a waiter permanently, including on close.**
   `apps/desktop/src/renderer/chat/gateway-transport.ts:206-217`;
   cleanup at `:185-189`.

   `reads.set(sessionId, ...)` silently replaces an existing waiter. All
   response/error/close cleanup can subsequently reach only the replacement.
   The first exported `readSession()` promise can never settle, even after
   the connection is gone. The added close and error tests use only one read.

   **Executed evidence:** called `readSession("same")` twice, waited for the
   server to receive both frames, then stopped the real Bun WebSocket server.
   No sleep or timing race was used:

   ```json
   {"requests":2,"first":"Promise { <pending> }","second":"gateway socket closed unexpectedly"}
   ```

   A controlled socket independently reproduced the same first pending
   promise for both `close` and `error`. Ordinary single-read close and
   send-failure regressions pass.

   **Minimal fix:** explicitly coalesce compatible reads, keep every waiter,
   or reject supersession before replacing the entry. Define what happens
   for differing cursors. Every admitted caller must settle on success,
   session error, socket error, and close. QueryClient's ordinary per-key
   deduplication does not establish that contract for the exported transport.

5. **Major: a one-action inspection can perform an unbounded ancestor scan.**
   `packages/agent/src/session-lifecycle/inspect.ts:42-59`.

   The round-1 attribution fix walks parents until it finds a turn or reaches
   the root. Those indexed reads are outside both budgets in `inspectSession`.
   Each individual lookup is indexed, but their count is proportional to the
   entire preceding chain. This restores unbounded work inside the supposedly
   bounded inspection read, even with depth zero and limit one.

   **Executed evidence:** a real ledger with configure plus 300 causally
   linked message actions; inspected only its final action using
   `{depth:0,cursor:300,limit:1}`. A wrapper counted calls to the real indexed
   `actionById`:

   ```json
   {"limit":1,"returned":1,"ancestorReads":300,"headRevision":301}
   ```

   **Minimal fix:** bound ancestry resolution as well as returned actions,
   using an indexed nearest-turn fact or an explicit resumable ancestry
   budget. Do not merely truncate to `turnId:null`, which would restore the
   round-1 attribution bug. Add a long-chain, one-action-page regression that
   asserts both correct attribution and bounded lookup work.

   The descendant off-by-one itself is fixed: limits 1, 2, 3, and 256 stayed
   within aggregate action/descendant budgets on a depth-two tree. Its existing
   small-limit test also killed the review's one-line budget mutant.

6. **Major: transitive-only inventory files fall between native and fallback ownership.**
   `script/run-quality-mutations.ts:781-784,797`;
   `script/quality-mutation-input.ts:48-61`.

   `analyze` now accepts only native root files, while `programs` still marks
   **all transitive source files** covered and excludes them from its inventory
   fallback. A mutable inventoried source imported by a project, but not in
   any project's root list, is consequently enumerated with no program. This
   is not the declared fallback behavior and was previously accepted through
   its importer.

   **Executed evidence:** the A/B fixture above with only
   `projects:["a/tsconfig.json"]`, but both A and B in the inventory, returned:

   ```json
   {"sourceDiagnostics":[],"errors":["b/value.ts: no owning compiler project"]}
   ```

   Its B census row is `syntax:"incompleteInventory",astNodes:0`. Adding B's
   project makes that error disappear; the branch's fixture edits do exactly
   that, rather than testing that fallback still covers the old case.

   **Minimal fix:** align the generator's covered set with the new canonical
   root ownership policy so otherwise-unowned inventoried files enter the
   fallback. Keep shared-file ownership deterministic and cover native-root,
   transitive-only, and truly unreferenced fallback inputs together.

7. **Minor: phase metadata is read after the final consistency check.**
   `apps/openomni/src/gateway.ts:220-232`, through `:178-179`.

   The before/page/after check protects history, terminal, and latest-action
   capture, but `phaseFacts` then performs fresh `latestOpenTurn` and
   `actionById` reads. A commit in that interval can combine an old page/head
   with a new turn's phase timestamp instead of returning the promised gap.

   **Executed evidence:** used the same real-commit kernel-wrapper technique
   as `gateway-session-read.test.ts`, but injected the commit during
   `latestOpenTurn`, after the last row check. The commit sealed turn 1 and
   opened turn 2. Observed:

   ```json
   {"type":"session_snapshot","headRevision":2,"phase":"running","phaseSince":900,"actionIds":["r2-race:configure","turn-1"],"actualHead":4}
   ```

   **Minimal fix:** capture phase facts before the final fence/revision
   validation, or capture all fields inside one ledger snapshot. Add this
   later interleaving to the existing torn-page regression.

   **Assumption/limit:** synchronous reads in a single JavaScript process do
   not interleave by themselves. The probe deterministically models another
   writer; it is not a reproduced spontaneous single-process race.
   Separate-process session writers are a supported composition boundary
   (`apps/openomni/src/process-entry.ts:286-292` opens the request's catalog
   and session directory). If an enforced invariant prevents such a writer
   from ever overlapping this reader, that would downgrade this finding.

## Checks and counter-cases

- **Round 1:** terminal pages no longer close chat streams; same-head empty
  continuations retain cached activity; small-limit child paging advances;
  paged causal attribution passes; script catches no longer introduce those
  two inferred-any callbacks; ordinary phase timestamps and exact resume
  delivery cardinality are retained. Findings 5 and 7 above concern newly
  exposed bounds/consistency seams, not the old failures being left unfixed.
- **Runtime boundaries:** boundary gate passed; runner allowlist is `[]`.
  Independent production search found seven calls, all in the two approved
  app edges (`cli/main.ts` and `gateway.ts`). No Effect imports in
  protocol/UI/desktop/tool bodies, production imports of test helpers,
  agent `ConfigProvider.fromEnv`, or `turnId:"noop"` residue were found.
- **Types and tests:** written-type gate reports zero. No added sleep/poll,
  skipped-test, or suppression patterns were found in changed tests.
  Normal close/error/send-failure tests pass; only overlapping reads exposed
  the waiter loss.
- **CLI semantics:** real subprocesses proved `runScriptMain` success exits 0
  without output; Error and string rejection exit 1 with exactly
  `ERROR: gate broke\n` and `ERROR: plain reason\n` on stderr. Setting
  `process.exitCode=7` inside a successful main still exits 7.
  The old `console.error` variant in check-deps and the shared stderr writer
  have the same tested output/exit behavior.
- **Module import:** importing check-written-types with
  `process.argv=["bun","caller","--root","/no/such/r2-root"]` neither runs the
  gate nor changes the exit code (`IMPORT_OK 0`). Missing `--root` value exits
  1. A file instead of a directory also fails closed with ENOTDIR/exit 1;
  its stack-shaped diagnostic is not a false-green result.
- **Documentation:** W5.3 remains explicitly pending merge. Docs do not
  claim hosted CI, patch coverage, or mutation completion. The broad
  "closes the W5 absolute-quality lanes" wording should not be read as a
  literal-zero receipt; the same section discloses remaining debt and
  incomplete evidence. No legacy migration or alternate runtime was added.

The strongest counter-case is finding 2's unchanged, correctly hashed source:
baseline admission is green but the actual candidate compiler rejects it.
For finding 3, this is the live persisted issue body, not an invented legacy
fixture. Conversely, the full native baseline at current HEAD is clean
locally; do not extrapolate the fixture defect into an unrun campaign claim.

## Commands and observed exits

All Bun commands below used this launcher, with `/opt/homebrew/bin` removed
from inherited PATH and
`D945_PYTHON=/Users/ino/.local/share/mise/installs/python/3.12.12/bin/python`:

```text
B = /opt/homebrew/bin/mise exec bun@1.4.1 -- bun
cwd = /Users/ino/Develop/openomni-w53
```

| Command/check | Exit/result |
| --- | --- |
| `git status --short`; branch/revision checks; `git log --oneline origin/main..HEAD`; full `git diff origin/main...HEAD` | 0; pinned branch/HEAD/base, 17 commits, initially clean |
| `B run build` | 0; 7/7 tasks |
| `B run check-types` | 0; 17/17 tasks plus script compiler |
| `B run lint` | 0; guard, side-effect, docs, and Ultracite checks |
| `B run lint:tools` | 0 |
| `B run check-effect-boundaries` | 0 |
| `B run check-written-types` | 0; written any/unknown types: 0 |
| `B run script/check-topology.ts` | 0 |
| `B run script/check-deps.ts` | 0; one stale `packages/channels/AGENTS.md` warning, 51 commits versus threshold 50 |
| `B run script/check-import-cycles.ts` | 0; 439 modules, 0 value-import cycles |
| `B run script/check-dead-exports.ts` | 0; 12 workspaces, 0 known/new issues |
| `B run script/verify-tsconfig-inheritance.ts` | 0; 35 projects, 1201 claimed inputs |
| Product test command below | 0; 121 pass, 0 fail |
| Script test command below | 0; 180 pass, 0 fail |
| Scratch counterexample tests | First run: 7 pass, 1 fail, exit 1; the failed probe used an invalid generation 0. Corrected it to the actual generation; targeted torn-phase rerun: 1 pass, exit 0 |
| Real-socket overlapping-read `B -e` probe described in finding 4 | 0; first promise remains pending after actual socket close |
| One-action inspection `B -e` probe described in finding 5 | 0; 300 ancestor reads |
| Real `previousAudit` import with issue #1119 body | 1; three missing metric fields |
| Real CLI probes described above | 0, 1, 1, 7 respectively; import-only 0; invalid roots 1 |
| Native compiler-only probe: `diagnostics(programs(root, contract, buildInventory(root, contract)), root)` using the shipped contract | 0; `NATIVE_BASELINE_DIAGNOSTICS=0`; no candidate campaign |
| Inspection mutant: `descendants = limit - 1`; `B test --config=/dev/null packages/agent/test/session-inspection.test.ts -t 'limits 1 and 2'` | 1; 0 pass, 1 fail, expected child-a but received no children |
| `git checkout -- packages/agent/src/session-lifecycle/inspect.ts` | 0; exact user-authorized mutant restoration |
| Same focused inspection command after restoration | 0; 1 pass |
| `B test --config=/dev/null packages/agent/test/durable-reconstruction.test.ts -t 'fresh-process refuses tampered checkpoint foldVersion before writes'` | 0; 1 pass locally |
| LSP diagnostics on gateway, transport, queries, inspect, written-types, main-runner, mutation runner | Initially no errors in all seven. A post-restoration inspect refresh timed out; source was restored byte-for-byte and its focused test passed |
| `git diff --check origin/main...HEAD` | 0 |
| `git diff --exit-code`; `git diff --cached --exit-code`; final `git status --short` | 0; no tracked/staged changes, status empty |
| `gh pr checks 1240 --watch --interval 30` | 1; final hosted checks were not green |
| Read-only `gh issue list/view` and completed-job `gh api --allow-escape-sequences .../logs` | 0 |

Exact focused product command:

```sh
B test --config=/dev/null --timeout 15000 \
  apps/openomni/test/session-cursor.test.ts \
  apps/openomni/test/gateway-phase-since.test.ts \
  apps/openomni/test/gateway-session-read.test.ts \
  apps/openomni/test/gateway-contracts.test.ts \
  apps/desktop/test/gateway-transport.test.ts \
  apps/desktop/test/session-read-model.test.ts \
  packages/agent/test/session-inspection.test.ts \
  packages/agent/test/attempt-metrics.test.ts \
  packages/protocol/test/json-boundary.test.ts \
  packages/protocol/test/error.test.ts \
  packages/protocol/test/policy/input-schema-parity.test.ts \
  packages/channels/test/websocket.test.ts \
  packages/ipc/test/framing.test.ts
```

Exact focused script command:

```sh
B test --config=/dev/null --timeout 300000 \
  script/main-runner.test.ts script/check-written-types.test.ts \
  script/check-effect-boundaries.test.ts script/check-dead-exports.test.ts \
  script/census-consumer-contract.test.ts script/quality-audit.test.ts \
  script/quality-audit-issues.test.ts script/run-quality-mutations-compiler.test.ts \
  script/generate-models-snapshot.test.ts script/lint-guards.test.ts \
  script/lint-tools.test.ts
```

Probe setup: the ignored review-only test file exercised real kernel stores,
the production handler/transport, and the compiler APIs. Its temporary
compiler project used exactly the A/B files and lib/path settings in finding 2.
With only A in `projects`, the same files reproduced finding 6. Probe tests
asserted observed defects rather than pretending to be green product
regressions. Scratch tests/fixtures and the journal were removed after their
observations were recorded here. Tests used `--config=/dev/null`; shared LCOV
was not overwritten by this review.

Setup/tool failures are not product findings: an attempted read of nonexistent
`packages/protocol/src/ledger/session-turn.ts` was corrected to `ledger/l0.ts`;
temporary fixture LSP had no TypeScript install; the first scratch imports
were corrected to repository-relative imports; `gh run view --log-failed`
was unavailable while the workflow was active; initial job-log API reads
refused terminal escapes until explicitly allowed. One runner regex was
sanitized incorrectly by the search tool and was rerun with literal
parenthesis syntax.

## Hosted evidence and verification limits

The monitored PR remained OPEN/DRAFT at the reviewed HEAD. Final check summary:
**25 successful, 3 failing, 2 skipped, 0 pending.**

- [Test (agent)](https://github.com/INONONO66/openomni/actions/runs/36520609023/job/109252640139):
  849 pass / 1 fail; `fresh-process refuses tampered checkpoint foldVersion
  before writes` timed out at 5002.47 ms, with
  `timed out waiting for reconstruction write`. The unchanged test passed
  when run locally here; its hosted root cause is not established and it is
  not certified as pre-existing.
- [Performance Benchmarks](https://github.com/INONONO66/openomni/actions/runs/36520609010/job/109252396490):
  `compaction/should-compact` measured 162.07365268284605 ns/op against
  reference 133.30021448017962 and limit 159.96025737621554; FAIL, exit 1.
  No baseline reset or rerun was performed.
- Aggregate CI failed; Patch Coverage and benchmark publication were skipped.
  C3's local patch-coverage receipt is not a hosted passing gate.

This review did not run the full repository suite, a mutation campaign,
native Electron, external providers, or new visual screenshots. The exercised
surfaces were actual WebSockets, app/kernel reads, public transport/compiler
imports, and real CLI subprocesses. Existing lane receipts were read, not
represented as new independent execution.

## Recommendation

Do not merge or close W5.3 from these receipts. Resolve the frozen-frame STOP,
the five major defects, and the late snapshot check; rerun the affected
regressions and require hosted CI/patch coverage to complete. Keep the
literal-zero and full-mutation claims open.

Recommended fixes above are review recommendations, not implemented or
verified patches. No source fix, staging, commit, push, external comment, or
history change was performed. The only tracked edit was the explicitly
authorized one-line mutant, restored with `git checkout -- <file>`.
