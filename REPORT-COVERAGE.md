# PR980 agent coverage recovery

Scope: additive tests for PR980 (`e8f44611`) in `packages/agent/test/core/execution/tool-wave.test.ts`. No production code, thresholds, skips, or unrelated worktree files were changed.

## Commands and evidence

Pinned runtime: Bun 1.3.6 (`/Users/ino/.local/share/mise/installs/bun/1.3.6/bin/bun`).

- Baseline exact CI agent command: `cd packages/agent && bun run test:ci` — 361 pass, 0 fail (`.omo/evidence/pr980/coverage-agent-1.3.6.txt` was refreshed after the additive tests; the pre-change baseline output is `/tmp/pr980-baseline-agent.txt`).
- Mutation RED: changed the fulfillment guard in `src/core/execution/tool-wave.ts` from `!outcomes.has(index)` to `outcomes.has(index)`; focused suite failed (10 pass, 12 fail), then the production file was restored. Raw output: `.omo/evidence/pr980/red.txt`.
- Focused GREEN: `bun test --timeout 15000 packages/agent/test/core/execution/tool-wave.test.ts` — 22 pass, 0 fail, 119 assertions. Raw output: `.omo/evidence/pr980/focused-green.txt`.
- Restored exact CI agent command: 363 pass, 0 fail, 979 assertions. Raw output: `.omo/evidence/pr980/coverage-agent-1.3.6.txt`.

## Coverage

LCOV from the restored pinned run reports:

| Agent-owned file | Covered lines | Total lines | Line coverage |
|---|---:|---:|---:|
| `src/core/execution/tool-wave.ts` | 131 | 131 | 100.00% |
| `src/tool-body.ts` | 79 | 79 | 100.00% |

The new tests assert the semantic outcomes behind the covered wave branches: a preceding rejection does not block a sequential barrier or following item, and a body that resolves after abort remains cancelled. Existing PR980 tests continue to exercise timeout ownership, raw rejection (including fallible conversion), refusal, and late settlement fencing.
