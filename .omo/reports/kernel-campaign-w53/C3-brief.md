# W5.3 #1113 wave C lane C3: close patch-coverage gaps

Worktree: /Users/ino/Develop/openomni-w53 (branch kernel/1113-w5-closure-20260929, HEAD 10c26e80, draft PR #1240). Do NOT commit. Bun via `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`; remove /opt/homebrew/bin from PATH when running tests (`export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '^/opt/homebrew/bin$' | paste -sd: -)`). D945_PYTHON=/Users/ino/.local/share/mise/installs/python/3.12.12/bin/python.

Goal: the PR patch-coverage gate (`script/check-patch-coverage.ts`, CI job patch-coverage) requires every changed executable line vs origin/main to be covered by lane LCOV. The parent's B2 run (root `bun test --coverage`, 4635/0) left these lines uncovered in YOUR ownership:

```
script/check-dead-exports.ts:84
script/check-dead-exports.ts:137
script/check-dead-exports.ts:260
script/check-dead-exports.ts:261
script/check-dead-exports.ts:268
script/check-dead-exports.ts:396
script/check-dead-exports.ts:397
script/check-dead-exports.ts:398
script/check-deps.ts:94
script/check-deps.ts:1137
script/check-deps.ts:1138
script/check-deps.ts:1139
script/check-written-types.ts: no coverage record
script/generate-models-snapshot.ts: no coverage record
script/lint-guards.ts: no coverage record
script/lint-side-effects.ts:107
script/lint-tools.ts:473
script/lint-tools.ts:481
script/lint-tools.ts:493
script/lint-tools.ts:502
script/lint-tools.ts:503
script/lint-tools.ts:506
script/lint-tools.ts:511
script/lint-tools.ts:519
script/lint-tools.ts:579
script/lint-tools.ts:584
script/lint-tools.ts:613
script/lint-tools.ts:614
script/lint-tools.ts:764
script/lint-tools.ts:765
script/lint-tools.ts:766
script/lint-tools.ts:767
script/lint-tools.ts:768
script/lint-tools.ts:794
script/lint-tools.ts:795
script/lint-tools.ts:796
script/quality-typescript-metrics.ts:125
script/quality-typescript-metrics.ts:126
script/quality-typescript-metrics.ts:127
script/quality-typescript-metrics.ts:128
script/quality-typescript-metrics.ts:129
script/quality-typescript-metrics.ts:130
script/quality-typescript-metrics.ts:131
```

Rules:
- Owned files only: script/**. Anything else is a defect.
- Prefer covering the line with a real test that can fail (typed error / exact state assertion, no sleeps, no timing waits; subscribe to the exact event before triggering). Read the surrounding code first; if a line is genuinely unreachable dead code, delete it (dead code 0 is DoD) rather than test-fake it. Never widen types to any/unknown (`bun run script/check-written-types.ts` must stay 0). Keep functions under the complexity gate (ultracite `noExcessiveCognitiveComplexity`).
- "no coverage record" means no test executed that module in-process (tests that only spawn the script as a subprocess produce no LCOV). Import the module in a test (the script/ tests already have patterns for this: see script/*.test.ts that import sibling modules and guard `import.meta.main`).
- Verify the CI way: run `bun run ci test --lane scripts-contracts` then each `scripts-tooling-*` lane key listed in .github/workflows/ci.yml (they share one script/coverage/lcov.info — run them STRICTLY serially, and note the parent also runs nothing on script/ while you work); then `bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'` and confirm none of YOUR lines remain (other lanes' lines may still show; ignore those). Also run `bunx ultracite check --formatter-enabled=false <changed files>` and tsc for the touched workspace(s).
- Receipt: write /Users/ino/Develop/openomni-w53/.omo/reports/kernel-campaign-w53/C3.md with files changed, tests added (name + what would fail), commands + exit codes, and the remaining uncovered lines in your ownership (must be none, or explain why the checker's view is wrong with evidence). Final answer: receipt path + 5-line summary.
