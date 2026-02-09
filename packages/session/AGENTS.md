# packages/session

Session lifecycle, message/part storage, event bus, snapshots, and compaction. Depends only on `@openomni/protocol`.

## STRUCTURE

```
src/
├── session.ts    # Session namespace: CRUD, message/part ops, TTL support
├── storage.ts    # StorageAdapter interface + InMemoryStorage + Storage singleton
├── bus.ts        # Bus pub/sub (publish/subscribe with BusEvent descriptors)
├── status.ts     # SessionStatus tracking
├── snapshot.ts   # Snapshot + InMemorySnapshotProvider
└── compaction.ts # Message compaction logic
```

## KEY PATTERNS

- **Namespace API**: `Session.create()`, `Session.get()`, `Session.addMessage()`, `Session.addPart()`. No class instances.
- **StorageAdapter injection**: Default is `InMemoryStorage`. Swap via `Storage.configure(adapter)`. Adapter has `.session`, `.message`, `.part` sub-objects.
- **TTL / lazy deletion**: `Session.create({ ttlMs })` sets `expiresAt`. `Session.get()` and `Session.list()` check expiry and auto-delete.
- **Bus events**: `Session.Event.Created`, `.Updated`, `.Deleted` published on mutation.
- **Backward compat**: `Session.storage` and `Session.messages` are Map-like shims for old tests. Use `Session.*` API for new code.

## ANTI-PATTERNS

- Do NOT access `Storage.getAdapter()` directly from outside this package — go through `Session.*` namespace.
- Do NOT import `./session` from other packages — import from `@openomni/session` (index re-exports).
