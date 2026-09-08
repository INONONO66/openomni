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

## Blocker
Rebased gate chain failed at turbo check-types on pre-existing packages/agent/test/session-inspection.test.ts:259 actionId property error; all preceding gates passed.

## Rebase and #1016 compatibility
Rebased onto origin/main at 6345c8c6. The trial merge of origin/ci/shared-ts-program (PR #1016, e096146f) produced conflicts in check-census.ts and check-types-census.ts because PR4 had added scoped plan arguments while #1016 added CensusPrograms. The resolution preserves both: scoped census calls use the shared CensusPrograms host, and the shared host is also used by the all-class census path. After resolving, the branch was rebased on #1016; the shared-program commit was already contained upstream and was dropped as a duplicate.

## Final verification
The full gate chain completed green: build, workspace check-types, script TypeScript, dependency checks, import-cycle checks, lint, lint:tools, Ultracite, dead exports, and script tests. Script tests: 681 pass, 0 fail, 6342 expect() calls. The scoped desktop quality timing remains 7.68 s versus 99.96 s full. RED-first receipts remain above and are now covered by the green implementation, including the shared scoped census tests.

The previously observed local Python 3.13 failures (tool_version / Python 3.12.12 required) were environmental only; this final run used the existing pinned Python 3.12.12 environment and had no such failures.
