# @openomni/telemetry

The observation channel. Ring 1, depends only on `@openomni/protocol`.

Everything the system says about itself goes through here: the process-wide `Bus`, an emitter that owns trace identity, span pairing for lifecycle events, and sink combinators. Nothing durable, nothing that decides.

## THE BOUNDARY RULE

**Replacing this package with no-ops must leave observed behavior identical.**

That is not a style preference; it is what makes the package safe to put in a hot path. Concretely:

- `Emitter.emit` never throws. A sink that fails is reported through `onEmitError` and the caller continues.
- `Emitter.child` never throws. A narrowing that omits a field keeps the parent's value.
- `tee` swallows a downstream throw and reports it.
- The one place that *does* throw is `scope()`, at construction — the composition root, where a malformed identity is a wiring error the process should not start with.

If something here can change what the observed code does, it belongs in `@openomni/policy` instead.

## FILES

```
src/
├── bus.ts     # Bus.publish / subscribe / observe, AsyncLocalStorage isolation, diagnostic stats
├── trace.ts   # TraceScope + requireTraceScope (construction-time guard)
├── scope.ts   # scope(trace, sink) -> Emitter: emit, span, child
├── span.ts    # SpanPair, SpanOutcome, span handle
└── sink.ts    # collector (tests), noopSink (the boundary reference), tee (fan-out)
```

## WHY THE EMITTER OWNS IDENTITY

```ts
export type EmitPayload<T> = Omit<T, TraceField | "time">;
```

A caller cannot pass `traceId` / `sessionId` / `runId` / `actorId` / `agentName` / `time` — they are removed from every payload type, and applied last at runtime so a cast cannot override them. `child()` cannot replace `traceId` at all: a child run, a delegated actor, and a nested span all belong to the same trace.

This exists because thirteen sites in the agent core minted a fresh `crypto.randomUUID()` per event. Those events were structurally uncorrelatable with the run that produced them — the record looked authoritative and pointed at nothing.

## WHY SPANS

`span(pair, start, body)` emits exactly one terminal event per start, on every exit: a normal return, a `settle()` recording a policy block or exhausted budget, or a throw.

`guard_denied` and `budget_exhausted` are first-class `SpanOutcome` variants because that is how a run most often stops, and a policy block looks like a normal return from the outside. Before spans, twelve of the agent's fifteen run-terminating paths emitted no terminal event at all.

First `settle()` wins, so an inner guard is not overwritten by an outer one on the way out.

## CONVENTIONS

- **No singletons beyond `Bus`.** An emitter is a value you hold, not a global you reach for. Consumers receive a `BusEvent.Sink` (declared in `@openomni/protocol`), and the composition root decides what is behind it.
- **Event descriptors live in `@openomni/protocol`**, not here. This package moves events; it does not define the vocabulary.
- **Storage lives in `@openomni/session`.** `BusPersistence` subscribes through `Bus.observe` and owns the durable journal. It stays there because it resolves a SQLite handle through the storage adapter and reads the `work_item` projection for session attribution — untangling that is a separate change.

## ANTI-PATTERNS

- Adding a dependency. This package is a leaf by design; `check-deps.ts` enforces it.
- Making `emit` or `child` able to throw. See the boundary rule.
- Reading state to decide what to emit. Telemetry reports; it does not evaluate.
- Re-introducing a second observation channel. The agent had one (`AgentEventEmitter`) with no production implementation for its whole life (#610).
