# Check 5 — Effect boundary law unchanged by the W5.1 cluster spike

Worktree: /Users/ino/Develop/openomni-w51 (branch kernel/1196-cluster-spike-20260928, base main 5b925d12).
All commands run 2026-09-28 with `/opt/homebrew/bin/mise exec bun@1.4.1 -- bun`.

## 1. check-effect-boundaries.ts — PASS

```
cd /Users/ino/Develop/openomni-w51 && /opt/homebrew/bin/mise exec bun@1.4.1 -- bun run script/check-effect-boundaries.ts
```

Exit code: **0**. Output: **233 lines, every one of them `R2_ALLOWLISTED_RATCHET allowlisted (ratchet)`** — zero new violations. Excerpt (first/last lines):

```
apps/openomni/test/helpers/alarm.ts:14 R2_ALLOWLISTED_RATCHET allowlisted (ratchet)
apps/openomni/test/helpers/alarm.ts:15 R2_ALLOWLISTED_RATCHET allowlisted (ratchet)
...
packages/machines/test/exec.test.ts:20 R2_ALLOWLISTED_RATCHET allowlisted (ratchet)
script/effect-error-contract.test.ts:129 R2_ALLOWLISTED_RATCHET allowlisted (ratchet)
```

Verified counts: `bun run script/check-effect-boundaries.ts 2>&1 | wc -l` -> 233; `grep -c R2_ALLOWLISTED_RATCHET` -> 233. **No spike/ file appears in the checker output** — the checker does not scan spike/ and the spike adds zero violations.

Cross-check against live main (/Users/ino/Develop/openomni @ 74cf90dc): same command, exit **0**, output **233 lines, 233 allowlisted** — identical numbers.

## 2. Allowlist baseline — PASS (unchanged)

```
wc -l script/conformance/effect-runner-sites.json   -> 226 script/conformance/effect-runner-sites.json
bun -e '...json().length'                            -> entries: 224
```

226 lines (the "226" expectation is the line count: 224 JSON array entries + 2 bracket lines).

```
git diff 5b925d12 -- script/conformance/effect-runner-sites.json script/check-effect-boundaries.ts
```
-> **empty**: neither the checker nor the allowlist differ from base main 5b925d12. Unchanged = PASS.

Note (main drift, not spike-caused): live main HEAD 74cf90dc has re-numbered 7 allowlist entries (packages/llm/test/retry/retry.test.ts 8/71/82 -> 9/72/83; packages/machines/test/exec.test.ts 10/12/14/19 -> 11/13/15/20) relative to base 5b925d12. Same 224 entries / 226 lines on both sides; the spike branch matches its base exactly.

## 3. Runner sites the spike would add — 5 total (1 prod-src, 4 test)

```
grep -rn -E "runPromise|runPromiseExit|runSync|runSyncExit|runFork|runCallback" spike/w5-cluster/src spike/w5-cluster/test
```
Exit 0, 5 hits:

| file:line | class | detail |
|---|---|---|
| spike/w5-cluster/src/smoke.ts:17 | **prod-src** | `Effect.runPromise(...)` top-level boot in the throwaway smoke entrypoint |
| spike/w5-cluster/test/check1-boot.test.ts:34 | test | `runtime.runPromise(Effect.void)` |
| spike/w5-cluster/test/check1-boot.test.ts:56 | test | `runtime.runPromise(sendPrompt("s1", ...))` |
| spike/w5-cluster/test/check1-boot.test.ts:60 | test | `runtime.runPromise(sendPrompt("s1", ...))` |
| spike/w5-cluster/test/check1-boot.test.ts:101 | test | `runtime.runPromise(sendPrompt("s2", ...))` |

If moved under packages/: **prod runner-site count is 1 (smoke.ts) — must become 0** for a real W5.2 implementation (smoke.ts is a spike-only demo and would be deleted, or its run moved behind a managed runtime boundary). The 4 test sites would be **4 new ratchet rows** in effect-runner-sites.json (226 -> 230 lines, 224 -> 228 entries).

## 4. any/unknown in spike TS — PASS (0)

```
grep -rn -E "\b(any|unknown)\b" --include=*.ts spike/w5-cluster/src spike/w5-cluster/test
```
Exit code: **1** (no matches). **0 hits.**

## 5. ultracite check on spike/ — FAIL (1 format diagnostic, reported not fixed)

```
cd /Users/ino/Develop/openomni-w51 && /opt/homebrew/bin/mise exec bun@1.4.1 -- bunx ultracite check --formatter-enabled=false spike/
```
Exit code: **1**. One diagnostic, format-only, in `spike/w5-cluster/tsconfig.json`:

```
spike/w5-cluster/tsconfig.json format
  × Formatter would have printed the following content:
     8    │ - ··"include":·[
     9    │ - ····"src",
    10    │ - ····"test"
    11    │ - ··]
        8 │ + ··"include":·["src",·"test"]
Checked 8 files in 12ms. No fixes applied.
Found 1 error.
```

No lint diagnostics in any .ts file. QA scope forbids code edits; the spike lane should run `ultracite fix` on that one JSON file.

## 6. check-deps / check-topology — both exit 1: the scripts DO see the spike

```
bun run script/check-deps.ts      -> exit 1
  ERROR: topology omits on-disk workspace(s): spike/w5-cluster
bun run script/check-topology.ts  -> exit 1
  VIOLATION [topology] dependency-bands: workspace inventory drift: unaccounted [spike/w5-cluster], nonexistent []
  VIOLATION [topology] import-cycles:    ... unaccounted [spike/w5-cluster] ...
  VIOLATION [topology] knip:             ... unaccounted [spike/w5-cluster] ...
  VIOLATION [topology] dead-exports:     ... unaccounted [spike/w5-cluster] ...
  VIOLATION [topology] ci-tests:         ... unaccounted [spike/w5-cluster] ...
  VIOLATION [topology] tsconfig:         ... unaccounted [spike/w5-cluster] ...
```

Because root package.json workspaces gained `spike/*`, the spike is a real workspace and the topology inventory (which enumerates on-disk workspaces) flags it as unaccounted in all 6 lanes. These failures exist on the branch today (CI-relevant); they are inventory-registration gaps, not boundary-law violations.

## 7. git status — PASS (clean; changes confined to allowed paths)

```
cd /Users/ino/Develop/openomni-w51 && git status --porcelain   -> (empty, exit 0)
git diff 5b925d12 --stat -- script/ packages/ apps/            -> (empty)
```

Re-checked at end of QA run — a concurrent spike lane added two untracked files while this check ran:

```
git status --porcelain
?? spike/w5-cluster/src/fence-child.ts
?? spike/w5-cluster/test/check3-fence.test.ts
```

Both are under spike/w5-cluster/ (allowed path); criterion still holds: nothing outside spike/, .omo/reports/kernel-campaign-w5-spike/, package.json, bun.lock. (.omo/ receipts are gitignored and do not appear in status.)

Full branch diff vs base 5b925d12 touches only:
- `.omo/reports/kernel-campaign-w5-spike/check1-smoke.md`, `check1-storage.md`
- `bun.lock` (+22)
- `package.json` (workspaces `+ "spike/*"` only — verified by `git diff 5b925d12 -- package.json`)
- `spike/w5-cluster/**` (README, package.json, tsconfig, src/{crypto,runtime,session-entity,session-file,smoke}.ts, test/check1-boot.test.ts)

Nothing under packages/, apps/, script/, docs/.

## Verdict per sub-check

| # | Sub-check | Verdict |
|---|---|---|
| 1 | boundaries checker exit 0, 233/233 allowlisted, same as main | PASS |
| 2 | allowlist 226 lines / 224 entries, byte-identical to base main | PASS |
| 3 | spike runner sites enumerated: 1 prod-src (smoke.ts), 4 test | PASS (enumerated; prod=1 flagged for W5.2) |
| 4 | any/unknown in spike .ts: 0 | PASS |
| 5 | ultracite: 1 format error (tsconfig.json) | FAIL (reported; spike lane to fix) |
| 6 | check-deps/check-topology exit 1: spike visible as unaccounted workspace | REPORTED |
| 7 | git clean; diff confined to spike/, reports/, package.json workspaces, bun.lock | PASS |

## Findings for W5.2

1. The boundary law is untouched: checker + allowlist byte-identical to base main; the checker does not scan spike/, so the spike currently rides outside the ratchet entirely.
2. Moving the code under packages/ adds exactly 4 test runner sites (ratchet rows) and 1 prod site (smoke.ts) that must be eliminated — delete smoke.ts or fold its boot into an app-level managed runtime.
3. `spike/*` in root workspaces breaks check-deps and all 6 check-topology lanes (workspace inventory drift). W5.2 must either register the package in the topology config or keep the real implementation inside the existing packages/ inventory — do not ship an unregistered workspace.
4. Zero any/unknown in spike TS — the type discipline transfers as-is.
5. One trivial formatter debt: spike/w5-cluster/tsconfig.json include-array formatting (ultracite fix).
