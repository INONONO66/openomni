# manualQa — check 4 (cluster mailbox + decideSessionAdmission keeps the W1 admission contract)

All scenarios are data-shaped/CLI-shaped behavior (pure decision functions + a headless cluster runtime),
so the faithful channel is `bun test` executed via the mandated toolchain
(`/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check4-admission.test.ts --timeout 60000`,
cwd `/Users/ino/Develop/openomni-w51/spike/w5-cluster`). No HTTP/browser/GUI surface exists for this change.
Evidence directory: `/Users/ino/Develop/openomni-w51/.omo/reports/kernel-campaign-w5-spike/` (caller's receipts
dir; the only ulw attempt dir in `.omo/evidence/ulw/<root-session>` belongs to the unrelated G010 goal).

## surfaceEvidence

| scenario id | criterion | surface | invocation | verdict | artifactRefs |
|---|---|---|---|---|---|
| qa-c4-tableA | Check 4: mailbox decisions equal inbox-table decisions for 15+ sequences (stop/refused/start/recover/resume/consume) | CLI (bun test, Table A: A01–A17) | `mise exec bun@1.4.1 -- bun test test/check4-admission.test.ts --timeout 60000` | PASS | art-run2, art-run3 |
| qa-c4-tableB | Additional requirement: decideRequestTransition per FIFO mailbox item equals inbox-order resolutions (7 rows + cancel-first effect) | CLI (bun test, Table B: B1–B8) | same | PASS | art-run2, art-run3 |
| qa-c4-fifo | Single-writer FIFO proof: 3 concurrent prompts to one entity → chain ordinals 1,2,3, non-overlapping handler spans | Real cluster runtime (SingleRunner + sqlite catalog + per-session ledger files) inside bun test C1/C2 | same; spans printed in log | PASS | art-run2, art-run3, art-receipt |
| qa-c4-repeat | VERIFY exits 0 twice in a row | CLI, two consecutive runs (plus a third saved run) | same command, runs 1/2/3 all exit 0 | PASS | art-run2, art-run3 |
| qa-c4-regression | The spike-local bunfig resolution shim does not alter check 1 | CLI (bun test check1-boot) | `mise exec bun@1.4.1 -- bun test test/check1-boot.test.ts --timeout 60000` | PASS | art-check1 |

## adversarialCases

| scenario id | criterion | adversarial class | expected behavior | verdict | artifactRefs |
|---|---|---|---|---|---|
| qa-c4-adv-foreign-item | A12 | cross-tenant/foreign input | mailbox item addressed to another session → `refused` on both planes | PASS | art-run2 |
| qa-c4-adv-foreign-authority | A13/A14 | forged open turn / forged terminal | foreign `open` or `terminal` action → `refused`, never `recover`/`resume` | PASS | art-run2 |
| qa-c4-adv-order-race | B3/B8 | ordering attack (cancel races resolve) | later resolve never applied: no `resolved`/`attached`, no inbox intake, request stays `cancelled` (token `duplicate`; see receipt note) | PASS | art-run2, art-receipt |
| qa-c4-adv-replay | B6 | duplicate/replayed command | second resolve → `duplicate`, terminal state unchanged | PASS | art-run2 |
| qa-c4-adv-late | B5 | stale message after deadline | resolve after timeout → `late_unknown`, request stays `expired` | PASS | art-run2 |
| qa-c4-adv-concurrency | C1 | concurrent writers on one entity | 3 concurrent senders serialize: spans never overlap, chain ordinals 1,2,3, prev_hash linkage intact | PASS | art-run2, art-receipt |
| qa-c4-adv-fence | — | stale lease fence / crashed writer takeover | not_applicable: fence/crash matrix is explicitly out of scope for check 4 (another lane; checks cover it separately) | not_applicable | — |

## artifactRefs

| id | kind | description | path |
|---|---|---|---|
| art-run2 | test-log | Full stdout of VERIFY run 2 (27 pass / 0 fail, FIFO spans line) | /Users/ino/Develop/openomni-w51/.omo/reports/kernel-campaign-w5-spike/check4-verify-run2.log |
| art-run3 | test-log | Full stdout of VERIFY run 3 (27 pass / 0 fail), proves repeatability | /Users/ino/Develop/openomni-w51/.omo/reports/kernel-campaign-w5-spike/check4-verify-run3.log |
| art-check1 | test-log | check1-boot regression under the new bunfig shim (4 pass / 0 fail) | /Users/ino/Develop/openomni-w51/.omo/reports/kernel-campaign-w5-spike/check4-check1-regression.log |
| art-receipt | receipt | Check 4 receipt: sequence/decision tables, FIFO timestamps, PASS/FAIL, Findings for W5.2 | /Users/ino/Develop/openomni-w51/.omo/reports/kernel-campaign-w5-spike/check4-admission.md |
