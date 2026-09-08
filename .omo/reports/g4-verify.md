# G4 verification

## Initial
 Tasks:    6 successful, 6 total
Cached:    6 cached, 6 total
  Time:    640ms >>> FULL TURBO


## RED-first
### .omo/reports/g4-red-plan.log
error: expect(received).toMatchObject(expected)
- Expected  - 2
### .omo/reports/g4-red-proof.log
error: Cannot find module './quality-plan' from '/Users/ino/Develop/openomni-ci-g4/script/quality-plan.test.ts'
 1 fail
### .omo/reports/g4-red-collect.log
error: expect(received).toEqual(expected)
- Expected  - 0
### .omo/reports/g4-red-shard-coverage.log
error: ENOENT: no such file or directory, open '/var/folders/hn/5mq7n_jn6k3065zcjcjmrpgw0000gn/T/quality-shards-u896NK/merged.json.start'
(fail) script shards merge native counters only after all four fresh partitions arrive [600.24ms]
### .omo/reports/g4-red-workflow.log
error: expect(received).toBeDefined()
Received: undefined
### .omo/reports/g4-red-metric-membership.log
error: expect(received).rejects.toMatchObject(expected)
Expected promise that rejects

## Green focused
193:(pass) accepts a truly empty git diff with an explicit reason [340.75ms]
194:(pass) fails topology inventory drift before emitting even a full plan [218.82ms]
289: 127 pass
290: 0 fail
292:Ran 127 tests across 8 files. [70.48s]

## Local scope
{
  "class": "desktop",
  "lanes": [
    "desktopApp",
    "scripts"
  ],
  "projects": [
    "apps/desktop/tsconfig.node.json",
    "apps/desktop/tsconfig.test.json",
    "apps/desktop/tsconfig.web.json"
  ],
  "toolingTests": false
}
qualityScope 67
types scoped
[quality-phase] name=types ms=7680
types full
[quality-phase] name=types ms=99962

## Gates
build	0	38
workspace-types	2	34

## Historical blocker (resolved by #1013)
Rebased gate chain failed at turbo check-types on pre-existing packages/agent/test/session-inspection.test.ts:259 actionId property error; all preceding gates passed.

## Rebase and #1016 compatibility
Rebased onto origin/main at 6345c8c6. The trial merge of origin/ci/shared-ts-program (PR #1016, e096146f) produced conflicts in check-census.ts and check-types-census.ts because PR4 had added scoped plan arguments while #1016 added CensusPrograms. The resolution preserves both: scoped census calls use the shared CensusPrograms host, and the shared host is also used by the all-class census path. After resolving, the branch was rebased on #1016; the shared-program commit was already contained upstream and was dropped as a duplicate.

## Final verification
After #1016 was squash-merged as ea060717 and #1011 as 2adc0a5d, rebased with `git rebase --onto origin/main e096146f`: all four PR4 commits replayed without conflicts. The shared host is byte-identical to main. The scoped API preserves #1016's fourth argument (shared host) and adds scope as the fifth. Two integration tests cover project deduplication and inventory fallback, including owned imports outside measurement scope. Six shared-program tests passed. The initial full run caught the missing census-program.test.ts shard assignment; the explicit tooling manifest now includes it.

Every Bun command used `mise exec bun@1.4.1 -- bun`. Latest full chain, after the actual main rebase:

| Gate | Result | Seconds |
| --- | --- | ---: |
| install --frozen-lockfile | PASS (512 installs checked, no changes) | 0.10 |
| run build | PASS | 47 |
| x turbo run check-types | PASS | 51 |
| x tsc -p script/tsconfig.json | PASS | 9 |
| run script/check-deps.ts | PASS | 1 |
| run script/check-import-cycles.ts | PASS | 0 |
| run lint | PASS | 3 |
| run lint:tools | PASS | 1 |
| x ultracite check --formatter-enabled=false . | PASS | 2 |
| run script/check-dead-exports.ts | PASS | 5 |
| test script/ --timeout 15000 | PASS: 683 tests, 0 failures, 6355 assertions | 1505 |

The final script test target passed in one invocation; no skipped/deleted tests or lowered floors. No package outside script/ is touched. LSP diagnostics on changed TypeScript, JSON and workflow files reported no diagnostics; no Markdown server is configured. The actual ci-plan.ts --full CLI emitted a version-2 global plan with the three tooling shards (contracts have a separate workflow job). git diff --check passed. The baseline diff adds source hashes only, not findings or ratchet allowances.

The earlier timing receipt above measured scoped desktop types at 7.68 s versus 99.96 s full; this is the prior agent's timing, not a new benchmark after #1016. RED-first and focused GREEN receipts remain above.

Environmental Python failures in this session: none. Contrary to the task's anticipated Python 3.13 noise, the existing worktree-local .omo/quality-venv supplies Python 3.12.12 and basedpyright; the gate runner explicitly used it. No environmental failures were excused.

The requested .omo/reports/ci-optimization-design-20260908.md was absent in this worktree. The implementation, workflow, docs and existing verification receipts supplied context; no other worktree was read or edited.

## Publication
PR https://github.com/INONONO66/openomni/pull/1017. The initial check watch returned only reviewer statuses because the moving main branch made the PR unmergeable; GitHub listed no Actions runs. The conflict-free rebase above addresses that publication blocker. Auto-merge is not enabled.
