# W5.3 #1113 wave C lane C2: close patch-coverage gaps

Worktree: /Users/ino/Develop/openomni-w53 (branch kernel/1113-w5-closure-20260929, HEAD 10c26e80, draft PR #1240). Do NOT commit. Bun via `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`; remove /opt/homebrew/bin from PATH when running tests (`export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '^/opt/homebrew/bin$' | paste -sd: -)`). D945_PYTHON=/Users/ino/.local/share/mise/installs/python/3.12.12/bin/python.

Goal: the PR patch-coverage gate (`script/check-patch-coverage.ts`, CI job patch-coverage) requires every changed executable line vs origin/main to be covered by lane LCOV. The parent's B2 run (root `bun test --coverage`, 4635/0) left these lines uncovered in YOUR ownership:

```
apps/desktop/src/renderer/attention/reason.ts:29
apps/desktop/src/renderer/chat/gateway-transport.ts:120
apps/desktop/src/renderer/chat/gateway-transport.ts:121
apps/desktop/src/renderer/chat/gateway-transport.ts:122
apps/desktop/src/renderer/chat/gateway-transport.ts:124
apps/desktop/src/renderer/chat/gateway-transport.ts:151
apps/desktop/src/renderer/chat/gateway-transport.ts:152
apps/desktop/src/renderer/chat/gateway-transport.ts:153
apps/desktop/src/renderer/chat/gateway-transport.ts:187
apps/desktop/src/renderer/chat/gateway-transport.ts:188
apps/desktop/src/renderer/chat/gateway-transport.ts:189
apps/desktop/src/renderer/chat/gateway-transport.ts:215
apps/desktop/src/renderer/chat/gateway-transport.ts:216
```

Rules:
- Owned files only: apps/desktop/src/renderer/**, apps/desktop/test/**. Anything else is a defect.
- Prefer covering the line with a real test that can fail (typed error / exact state assertion, no sleeps, no timing waits; subscribe to the exact event before triggering). Read the surrounding code first; if a line is genuinely unreachable dead code, delete it (dead code 0 is DoD) rather than test-fake it. Never widen types to any/unknown (`bun run script/check-written-types.ts` must stay 0). Keep functions under the complexity gate (ultracite `noExcessiveCognitiveComplexity`).
- "no coverage record" means no test executed that module in-process (tests that only spawn the script as a subprocess produce no LCOV). Import the module in a test (the script/ tests already have patterns for this: see script/*.test.ts that import sibling modules and guard `import.meta.main`).
- Verify the CI way: `cd apps/desktop && bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage`; then `bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'` and confirm none of YOUR lines remain (other lanes' lines may still show; ignore those). Also run `bunx ultracite check --formatter-enabled=false <changed files>` and tsc for the touched workspace(s).
- Receipt: write /Users/ino/Develop/openomni-w53/.omo/reports/kernel-campaign-w53/C2.md with files changed, tests added (name + what would fail), commands + exit codes, and the remaining uncovered lines in your ownership (must be none, or explain why the checker's view is wrong with evidence). Final answer: receipt path + 5-line summary.
