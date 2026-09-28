# manualQa — check 5 (Effect boundary law) — task st_01a0e7fb

All scenarios executed live on 2026-09-28 in /Users/ino/Develop/openomni-w51 (branch kernel/1196-cluster-spike-20260928). Surface for every case is CLI/data-shaped (conformance scripts, grep, git), so terminal invocation is the faithful channel.

## surfaceEvidence

| scenario | criterion | surface | invocation | verdict | artifactRefs |
|---|---|---|---|---|---|
| s1-boundaries-checker | Deliverable item 1 | CLI (bun script) | `cd /Users/ino/Develop/openomni-w51 && /opt/homebrew/bin/mise exec bun@1.4.1 -- bun run script/check-effect-boundaries.ts` | PASS — exit 0, 233 lines all `R2_ALLOWLISTED_RATCHET allowlisted (ratchet)`, no spike/ hits | a1 |
| s2-allowlist-baseline | Deliverable item 2 | data (JSON + git) | `wc -l script/conformance/effect-runner-sites.json` (226); `bun -e '...json().length'` (224 entries); `git diff 5b925d12 -- script/conformance/effect-runner-sites.json script/check-effect-boundaries.ts` (empty) | PASS — unchanged vs base main | a1 |
| s3-spike-runner-sites | Deliverable item 3 | CLI (grep) | `grep -rn -E "runPromise|runPromiseExit|runSync|runSyncExit|runFork|runCallback" spike/w5-cluster/src spike/w5-cluster/test` | PASS — 5 hits enumerated: 1 prod-src (src/smoke.ts:17), 4 test (test/check1-boot.test.ts:34,56,60,101) | a1 |
| s4-any-unknown | Deliverable item 4 | CLI (grep) | `grep -rn -E "\b(any|unknown)\b" --include=*.ts spike/w5-cluster/src spike/w5-cluster/test` | PASS — exit 1, 0 hits | a1 |
| s5-ultracite | Deliverable item 5 | CLI (bunx) | `/opt/homebrew/bin/mise exec bun@1.4.1 -- bunx ultracite check --formatter-enabled=false spike/` | FAIL (reported) — exit 1, single format diagnostic in spike/w5-cluster/tsconfig.json; 8 files checked, no .ts lint errors | a1 |
| s6-deps-topology | Deliverable item 6 | CLI (bun scripts) | `bun run script/check-deps.ts` (exit 1: "topology omits on-disk workspace(s): spike/w5-cluster"); `bun run script/check-topology.ts` (exit 1: 6x workspace-inventory-drift VIOLATION) | REPORTED — scripts DO see the spike, as unaccounted workspace | a1 |
| s7-git-cleanliness | Deliverable item 7 | CLI (git) | `git status --porcelain` (empty, exit 0); `git diff 5b925d12 --stat -- script/ packages/ apps/` (empty); `git diff 5b925d12 -- package.json` (workspaces += "spike/*" only) | PASS | a1 |

## adversarialCases

| scenario | criterion | class | expected behavior | verdict | artifactRefs |
|---|---|---|---|---|---|
| adv1-main-drift | item 1/2 "same numbers as main" | stale-baseline comparison | Comparing only against the worktree could hide checker/allowlist drift on live main. Ran the checker on live main (/Users/ino/Develop/openomni @ 74cf90dc): exit 0, 233/233 allowlisted — same numbers. Diffed live-main allowlist vs worktree: 7 entries re-numbered (retry.test.ts, exec.test.ts) by post-base main commits, entry count identical (224); spike branch is byte-identical to its own base 5b925d12. | PASS (drift detected, attributed to main progression, not the spike) | a1, a2 |
| adv2-checker-blind-spot | item 1/3 | false-negative via unscanned directory | The checker exiting 0 could mean it simply never scans spike/. Confirmed: no spike/ path in checker output while grep proves 5 runner sites exist in spike/ — so PASS on item 1 is "law unchanged", not "spike is clean"; the 5 sites are the true cost of moving under packages/. | PASS (blind spot confirmed and quantified) | a1 |
| adv3-entry-count-semantics | item 2 "expected 226 entries" | spec ambiguity (lines vs entries) | wc -l = 226 but JSON array length = 224 (2 bracket lines). Verified against base main via `git show 5b925d12:...json | wc -l` = 226 and empty git diff: both readings unchanged. | PASS (ambiguity resolved with both numbers recorded) | a1 |
| adv4-hidden-tree-changes | item 7 | untracked/committed changes outside allowed paths | `git status --porcelain` empty could still hide committed out-of-scope edits. Ran full `git diff 5b925d12 --stat`: 13 files, all under spike/, .omo/reports/kernel-campaign-w5-spike/, bun.lock, package.json (workspaces line only). | PASS | a1 |
| adv5-flaky-checker | item 1 | nondeterministic checker output | Checker run 3x during evidence collection (worktree twice, main once); identical 233-line all-allowlisted output and exit 0 each time. | PASS | a1, a2 |

## artifactRefs

| id | kind | description | path |
|---|---|---|---|
| a1 | markdown receipt | Full check-5 receipt: exact commands, stdout excerpts, exit codes, per-sub-check verdicts, Findings for W5.2 | /Users/ino/Develop/openomni-w51/.omo/reports/kernel-campaign-w5-spike/check5-boundaries.md |
| a2 | raw stdout capture | check-effect-boundaries.ts output on live main @ 74cf90dc (233 lines) | /tmp/main-boundaries.out |
