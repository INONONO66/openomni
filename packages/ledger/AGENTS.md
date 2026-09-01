# packages/ledger

Durable state substrate: session lifecycle, message/part storage, hash-chained bus persistence, artifacts, surface-key records, worker-run records, actor/grant/blacklist stores, and the WorkItem store used by the OpenOmni kernel. Depends on `@openomni/protocol` and `@openomni/telemetry`.

SSOT directive ([docs/gateway-design.md](../../docs/gateway-design.md) §4, Owner 2026-08-19): "exactly one database, owned by `@openomni/ledger` (the #502 rename of session's storage). No package other than ledger touches the storage engine — every read/write goes through ledger's typed store surfaces." This package is the single storage engine owner; row schemas stay in `protocol`.

`Bus` itself lives in `@openomni/telemetry` (#606) — every consumer imports it from there directly; this package keeps the durable journal that subscribes to it.

This package stores facts; the kernel decides their product meaning. Communication routing, actor authority, wait precedence, and writeback belong in product composition.

`WorkerRunStateStore` is a FROZEN legacy storage surface: every write throws a typed frozen error (#510 D2b) and historical rows stay readable; the attempt-run view (`WorkItemAttemptRun`) read-upcasts them. The pending_ask/pending_interaction tables were dropped by migration 0025 (which refuses to drop non-empty tables). New delegated-execution writes use the canonical WorkItem attempt and `Wait` contracts in the [kernel contract](../../docs/kernel-contract.md).

## STRUCTURE

```
src/
├── index.ts              # Package barrel — re-exports all namespaces
├── session/
│   ├── index.ts          # Session namespace barrel: public Session.* API re-exports
│   ├── events.ts         # Session bus event descriptors
│   ├── lifecycle.ts      # Session CRUD/children; pure expiry-filtering reads + explicit sweepExpired deletion
│   ├── messages.ts       # Message/part writes and reads, message status
│   ├── transcript.ts     # TranscriptStore (#547 C3) — append-only transcript_fact recording; message/part tables are fold projections
│   └── info.ts           # SessionInfo schema (leaf — breaks session ↔ storage cycle)
├── storage/
│   ├── index.ts          # Barrel
│   ├── storage.ts        # Storage.Adapter interface + Storage singleton
│   ├── sqlite-storage.ts # SqliteStorageAdapter facade (Bun SQLite persistence)
│   ├── sqlite-*-adapter.ts # SQLite sub-adapters by storage seam
│   ├── sqlite-schema-lifecycle.ts # PRAGMAs, migrations, and clear ordering
│   ├── commit-coordinator.ts # SOLE owner of decision-class commit MECHANICS: append at expectedHead → adopt an empty pre-cutover stream → caller's projection CAS, with SQLITE_BUSY mapped to the caller's typed error. A refused projection is ATOMIC via a nested transaction (savepoint), so head never outruns revision even when the caller reports the refusal by RETURNING (completion-writer) rather than throwing. Domains keep their folds, fact payloads, adoption genesis, and conflict taxonomy
│   ├── atomic-file.ts # sole temp-write/rename owner for durable file replacement (optional fsync durability)
│   ├── migration-runner.ts / sqlite-busy.ts / sqlite-json-data.ts / timestamped-store.ts # shared SQLite helpers (requireSubAdapter lives in timestamped-store)
│   └── initialize.ts     # initialize({ dbPath }) — bootstraps the default SQLite adapter
├── ledger-core/          # Ledger append core (#510 A): serialized CAS append, adoptStream, headFact/factsByType, verifyTail over the hash-chained ledger_event table (schema.ts = drizzle DDL source)
├── bus-persistence/      # Observational hash-chained bus journal + BusQuery; payload status/diagnostic preserves invalid raw values
├── actor/                # ActorIdentity / ActorEndpoint registry stores
├── blacklist/            # Raw Blacklist entry CRUD; channels owns active/pattern matching
├── channel-grant/        # Raw ChannelGrant CRUD; channels owns ranking/default treatment
├── artifact/             # Artifact.store / get; reads normalize legacy invalid metadata into the current schema
├── app-connector/        # Installed-app lifecycle; installation and connector actor identity/endpoint change transactionally
├── surface-key/          # SurfaceKey — N:1 mapping from external surface keys to session IDs
├── engagement/           # EngagementStore — durable delegation machine (#709, gateway-design §5): fact-before-projection appends on engagement:<id> streams via the shared commit coordinator (no adoption path — the stream class was born with the table), typed Engagement.StoreError fail-closed, lazy deadline expiry at hydration (listActive). Brain-domain surface: the brain is its sole writer
├── wait/                 # WaitStore — raw correlation reads plus durable channels-produced Wait outcomes (#215/#510 B): fact-before-projection CAS via the shared commit coordinator, typed Wait.StoreError fail-closed, lazy pre-cutover adoption
├── egress/               # EgressBudgetStore — durable perimeter social-budget debit records
├── work-item/            # WorkItemStore — universal work state engine
│   ├── index.ts          # WorkItemStore namespace barrel: public WorkItemStore.* API
│   ├── create.ts         # Work item creation, parent linkage, Created event
│   ├── crud.ts           # get/list/remove/update plus relation cleanup
│   ├── lifecycle.ts      # start/fail/cancel plus typed raw-completion refusal, blockers, evidence
│   ├── mutation.ts       # mutation persistence, transition validation, Updated/StatusChanged events
│   ├── facts.ts          # #510 C1 decision-class fact appends on work:<hash> via the shared commit coordinator: head==revision CAS, lazy adoption (full-snapshot genesis — recorded #606 divergence), typed revision/duplicate/unavailable errors
│   ├── completion-writer.ts # authorized completion-authority writer: admission fact append before the projection CAS, one transaction (#510 C1)
│   ├── attempt-run.ts    # WorkItemAttemptRun — run lifecycle over attempt facts + deterministic upcast of frozen worker_run_state rows (#510 D2b)
│   ├── dependency.ts     # dependency readiness + cycle detection
│   ├── builder.ts        # WorkItem.Info construction
│   └── types.ts          # Internal WorkItemStore implementation types
└── worker-run/           # Frozen worker_run_state implementation (`state-store.ts`); root barrel intentionally exports no write surface
```

### Circular Dependency Avoidance

`session/info.ts` is a leaf with zero internal imports. `storage/storage.ts` imports `../session/info` (NOT `../session`). Session implementation files import `../storage/storage`; `session/index.ts` is a namespace barrel and does not import storage directly. This breaks the session ↔ storage cycle.

## KEY PATTERNS

- **Namespace API**: `Session.create()`, `Session.addMessage()`, `Session.addPart()`, `Session.createChild()`, `Session.update()`, etc. No class instances. Worker metadata lives on `SessionInfo.workerMeta` and round-trips through `update`/`get` (the dedicated accessors were dead surface, removed in #606).
- **Storage.Adapter**: There is no default adapter — `Storage.get()` before `initialize({ dbPath })`/`configure(adapter)` throws (fail-closed, #522; no silent `:memory:` fallback). `SqliteStorageAdapter` is the branded production backend. `Storage.configure()` validates every required production capability before installing a branded adapter and throws `Storage.IncompleteAdapterError` naming the first missing capability; narrow unbranded test fakes remain valid and individual stores still fail closed when an optional-in-type seam is absent. App connector install/update writes the installation and its exact actor identity/endpoint in one transaction; uninstall removes all three in one transaction, leaving unrelated actors untouched. Schema lifecycle concerns that must evolve together live in `sqlite-schema-lifecycle.ts`.
- **Legacy task/todo tables**: dropped by migration `0017_drop_dead_tables` (#606) — `event_log`, `task`, `task_run`, `task_idempotency`, `plan`, `todo`, `background_task` had zero readers and writers; their features live on the WorkItem projection + ledger and `bus_event`.
- **Bus events**: `Session.Event.Created`, `.Updated`, `.Deleted` are published on mutation. `worker.run.*` lifecycle events are published by the server worker runner (wire contract), never by this package — the frozen store publishes nothing. BusPersistence is an observational journal: schema-valid payloads persist as normalized `valid`; validation failures persist the exact raw value as `invalid`; parser failures persist it as `parse_failed` with a safe diagnostic. Query readers expose nullable markers so rows written before the marker migration remain readable.
- **SurfaceKey records**: N:1 mapping from surface-specific keys (e.g. `telegram:botId:chat:chatId`) to session IDs, stored solely in `Storage.Adapter.surfaceKey` (no in-memory index); a missing sub-adapter fails closed — ownership answers are never fabricated (#522). This package stores and looks up the mapping; the app decides when the mapping wins over other routing facts.
- **WorkItemStore namespace**: `WorkItemStore.create()`, `.get()`, `.list()`, `.start()`, `.fail()`, `.cancel()`, `.assignExecution()`, `.allocateAttempt()`, `.addBlocker()`, `.resolveBlocker()`, and `.addEvidence()` own lower-layer storage semantics; every mutation is a dedicated lifecycle helper (the freeform `.update()` and `.remove()`/`.recordOutcome()`/`.areDependenciesMet()` dead surface was removed in #606). There is NO raw completion entry point: the old `.complete()` tombstone is deleted, so completion is reachable only through the admission writer returned by `Storage.configure` — OpenOmni owns completion fact/admission appends and the terminal CAS. `parentHash` and stable completion criteria are immutable by construction.
- **Artifact reads**: New writes must satisfy the current `Artifact.Meta` schema. `Artifact.get()` upcasts legacy persisted rows on read: non-positive/non-integral versions normalize to at least `1`, and blank `mimeType`/`createdAt` receive stable compatibility defaults before current-schema parsing.
- **WorkerRunStateStore**: the frozen `worker_run_state` archive (#510 D2b). Reads (`get` / `listBySession` / `listByStatus`) keep serving historical rows — including the upcast-on-read attempt-run view in `WorkItemAttemptRun.find` — while every write throws the typed `WorkerRun.FrozenError` (`worker_run_frozen`) and persists nothing. Run lifecycle lives on WorkItem attempt facts (`work_item.attempt_allocated` / `attempt_finished`).
- **Session TTL**: `Session.create({ ttlMs })` sets `expiresAt`. `Session.get()` and `.list()` are pure reads that hide expired rows without deleting them. `Session.sweepExpired()` owns physical removal (including message/part cascade) and is invoked by boot recovery; there is no periodic sweep yet.
- **Session lineage**: `Session.createChild()` + `parentSessionId` + `spawnDepth` are the current foundation for original → self-loop → child Worker trees. Future work should add explicit metadata conventions before adding new storage shapes.

## STORE SEMANTICS

Stores may provide CRUD and indexed queries:

- `WaitStore.findByCorrelation(...)` returns raw indexed candidate records; it does not filter follow-up eligibility.
- `WaitStore.commit(...)` persists a channels-produced outcome under revision CAS; it does not invoke a domain fold.
- `ChannelGrantStore` / `BlacklistStore` persist and retrieve raw records only.

Stores must not own kernel decisions:

- Do not decide whether a wait match takes precedence over SurfaceKey.
- Do not decide whether an actor is trusted enough to enter a channel.
- Do not decide whether a worker may create a new external task.
- Do not route messages to Resident/Worker/session/surface.
- Do not perform writeback or projection policy.

If a store method starts combining multiple product facts into an allow/deny/routing result, move that logic to `apps/openomni` and keep only the indexed data access here.

## ANTI-PATTERNS

- **Storage API tiers**: `Storage.get()` is the public low-level API for accessing sub-adapters such as `workItem` and `workerRunState` from outside this package. The interface keeps many capabilities optional so narrow test fakes are possible, but the branded production adapter must pass `Storage.assertComplete()` at configuration. For core session operations, prefer namespace APIs (`Session.*`, `Artifact.*`, `SurfaceKey.*`).
- Do NOT import internal paths from other packages — import from `@openomni/ledger` (index re-exports).
- Do NOT persist ad-hoc delegated execution state alongside `Session`. `worker_run_state` is a frozen read-only archive; new writes use the canonical WorkItem attempt contract rather than reviving the legacy shape.
- Do NOT write raw self-loop transcripts back into the original user session. Store internal work in child sessions and let `openomni` decide what distilled result belongs in the original session.
- Do NOT add communication routing or authority evaluation here. The ledger is the durable substrate; OpenOmni is the kernel.
- Do NOT add a second completion-admission append or terminal method here. A future product completion boundary must consume the inherited contract rather than adding a ledger shortcut.

_Edited 2026-08-10 per Owner-approved clean-room corpus (local docs/corpus, session record)._
