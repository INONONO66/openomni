# @openomni/telemetry

The observation channel. Ring 1, depends only on `@openomni/protocol`.

Everything the system says about itself goes through here: the process-wide `Bus`, an emitter that owns trace identity, and sink combinators. Nothing durable, nothing that decides.

## THE BOUNDARY RULE

**Replacing this package with no-ops must leave observed behavior identical.**

That is not a style preference; it is what makes the package safe to put in a hot path. Concretely:

- `Emitter.emit` never throws. A sink that fails is reported through `onEmitError` and the caller continues; a reporter that itself throws is swallowed, because there is nothing left to report to.
- `Emitter.child` never throws. A narrowing that omits a field keeps the parent's value.
- `tee` swallows a downstream throw and reports it.
- The one place that *does* throw is `scope()`, at construction — the composition root, where a malformed identity is a wiring error the process should not start with.

If something here can change what the observed code does, it belongs in `@openomni/policy` instead.

## FILES

```
src/
├── bus.ts     # Bus.publish / subscribe / observe, AsyncLocalStorage isolation, diagnostic stats
├── trace.ts   # TraceScope + requireTraceScope (construction-time guard)
├── scope.ts   # scope(trace, sink) -> Emitter: emit, child
└── sink.ts    # collector (tests), noopSink (the boundary reference), tee (fan-out)
```

## WHY THE EMITTER OWNS IDENTITY

```ts
export type EmitPayload<T> = Omit<T, TraceField | "time">;
```

A caller cannot pass `traceId` / `sessionId` / `runId` / `actorId` / `agentName` / `time` — they are removed from every payload type, and applied last at runtime so a cast cannot override them. `child()` cannot replace `traceId` at all: a child run, a delegated actor, and a nested span all belong to the same trace.

This exists because thirteen sites in the agent core minted a fresh `crypto.randomUUID()` per event. Those events were structurally uncorrelatable with the run that produced them — the record looked authoritative and pointed at nothing. **All thirteen are converted**: `core/retry.ts`'s eight were narration of a pure decision the caller already reports correlated, so they were deleted rather than rewired; `core/budget.ts`, `core/execution/compaction.ts`, and `../openomni/src/execution-runtime/middleware/tool-permission-policy.ts` inherit the run's trace or refuse. **`packages/agent/src` mints no trace id at all.** The three that remained in `src/runtime/mcp/client.ts` are converted too: a server's lifecycle is reported under the trace of whatever brought it up (the boot, by way of `McpToolProvider`) or not reported, and a tool call inherits the trace of the run that made it or is refused.

The rest of the tree has not caught up — see D11 in [docs/agent-core-rewrite.md](../../docs/agent-core-rewrite.md) for the remaining count, and note that `scope()` itself still has no production caller.

## WHAT IS WIRED TODAY

`Bus`, `newTraceId`, and `newSpanId` have production consumers. Everything else — `child`, the sinks (`tee`, `noopSink`, `collector`), the `traceparent` codec, and the guards (`requireTraceScope`, `rootScope`, `isTraceId`, `isSpanId`, `InvalidTraceScopeError`) — has zero PRODUCTION consumers, but its test/bench consumers span packages: `collector` is imported by llm, agent, and openomni tests (not just this package's own), `noopSink` by `packages/agent/bench/index.ts`, and `scope` by a `packages/ledger` test fixture. The dormant span API was deleted after a repository-wide consumer scan found no reader outside this package; future span work must arrive with its production consumer rather than another roadmap surface. `check-dead-exports` does not prove entry-export reachability because tests count as consumers, so re-check with `bunx knip --include-entry-exports` when touching this surface.

## CONVENTIONS

- **No singletons beyond `Bus`.** An emitter is a value you hold, not a global you reach for. Consumers receive a `BusEvent.Sink` (declared in `@openomni/protocol`), and the composition root decides what is behind it.
- **Event descriptors live in `@openomni/protocol`**, not here. This package moves events; it does not define the vocabulary.
- **Storage lives in `@openomni/ledger`.** `BusPersistence` subscribes through `Bus.observe` and owns the durable journal. It stays there because it resolves a SQLite handle through the storage adapter and reads the `work_item` projection for session attribution — untangling that is a separate change.

## ANTI-PATTERNS

- Adding a dependency. This package is a leaf by design; `check-deps.ts` enforces it.
- Making `emit` or `child` able to throw. See the boundary rule.
- Reading state to decide what to emit. Telemetry reports; it does not evaluate.
- Re-introducing a second observation channel. The agent had one (`AgentEventEmitter`) with no production implementation for its whole life (#610).
