# Review r3 brief — PR #1240 (W5.3 #1113)

Worktree /Users/ino/Develop/openomni-w53, branch kernel/1113-w5-closure-20260929, base origin/main 8390912c. Bun: `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`; strip /opt/homebrew/bin from PATH for coverage-collector tests; D945_PYTHON=/Users/ino/.local/share/mise/installs/python/3.12.12/bin/python. Never run a mutation campaign; never commit.

You are a fresh adversarial reviewer. Round 2 (review-r2.md) returned NO-GO with 1 Owner STOP, 5 majors, 1 minor. Fix lanes F1-r2..F6-r2 (briefs F?-r2-brief.md, receipts F?-r2.md) addressed them; the Owner decision for the STOP is in owner-decisions.md (receipt frame restored to base shape; binding in a new additive `session_bound` frame).

Deliverable: /Users/ino/Develop/openomni-w53/.omo/reports/kernel-campaign-w53/review-r3.md with verdict GO / GO-WITH-CONDITIONS / NO-GO.

Required checks (each with the command and exit code you observed):
1. Every r2 finding: re-read the cited lines on the current tree, confirm the fix is real (not a test weakened to pass), and try to construct a counterexample. For finding 1 verify `git diff 8390912c -- packages/channels/src/websocket.ts` leaves the accepted receipt object byte-identical in shape; grep-zero `receipt.result`.
2. Wire freeze: diff every Zod schema under packages/protocol/src/gateway against 8390912c; any change to an EXISTING frame's shape (field added/removed/retyped, even optional) is an Owner STOP — report it. New frames are additive and allowed.
3. Gates: build, check-types, lint, lint:tools, lint:docs, check-topology, check-deps, check-import-cycles, check-dead-exports, verify-tsconfig-inheritance, check-effect-boundaries (allowlist must stay `[]`), check-written-types (must print 0), `bun test --timeout 15000` per workspace (script lanes serially), patch coverage vs origin/main.
4. Hosted CI: `gh pr checks 1240`; report each failing job with its cause. The previous head failed Test (agent) on `fresh-process refuses tampered checkpoint foldVersion before writes` (5 s timeout) — verify F6-r2's fix is deterministic (no sleeps, exact signal subscription).
5. Docs: docs/implementation-status.md W5.3 section, docs/SLOP.md closed rows, AGENTS.md stamp, docs/kernel-references.md must describe the current tree (HEAD SHA, session_bound frame, r2 findings). Stale claims are findings.
6. Scope: list every file changed vs 8390912c that no lane brief or plan (.omo/plans/kernel-campaign-w53/plan.md) owns.

Report only what you observed; label anything you could not run.
