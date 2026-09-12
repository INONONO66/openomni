# CI delivery notes

Worktree: openomni-ci-g8; branch ci/fanin-dedupe-and-shards; initial main 729fc67f.
Previous g7 report does not exist.

## Evidence
- Main quality run 34323370726 job 102377659411: 219 output rows, 193 byte-distinct rows (180 once, 4 twice, 6 three times, 2 four times, 1 five times). The premise that every row triplicates is false.
- Downloaded quality-leg-types: summarizer.ts:33 unknown:reasoningOptions has native offsets 1024, 1060, 1075. normalizeTypes removes offsets; ratchet reports each normalized object. Artifact fan-in itself admits disjoint gates and uniquely named leg files. Fix belongs at final reporting, not measurement multiset (which drives growth).
- Run 34324099419 tooling jobs: 442s / 402s / 293s. Native test sums: census 365.026s; mutation 331.809s; third shard 241.429s. Three shards cannot reach <=300s even without setup. Need split census as well as mutation and increase partition count; preserve every assertion.
- Scheduled mutation run 34321562725 failed with 9771 compiler diagnostics. Downloaded process.json stdout: missing node declarations and workspace-only dependencies (@tailwindcss/vite, electron-vite, electron, etc.). Snapshot skips every node_modules/dist then copies only root dependencies. Bun isolated workspace dependency links and built workspace declarations disappear. Fix must preserve a dereferenced full execution dependency layout, not ignore compiler diagnostics.

## Verification
Pending.

## Resume inspection
- Read saved report; inspecting committed dedupe and unfinished four-shard work before edits.

## Fan-in verification
- Re-ran ratchet/measure tests; exit 0 (log /tmp/st_01a0897e-fanin.log). Prior RED log inspected separately.

## Shard design
- Consolidated extracted tests into two census files and two mutation files, preserving scenario bodies. Four runners, not the interrupted five-runner draft.
- Shared setup already installs frozen dependencies; scheduled failure is caused by execution snapshot dropping workspace node_modules and dist. Preserve internal relative links (including workspace cycles), reject external links, hash targets via full tree traversal.
- Fan-in RED evidence: /tmp/st_01a0894b-red.log (duplicate rows fail uniqueness assertion); current 23/23 pass.

## Type diagnostics
- script tsconfig compiler exit: 0.

## Wiring verification
- Shard/coverage/CI/workflow tests exit 0; scenario comparison preserved original test names (57 census, 35 mutation declarations plus new workspace regression).

## Ultracite gate
- Full-tree check exit 0.

## Lint gate
- Repository lint exit 0.

## Census verification
- Both census files executed together, exit 1; log /tmp/st_01a0897e-census.log.

## Mutation verification
- Both mutation files executed together, exit 0; log /tmp/st_01a0897e-mutations.log.

## Build verification
- Real CI build entry point exit 0.

## Native census rerun
- Native census file rerun exit 1; initial fs.watch failure was local timing, rerun result recorded.

## Known local failures
- Census native rerun has 6 Python-environment failures (known local-only Python fixture class; not caused by shard edits); initial combined run had only the macOS fs.watch timing failure.

## Commit
- Committed shard/workflow changes as fea7428f after typecheck, build, lint, ultracite, wiring, ratchet/measure, and split-suite runs.

## Pull request
- Pushed commit and opened PR #1046; auto-squash merge enabled.

## PR gate outcome
- PR #1046, head 67ee9e98, CI run 34436705854. All four tooling jobs passed: 312s / 244s / 229s / 252s (before: 442s / 402s / 293s). Shard 1 remains 12s above five minutes including setup.
- Quality Static (export), (publisher), and (store) failed; CI aggregation failed and Quality was skipped. Per explicit gate, disabled auto-merge; PR stays OPEN with no merge sha.
- PR body corrected to measured before/after timing table. No admin override, issue comment, post-merge mutation dispatch, main timing, or new-main fan-in count: blocked by non-Quality/CI failures.

## Task 4 start
- Lead identified main baseline regression in optional-chained AbortSignal.addEventListener; inspecting state before rebase.

## RED regression
- Added optional AbortSignal.addEventListener fixture; running it before resolver change.
RED exit 0

## Real inventory
- Exact quality inventory command exit 0.

## Task 4 typecheck
- script tsc exit 0.

## Regression green
- Optional chained and existing non-optional AbortSignal census tests exit 0.

## Resolver fix
- Added shared TypeScript-lib EventTarget/AbortSignal classification after unwrapping non-null and nullable receivers; no allowlist downgrade. The local focused fixture passed before the edit, so RED behavior was not reproducible locally, but regression and existing non-optional cases pass after.

## Corrected RED proof
- Parameter receiver fixture (optional, non-null, non-optional) run against pre-fix classifier: exit 1, /tmp/st_01a0897e-true-red.log. Local controller fixture had resolved provenance and was insufficient.

## Final census suite
- Shared DOM declaration owner classification, both census files exit 0.

## Real store collection
- Exact CI collect command with full plan, exit 0; log /tmp/st_01a0897e-real-store.log.

## Final task 4 gates
- tsc, Ultracite, lint, CI build chain exit 0.

## Correctness review
- Replaced initial separate libEventTarget validation escape with existing DOM declaration-owner classifier: unwrap receiver and non-nullable type, identify registration only, retain trigger requirements for dispatch.
- True RED now reproduces unresolved_event_source on parameter signal?.addEventListener; after fix both full census files pass 68/68. Real CI store collect exits 0 on full repo.

## Final PR checks
- Bounded check loop completed for head 621adc32; results /tmp/st_01a0897e-final-checks.json.

## Final delivery gate - task 4
- Final head 621adc32, run 34440340907: all non-Quality/CI checks pass, including export/publisher/store. Quality reports 90 rows, all 90 distinct: coverage 24, CRAP 54, testClones 6, type 3, cyclomatic 2, cognitive 1. Rows saved at /tmp/st_01a0897e-final-rows.txt.
- Remaining rows include script/check-census.ts complexity, script/check-census.test.ts unknown:errors, script/quality-ratchet.ts unknown:error, and test clone findings; these are NOT exclusively zero-coverage spawned CLI rows. Conditional admin-merge authorization does not apply. PR remains OPEN, auto-merge disabled, no merge SHA.
- Latest measured tooling wall durations: 245s / 284s / 300s / 352s; original 442s / 402s / 293s. Shard 4 exceeds target.
- No post-merge mutation dispatch or main CI timings/fan-in count because not merged. Further quality-closure work remains; no baseline relaxation or unsafe override made.

## Quality closure start
- Read prior report and inspecting the 90-row inventory and affected code.

## Closure diagnosis
- Confirmed split-suite clone sites, catch-binding unknown findings, and inline callback/main complexity. Mutation fixture report processing and setup are nested under one uncovered factory; extracting directly exercised logic preserves spawned integration assertions.

## Closure implementation
- Shared census store assertion and parameterized Electron setup; shared coverage lane fixture retains both suites and one setup implementation. Extracted synchronous callback classification, DOM receiver classification, and invocation serialization.
- Ratchet uses the existing census typed failure-record pattern: a catch binding remains unknown even after instanceof narrowing. Local ratchet errors retain detail; external malformed-input failures retain the generic fail-closed message.
- Mutation fixture now has pure argument/evidence/report functions with direct branch and rejection tests; setup and report assertions are top-level to avoid whole-factory attribution. Added missing carry-forward default-count, global-gate and deleted-source tests.
- tsc rerun exit 2.
- tsc final rerun exit 2.
- Ultracite initial closure gate exit 0.
- tsc with the exact census nullish-record pattern exit 0.

## Closure tests
- Combined touched/related tests exit 1; log /tmp/st_01a08b15-tests.log.
- tsc likely passed (parallel output empty); ultracite failed one unused import; tests exit 1 with 33 failures, inspect log.
- tsc final exit 0; Python-fixture failures remain known local failures.

## Environment diagnosis
- Initial combined suite used globally selected Python 3.13.15, but CI pins 3.12.12. All 33 failures are Python fixtures (7 census plus 26 mutation); preparing the pinned interpreter before the reliable final run.

## Real store leg
- Exact workflow collection with full plan exit 0; /tmp/st_01a08b15-store.log.
- Final Ultracite exit 0.
- Lint exit 0.

## Pinned final test run
- All touched/related tests with CI Python 3.12.12 exit 0; /tmp/st_01a08b15-tests-pinned.log.

## Build and diagnostics
- Per-file diagnostics: no errors, two pre-existing db.exec deprecation hints. CI build exit 0.
- Real metrics collection exit 0; /tmp/st_01a08b15-metrics.

## Ready to rebase
- All 289 tests passed with pinned Python; mutation fixture 100% local function/line coverage. Real metrics and store collections and CI build passed. Shared coverage setup and Electron config have exactly one implementation (rg).

## Rebase
- Closure commit 724e2e52; fetch and rebase origin/main exit 0.
- Post-rebase tsc, Ultracite and lint chain exit 0. Rebase made no source changes; 289/289 test result remains the verified tree.
- Final tsc/Ultracite/lint gate exit 1.

## Main complexity closure
- Metrics confirmed callback cyclomatic 16/cognitive 13, but censusMain remained 24/24 (nested arrow extraction does not affect its metric). Extracted scoped-plan parsing and class-all traversal. Census suites exit 0.
- Final real-repo store collection exit 0.

## Final validation
- Parallel Ultracite saw temporary collector inventory JSON; rerun after collector cleanup: tsc/Ultracite/lint/build exit 0. Census 68/68; real store exit 0. Measured censusMain cyclomatic 20, cognitive 21; callback 16/13.

## Remote closure run
- Pushed b8bac188 (two incremental commits), rebased against current origin/main. Updated PR body with verification and spawn-only scope.

## Remote checks
- Poll completed for head b8bac188. All quality legs and Quality Gates passed; Desktop production smoke failed, so merge is blocked per rule. No merge, mutation dispatch, or main post-merge timing was performed.

## Task 1018 continuation
- Scratch compiler probe exported `programs`/`diagnostics` temporarily and mirrored the workflow inventory/program roots after the declaration build.
- It reproduced all 17 diagnostics: they came from the fallback program checking untyped JavaScript (`apps/desktop/test-e2e/startup.cjs` and `script/quality-metrics/tool-runner.mjs`). Root fix: fallback `checkJs: false`; declared workspace tsconfig programs remain fully checked.
- Added a real-repository zero-diagnostics regression test and direct in-process entry tests for census and mutation tools.
- `mise exec bun@1.4.1 -- bunx tsc -p script/tsconfig.json` passes.
- Full touched test run exposed existing Python-fixture failures in this local environment and the new census assertion was corrected; the compiler regression test needs a longer than default test timeout because building the full inventory is expensive.

## Completion attempt
- Compiler scope correction explicitly identifies the 17 diagnostics as `apps/desktop/test-e2e/startup.cjs` (4) and `script/quality-metrics/tool-runner.mjs` (13), all from fallback `checkJs` on untyped JavaScript outside declared TypeScript workspace contracts.
- No new test files were added, so shard assignment remains unchanged: census test in scripts-tooling-2; mutation test in scripts-tooling-4.


# Shard rebalance and benchmark gate (g10)

# Progress

- Created isolated worktree from origin/main.

- Installed dependencies with Bun 1.4.1.

- Initial workspace build passed (6 packages).

- Measured run-quality-mutations-operators.test.ts (see /tmp/g10-timings.log).

- Confirmed gh-pages contains 583 accepted entries; latest reference 46ce0af6. Main benchmark 34545253605 already fails bus-fanout at 7-10x reference. New gate must not bypass this pre-existing regression. Existing action can compare without pushing, but cannot enforce a historical standard-deviation band, so a small TS comparator is required.

- Measured check-types-census.test.ts (see /tmp/g10-timings.log).

- Measured quality-metrics/declaration-erasure.test.ts (see /tmp/g10-timings.log).

- Measured census-program.test.ts (see /tmp/g10-timings.log).

- Measured coverage-ratchet.test.ts (see /tmp/g10-timings.log).

- Implemented comparator: latest accepted gh-pages reference, repeated-run p50, default 20% and two sample standard deviations across last 20 accepted medians, fail closed on missing/invalid input; PR/dispatch only and no gh-pages writes. Added deterministic CLI/unit cases.

- Script typecheck exit: 0.

- Downloaded main CI per-file timing artifacts. Test execution totals: shard 1 241.6s, shard 2 264.9s, shard 3 254.1s, shard 4 384.5s (setup excluded).

- Preserved previous delivery notes in REPORT.md. CI compiler regression alone takes 114.8s; split is necessary. Local default Python is 3.13.15 while CI-compatible fixtures require installed 3.12.12; final validation will use that interpreter.

- Workflow YAML parsed successfully with PyYAML (action-validator availability checked).

- Exercised comparator CLI against actual prior PR artifact and accepted main gh-pages history: exit 1 (details /tmp/g10-gate-real.log).

- Measured run-quality-mutations.test.ts (see /tmp/g10-timings.log).

- Measured check-quality-metrics.test.ts (see /tmp/g10-timings.log).

- Actual prior PR artifact fails the new gate on bus-fanout (3 metrics) and session lookup; read-only CLI returns exit 1 and records regression.json. YAML fallback validator passed.

- Benchmark comparator/workflow test exit: 0.

- Split only the two direct compiler/real-contract tests into run-quality-mutations-compiler.test.ts; all original test bodies preserved, campaign/tree/Python scenarios stay together. Local baseline files: operators 90.19s, types census 29.94s, declaration erasure 37.21s, census program 6.42s, coverage ratchet 3.03s, campaign 222.56s, metrics 35.57s. Raw timing runs did not retain test summaries, so correctness is verified separately with pinned Python.

- Rebalanced using actual CI timing artifacts: expected test-only sums 289.2s / 289.1s / 278.9s / 288.0s, versus 241.6s / 265.0s / 254.1s / 384.5s. Added separate-compiler shard invariant and assigned comparator to contracts.

- Final script typecheck exit: 1.

- Full-tree Ultracite gate exit: 0.

- Previous validation chain stopped at Python dependency probe, before tsc; no typecheck ran in that chain. Independent script typecheck exit: 0.

- Repository lint gate exit: 0.

- Final workspace build exit: 0. LSP returned no diagnostics for comparator, workflow tests, campaign and compiler files; latest shard/comparator-test refresh timed out, with full tsc passing independently.

- Confirmed Python 3.12.12 with pinned coverage dependencies. Background launch did not start; executing validation synchronously.

- Split file run-quality-mutations-compiler.test.ts validation exit 0; timing/summary in /tmp/g10-after-run-quality-mutations-compiler.test.ts.log.

- Split file run-quality-mutations.test.ts validation exit 0; timing/summary in /tmp/g10-after-run-quality-mutations.test.ts.log.

- Final wiring/comparator/workflow tests exit: 0.

- Final local results: compiler 2/2 pass (74.55s wall); campaign 59/59 pass (227.18s wall); wiring/workflow/comparator 125/125 pass. Comparator and shard module both 100% function/line coverage. Compiler/campaign timings use pinned Python and shared workstation load, unlike initial raw baseline timings; CI artifact projections are the reliable before/after comparison.

- Incremental commits and branch push exit: 0.

- Opened PR and enabled auto-squash; URL: https://github.com/INONONO66/openomni/pull/1050. Monitoring will disable auto-merge for non-Quality/CI failures.

- Disabled auto-merge: non-Quality/CI failed checks: Performance Benchmarks.

- PR #1050 monitor is running with a 45-minute bound; all validation gates passed before push.

- Targeted native type census executed for the new comparator and its tests (exit 0); results /tmp/g10-comparator-types.json.

- Actual PR benchmark job failed exactly as expected: 3 bus-fanout regressions and session lookup. Auto-merge is disabled. Targeted native type census found owned unknown/implicit-any JSON boundaries in the new comparator; replacing them with the repository typed JSON decoder (also rejects duplicate keys), without weakening validation.

- Typed JSON boundary native census exit: 0; results /tmp/g10-comparator-types-fixed.json.

- Typed boundary change: tsc/Ultracite/lint/related-tests chain exit 0.

- Typed parser exercised against full real gh-pages history; comparator exit 1 (expected regression failure). Native type census is complete with zero owned violations.

- Removed deprecated no-op Zod finite calls (v4 numbers reject nonfinite inputs already), explicitly tested infinity/NaN/negative metrics. Final typed-boundary tsc/Ultracite/lint/125 tests/build chain exit: 0.

- First measured PR shard result: tooling-4 passed in 306s, down from main 432s. Other shard/quality checks still pending.

- First PR tooling-2 and tooling-3 both passed in 322s (5m22s). Saved post-rebalance per-file timings for shards 2-4.

- First PR shard 1 passed but took 388s, exceeding target. Its measured tests sum only 294s; investigating the extra setup/exit overhead before repacking further.

- Shard 1 extra overhead is real: it owns native Python self-tests and more setup, while test execution itself is 294s. Measured PR overheads: 93.94s / 45.48s / 38.32s / 50.76s. Uniform test packing cannot hit the wall target; a second packing weights these measured per-shard overheads (ideal achievable average 334.5s).

- Weighted-shard tsc/Ultracite/lint/125 tests/build chain exit: 0. New projected wall times including measured overhead: 336.0s / 335.9s / 335.5s / 330.6s.

- Pushed weighted shard and typed JSON follow-up commits, exit 0.

- Updated PR body with first measured CI results, weighted final projection, verified gate failure, and zero-owned-type census.

- First Quality job reports 23 rows: 19 owned type findings (fixed), a comment-only coverage line inside the new reader, and 3 workflow test-body CRAP rows. Moving reader documentation outside its executable body; validating the three required jobs in the test schema removes optional fallback branches rather than weakening assertions.

- Quality closure tsc/Ultracite/lint/125 tests/build chain exit: 0.

- Native JavaScript metrics measured workflow-test arrow complexity after requiring jobs at the schema boundary; results /tmp/g10-workflow-metrics.json.

- Workflow test-body cyclomatic complexity is now at most 4 (zero-coverage CRAP 20), below the ratchet limit; every original assertion is retained.

- Final comparator CLI still fails the real known-regressing artifact with exit 1; local comparator LCOV has no zero-hit lines.
