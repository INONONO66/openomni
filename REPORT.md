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
