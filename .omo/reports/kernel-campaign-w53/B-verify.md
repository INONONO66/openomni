# W5.3 #1113 wave B verification (parent-run)

HEAD 524c6b95 (2026-09-29), worktree /Users/ino/Develop/openomni-w53, Bun 1.4.1 via mise, /opt/homebrew/bin removed from PATH.

## B1 gates (chain-b1.log)

build 0 · check-types 0 · lint 0 · lint:tools 0 · lint:docs 0 · check-topology 0 · check-deps 0 ·
check-import-cycles 0 · check-dead-exports 0 (12 workspaces, 0 known, none new) ·
verify-tsconfig-inheritance 0 · check-effect-boundaries 0 (no violations; 2 stale docs:
packages/ipc/AGENTS.md 180 commits, packages/llm/AGENTS.md 96 commits — refreshed in wave B docs) ·
check-written-types 0 ("written any/unknown types: 0").

## Script lane (a5-script-tests.log, serial, D945_PYTHON=CPython 3.12.12)

730 pass / 1 fail; the failure was the stale `packages/demo` fixture without an owning compiler
project (A5's root-file candidate ownership). Fixture fixed in quality-native-mutation.test.ts and
quality-mutation-shard.test.ts; rerun of both files 7/0 (a5-fixture-rerun.log).

## quality-audit --dry-run (audit-b.log, no LCOV lanes locally → complete:false)

| Kind | 8390912c baseline | 524c6b95 |
| --- | ---: | ---: |
| coverage (missing-file records, not debt) | 3116 | 485 |
| complexity | 17 | 14 |
| cyclomatic (new, <22) | — | 1 |
| halstead (new, <80) | — | 0 |
| crap (new, <25; needs LCOV) | — | 761 (no coverage input) |
| clones | 280 | 280 |
| types | 2779 | 2123 |

Absolute coverage/CRAP require the scheduled quality-audit.yml LCOV lanes; the local dry-run
reports all 15 lanes missing. Mutation: quality-mutation.yml baseline-compiler rejection fixed by A5
(root-file ownership; pilot receipts under A5-pilot*/), full campaign stays scheduled (never on this Mac).

## B2 full suite (b2-tests.log, HEAD 10c26e80 after F1)

`bun test --timeout 15000 --coverage` at root: **4635 pass / 0 fail**, TESTS_EXIT=0 (the two "(fail)" lines in the
log are fixture child-process output inside passing script/cleanup-oracle tests). durable-reconstruction.test.ts
passed (the A4b 5000 ms timeout did not reproduce).

Patch coverage (b2-patch-root.log; root lcov re-keyed to absolute SF paths because the checker requires a workspace
ancestor): 71 changed executable lines uncovered across 12 files (script 43, apps/openomni/gateway.ts 14,
desktop gateway-transport.ts 12, agent inspect.ts 1, desktop attention/reason.ts 1). Wave C lanes C1/C2/C3 close them
with CI-shaped per-workspace LCOV; the authoritative gate is the CI patch-coverage job on PR #1240.

## Wave B re-run after C1/C2/docs commits (HEAD 10aec492, C3 script edits uncommitted in tree)
Root gates, all exit 0: build, check-types, lint, lint:tools, lint:docs, check-topology, check-deps, check-import-cycles, check-dead-exports, verify-tsconfig-inheritance, check-effect-boundaries, check-written-types (logs /tmp/w53-gate-*.log).
Package suites with coverage, all exit 0: protocol 502/0, policy 72/0, ledger 197/0, llm 409/0, ipc 90/0, machines 68/0, codemode 28/0, channels 577/0, ui 206/0 (logs /tmp/w53-pkg-*.log). apps/openomni 557/0 and packages/agent 850/0 (C1 verify), apps/desktop 437/0 (C2 verify).
Script lanes: owned by C3 (serial, shared script/coverage/lcov.info); patch-coverage final run after C3 lands.

## Wave B re-run after the r2 fix lanes (HEAD 03f70089, docs edits uncommitted)
Root gates, all exit 0 (/tmp/w53-chain.log): build, check-types, lint, lint:tools, lint:docs, check-topology, check-deps, check-import-cycles, check-dead-exports, verify-tsconfig-inheritance, check-effect-boundaries (allowlist `[]`), check-written-types (0).
Root `bun test --timeout 15000 --coverage`: exit 0, **4671 pass / 0 fail** (/tmp/w53-test.log); durable-reconstruction passed inside the root run.
Script lanes serially (bash_437): scripts-tooling-1 253/0, scripts-tooling-2 81/0, scripts-contracts 336/0, all exit 0.
Patch coverage first pass (script lcov = last lane only): 21 lines in script/quality-typescript-metrics.ts and script/run-quality-mutations.ts reported "no coverage record" because the three script lanes overwrite one script/coverage/lcov.info; second pass with the per-lane lcov union recorded below.
Patch coverage second pass (per-lane script lcov union, /tmp/w53-patch2.log): exit 0, "all changed executable lines are covered" (3 AST-skipped lines in script/topology.ts and script/verify-tsconfig-inheritance.ts).
