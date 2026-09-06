# #937 R1: actual timed definition retention

## Delivered correction

The remaining timed-body R1 invariant is fixed additively on `kernel/937-integration`, over `4f04a2fec0115929e294c581a615e57790c5fa89`. Ready for incremental review, not full #937 closure. Prior commits and the reserved original worktree are preserved.

Production change: **four added lines in `packages/agent/src/tool-body.ts`**. Before installing/racing the timeout, the actual `definition.execute(...)` settlement is registered with the same bound/inherited owner already carried by `waveBodyScope`. The retained promise is derived from the definition's settlement, never from `Promise.race`. Its existing success/error conversion means rejection also fulfills the ownership promise, so the session's existing set removes it normally. No rejection is silently discarded: the existing definition error result is preserved; a result arriving after timeout cannot replace the frozen timeout result.

No executor, lease manager, policy engine, lock or store was added. Dispatcher, session heartbeat/release and late-commit fence implementations are unchanged. Immediate timeout wrapper and SDK interruption release remain independent of raw settlement. The untimed path already awaits the definition directly and is unchanged.

## Failing-first and real proof

Evidence **E**: `.omo/evidence/937/wave-r3/`. The reviewer countercase from `.omo/evidence/937/review-wave-r2/st_01a07664/timeout-countercase.test.ts` was adapted into the existing app wave test before any production edit.

- Eight real-app cases: timed current/captured cell/wave, each with raw fulfillment and rejection. These use authenticated WebSocket, the actual app, Anthropic SDK/local SSE, public SDK handle, real file SQLite and a gated filesystem effect. Only catalog resolution is supplied. Captured calls run outside ambient execution; current calls resolve the enclosing executor.
- Four standalone cases: real unbound executor and dispatcher inherit only the enclosing wave's retainer, with timed cell/wave and fulfillment/rejection. After both wrappers settle, exactly the raw definition remains retained; after it settles, the retained set empties, including rejection.
- **Semantic RED before production edit:** 0 pass / 12 fail, 76 assertions (`red-2.txt`). Every app contender wrongly acquires fence 2 while the file effect is gated; every standalone case has 0 retained effects instead of 1.
- **GREEN:** 414 pass / 0 fail, 1,418 assertions across 60 files on **each** Bun 1.3.6 and 1.4.1, one final related execution per runtime. All original seven ordinary-retention regressions remain unchanged and pass.
- **Unmodified reviewer probe replay:** 2 pass / 0 fail, 22 assertions on each runtime. Its real receipt now has `contender.ok=false`, `reason=held`, marker absent before release, marker present afterward, and zero stale starts (`reviewer-green-1.3.6.txt`, `reviewer-green-1.4.1.txt`).

Each app regression waits for the definition's exact timeout abort and the error wrapper result before finishing the top-level tool. SDK interruption is subscribed before the second provider completion. The contender is checked only after timeout wrapper, parent and interrupt settlement, so none can mask missing raw retention. Assertions preserve ordered nested timeout/top-level result slots, independently read SQLite action count, refuse contender before the raw write, allow fence 2 afterward, and prove zero stale body starts/actions after both seal and takeover. Existing canceled-slot, sequential-barrier and abort-linearization tests also pass.

The initial RED (`red.txt`) had an incorrect cross-wave order expectation in the app fixture: nested timeout results commit before the enclosing wave commits its A/outer positional results. The exact expected order was corrected before production edits; the subsequent semantic RED above fails on retention in all twelve cases. No assertion was weakened, timeout increased, test skipped or polling/sleep introduced. The zero-duration timer is itself the behavior under test; all other waits use exact events/deferred gates with bounded failure deadlines.

## Verification commands and results

All execution occurred in `/Users/ino/Develop/openomni-937-integration`, macOS arm64. Complete exact command history is `E/commands.txt`.

```bash
cd /Users/ino/Develop/openomni-937-integration
B136=/Users/ino/.local/share/mise/installs/bun/1.3.6/bin/bun
B141=/Users/ino/.bun/bin/bun
./node_modules/.bin/tsc --noEmit -p packages/agent/tsconfig.test.json
./node_modules/.bin/tsc --noEmit -p packages/llm/tsconfig.test.json
./node_modules/.bin/tsc --noEmit -p apps/openomni/tsconfig.test.json
PATH=/Users/ino/.local/share/mise/installs/bun/1.3.6/bin:$PATH "$B136" run build --force --cache-dir=.turbo/r3-cache --concurrency=8

# Identical target set executed once with each runtime:
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
    packages/agent/test packages/llm/test/run-tool-execution.test.ts \
    packages/llm/test/run-stream-args.test.ts
done
```

Installed compilers passed before build/tests (`types.txt`); forced build passed 6/6 tasks with 0 cache hits (`build.txt`). The RED phase also had compiler/build success before execution. LSP was attempted on all three changed TS files but its daemon was unreachable; no clean-LSP claim. Biome and whitespace checks pass. Dependency/cycle/dead-export gates pass, with only pre-existing stale IPC/placement AGENTS warnings. No root config, baseline, migration or A4+ source edits occurred.

The related targets include the complete agent suite, all original wave/compaction/heartbeat/fencing cases, real SSE reversible compaction (six requests/two summaries), G034 archive/verify/dispose and channel delegation, Resident/worker wiring, inline delegation, real code-mode transport and fact-tap retirement. No full-repository tests, global mutation/coverage or hosted CI are claimed.

## Preservation, hashes and cleanup

SHA-256:

| E artifact | Hash |
| --- | --- |
| `red-2.txt` | `3b39f6c280c41e12084eee373bb83cfbc214bc7165ce75d80f8caf63cae0f7e1` |
| `related-1.3.6.txt` | `8579c5b00d1e0171e2318b9a0bfefc76ccbe975ab342ab16bff3527ee6fbcf64` |
| `related-1.4.1.txt` | `22af620a68e7173be4c6043fae38daaa56137545081fcbc407d9b4f82bab73a6` |
| `source-SHA256SUMS` | `6cf7bb47a9bfb17976cff3d49215d0225f7e64af4894c36cfef768cae4f87c47` |

`fix.patch` and `regression.patch` retain the exact changes. `E/SHA256SUMS` inventories evidence; `E/commit.txt` records the additive commit/tree after committing. All previous R2 evidence hashes verify unchanged. All review document hashes verify unchanged. The reserved original tracked diff remains `6d5ce7f8953b3911e61b35f21e597bee1a8a3436d58411ca59ccab4de52a8bb7`, and all ten untracked hashes exactly match R2 preservation (`original-preservation.txt`).

Finally blocks release both gates and await the actual effect and channel binding completion before teardown. Both fulfilled and rejected raw definitions release the lease. Contender leases are explicitly released. Cleanup asserts directory removal, socket closure and app/provider port rebind; standalone retention empties after settlement. Real code-mode tests record interpreter exit and socket cleanup. The unchanged reviewer probes also emit successful resource-cleanup receipts. Task runtimes terminate; no owned background process was launched. Pre-existing Turbo and unrelated campaign processes were untouched.

`REPORT-WAVE-R2.md` is corrected as a historical ordinary-retention receipt, with this timed correction linked from `REPORT-WAVE.md`. Only the three pre-existing untracked review documents remain outside the commit. No original-worktree write, push, PR or comment. Full #937 A4-A10 and independent review remain open.
