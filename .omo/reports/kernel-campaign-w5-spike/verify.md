# W5.1 spike — independent verification (verify.md)

Date: 2026-09-28. Verifier: independent QA executor (task st_01a0e806).
Worktree: /Users/ino/Develop/openomni-w51 (branch kernel/1196-cluster-spike-20260928, HEAD 945c816c, base main 5b925d12).
All bun invocations via `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`. No code or git state touched; this file is the only write.

## Commands and exit codes

| # | Command (cwd) | Exit | Result |
|---|---|---|---|
| 1 | `bun test --timeout 60000` (spike/w5-cluster) — run 1 | **0** | 37 pass / 0 fail, 159 expect() calls, 4 files [8.74s] |
| 2 | `bun test --timeout 60000` (spike/w5-cluster) — run 2 | **0** | 37 pass / 0 fail, 159 expect() calls [8.53s] (log: /tmp/w51-run2.log) |
| 3 | `bun test --timeout 60000` (spike/w5-cluster) — run 3 | **0** | 37 pass / 0 fail, 159 expect() calls [8.48s] (log: /tmp/w51-run3.log) |
| 4 | `bunx tsc -p tsconfig.json --noEmit` (spike/w5-cluster) | **0** | clean |
| 5 | `bunx ultracite check --formatter-enabled=false spike/` (worktree root) | **1** | **2 errors** (see below) |
| 6 | `bun run script/check-effect-boundaries.ts` (worktree root) | **0** | 233 lines, all 233 `R2_ALLOWLISTED_RATCHET allowlisted (ratchet)`; no spike/ file in output |

Run-1 stdout excerpt (tail):

```
 37 pass
 0 fail
 159 expect() calls
Ran 37 tests across 4 files. [8.74s]
```

Ultracite output (exact, run 5):

```
spike/w5-cluster/src/fence-child.ts:73:9 lint/complexity/useOptionalChain  FIXABLE
  × Change to an optional chain.
spike/w5-cluster/tsconfig.json format
  × Formatter would have printed the following content:  ("include": [...] -> one line)
Checked 17 files in 13ms. No fixes applied.
Found 2 errors.
```

## Numbers table (observed this session)

| Metric | Value | Source |
|---|---|---|
| Per-session sqlite files created (check1) | 2 (`s1.sqlite`, `s2.sqlite`) + 1 crash-session file (check2) | check1 test d, check2 |
| Chain rows | s1 = 2 (ordinal 1->2, prev_hash linked from GENESIS), s2 = 1; crash session final `CHAIN_OK 3` | run-1 stdout |
| Cluster tables in catalog file | 5: cluster_locks, cluster_messages, cluster_migrations, cluster_replies, cluster_runners | check1 test a |
| DeliverAt residual_ms | run 1: **1514**, run 2: **1517**, run 3: **1507** (all >= 1500 target) | run stdout / logs |
| Runner sites in spike (runPromise etc.) | **11** total: 5 src (smoke.ts:17; crash-child.ts:104,131,155,179) + 6 test (check1-boot x4; check4-admission x2) | grep, this session |
| any/unknown in spike .ts | **0 in code**; 1 grep hit is the English word "any" in a fence-child.ts doc comment (line 7) | grep, this session |
| Allowlist baseline | script/conformance/effect-runner-sites.json = 226 lines (unchanged) | wc -l |
| Spike LOC | src = 827 (9 files), test = 970 (5 files), total 1797 | wc -l |

wc -l detail: src: admission-bridge 80, crash-child 194, crash-entity 208, crypto 11, fence-child 83, runtime 32, session-entity 56, session-file 146, smoke 17. test: check1-boot 114, check2-crash 178, check3-fence 165, check4-admission 489, preload-module-map 24.

## Receipt audit (five receipts vs observed runs)

| Receipt | Its verdict | Consistent with this session? | Notes |
|---|---|---|---|
| check1-storage.md | PASS (4 sub-checks) | **PASS — consistent** | All 4 check1-boot tests pass in all 3 full runs; tsc exit 0 matches its claim; cluster tables + chain-linkage evidence reproduced in run stdout. |
| check2-crash.md | PASS (7 sub-checks) | **PASS — consistent** | check2 test passes in all 3 runs; observed markers match receipt shape exactly (exit=137 SIGKILL, processed=0 row surviving, REDELIVERED deduped=true with identical action_hash, CHAIN_OK 1 -> 3, CHECKPOINT_HYDRATED, residual_ms 1507–1517 within the receipt's claimed 1500–3500 band). |
| check3-fence.md | PASS (5 sub-checks a–e) | **PASS — consistent** | check3-fence.test.ts is one of the 4 files in the 37-pass suite; 0 failures in 3 consecutive full runs, so its per-test PASS claims (holder commits, second writer "stale", concurrent race single-winner, SQLITE_BUSY after busy_timeout) are backed by observed green runs. |
| check4-admission.md | PASS (Table A 17/17, Table B 8/8, C1, C2) | **PASS — consistent** | All 27 check4 tests pass in all 3 runs; C1 FIFO spans observed in run-1 stdout (ordinals 1,2,3, start(n) >= end(n-1)); C2 pass observed. |
| check5-boundaries.md | Mixed: sub-checks 1,2,3,4,7 PASS; 5 (ultracite) FAIL; 6 REPORTED | **Verdicts consistent; two numeric claims stale** | (1) boundaries checker exit 0 with 233/233 allowlisted — reproduced exactly. (2) allowlist 226 lines — reproduced. (5) ultracite FAIL — reproduced, but the count grew: receipt says 1 error / 8 files; now **2 errors / 17 files** (new lint error in fence-child.ts:73, a file added by the check3 lane AFTER check5 was written — the receipt itself flagged fence-child.ts as arriving concurrently). (3) runner-site count "5" is stale for the same reason: now 11 (crash-child.ts + check4/check2/check3 files added later). (4) any/unknown "0" still holds for code; the literal grep now exits 0 due to the word "any" in a comment. No PASS verdict in check5 is contradicted; the stale numbers do not flip any verdict, but W5.2 should treat 11 runner sites and 2 ultracite errors as the current truth. |

Note: check1-smoke.md (pre-existing) was not in scope of the five-receipt audit.

## Overall verdict

- Spike test suite: **PASS**, 3/3 runs green (exit 0, 0, 0), 37 pass / 0 fail each.
- tsc: **PASS** (exit 0).
- ultracite: **FAIL** (exit 1, 2 errors: fence-child.ts:73 useOptionalChain lint; tsconfig.json format). check5 already declares ultracite FAIL, so no receipt claims a lint pass that does not exist.
- check-effect-boundaries: **PASS** (exit 0, 233/233 allowlisted, zero spike violations).
- Receipts 1–4: PASS claims fully backed by observed test runs. Receipt 5: verdicts consistent; runner-site count (5 -> 11), ultracite error count (1 -> 2), and any/unknown grep exit (1 -> 0, comment-only) are stale snapshots superseded by the numbers table above.
- Outstanding debt for the spike lane before commit: the 2 ultracite errors (both trivially fixable: optional chain + JSON include-array format).
