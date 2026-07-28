# packages/session

Structural durable-ledger substrate for the P2 clean baseline. Depends only on `@openomni/protocol`. This package owns SQLite schema lifecycle, atomic append/query/blob mechanics, the closed synchronous projection set, lossy process-local Bus observation, trace context, and audit primitives. It does not own product transition meaning.

P2-04 is production-wired. The former session CRUD, optional storage-adapter, mutable work/run/pending stores, cron adapter, and hash-chained Bus-persistence surfaces are deleted from the production durable path. There is no legacy import, compatibility reader, or upcast-on-read path: production accepts only the fresh `p2-clean-v1` baseline.

## STRUCTURE

```
src/
├── index.ts              # Package barrel
├── ledger/
│   ├── runtime.ts        # One process-lifetime FULL writer; bounded serialized appends, sync query callbacks, clean close
│   ├── writer.ts         # Transactional CAS/idempotent append plus in-transaction projection application
│   ├── query.ts          # Bounded immutable event and projection reads
│   ├── projection.ts     # Closed production projection catalog and synchronous startup rebuild
│   ├── blob.ts           # Content-addressed blob persistence on the writer transaction
│   └── index.ts          # Ledger namespace barrel
├── storage/
│   ├── migration-runner.ts
│   ├── sqlite-schema-lifecycle.ts
│   └── timestamped-store.ts
├── bus/                  # Lossy process-local observation only
├── trace/                # TraceContext helpers
└── audit/                # Audit primitives
migration/
└── 0001_p2_clean_baseline/migration.sql
```

## PRODUCTION CONTRACT

- `openLedgerRuntime({ dbPath })` exclusively owns the writable database handle for its full lifetime. A second writable runtime for the same database is rejected.
- Schema initialization accepts only baseline identity `p2-clean-v1`, version 1. Old databases are not imported or translated.
- Each authoritative append is one complete immutable batch. CAS/idempotency checks, event writes, blob writes, and all required projection updates succeed or fail in the same SQLite transaction.
- `createProductionLedgerProjections()` is the closed projection catalog. `rebuildProductionLedgerProjections()` synchronously rebuilds it from complete committed batches before new writes are admitted.
- Query callbacks must complete synchronously and receive no writable handle. OpenOmni semantic services receive only bounded structural writer/query/projection ports.
- Closing rejects new work, waits for accepted appends, releases the lifetime lock, and closes the database.
- Bus publication is optional observation. It is never product state, ordering authority, replay evidence, or a fallback when an append fails.

## OWNERSHIP BOUNDARY

OpenOmni owns native transition selection, authority, Work/Attempt/Wait meaning, schedules, effects, completion admission, and projection interpretation. Session validates and persists structural ledger facts only. Server may open and close the runtime as the process composition root, but it receives no right to define lifecycle meaning or create a second writer.

## ANTI-PATTERNS

- Do not add compatibility migrations, legacy-data readers, upcasters, dual/shadow writers, or optional durability fallbacks.
- Do not expose the SQLite handle, projection transaction, generic append authority, or unbounded query access to kernel consumers or Workers.
- Do not add communication routing, authority evaluation, transition selection, or effect policy here.
- Do not treat a Bus event, console warning, transient object, or derived cache as durable evidence.
- Import package contracts from `@openomni/session`; do not deep-import internals from other packages.

P2-05–P2-07 export/replay deliverables, C1 qualification, P3 package/ring moves, and P4 roles remain unshipped. See [Implementation Status](../../docs/implementation-status.md).