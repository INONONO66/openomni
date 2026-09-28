# packages/ledger

Durable state substrate. Depends only on `@openomni/protocol`; application
composition and execution belong outside ledger. W5.2 (#1197, 2026-09-28)
replaces the process-wide adapter with handle-scoped catalog and session-file
stores. The entity owns activation and admission; ledger owns atomic facts and
fence compare-and-set operations.

## Ownership

Ledger owns the storage engine and typed durable stores. Other production packages use published ledger APIs, not SQL or internal package paths. `Bus` lives in agent and enters ledger only as an injected observation sink; it is not persisted or queried as truth.

## Structure

```text
src/
  index.ts                  # Public store exports
  session/kernel.ts         # SessionHandleStore kernel over explicit handles
  storage/session-store.ts  # One scoped handle per session SQLite file
  storage/catalog-store.ts  # Shared cross-session catalog handle
  storage/schema-session-file.ts # Fresh three-table session schema
  storage/schema-catalog.ts # Fresh catalog schema and session index
  storage/sqlite-l0-{sessions,actions,policies}.ts # Session-file operations
  storage/sqlite-l0-write.ts # Atomic fenced action writes
  storage/sqlite-l0-rows.ts # Validated SQLite row codecs
  storage/sqlite-decision-facts.ts # First-writer-wins decision facts with row hashes
  actor/                    # Identity and endpoint facts
  blacklist/                # Raw blacklist facts
  channel-grant/            # Raw channel grants
  provisioning/             # Person/channel declarations and vault rows
  surface-key/              # Perimeter surface-to-session identity mapping
  egress/                   # Perimeter social-budget debits
```

## Session authority

- `openSessionStore` and `openCatalogStore` are the public storage factories.
  The caller owns each handle's scope and closes it explicitly.
- `SessionHandleStore.createSessionKernel` binds one session-file handle to the
  catalog. Parent identity, role, revision, fence, and generations live in
  canonical SQL columns.
- Entity mailbox admission and fenced action commits replace mutable
  message/status/metadata CRUD. Observations follow the durable commit; they
  never authorize execution.
- The legacy static Session namespace, its info/events/lifecycle/messages modules, and the singular session/message/part sub-adapters are removed. Do not add aliases, shims or replacement CRUD authority.
- Activation rotates the catalog fence exactly once, then the entity opens the
  matching session-file handle. Passivation closes that handle without deleting
  durable rows.
- The live schemas are fresh: each session file contains `session`, `action`,
  and `decision_fact`; the catalog contains the session index and cross-session
  actor/channel/policy facts. There is no lease, timer, mailbox, or migration
  store in ledger.
- Old database files are inert. Production boot does not inspect, upgrade,
  archive, or delete them. Do not reintroduce compatibility readers or writers.

## Store discipline

- Own catalog and session-file handles through every operation. Close is
  idempotent; close a handle before replacing it.
- `SurfaceKey` owns only the perimeter mapping, not session materialization. Routing, trust, admission, waiting precedence and product lifecycle decisions belong in their owning domains.
- Request state is derived from canonical session action history, not a replacement standalone store. Frozen archival history cannot authorize execution.
- Stored JSON is decoded into validated plain values before row/domain assembly.
- Do not write ad-hoc delegated state beside canonical session actions. Do not add a second completion or terminal authority.

## Verification

Use real SQLite and canonical handle fixtures. Test corruption at the persisted-data boundary and rollback across the complete write unit. Observe exact completion events before triggering async actions; teardown all adapters, sockets and temporary directories. Public API/schema/adapter census is separate from physical archival and disposal proof.
