# packages/ledger

Durable state substrate: session lifecycle, message/part storage, hash-chained bus persistence, surface-key records, worker-run records, and actor/grant/blacklist stores. Depends on `@openomni/protocol` and `@openomni/telemetry`.

SSOT directive ([docs/gateway-design.md](../../docs/gateway-design.md) §4, Owner 2026-08-19): "exactly one database, owned by `@openomni/ledger` (the #502 rename of session's storage). No package other than ledger touches the storage engine — every read/write goes through ledger's typed store surfaces." This package is the single storage engine owner; row schemas stay in `protocol`.

`Bus` itself lives in `@openomni/telemetry` (#606) — every consumer imports it from there directly; this package keeps the durable journal that subscribes to it.

This package stores facts; the kernel decides their product meaning. Communication routing, actor authority, wait precedence, and writeback belong in product composition.

`WorkerRunStateStore` is a FROZEN legacy storage surface: every write throws a typed frozen error (#510 D2b) and historical rows stay readable. The pending_ask/pending_interaction tables were dropped by migration 0025 (which refuses to drop non-empty tables). New delegated-execution writes use `Wait` contracts in the [kernel contract](../../docs/kernel-contract.md).

## STRUCTURE

```
src/
├── index.ts              # Package barrel — re-exports all namespaces
├── session/
│   ├── index.ts          # Session namespace barrel: public Session.* API re-exports
│   ├── events.ts         # Session bus event descriptors
│   ├── lifecycle.ts      # Session CRUD/children; pure expiry-filtering reads + explicit sweepExpired deletion
│   ├── messages.ts       # Message/part writes and reads, message status
│   └── info.ts           # SessionInfo schema (leaf — breaks session ↔ storage cycle)
├── storage/
│   ├── index.ts          # Barrel
│   ├── storage.ts        # Storage.Adapter interface + Storage singleton
│   ├── sqlite-storage.ts # SqliteStorageAdapter facade (Bun SQLite persistence)
│   ├── sqlite-*-adapter.ts # SQLite sub-adapters by storage seam
│   ├── sqlite-schema-lifecycle.ts # PRAGMAs, migrations, and clear ordering
│   ├── atomic-file.ts # sole temp-write/rename owner for durable file replacement (optional fsync durability)
│   ├── migration-runner.ts / sqlite-busy.ts / sqlite-json-data.ts / timestamped-store.ts # shared SQLite helpers (requireSubAdapter lives in timestamped-store)
│   └── initialize.ts     # initialize({ dbPath }) — bootstraps the default SQLite adapter
├── ledger-core/          # Ledger append core (#510 A): serialized CAS append, adoptStream, headFact/factsByType over the hash-chained ledger_event table (schema.ts = drizzle DDL source)
├── bus-persistence/      # Observational hash-chained bus journal + BusQuery; payload status/diagnostic preserves invalid raw values
├── actor/                # ActorIdentity / ActorEndpoint registry stores
├── blacklist/            # Raw Blacklist entry CRUD; channels owns active/pattern matching
├── channel-grant/        # Raw ChannelGrant CRUD; channels owns ranking/default treatment
├── app-connector/        # Installed-app lifecycle; installation and connector actor identity/endpoint change transactionally
├── surface-key/          # SurfaceKey — N:1 mapping from external surface keys to session IDs
├── engagement/           # EngagementStore — durable delegation machine (#709, gateway-design §5): fact-before-projection appends on engagement:<id> streams via the shared commit coordinator (no adoption path — the stream class was born with the table), typed Engagement.StoreError fail-closed, lazy deadline expiry at hydration (listActive). Brain-domain surface: the brain is its sole writer
├── conversation/         # ConversationStore — durable bounded conversation windows: decision facts and projection CAS via the shared commit coordinator, typed Conversation.StoreError fail-closed
├── lease/                # LeaseStore — durable carved send rights: lease decisions and dual-stream send debit via the shared commit coordinator, typed Lease.StoreError fail-closed
├── approval/             # ApprovalStore — durable Owner approval requests and decisions via the shared commit coordinator, typed Approval.StoreError fail-closed
├── wait/                 # WaitStore — raw correlation reads plus durable channels-produced Wait outcomes (#215/#510 B): fact-before-projection CAS via the shared commit coordinator, typed Wait.StoreError fail-closed, lazy pre-cutover adoption
├── egress/               # EgressBudgetStore — durable perimeter social-budget debit records
└── worker-run/           # Frozen worker_run_state implementation (`state-store.ts`); root barrel intentionally exports no write surface
```

### Circular Dependency Avoidance

`session/info.ts` is a leaf with zero internal imports. `storage/storage.ts` imports `../session/info` (NOT `../session`). Session implementation files import `../storage/storage`; `session/index.ts` is a namespace barrel and does not import storage directly. This breaks the session ↔ storage cycle.

## KEY PATTERNS

- **Namespace API**: `Session.create()`, `Session.addMessage()`, `Session.addPart()`, `Session.createChild()`, `Session.update()`, etc. No class instances. Worker metadata lives on `SessionInfo.workerMeta` and round-trips through `update`/`get` (the dedicated accessors were dead surface, removed in #606).
- **Storage.Adapter**: There is no default adapter — `Storage.get()` before `initialize({ dbPath })`/`configure(adapter)` throws (fail-closed, #522; no silent `:memory:` fallback). `SqliteStorageAdapter` is the branded production backend. `Storage.configure()` validates every required production capability before installing a branded adapter and throws `Storage.IncompleteAdapterError` naming the first missing capability; narrow unbranded test fakes remain valid and individual stores still fail closed when an optional-in-type seam is absent. App connector install/update writes the installation and its exact actor identity/endpoint in one transaction; uninstall removes all three in one transaction, leaving unrelated actors untouched. Schema lifecycle concerns that must evolve together live in `sqlite-schema-lifecycle.ts`.
- **Bus events**: `Session.Event.Created`, `.Updated`, `.Deleted` are published on mutation. `worker.run.*` lifecycle events are published by the server worker runner (wire contract), never by this package — the frozen store publishes nothing. BusPersistence is an observational journal: schema-valid payloads persist as normalized `valid`; validation failures persist the exact raw value as `invalid`; parser failures persist it as `parse_failed` with a safe diagnostic. Query readers expose nullable markers so rows written before the marker migration remain readable.
- **SurfaceKey records**: N:1 mapping from surface-specific keys (e.g. `telegram:botId:chat:chatId`) to session IDs, stored solely in `Storage.Adapter.surfaceKey` (no in-memory index); a missing sub-adapter fails closed — ownership answers are never fabricated (#522). This package stores and looks up the mapping; the app decides when the mapping wins over other routing facts.

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

- **Storage API tiers**: `Storage.get()` is the public low-level API for accessing sub-adapters such as `workerRunState` from outside this package. The interface keeps many capabilities optional so narrow test fakes are possible, but the branded production adapter must pass `Storage.assertComplete()` at configuration. For core session operations, prefer namespace APIs (`Session.*`, `SurfaceKey.*`).
- Do NOT import internal paths from other packages — import from `@openomni/ledger` (index re-exports).
- Do NOT persist ad-hoc delegated execution state alongside `Session`. `worker_run_state` is a frozen read-only archive; new writes use the canonical `Wait` contract rather than reviving the legacy shape.
- Do NOT write raw self-loop transcripts back into the original user session. Store internal work in child sessions and let `openomni` decide what distilled result belongs in the original session.
- Do NOT add communication routing or authority evaluation here. The ledger is the durable substrate; OpenOmni is the kernel.
- Do NOT add a second completion-admission append or terminal method here. A future product completion boundary must consume the inherited contract rather than adding a ledger shortcut.

_Edited 2026-08-10 per Owner-approved clean-room corpus (local docs/corpus, session record)._
