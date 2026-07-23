# packages/session

Durable state substrate: session lifecycle, message/part storage, event bus + hash-chained bus persistence, trace context, artifacts, audit records, surface-key records, worker-run records, actor/grant/blacklist/pending stores, and the WorkItem store used by the OpenOmni kernel. Depends only on `@openomni/protocol`.

This package stores facts; the kernel decides their product meaning. Communication routing, actor authority, PendingInteraction/PendingAsk precedence, worker grant semantics, and writeback policy belong in `@openomni/openomni`.

`WorkerRun`, `PendingAsk`, and `PendingInteraction` are current legacy storage surfaces. The P2 target freezes writes to those shapes and read-upcasts existing records; new attempt and `Wait` writes begin only after the P2 cutover. That migration is planned, not wired; the canonical attempt and Wait contracts live in the [kernel contract](../../docs/kernel-contract.md).

## STRUCTURE

```
src/
├── index.ts              # Package barrel — re-exports all namespaces
├── bus/                  # Bus pub/sub (Bus.publish / Bus.subscribe) + typed event descriptors
├── session/
│   ├── index.ts          # Session namespace barrel: public Session.* API re-exports
│   ├── events.ts         # Session bus event descriptors
│   ├── lifecycle.ts      # Session CRUD, child sessions, worker meta, TTL lazy deletion
│   ├── messages.ts       # Message/part writes, pagination, hydration, resume recovery
│   └── info.ts           # SessionInfo schema (leaf — breaks session ↔ storage cycle)
├── storage/
│   ├── index.ts          # Barrel
│   ├── storage.ts        # Storage.Adapter interface + InMemoryStorage + Storage singleton
│   ├── sqlite-storage.ts # SqliteStorageAdapter facade (Bun SQLite persistence)
│   ├── sqlite-*-adapter.ts # SQLite sub-adapters by storage seam
│   ├── sqlite-schema-lifecycle.ts # PRAGMAs, migrations, and clear ordering
│   ├── initialize.ts     # initialize({ dbPath }) — bootstraps the default SQLite adapter
│   └── part-time.ts      # Message-part timestamp helpers
├── bus-persistence/      # Durable hash-chained bus event journal + BusQuery (stats/history/verifyChainIntegrity)
├── actor/                # ActorIdentity / ActorEndpoint registry stores
├── audit/                # Audit record store
├── blacklist/            # Blacklist entry store (absolute deny gate data)
├── channel-grant/        # ChannelGrant store (surface/workspace/channel ceilings)
├── pending-ask/          # PendingAskStore (legacy resident.ask path; #215 target freezes writes and read-upcasts to Wait)
├── pending-interaction/  # PendingInteractionStore (legacy correlation/follow-up records; #215 target read-upcasts to Wait)
├── worker-grant/         # WorkerGrantStore (scoped worker-egress grants)
├── trace/                # TraceContext helpers
├── artifact/             # Artifact.store / get / list / versions with write-through caching
├── app-connector/        # AppConnectorInstallationStore for durable installed-app lifecycle records
├── surface-key/          # SurfaceKey — N:1 mapping from external surface keys to session IDs
├── work-item/            # WorkItemStore — universal work state engine
│   ├── index.ts          # WorkItemStore namespace barrel: public WorkItemStore.* API
│   ├── create.ts         # Work item creation, parent linkage, Created event
│   ├── crud.ts           # get/list/remove/update plus relation cleanup
│   ├── lifecycle.ts      # start/complete/fail/cancel, blockers, evidence, retry, outcome
│   ├── mutation.ts       # mutation persistence, transition validation, Updated/StatusChanged events
│   ├── dependency.ts     # dependency readiness + cycle detection
│   ├── retry.ts / retry-policy.ts # retry defaults + kernel-enforced exhaustion blocker
│   ├── outcome.ts        # Owner adoption outcome recording (adopted/corrected/redone/ignored)
│   ├── builder.ts        # WorkItem.Info construction
│   └── types.ts          # Internal WorkItemStore implementation types
└── worker-run/           # WorkerRun — current legacy delegated execution records
```

### Circular Dependency Avoidance

`session/info.ts` is a leaf with zero internal imports. `storage/storage.ts` imports `../session/info` (NOT `../session`). Session implementation files import `../storage/storage`; `session/index.ts` is a namespace barrel and does not import storage directly. This breaks the session ↔ storage cycle.

## KEY PATTERNS

- **Namespace API**: `Session.create()`, `Session.addMessage()`, `Session.addPart()`, `Session.createChild()`, `Session.getWorkerMeta()` / `updateWorkerMeta()`, etc. No class instances.
- **Storage.Adapter**: Default is `InMemoryStorage`. `SqliteStorageAdapter` is the Bun SQLite persistent backend bootstrapped via `initialize({ dbPath })`. Its facade wires focused SQLite sub-adapter modules for required `session` / `message` / `part` and optional `artifact`, `surfaceKey`, `cronJob`, `workItem`, `workerRunState`, and `appConnectorInstallation`. App connector installation records include Owner consent metadata plus disable/uninstall lifecycle operations because the installation record is the lifecycle SSOT. Schema lifecycle concerns that must evolve together (PRAGMAs, ordered migrations, clear ordering) live in `sqlite-schema-lifecycle.ts`. Unimplemented optional sub-objects gracefully degrade.
- **Migration 0006**: Legacy task/todo tables remain in SQLite for data preservation, but no TypeScript storage sub-adapters expose them.
- **Bus events**: `Session.Event.Created`, `.Updated`, `.Deleted` are published on mutation; WorkerRun events flow through `WorkerRun.Events.*`.
- **SurfaceKey records**: N:1 mapping from surface-specific keys (e.g. `telegram:botId:chat:chatId`) to session IDs. In-memory forward/reverse indexes plus optional `Storage.Adapter.surfaceKey` for persistence. This package stores and looks up the mapping; `openomni` decides when the mapping wins over PendingInteraction or other routing facts.
- **WorkItemStore namespace**: `WorkItemStore.create()`, `.get()`, `.list()`, `.remove()`, `.update()`, `.start()`, `.complete(hash, completionReport)`, `.fail()`, `.cancel()`, `.addBlocker()`, `.resolveBlocker()`, `.addEvidence()`, `.addReadBackEvidence()`, `.areDependenciesMet()`, `.retry()`. Publishes `WorkItem.Events.*` (Created, Updated, StatusChanged, Completed, Failed, Removed) on every mutation. Gracefully degrades when `Storage.Adapter.workItem` is absent. Terminal state transitions are validated; completion requires a report whose claim evidence IDs resolve to ledger evidence. `parentHash` is create-only immutable.
- **WorkerRun**: Stored through the direct `workerRunState` adapter (`worker_run_state` table in SQLite). `WorkerRun.create()`, `WorkerRun.updateStatus()`, `WorkerRun.updateStatusIfCurrent()`, `WorkerRun.get()`, and `WorkerRun.listBySession()` publish lifecycle bus events but do not depend on event-log replay. State transitions such as `waiting_input → running` increment `resumeCount`.
- **TTL / lazy deletion**: `Session.create({ ttlMs })` sets `expiresAt`; `Session.get()` and `.list()` check expiry and auto-delete.
- **Session lineage**: `Session.createChild()` + `parentSessionId` + `spawnDepth` are the current foundation for original → self-loop → child Worker trees. Future work should add explicit metadata conventions before adding new storage shapes.

## STORE SEMANTICS

Stores may provide CRUD and indexed queries:

- `PendingInteractionStore.findByCorrelation(...)` may return candidate records.
- `PendingAskStore.findByCorrelation(...)` may remain while the legacy resident.ask path exists.
- `ChannelGrantStore` / `BlacklistStore` may persist and retrieve records.
- `WorkerGrantStore` may persist grants and expose data needed for evaluation.

Stores must not own kernel decisions:

- Do not decide whether PendingInteraction takes precedence over SurfaceKey.
- Do not decide whether an actor is trusted enough to enter a channel.
- Do not decide whether a worker may create a new external task.
- Do not route messages to Resident/Worker/session/surface.
- Do not perform writeback or projection policy.

If a store method starts combining multiple product facts into an allow/deny/routing result, move that logic to `packages/openomni` and keep only the indexed data access here.

## ANTI-PATTERNS

- **Storage API tiers**: `Storage.get()` is the public low-level API for accessing optional sub-adapters such as `workItem` and `workerRunState` from outside this package. For core session operations (session/message/part CRUD), prefer the namespace APIs (`Session.*`, `Artifact.*`, `SurfaceKey.*`) for package-level invariants; note that bus publication is operation-specific. `Storage.getAdapter()` is an internal alias — both return the same adapter.
- Do NOT import internal paths from other packages — import from `@openomni/session` (index re-exports).
- Do NOT persist ad-hoc delegated execution state alongside `Session`. Until the P2 cutover, current code uses `WorkerRun`; after cutover, new writes use the canonical WorkItem attempt contract rather than extending the legacy shape.
- Do NOT write raw self-loop transcripts back into the original user session. Store internal work in child sessions and let `openomni` decide what distilled result belongs in the original session.
- Do NOT add communication routing or authority evaluation here. Session is the durable substrate; OpenOmni is the kernel.
