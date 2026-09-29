# st_01a0e967 manual QA matrix (L3.3c-B)

Attempt directory fallback: no attempt dir for `st_01a0e967` exists on this
machine; artifacts are under
`.omo/reports/kernel-campaign-w52/L3.3c-B-artifacts/` (all non-empty).

| # | Check | How exercised | Result | Artifact |
| --- | --- | --- | --- | --- |
| 1 | Owned green set passes in one run | `bun test` over the 9 previously-red owned files (effect-shutdown, cluster-runtime, boot-wiring, message-mutation-killers, provision-tools, outbound-inbox-binding, monitor-app, session-tool-recovery-e2e, e2e) | PASS - 67 pass / 0 fail, exit 0 | `L3.3c-B-artifacts/green-set.log` |
| 2 | Full apps suite measured under wtimeout 600 | `/bin/bash /tmp/wtimeout.sh 600 mise exec bun@1.4.1 -- bun test` in `apps/openomni` | 515 pass / 14 fail, exit 1; failing set identical to parent's post-A measurement; all 14 mapped to src seams S1-S5 in receipt | `L3.3c-B-artifacts/full-suite.log` |
| 3 | session-wave-e2e (lane A) unaffected | full-suite log inspection | PASS - zero session-wave-e2e failures | `L3.3c-B-artifacts/full-suite.log` |
| 4 | 967-U1 "(fail)" line is echoed child output, not a counted failure | `grep -n "967-U1"` in full-suite log: outer run passes at line 731; the `(fail)` line sits inside `cleanup-oracle.test.ts`'s console.log of its nested `bun test` child (intentional teardown-rejection scenario); counted fails = 14, listed `(fail)` lines = 15 | PASS (explained) | `L3.3c-B-artifacts/full-suite.log` |
| 5 | S1/S2 reproduction without a test file | standalone probe: `messageFixture().send({to:{kind:"new_session",...}, deadline:200})` | Confirms `isError: true, output: "ForeignFailure"` at current HEAD | `L3.3c-B-artifacts/send-probe.ts` (probe source; output quoted in receipt S2 section) |
| 6 | request-owner-e2e unmasked failure + hang points | run with temporary stop-stage probes (since reverted): test 1 hangs in `runtime.dispose()`, test 2 hangs at `wsCallbacks.settled()` with 1 in-flight prompt frame | Documented as S4/S5 | `L3.3c-B-artifacts/roe-probe3.log` |
| 7 | npm-package failure is the deleted migration plane | individual run: build exits 1 with `ENOENT lstat packages/ledger/migration` | Documented as S3 with exact diff | `L3.3c-B-artifacts/npm-package.log` |
| 8 | process-session-e2e failures are the S1/S2 family | individual run: all 4 fail on `new_session` sends returning `isError` | Documented under S1+S2 | `L3.3c-B-artifacts/process-session-e2e.log` |
| 9 | message-ingress-boundaries failure is the S1/S2 family | individual run: only "child admission observations see the deadline..." fails | Documented under S1+S2 | `L3.3c-B-artifacts/message-ingress-boundaries.log` |
| 10 | Typecheck both configs | `bun x tsc --noEmit -p tsconfig.test.json` and `-p tsconfig.json` | PASS - both exit 0 | command exits recorded in receipt (run in session; no file artifact) |
| 11 | No src drift / no leftover probes | `git diff 7773bd09 -- apps/openomni/src` empty; `grep -rn "PROBE\|TEMPCLOSE"` over src+test empty | PASS | receipt "Probes and hygiene" |
| 12 | Deleted tests recorded with their deleted plane | `boot-recovery-error.test.ts` (boot recovery sweep plane), `zz-probe.test.ts` (own probe, never a real test) | PASS - recorded in per-file table | `L3.3c-B.md` |
| 13 | No timing sleeps introduced | all ported waits are exact signals: `Bus.subscribe(ActionCommittedEvent)` terminal-`waiting` commit (monitor-app), `rejects.toThrow` (outbound-inbox-binding), kernel evidence reads (mutation-killers) | PASS | test diffs in worktree |
