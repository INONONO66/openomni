# W5.2 V-verify (#1197) — head 7f0e7046, branch kernel/1197-session-entity-20260928

Bun: `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`; /opt/homebrew/bin removed from PATH for test runs; python for the mutation-runner tests = mise python 3.12.

| gate | exit | evidence |
| --- | ---: | --- |
| bun run build | 0 | L4.2.md: 7/7 tasks |
| bun run check-types | 0 | L4.2.md 17/17; re-run on apps/openomni after 0700556b: 0 TS errors |
| bun run lint | 0 | 0 errors; warnings 13 -> 0 at 3e8c6cac |
| bun run lint:tools / lint:docs | 0 | L4.2.md; docs commit c9e0f454 |
| check-topology / check-deps / check-import-cycles / check-dead-exports / verify-tsconfig-inheritance | 0 | L4.2.md |
| check-effect-boundaries | 0 | runner-site allowlist 54 -> 48 (shrink), 1eb32862 |
| check-ledger-schema-drift / verify-ledger-rename | n/a | gates deleted with the old persistence plane (#1197 list) |
| deletion-token grep (13 tokens) | 0 hits | C001-grep.txt |
| crash matrix (script/conformance/crash-matrix.json, 27 rows) | 0 | crash-matrix.test.ts + fold-crash.test.ts: 42 pass / 0 fail, 27 matrix cells (/tmp/w52-crash.txt) |
| bun test --timeout 60000 --coverage (full, 3e8c6cac) | 1 | 4627 pass / 30 fail: 29 = script/run-quality-mutations.test.ts Python probe tests with D945_PYTHON unset in the monitor shell (python 3.12: main 114/0 == branch 114/0 → environment, not branch); 1 = intentional nested 967-U1 meta-test |
| bun test apps/openomni/test/monitor-ports.test.ts (0700556b) | 0 | 4/0, DA:247 hit |
| check-patch-coverage --base origin/main (absolute-SF lcov) | 0 uncovered | 124 -> 1 via C1/C2/C3, -> 0 at 0700556b |

Stop-condition check: protocol diff (l0.ts, storage/index.ts) deletes storage-internal lease/alarm/inbox rows and adds AdoptFence; 0 references from apps/desktop, packages/channels, packages/ui src on main → no wire/DTO change. No ratchet growth (boundaries exit 0, allowlist shrank).

Adversarial review: review-r1.md (st_01a0ea5c).
