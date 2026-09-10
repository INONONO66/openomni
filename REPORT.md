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
