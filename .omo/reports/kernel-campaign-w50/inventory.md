# W5.0 tsc inventory (bare pin effect@4.0.0-rc.118, no code changes)

Source: `tsc-inventory.txt` (per-tsconfig `tsc --noEmit`, 21 configs; turbo halts at the first failing build so this was collected per package). Errors deduplicated by file:line:col:code across overlapping test/src tsconfigs.

**Unique errors: 1792** across 246 files. packages/protocol: 0 (stays Effect-free). packages/policy: 0.

## By pattern bucket (primary errors = a missing/renamed effect member)

| Bucket | Errors | Files |
| --- | ---: | ---: |
| Either -> Result / Effect.either -> Effect.result | 286 | 66 |
| Cause flattening + exception renames | 52 | 31 |
| Effect combinator renames (async/zipRight/timeoutFail/semaphore/serviceOptional/locally) | 50 | 36 |
| fork/fiber-runtime renames | 46 | 12 |
| Context.Tag/GenericTag -> Context.Service | 42 | 20 |
| Deferred/Fiber API (unsafeDone/RuntimeFiber/poll) | 39 | 16 |
| Layer scoped/unwrap/toRuntime merge | 31 | 14 |
| catch* renames | 22 | 15 |
| Scope/ExecutionStrategy | 17 | 12 |
| TestContext/TestClock moves | 12 | 6 |
| Queue API | 4 | 4 |
| FiberRef -> Context.Reference | 4 | 4 |
| Other member: effect.Supervisor | 1 | 1 |
| Secondary cascade (implicit any / unknown / assignability / arity / iterator) | 1119 | 209 |
| Unclassified | 67 | - |

## Exact renamed members (count)

| Member | Errors | v4 target (migration/v3-to-v4.md) |
| --- | ---: | --- |
| Effect.either | 237 | Effect.result |
| effect.Either | 49 | Result |
| Effect.fork | 42 | Effect.forkChild |
| Context.Tag | 33 | Context.Service |
| Deferred.unsafeDone | 28 | Deferred.doneUnsafe |
| Effect.zipRight | 21 | Effect.andThen |
| Cause.isInterrupted | 19 | Cause.hasInterrupts |
| Effect.async | 16 | Effect.callback |
| Layer.scopedDiscard | 14 | Layer.effectDiscard |
| Scope.extend | 14 | Scope.provide |
| Effect.catchAll | 12 | Effect.catch |
| Cause.failureOption | 11 | Cause.findErrorOption |
| Layer.scoped | 10 | Layer.effect |
| Fiber.RuntimeFiber | 10 | Fiber.Fiber |
| Cause.isInterruptedOnly | 7 | Cause.hasInterruptsOnly |
| Effect.catchAllCause | 7 | Effect.catchCause |
| Context.GenericTag | 7 | Context.Service<T>(id) |
| effect.TestClock | 6 | effect/testing/TestClock |
| effect.TestContext | 6 | Layer.mergeAll(TestConsole.layer, TestClock.layer()) |
| Cause.defects | 6 | reasons.filter(Cause.isDieReason) |
| Effect.timeoutFail | 5 | Effect.timeoutOrElse |
| Effect.makeSemaphore | 5 | Semaphore.make |
| Queue#.unsafeOffer | 4 | ? |
| Cause.failures | 4 | reasons.filter(Cause.isFailReason) |
| effect.FiberRef | 4 | Context.Reference |
| Layer.scopedContext | 3 | Layer.effectContext |
| Cause.dieOption | 2 | Cause.findDefect (Result) |
| Effect.unsafeMakeSemaphore | 2 | Semaphore.makeUnsafe |
| Context.isTag | 2 | Context.isKey |
| Cause.isDie | 2 | Cause.hasDies |
| Scope.CloseableScope | 2 | ? |
| Effect.catchAllDefect | 2 | Effect.catchDefect |
| Layer.unwrapScoped | 1 | Layer.unwrap |
| Effect.forkDaemon | 1 | Effect.forkDetach |
| Cause.stripFailures | 1 | Cause.fromReasons(filter) |
| Effect.withFiberRuntime | 1 | removed |
| effect.ExecutionStrategy | 1 | "sequential" literal |
| Effect.tapErrorCause | 1 | Effect.tapCause |
| effect.Supervisor | 1 | ? |
| Effect.supervised | 1 | FiberSet |
| Fiber.poll | 1 | fiber.pollUnsafe() |
| Layer.fail | 1 | Layer.unwrap(Effect.fail) |
| Effect.disconnect | 1 | Effect.forkDetach |
| Layer.scope | 1 | Layer.effect(Scope.Scope, acquireRelease) |
| Layer.unwrapEffect | 1 | Layer.unwrap |
| Effect.locally | 1 | Effect.provideService |

## By package

| Package | Errors |
| --- | ---: |
| packages/agent | 810 |
| apps/openomni | 405 |
| packages/ledger | 377 |
| packages/codemode | 64 |
| packages/llm | 43 |
| packages/ipc | 41 |
| packages/machines | 23 |
| packages/channels | 23 |
| script | 6 |

## By file (top 40)

| File | Errors |
| --- | ---: |
| packages/agent/test/session-handle.test.ts | 109 |
| packages/agent/test/bundle.test.ts | 97 |
| packages/codemode/src/kernel.ts | 58 |
| packages/ledger/test/session/kernel.test.ts | 39 |
| packages/ledger/test/session/write-discipline.test.ts | 39 |
| packages/ledger/test/storage/storage-boundaries.test.ts | 37 |
| packages/ledger/test/session/message-commit.test.ts | 33 |
| packages/ledger/test/storage/adapter-contracts.test.ts | 33 |
| packages/agent/test/session-lifecycle-conformance.test.ts | 33 |
| packages/agent/test/session-generation-swap.test.ts | 32 |
| packages/ledger/test/storage/alarm.test.ts | 30 |
| apps/openomni/test/monitor-occurrence.test.ts | 30 |
| packages/agent/test/tool-capability-bridge.test.ts | 27 |
| apps/openomni/src/gateway.ts | 25 |
| packages/agent/src/executor.ts | 24 |
| packages/agent/test/core/execution/tool-wave.test.ts | 23 |
| packages/agent/test/helpers/service-layers.ts | 21 |
| apps/openomni/src/composition/generation-layers.ts | 20 |
| apps/openomni/src/index.ts | 20 |
| packages/ledger/test/session/message-deadline.test.ts | 19 |
| packages/ledger/test/storage/request-count-cas.test.ts | 19 |
| packages/agent/src/bundle.ts | 18 |
| packages/agent/src/core/execution/run.ts | 18 |
| apps/openomni/test/generation-layers.test.ts | 17 |
| packages/ledger/test/storage/process-layers.test.ts | 16 |
| packages/ledger/test/integration/observability.test.ts | 15 |
| packages/ipc/src/peer-request-table.ts | 15 |
| packages/agent/src/session-turn.ts | 15 |
| packages/agent/test/generation-retirement.test.ts | 15 |
| apps/openomni/test/monitor-dispatcher.test.ts | 15 |
| apps/openomni/test/monitor-message-controls.test.ts | 15 |
| packages/ledger/test/storage/alarm-control.test.ts | 13 |
| packages/ledger/test/storage/sqlite-storage.test.ts | 13 |
| packages/agent/test/generation-policy.test.ts | 13 |
| packages/ledger/test/session/commit-fencing.test.ts | 11 |
| packages/ledger/test/session/received-message.test.ts | 11 |
| packages/agent/test/helpers/session-services.ts | 11 |
| packages/agent/test/core/entropy.test.ts | 11 |
| packages/agent/test/session-fsm.test.ts | 11 |
| packages/agent/test/session-outbound.test.ts | 11 |

## Unclassified samples

- 37x `'…' has no exported member named '…'. Did you mean '…'?`
- 30x `Property '…' does not exist on type '…'.`
