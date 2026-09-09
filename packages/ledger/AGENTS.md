# packages/ledger

Durable state substrate. Depends only on `@openomni/protocol`; application composition and execution belong outside ledger. Storage boundaries and sub-adapter ownership updated on `q945/ledger`, 2026-09-09.

## Ownership

Ledger owns the storage engine and typed durable stores. Other production packages use published ledger APIs, not SQL or internal package paths. `Bus` lives in agent and enters ledger only as an injected observation sink; it is not persisted or queried as truth.

## Structure

```text
src/
  index.ts                  # Public store exports
  session/kernel.ts         # SessionHandleStore: materialize, fenced commit, snapshots
  storage/storage.ts        # Adapter contract, scoped initialization/reset
  storage/sqlite-storage.ts # Production adapter wiring and connection lifetime
  storage/sqlite-l0-adapter.ts # Canonical sub-adapter composition
  storage/sqlite-l0-{sessions,actions,inbox,alarms,policies}.ts # Per-surface operations
  storage/sqlite-l0-write.ts # Shared transaction-local write invariants
  storage/sqlite-l0-rows.ts # Validated SQLite row and replay codecs
  storage/sqlite-l0-observation.ts # Lossy post-commit publication
  storage/sqlite-json-data.ts # Validated stored JSON and aggregate counts
  storage/migration-runner.ts # Ordered transactional migration runner
  storage/migration-statements.ts # Quote/comment-aware statement boundaries
  storage/sqlite-schema-lifecycle.ts # PRAGMAs, migration list, test-only clear
  ledger-core/              # Hash-chained decision facts and revision CAS
  actor/                    # Identity and endpoint facts
  blacklist/                # Raw blacklist facts
  channel-grant/            # Raw channel grants
  provisioning/             # Person/channel declarations and vault rows
  surface-key/              # Perimeter surface-to-session identity mapping
  egress/                   # Perimeter social-budget debits
```

## Session authority

- Agent session handles and `SessionHandleStore` are the live session APIs. `materialize` creates or promotes one durable row with its initial configuration action. Parent identity, role, revision, fence and generations live in canonical SQL columns.
- Session snapshots fold action history. Inbox admission and fenced action commits replace mutable message/status/metadata CRUD. Observations follow the durable commit; they never authorize execution.
- The legacy static Session namespace, its info/events/lifecycle/messages modules, and the singular session/message/part sub-adapters are removed. Do not add aliases, shims or replacement CRUD authority.
- App boot retains open-turn/pending-inbox recovery. There is no legacy TTL sweep: expired historical JSON cannot delete promoted canonical history. Hibernation releases runtime resources, not durable rows.
- SQL `session`, `action`, `inbox`, `alarm` and `policy` remain canonical. Nullable-role legacy rows and their JSON remain preserved until explicitly promoted or dispositioned. Message/part tables are retained without live adapters pending verified archival and the final post-#937 consumer/retention decision. No physical disposal is authorized by API deletion. Historical migrations are immutable; #967 remains open.

## #967 archive cutover

- Migration `0034_u967_archive_disposition` drops only empty `bus_event`; the existing runner's in-transaction preparation may first remove explicitly approved archived bus rows and eligible retired Wait projections. The archive-disposition command stops at 0036; it does not authorize the request cutover.
- Migration `0038_session_requests` extends action/policy kinds and retains terminal legacy rows indefinitely in immutable `archive_969_wait` and `archive_969_approval` tables before dropping the live tables. Original rowids, native values, action parents and immutable history survive. Unresolved, malformed, incoherent and follow-up-visible legacy rows refuse before connection PRAGMAs and again under the migration write lock. No original invocation is synthesized from old approval/correlation rows.
- Historical archive validation owns frozen old formats under `storage/historical-request-format.ts`; it does not import removed live protocol/store APIs. Existing native archives remain verifiable against the retained 0038 archival rows.
- The existing `script/generate-ledger-archive-manifest.ts` requires explicit `--db`, `--out`, and `--backup`. Archive and `--verify` do not authorize deletion. `--dispose-967 --approve-manifest-sha256 <sha256-of-manifest-bytes>` is the sole per-database confirmation. Stop writers before the operator procedure; never run this against an uninspected live database.
- Native SQLite archives and manifests are retained indefinitely. Verification opens only an exclusive byte-identical disposable restore copy, compares native values and integrity/FKs, checks unchanged image hashes, then closes/finalizes handles before deleting that copy. The operator archive is never opened writable.
- Normal boot accepts genuinely fresh or complete known schemas only; partial/older/tampered history refuses before connection pragmas or earlier destructive migrations. Nonempty retired targets need the explicit command; pending, malformed, incoherent, follow-up-visible and linked pending-wake rows refuse unchanged. Message/part and canonical/history/delegation data are preserved; final message/part disposition still waits for #937.

## Store discipline

- `Storage.get()` before initialize/configure fails closed. Branded production adapters must pass `Storage.assertComplete`; narrow test fakes may omit unrelated capabilities, and each store fails closed when its required capability is absent.
- Own adapter lifetime through every operation. `Storage.reset()` closes its adapter; close is idempotent. Close before replacing an adapter. Benchmarks run each measured task before resetting its connection.
- `SurfaceKey` owns only the perimeter mapping, not session materialization. Routing, trust, admission, waiting precedence and product lifecycle decisions belong in their owning domains.
- Request state is derived from canonical session action history, not a replacement standalone store. Frozen archival history cannot authorize execution.
- Stored JSON is decoded into validated plain values before row/domain assembly. Migration statement parsing preserves the existing corpus's executed statement bytes; applied migration semantics and schema fingerprints are unchanged.
- Do not write ad-hoc delegated state beside canonical session actions. Do not add a second completion or terminal authority.

## Verification

Use real SQLite and canonical handle fixtures. Test corruption at the persisted-data boundary and rollback across the complete write unit. Observe exact completion events before triggering async actions; teardown all adapters, sockets and temporary directories. Public API/schema/adapter census is separate from physical archival and disposal proof.
