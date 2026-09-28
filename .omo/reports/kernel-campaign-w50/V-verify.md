# W5.0 #1195 — V-verify (Effect 3.22.2 -> 4.0.0-rc.118, zero behavior change)

Branch `kernel/1195-effect-v4-pin-20260928`, PR #1198, base `origin/main` fc1e5c4d, verified HEAD `146d2f92` (+ this receipt commit) (2026-09-28).
All commands run as `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun ...` with `PATH` excluding `/opt/homebrew/bin` and `D945_PYTHON` = mise python 3.12.12.

## Gate chain (`.omo/reports/kernel-campaign-w50/gates-head.log`, tree 758925df; source-identical for gates at HEAD except the four review fixes, re-typed below)

| Gate | Exit |
|---|---|
| `build` | 0 (turbo, all workspaces) |
| `check-types` | 0 |
| `lint` | 0 |
| `lint:tools` | 0 |
| `lint:docs` | 0 |
| `script/check-topology.ts` | 0 |
| `script/check-deps.ts` | 0 |
| `script/check-import-cycles.ts` | 0 |
| `script/check-dead-exports.ts` | 0 |
| `script/verify-tsconfig-inheritance.ts` | 0 |
| `script/verify-ledger-rename.ts` | 0 |
| `script/check-ledger-schema-drift.ts` | 0 |
| `script/check-effect-boundaries.ts` | 0 |

Post-fix re-checks at HEAD: `tsc --noEmit` apps/openomni 0, packages/agent 0; `check-effect-boundaries.ts` exit 0.

## Ratchets (must not grow)

| Ratchet | main | branch |
|---|---|---|
| `script/conformance/effect-runner-sites.json` lines | 226 | 226 |
| `script/conformance/effect-boundary-sites.json` | `[]` | `[]` |
| `R2_ALLOWLISTED_RATCHET` lines (checker output) | 233 | 233 |
| `effectServiceInventory` services | 17 | 17 |
| `packages/protocol` diff | — | comment-only (SLOP H18) |
| `effect` in protocol/ui/desktop/policy package.json | absent | absent |

## Tests — per-lane CI reproduction (`bun run ci test --lane <key>`, `.omo/reports/kernel-campaign-w50/lanes/`)

| Lane | Result |
|---|---|
| agent | 805 pass / 0 fail |
| channels | 576 pass / 0 fail |
| codemode | 28 pass / 0 fail |
| desktopApp | 429 pass / 0 fail |
| ipc | 90 pass / 0 fail |
| ledger | 421 pass / 0 fail |
| llm | 412 pass / 0 fail |
| machines | 68 pass / 0 fail |
| openomniApp | 558 pass / 0 fail |
| policy | 72 pass / 0 fail |
| protocol | 552 pass / 0 fail |
| scripts-contracts | 448 pass / 0 fail |
| scripts-tooling-1 | 236 pass / 0 fail |
| scripts-tooling-2 | 78 pass / 0 fail |
| ui | 206 pass / 0 fail |
| **total** | **4979 pass / 0 fail**, 15/15 lanes exit 0 |

Root `bun test --timeout 15000 --coverage` on main baseline: 4976 pass; branch +3 = v4 fixture cases added to `script/check-effect-boundaries.test.ts`. Two `(fail)` lines inside the openomniApp log are child `bun test` processes spawned on purpose by `shutdown-hooks.test.ts` ("flush failed") and 967-U1 (cleanup after an assertion failure); the lane's own total is 558/0.

## Patch coverage

`bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'`

Exit 0: `patch coverage: all changed executable lines are covered` (`.omo/reports/kernel-campaign-w50/patch-coverage-final.log`, 63 AST-skipped-line notes, 0 uncovered). Note: the three script lanes share `script/coverage/lcov.info`; run concurrently they overwrite each other, so scripts-contracts was rerun alone before the final gate (CI lanes run on separate runners).

## Adversarial review (`.omo/evidence/1195-effect-v4-pin-code-review.md`)

- Round 1 (fresh omo-native-code-reviewer, claude-fable-5-1, 29m): RED. F1 heartbeat not armed (v4 `forkIn` defers) -> 758925df; F2 speculation abort before start -> bc1baead (`settleAbort`, both repro directions in the message); F3 v3 Die-cause test shape -> 41ceb470; F4 CLI exit 1 on SIGTERM (dispose interrupts `daemon.closed` awaiter) -> d6b0ea8d then simplified in 146d2f92; F5 boot-recovery test disposing through its own runtime -> bb8d1327. Nine other prod fork sites judged not load-bearing.
- Round 2 (fresh reviewer, HEAD bb8d1327): GREEN / APPROVE, zero blockers; nits F6-F10 non-blocking.

## v3 -> v4 semantics that needed hand ports (for W5.1+)

1. `Effect.forkIn/forkScoped` start deferred; v3 drained the fiber queue at the parent's next async resumption. Sites that depend on the child's first tick: `session-turn.ts` (`startImmediately`), `run.ts` settle finalizer (`settleAbort` = one `yieldNow`).
2. `ManagedRuntime.dispose` interrupts every fiber the runtime is running, including waits issued through it.
3. `Exit` failures carry `cause.reasons`; assert via `Cause.isDieReason` / `Cause.squash`.
4. `Effect.all(..., { mode: "result" })` yields `Result`; `shutdown.ts` validate semantics kept with `Result.isFailure`.
