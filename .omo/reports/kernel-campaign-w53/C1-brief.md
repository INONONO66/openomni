# W5.3 #1113 wave C lane C1: close patch-coverage gaps

Worktree: /Users/ino/Develop/openomni-w53 (branch kernel/1113-w5-closure-20260929, HEAD 10c26e80, draft PR #1240). Do NOT commit. Bun via `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`; remove /opt/homebrew/bin from PATH when running tests (`export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '^/opt/homebrew/bin$' | paste -sd: -)`). D945_PYTHON=/Users/ino/.local/share/mise/installs/python/3.12.12/bin/python.

Goal: the PR patch-coverage gate (`script/check-patch-coverage.ts`, CI job patch-coverage) requires every changed executable line vs origin/main to be covered by lane LCOV. The parent's B2 run (root `bun test --coverage`, 4635/0) left these lines uncovered in YOUR ownership:

```
apps/openomni/src/gateway.ts:183
apps/openomni/src/gateway.ts:184
apps/openomni/src/gateway.ts:224
apps/openomni/src/gateway.ts:225
apps/openomni/src/gateway.ts:226
apps/openomni/src/gateway.ts:227
apps/openomni/src/gateway.ts:228
apps/openomni/src/gateway.ts:229
apps/openomni/src/gateway.ts:252
apps/openomni/src/gateway.ts:253
apps/openomni/src/gateway.ts:254
apps/openomni/src/gateway.ts:255
apps/openomni/src/gateway.ts:256
apps/openomni/src/gateway.ts:287
packages/agent/src/session-lifecycle/inspect.ts:59
```

Rules:
- Owned files only: apps/openomni/src/gateway.ts, apps/openomni/test/**, packages/agent/src/session-lifecycle/inspect.ts, packages/agent/test/**. Anything else is a defect.
- Prefer covering the line with a real test that can fail (typed error / exact state assertion, no sleeps, no timing waits; subscribe to the exact event before triggering). Read the surrounding code first; if a line is genuinely unreachable dead code, delete it (dead code 0 is DoD) rather than test-fake it. Never widen types to any/unknown (`bun run script/check-written-types.ts` must stay 0). Keep functions under the complexity gate (ultracite `noExcessiveCognitiveComplexity`).
- "no coverage record" means no test executed that module in-process (tests that only spawn the script as a subprocess produce no LCOV). Import the module in a test (the script/ tests already have patterns for this: see script/*.test.ts that import sibling modules and guard `import.meta.main`).
- Verify the CI way: `cd apps/openomni && bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage` and `cd packages/agent && bun run test:ci`; then `bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'` and confirm none of YOUR lines remain (other lanes' lines may still show; ignore those). Also run `bunx ultracite check --formatter-enabled=false <changed files>` and tsc for the touched workspace(s).
- Receipt: write /Users/ino/Develop/openomni-w53/.omo/reports/kernel-campaign-w53/C1.md with files changed, tests added (name + what would fail), commands + exit codes, and the remaining uncovered lines in your ownership (must be none, or explain why the checker's view is wrong with evidence). Final answer: receipt path + 5-line summary.
