# W5.3 #1113 adversarial review r2

Worktree /Users/ino/Develop/openomni-w53, branch kernel/1113-w5-closure-20260929, draft PR #1240 ("Part of #1113 / #930"), base origin/main 8390912c.
Bun: `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun` (strip /opt/homebrew/bin from PATH for tests). Read-only: do NOT edit or commit.

Scope: `git diff origin/main...HEAD` (whole PR). Review r1 (review-r1.md) found 7 findings; F1.md/F2.md landed the fixes, wave C (C1/C2/C3.md) closed patch-coverage gaps, D-docs.md synced docs. Receipts A1–A6, A2b, A4b, W4-1112-receipt.md, B-verify.md are in this directory.

Owner rules to police:
- Effect boundary law: protocol/ui/desktop/tool bodies never import effect (`bun run script/check-effect-boundaries.ts`), runner-site allowlist is now `[]` with RUNNER_OWNERS — verify no prod runner site slipped in.
- No wire/DTO shape change visible to desktop/channels except ADDITIVE frames (session_read/session_snapshot/session_page/session_gap). Any change to an existing frame's shape = STOP finding.
- Written any/unknown 0 (`bun run script/check-written-types.ts`), dead code 0, no duplicated logic, complexity under ultracite's gate, no sleeps/timing waits in tests, tests must be able to fail (spot-check by mutating a source line and running the test).
- No legacy migration, no Rivet/Restate/fallback runtime.
- Docs claim only what receipts prove (nothing marked merged that isn't).

Deliverable: /Users/ino/Develop/openomni-w53/.omo/reports/kernel-campaign-w53/review-r2.md with verdict GO / GO-WITH-CONDITIONS / NO-GO, numbered findings (severity, file:line, why it is wrong, minimal fix), and the commands you ran with exit codes. Be adversarial: look for the bug the lanes' own tests would not catch (races in gateway session_read vs commits, cursor/gap semantics, desktop transport pending-map lifecycle, inspect budget accounting, script main-runner exit semantics, mutation baseline root-file ownership edge cases).
