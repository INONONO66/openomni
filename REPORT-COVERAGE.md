# PR980 agent coverage recovery

Scope: additive tests for PR980 (`e8f44611`) in `packages/agent/test/core/execution/tool-wave.test.ts`. No production code, thresholds, skips, or unrelated worktree files were changed.

## Commands and evidence

Historical runtime correction: the absolute Bun 1.3.6 launcher did not pin the nested CI script. Both historical CI logs below print Bun **1.4.1**; only the direct focused RED/GREEN runs print 1.3.6. The original pinned baseline is unverified. These raw logs are retained unchanged; `REPORT-COVERAGE-R2.md` supplies fresh PATH-pinned aggregate evidence.

- Historical unpinned baseline CI agent command (nested Bun 1.4.1): `cd packages/agent && bun run test:ci` — 361 pass, 0 fail (`.omo/evidence/pr980/coverage-agent-1.3.6.txt` was refreshed after the additive tests; the pre-change baseline output is `/tmp/pr980-baseline-agent.txt`).
- Mutation RED: changed the fulfillment guard in `src/core/execution/tool-wave.ts` from `!outcomes.has(index)` to `outcomes.has(index)`; focused suite failed (10 pass, 12 fail), then the production file was restored. Raw output: `.omo/evidence/pr980/red.txt`.
- Focused GREEN: `bun test --timeout 15000 packages/agent/test/core/execution/tool-wave.test.ts` — 22 pass, 0 fail, 119 assertions. Raw output: `.omo/evidence/pr980/focused-green.txt`.
- Historical restored CI agent command (nested Bun 1.4.1): 363 pass, 0 fail, 979 assertions. Raw output: `.omo/evidence/pr980/coverage-agent-1.3.6.txt`.

## Coverage

The historical restored unpinned run reported only these two files, not the aggregate gate:

| Agent-owned file | Covered lines | Total lines | Line coverage |
|---|---:|---:|---:|
| `src/core/execution/tool-wave.ts` | 131 | 131 | 100.00% |
| `src/tool-body.ts` | 79 | 79 | 100.00% |

The rejection/barrier test discriminated a poisoned join. Independent review found that the original late-fulfillment assertion observed cancellation too early and survived an overwrite mutant; it did not cover late rejection. R2 strengthens that oracle for both settlements. Existing PR980 tests continue to exercise timeout ownership, raw rejection (including fallible conversion), refusal, and late settlement fencing.
