# F2-r2 manualQa matrix

Surface for this lane is CLI/data-shaped (Bun test runner, real subprocess
lanes, lcov data). All scenarios executed for real in
/Users/ino/Develop/openomni-w53 with
`/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`, PATH minus /opt/homebrew/bin,
D945_PYTHON=/Users/ino/.local/share/mise/installs/python/3.12.12/bin/python.
Evidence root: `.omo/reports/kernel-campaign-w53/evidence/f2-r2/`.

## surfaceEvidence

| scenario | criterion | surface | invocation | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| f2r2-s1 | review-r2 finding 2: unchanged bytes valid, invalid mutation invalid, consumer-root errors preserved, through `FrozenMutationCompiler.check` | bun test (real tmpdir fixture, real TS compiler) | `bun test --config=/dev/null --timeout 300000 script/run-quality-mutations-compiler.test.ts -t 'baseline diagnostics use project roots\|transitive-only inventory files'` | PASS (exit 0, 2 pass) | a2 (full-file rerun includes both) |
| f2r2-s2 | review-r2 finding 6: transitive-only inventory file owned by fallback; native-root, transitive-only, unreferenced inputs together; zero `no owning compiler project` errors | bun test (generator + analyze + compiler on same fixture) | same as f2r2-s1 (second test in filter) | PASS (exit 0) | a2 |
| f2r2-s3 | one ownership rule holds on the real repository contract (baseline stays clean after covered-set change) | bun test, real checkout contract | `bun test --config=/dev/null --timeout 300000 script/run-quality-mutations-compiler.test.ts` ("real mutation contract has no baseline compiler diagnostics", 57.5s) | PASS (15 pass / 0 fail) | a2 |
| f2r2-s4 | brief: serial script lanes exit 0 on shared script/coverage | real subprocess lanes | `bun run ci test --lane scripts-tooling-1` then `--lane scripts-tooling-2` then `--lane scripts-contracts`, strictly serial | PASS (0; 253, 81, 336 pass; 0 fail each) | a4, a5 (lcov snapshots produced by the lanes) |
| f2r2-s5 | brief: every changed executable line covered | patch-coverage engine over lane lcov union | bun -e probe importing `changedLines`/`lcovUnion`/`uncoveredRows` from `script/check-patch-coverage.ts`, diff `git diff -U0 HEAD -- <3 prod files>` | PASS (exit 0, `uncovered: []`) | a3, a4, a5 |
| f2r2-s6 | brief hygiene gates | CLI | `bun x ultracite check --formatter-enabled=false <4 files>`; `bun x tsc -p script/tsconfig.json`; `bun run script/check-written-types.ts` | PASS (0 / 0 / 0, written any/unknown: 0) | a6 (diff of the 4 files these gates ran on) |

## adversarialCases

| scenario | criterion | class | expected | verdict | artifactRefs |
| --- | --- | --- | --- | --- | --- |
| f2r2-a1 | tests must be able to fail | scratch mutant in the fixed logic (`ownsDiagnostic` drops file-attributed diagnostics) | both new regressions fail | PASS — 0 pass / 2 fail, exit 1; reverted, 15 pass / exit 0 | a1, a2 |
| f2r2-a2 | finding 2 inverse: genuinely invalid mutation must stay invalid (fix must not over-filter) | false-green | `export const value: number = document.title;` rejected with diagnostic at b/value.ts; consumer-breaking `export const value = 1;` rejected at a/index.ts | PASS (asserted inside f2r2-s1 test, exit 0) | a2 |
| f2r2-a3 | finding 6 inverse: files with a native root owner must NOT leak into fallback | ownership drift | generator owners exactly `[["a/index.ts"], ["b/value.ts","c/orphan.ts"]]`; real-repo baseline still zero diagnostics | PASS (f2r2-s2 + f2r2-s3) | a2 |
| f2r2-a4 | flaky/timing behavior | nondeterminism | not_applicable — all new assertions are synchronous compiler/analyze calls over tmpdir fixtures; no async, no sleeps | not_applicable | — |

## artifactRefs

| id | kind | description | path |
| --- | --- | --- | --- |
| a1 | test log | focused regressions under scratch mutant: 0 pass / 2 fail, exit 1 | .omo/reports/kernel-campaign-w53/evidence/f2-r2/mutant-fail.log |
| a2 | test log | full run-quality-mutations-compiler.test.ts after revert: 15 pass / 0 fail, exit 0 | .omo/reports/kernel-campaign-w53/evidence/f2-r2/regressions-pass.log |
| a3 | data | patch-line coverage probe output: changed lines per file, `uncovered: []`, exit 0 | .omo/reports/kernel-campaign-w53/evidence/f2-r2/patch-coverage-probe.json |
| a4 | lcov | script/coverage/lcov.info snapshot after scripts-tooling-1 (exit 0) | .omo/reports/kernel-campaign-w53/evidence/f2-r2/lcov-scripts-tooling-1.info |
| a5 | lcov | script/coverage/lcov.info snapshot after scripts-tooling-2 (exit 0) | .omo/reports/kernel-campaign-w53/evidence/f2-r2/lcov-scripts-tooling-2.info |
| a6 | diff | working-tree diff of the four owned files (the change under test) | .omo/reports/kernel-campaign-w53/evidence/f2-r2/f2-r2.diff |

Note: lane stdout for scripts-tooling-1/2 and scripts-contracts was not teed
to files (exit codes and pass counts observed live: 0/0/0; 253/81/336 pass);
their durable evidence is the lcov snapshots a4/a5 those runs produced plus
`script/coverage/timings.json` updated by the tooling lanes.
