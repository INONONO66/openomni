# packages/ledger

Durable state substrate. Depends only on `@openomni/protocol`; application composition and execution belong outside ledger. Session authority verified on `kernel/967-session`, 2026-09-06.

## Ownership

Ledger owns the storage engine and typed durable stores. Other production packages use published ledger APIs, not SQL or internal package paths. `Bus` lives in agent and enters ledger only as an injected observation sink; it is not persisted or queried as truth.

## Structure

```text
src/
  index.ts                  # Public store exports
  session/kernel.ts         # SessionHandleStore: materialize, fenced commit, snapshots
  storage/storage.ts        # Adapter contract, scoped initialization/reset
  storage/sqlite-storage.ts # Production adapter wiring and connection lifetime
  storage/sqlite-l0-adapter.ts # Canonical session/action/inbox/alarm/policy SQL
  storage/migration-runner.ts # Ordered transactional migration runner
  storage/sqlite-schema-lifecycle.ts # PRAGMAs, migration list, test-only clear
  ledger-core/              # Hash-chained decision facts and revision CAS
  actor/                    # Identity and endpoint facts
  blacklist/                # Raw blacklist facts
  channel-grant/            # Raw channel grants
  provisioning/             # Person/channel declarations and vault rows
  surface-key/              # Perimeter surface-to-session identity mapping
  approval/                 # Existing approval store (separate convergence work)
  wait/                     # Existing correlation/outcome store (retained until cutover)
  delegation/               # Durable delegation records
  egress/                   # Perimeter social-budget debits
  worker-run/               # Frozen historical worker-run archive
```

## Session authority

- Agent session handles and `SessionHandleStore` are the live session APIs. `materialize` creates or promotes one durable row with its initial configuration action. Parent identity, role, revision, fence and generations live in canonical SQL columns.
- Session snapshots fold action history. Inbox admission and fenced action commits replace mutable message/status/metadata CRUD. Observations follow the durable commit; they never authorize execution.
- The legacy static Session namespace, its info/events/lifecycle/messages modules, and the singular session/message/part sub-adapters are removed. Do not add aliases, shims or replacement CRUD authority.
- App boot retains open-turn/pending-inbox recovery. There is no legacy TTL sweep: expired historical JSON cannot delete promoted canonical history. Hibernation releases runtime resources, not durable rows.
- SQL `session`, `action`, `inbox`, `alarm` and `policy` remain canonical. Nullable-role legacy rows and their JSON remain preserved until explicitly promoted or dispositioned. Message/part tables are retained without live adapters pending verified archival and the final post-#937 consumer/retention decision. No physical disposal is authorized by API deletion. Historical migrations are immutable; #967 remains open.

## Store discipline

- `Storage.get()` before initialize/configure fails closed. Branded production adapters must pass `Storage.assertComplete`; narrow test fakes may omit unrelated capabilities, and each store fails closed when its required capability is absent.
- Own adapter lifetime through every operation. `Storage.reset()` closes its adapter; close is idempotent. Close before replacing an adapter. Benchmarks run each measured task before resetting its connection.
- `SurfaceKey` owns only the perimeter mapping, not session materialization. Routing, trust, admission, waiting precedence and product lifecycle decisions belong in their owning domains.
- Wait correlation/delivery and frozen WorkerRun history remain retained consumers, not permission to revive WorkItem/Attempt or add another execution authority.
- Do not write ad-hoc delegated state beside canonical session actions. Do not add a second completion or terminal authority.

## Verification

Use real SQLite and canonical handle fixtures. Test corruption at the persisted-data boundary and rollback across the complete write unit. Observe exact completion events before triggering async actions; teardown all adapters, sockets and temporary directories. Public API/schema/adapter census is separate from physical archival and disposal proof.
