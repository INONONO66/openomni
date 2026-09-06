# PR980 coverage R2: aggregate gate passed

Parent: `613681bdf27f2a952d2d1c030c19b8c964e824d9`. Test-only follow-up on the assigned `kernel/937-integration` branch; all prior commits and A1-A3 production changes are retained. No A4 design, production fix, baseline/configuration change, exclusion, removed assertion, skipped test, push, or PR.

## Aggregate evidence, including the original denominator

Final agent command, executed **once** after restored mutation probes and build:

```sh
cd packages/agent
PATH=/Users/ino/.local/share/mise/installs/bun/1.3.6/bin:$PATH bun run test:ci
```

UTC interval: **2026-09-06T13:11:13.295703Z to 13:11:14.697730Z**. Raw output begins with the nested CI command and **`bun test v1.3.6 (d530ed99)`**; the capture wrapper asserts that banner and exit 0. Result: **378 pass, 0 fail, 1,045 assertions, 50 files**.

All figures below sum only owned `SF:src/` records, not dependency coverage or Bun's headline.

| Measurement | Owned records | LH | LF | Exact coverage |
|---|---:|---:|---:|---:|
| Preserved independent pinned review run, before R2 | 30 | 4,855 | 5,055 | 96.0435212661% |
| Fresh native Bun 1.3.6 LCOV | 30 | 5,012 | 5,052 | 99.2082343626% |
| **Conservative acceptance, frozen original line universe** | **30** | **5,012** | **5,055** | **99.1493570722%** |

The native LCOV omitted three formerly zero-hit DA records in unchanged `executor-approval.ts`: **138, 141, 147**. This was discovered when the initial aggregate calculation's unchanged-native-LF assertion failed. No source or coverage file was edited to remove those records. The conservative calculation keeps every original executable line and counts all three omissions as uncovered: **157 genuinely newly covered original lines**, no new line identities, no denominator benefit. That exceeds the required LH 4,939 by **73 lines**.

`check-aggregate.ts` calls the repository's actual `parseLcovSummary` and `compareCoverage` with the unchanged agent baseline **98.2** and tolerance **0.5**. Both native and frozen-universe comparisons have **zero violations** and exceed **97.7%** without rounding dependence. This verifies the agent lane, not a fresh whole-repository coverage run. The checker's suggestion to update the baseline was deliberately not acted on.

Exact original uncovered-line lists and final lists are in `aggregate.json`; recovered original line identities are in `aggregate-gate.txt`. The gains are:

| Concern | Before LH/LF | Final native LH/LF | New original lines hit |
|---|---:|---:|---:|
| Executor approvals: validation, authentication, decisions, expiry, abort, commit failure, cleanup | 17/136 | 133/133 | 116 |
| Approval error construction | 2/6 | 6/6 | 4 |
| Session transformed-usage validation, required/optional counters and strict shape | 1260/1308 | 1297/1308 | 37 |

Wave cancellation and compaction restoration assertions receive **no numerical coverage credit**: their value is mutation discrimination, not inflating already-covered files. Other remaining own-source uncovered groups are explicitly retained in `aggregate.json` (40 native, 43 under the frozen universe).

## Behavioral oracles and mutation discrimination

The cancellation test now returns the **raw deferred promise**, rather than an async adoption wrapper. It aborts, settles that raw promise with separate fulfillment and rejection countercases, awaits the exact retained scheduler effect with a bounded failure deadline, and only then checks the actual returned outcome. No cloned result snapshot substitutes for observing settlement. Both precise overwrite mutants fail **the new cancellation assertion at test line 285**, returning `fulfilled` or `rejected` instead of `cancelled`. The rejection/barrier continuation test remains intact.

The new approval tests use the production compiled policy and executor with the existing recording-ledger seam; they do not mock the approval manager, scheduling, or policy decisions. Session tests use real isolated SQLite storage and compiled post-policy transformations. The compaction oracle exercises the production restoration function with a missing original boundary.

**39/39 temporary mutants discriminated** their explicitly selected test; unrelated test failures do not count. Each source is read, patched once, executed, restored in `finally`, and SHA-256-checked. Final RED interval: **2026-09-06T13:10:19.556490Z to 13:10:25.542504Z**. All observed failures are value/type assertions, not timing failures. `mutations.json` maps every probe to its test, timestamp, exit code, and original source hash; `mutate.py` contains the exact edits. The per-oracle matrix is:

| New or strengthened oracle | Mutations that its selected execution rejects |
|---|---|
| Late fulfillment preserves cancellation | Unconditional fulfillment overwrite |
| Late rejection preserves cancellation | Unconditional rejection overwrite |
| Existing added rejection/barrier continuation | Rejection escapes the scheduler and poisons the join |
| Authenticated approve; authenticated refuse (each separately) | Opposite decision; aliased pending snapshot; absent evidence; wrong credential; wrong tools generation; wrong input hash; wrong answer parent; omitted durable answer (8 each) |
| Forged request / unavailable authority | Bypassed request digest binding; accepting an answer with no authority (2) |
| Cancellation during asynchronous authorization | Removed post-authorization staleness recheck |
| Exact scheduled deadline | Early expiration; wrong deadline evidence; wrong scheduled delay; wrong expiresAt; missing deadline cancellation (5) |
| Native immediate deadline | Expiration approves instead of timing out |
| Failed timeout commit | Swallowed commit failure; leaked pending approval (2) |
| Invalid approval timeout | Accepting -1 as a valid timeout |
| Valid required session counters | Corrupted totalTokens |
| Valid optional session counters | Corrupted reasoningTokens, cacheReadTokens, cacheWriteTokens (3) |
| Invalid required counter | Removed required-counter validation |
| Invalid optional counter | Removed optional-counter validation |
| Unknown counter | Removed usage key whitelist |
| Compaction restoration without kept boundary | Removed boundary check |

All new held promises are released/drained in `finally`; rejection observers are attached before the asynchronous rejection triggers. Deadline behavior uses either an explicitly signaled scheduler callback and injected clock or the real zero-duration timer (time is the behavior under test). There are no sleeps, polling loops, or prose-pinning assertions.

## Restored verification and real application surface

All commands below used the same PATH prefix shown above.

- `bun run build`: **6 successful tasks**, 4 cached; agent and app TypeScript builds actually executed.
- `bun run --cwd packages/agent check-types`: passed source, benchmark, and test compiler projects.
- `bunx biome check --formatter-enabled=false` over all four changed test files: **4 checked, no errors**.
- Restored focused suite: **78 pass, 0 fail, 346 assertions**, before final mutation/CI verification.
- Final agent CI: **378 pass, 0 fail, 1,045 assertions**, as above.
- `cd packages/llm && bun test --timeout 15000`: **382 pass, 0 fail, 895 assertions**, UTC 13:11:13.296307Z-13:11:14.359904Z.
- `cd apps/openomni && bun test --timeout 15000 test/session-wave-e2e.test.ts`: **25 pass, 0 fail, 341 assertions**, UTC 13:11:13.296040Z-13:11:15.423734Z. This executes the real app entry point, authenticated WebSocket ingress, provider HTTP/SDK path, SQLite-backed session/executor, approval/refusal/expiry, interrupts, and late raw settlement. The suite owns sockets, provider servers, app shutdown, storage reset, and temp directories. Its before/after temp-state sets are both empty; a final independent census is also empty. The agent/LLM receipts briefly see app-owned temp directories because these independent suites ran concurrently, not leaked resources.

Language-server diagnostics were requested on every changed test. The existing `test/tsconfig.json` selects `types: []` and inherits the source `rootDir`, producing Bun/global/lib/rootDir diagnostics; those LSP results are **not claimed clean**. The actual package `tsconfig.test.json` compiler passed, as did the source and benchmark projects. The aggregate verifier has no LSP diagnostics. Initial fixture-development failures (missing approval-policy reason, test typing, and one empty observation callback) were corrected in tests; the rejected `--coverage=false` CLI attempt in `approval-green.txt` is not GREEN evidence. Exploratory outputs are retained, not relabeled as final passes.

## Provenance, retained history, and artifacts

`REPORT-COVERAGE.md` now correctly labels the original baseline and historical restored CI output as **nested Bun 1.4.1**, despite the old filename `coverage-agent-1.3.6.txt`. The original historical RED/focused GREEN really used 1.3.6. Those three committed raw logs are byte-for-byte unchanged. The original pre-613681bd pinned baseline remains unverified; the independently preserved review run is the genuine pinned pre-R2 comparison.

The requested `.omo/evidence/pr980/review-coverage/st_01a076bf` directory was absent in the supplied worktree. The review's actual `/tmp/pr980-review-ci-1.3.6.txt`, LCOV, and probe output were present and copied without overwriting their originals. The retained historical unpinned `/tmp/pr980-baseline-agent.txt` is also copied under its correct 1.4.1 label.

Important SHA-256 values:

- Preserved review LCOV: `6292b6bbb59311381e7df6415f74aa1e0c9839ec785b54d20379cac8174ee13f`.
- Fresh final LCOV: `9d6c003aa0b51aeafe77dba769750cc1e065c9c21d2733811af3064be7fcd8f0`.
- Fresh raw agent CI: `79555b6b03e1113e96d20718c359190d3d4763dbbcaf9b7cda7ebea2436d23a4`.
- Unchanged agent production Git tree: `6e82930208e1766ddf287ce514495a3a921a363f`.

Evidence directory: `.omo/evidence/pr980/coverage-r2/`. To keep the additive commit small, its full raw evidence is committed as **`raw-evidence.tar.gz`**, alongside the executable verifiers and `SHA256SUMS`. The loose originals remain in this worktree; in another checkout, extract with `tar -xzf raw-evidence.tar.gz` from that directory, then use `shasum -a 256 -c SHA256SUMS`. `source-SHA256SUMS` records the final test/helper bytes. No original report or baseline log is replaced by the archive.

The reserved `/Users/ino/Develop/openomni-wt-937` remains on `5f3a75ff`; its before/after status and diff digest match. Untracked review documents in the integration worktree are left untouched and excluded from this commit. The final commit hash is supplied in the handoff rather than self-embedded in this report.
