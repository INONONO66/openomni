# #937 R1: transitive raw-body retention correction

## Outcome and scope

This increment fixed ordinary transitive retention on `kernel/937-integration`, additively over `5c96d52221d897c5990921f786744cbd317df139`. `REVIEW-WAVE-R2.md` subsequently demonstrated missing retention below the configured tool timeout race; the actual-definition correction and proof are in `REPORT-WAVE-R3.md`. This historical receipt is not full R1 or #937 approval. Prior wave/compaction/G034 commits are unchanged ancestors. Task: `st_01a07652`.

The existing per-turn executor now binds the session's signal and retention capability. `runBatch` combines caller, enclosing body and turn cancellation, and passes the bound owner (or inherited owner for standalone nested executors) to every raw body. `run` uses that same path. The ambient scope carries ownership as well as its signal. The existing session effect set drains until empty; no second manager, lock, policy engine, action store or migration was added. Existing fenced ledger admission and heartbeat/release ownership are unchanged.

Six production files change by 26 additions / 9 deletions. The other code changes are regressions in the existing app wave and scheduler suites. No A4+ migration, original-worktree write, push, PR or comment was performed.

## Failing-first proof and real surface

Evidence directory **E**: `.omo/evidence/937/wave-r2/st_01a07652/`.

The review probe at `.omo/evidence/937/review-wave/st_01a0764a/nested-countercase.test.ts` was adapted into `apps/openomni/test/session-wave-e2e.test.ts` before production edits. It uses the existing real app, authenticated WebSocket, public SDK session handle, actual Anthropic SDK/local SSE, file-backed SQLite, production executors/dispatchers and a gated filesystem write. Only provider catalog resolution is supplied; no execution, policy or storage mock drives the app proof.

- **Original RED:** 0 pass / 6 fail, 52 assertions (`red.txt`). Every case observes contender `{ok:true,fence:2}` instead of refusal while its raw effect is still blocked.
- **Final mutation RED:** replacing only the retention selection with `retain: control.retain` kills all six app cases and the standalone transitive test: 0 pass / 7 fail, 60 assertions (`toggle-red-2.txt`). All six contenders acquire fence 2; standalone retained body count is 1 instead of 3. The mutation was reversed before final compiler/build/tests.
- **GREEN:** both Bun versions pass the final seven regressions as part of their single related-suite execution.

The six doors are current `run`, current `runBatch`, captured `run`, captured `runBatch`, captured cell dispatch and captured wave dispatch. Captured calls are invoked from the test continuation outside ambient execution; `currentExecutor()` is explicitly unavailable there. Captured cases finish the top-level tool before interrupting at the next exact provider completion, so retaining a top-level body cannot mask the bug. Current cases catch/unwind the nested abort while the inner raw effect remains live.

Each case proves SDK interruption and wrapper settlement before releasing the raw effect; existing completed/canceled positional slots; contender refusal while the marker is absent; successful raw file write afterward; lease release and fence-2 acquisition only afterward; and zero body starts and action additions from the captured executor both after seal and after takeover. The standalone test additionally uses two real, unbound executors under one wave owner, including a nested batch with an independent signal, and retains all three actual body promises.

### Fixture corrections retained in evidence

The first GREEN attempt (`green.txt`) had six WebSocket reply deadline failures: the existing Resident binding closes the handle before sending the channel reply, and close joins retention. The test now checks immediate release at **SDK `interrupt()`**, and awaits the channel reply only after the effect is released. No production channel/close behavior was changed and no deadline was increased.

The first mutation probe (`toggle-red.txt`) showed that four captured cases could pass while the top-level body was still transiently retaining the lease. Their oracle was strengthened: top-level completion now precedes the exact second-model interrupt, and wrapper settlement precedes contender acquisition. The final mutation kills all seven cases. No assertion was weakened or failing test skipped.

## Verification

All commands ran in `/Users/ino/Develop/openomni-937-integration` on macOS arm64. Exact reproducible commands are below and in `E/commands.txt`.

| Validator | Executed result |
| --- | --- |
| LSP on all eight changed TypeScript files | Daemon unreachable; recorded in `diagnostics.txt`, not claimed clean |
| Installed agent, LLM and app test-project `tsc --noEmit` | Exit 0, before build and final tests (`final-types.txt`) |
| Forced full workspace build, local cache, concurrency 8 | 6 successful / 6 total, 0 cached (`build.txt`) |
| Bun 1.3.6 related suite, including the complete agent suite | **402 pass / 0 fail**, 1,258 assertions, 60 files (`related-1.3.6.txt`) |
| Bun 1.4.1 same related suite | **402 pass / 0 fail**, 1,258 assertions, 60 files (`related-1.4.1.txt`) |
| Biome on all eight changed TS files; diff whitespace | Exit 0 (`final-lint.txt`) |
| Dependency, import-cycle and dead-export gates | Exit 0; 0 cycles/new export issues (`gates.txt`) |

The dependency gate reports pre-existing stale `packages/ipc/AGENTS.md` and `packages/placement/AGENTS.md`; they were not edited. No full-repository test, coverage, global mutation or hosted-CI claim is made for this focused correction.

```bash
cd /Users/ino/Develop/openomni-937-integration
B136=/Users/ino/.local/share/mise/installs/bun/1.3.6/bin/bun
B141=/Users/ino/.bun/bin/bun
./node_modules/.bin/tsc --noEmit -p packages/agent/tsconfig.test.json
./node_modules/.bin/tsc --noEmit -p packages/llm/tsconfig.test.json
./node_modules/.bin/tsc --noEmit -p apps/openomni/tsconfig.test.json
PATH=/Users/ino/.local/share/mise/installs/bun/1.3.6/bin:$PATH "$B136" run build --force --cache-dir=.turbo/r2-cache --concurrency=8

# The following identical command was executed once with each runtime:
for BUN in "$B136" "$B141"; do
  "$BUN" test --config=/dev/null --timeout 15000 \
    apps/openomni/test/session-wave-e2e.test.ts \
    apps/openomni/test/session-loop-e2e.test.ts \
    apps/openomni/test/channel-delegation-e2e.test.ts \
    apps/openomni/test/delegation-e2e.test.ts \
    apps/openomni/test/code-mode-e2e.test.ts \
    apps/openomni/test/fact-tap-retirement.test.ts \
    apps/openomni/test/resident-tool-executor-wiring.test.ts \
    apps/openomni/test/worker-tool-executor-wiring.test.ts \
    apps/openomni/test/gateway-contracts.test.ts \
    packages/agent/test \
    packages/llm/test/run-tool-execution.test.ts \
    packages/llm/test/run-stream-args.test.ts
done
```

This executes the original 11 wave cases, compaction/overflow and heartbeat/fencing suites, real SSE compaction with six requests/two summaries and persisted reversible evidence, G034 archive/verify/dispose channel delegation, Resident/worker wiring, real code-mode transport and fact-tap retirement. The real surface is exercised by the app regression itself, not by a mock substitute or an unrun manual recipe.

## Hashes and cleanup

SHA-256 receipts:

| Artifact in E | SHA-256 |
| --- | --- |
| `red.txt` | `402ddf45b4b3f2af262a71b0cb99eb659c55cb0489566520d8093505ee668f87` |
| `toggle-red-2.txt` | `3f05d8e395a54aeb70f98f3a7e2c5875a311893baa4d72d89a6b7196a6a2fdcf` |
| `related-1.3.6.txt` | `5f6d5612b6e07eeca7555f24ee904687edfed567a6ae614c5975e21937af779d` |
| `related-1.4.1.txt` | `e57297d86949b46156922c9cc5eaddda5ed6b23f5b2ce2befaf5d364f6ae1b3f` |
| `build.txt` | `6679667e99fe9e4abbdce0989df0ed819929b90709a9af55a8d0b937b98e77f1` |
| `source-SHA256SUMS` (all eight changed TS files) | `95958488930ebd28ab8d5d623b39f265767b66a77cadd58968cace1d37b05d25` |

`fix.patch`, `regression.patch` and `SHA256SUMS` retain the source delta and evidence inventory. The additive commit hash/tree are recorded in `E/commit.txt` after committing; prior commits are not rewritten.

All test gates are released in `finally`; the captured wrapper and actual file effect are awaited before teardown. Contender leases are released, app/provider ports rebound, sockets closed, SQLite reset and unique directories removed by asserted cleanup. Related code-mode receipts record interpreter exit/close and Unix-socket removal. The process census found no task test/provider/interpreter process left; the pre-existing Turbo daemon and unrelated campaign work were untouched. No debug instrumentation remains in production.

The reserved original remains read-only. Recomputed tracked diff SHA-256 is `6d5ce7f8953b3911e61b35f21e597bee1a8a3436d58411ca59ccab4de52a8bb7`; all ten untracked hashes match the prior wave preservation receipt (`E/original-preservation.txt`). Existing untracked `REVIEW-WAVE.md` and `REVIEW-R2.md` remain uncommitted and unmodified. A4-A10 and the full-issue review obligations remain open.
