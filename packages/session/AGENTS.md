# packages/session

Session lifecycle, message/part storage, event bus, snapshots, and compaction. Depends only on `@openomni/protocol`.

## STRUCTURE

```
src/
├── session-info.ts   # SessionInfo schema (extracted to break circular dep)
├── session.ts        # Session namespace: CRUD, message/part ops, TTL support
├── storage.ts        # Storage.Adapter interface + InMemoryStorage + Storage singleton
├── file-storage.ts   # FileStorageAdapter: file-based persistence with atomic writes
├── bus.ts            # Bus pub/sub (publish/subscribe with BusEvent descriptors)
├── status.ts         # SessionStatus tracking
├── snapshot.ts       # Snapshot.Provider, Snapshot.Diff + InMemorySnapshotProvider
├── compaction.ts     # Message compaction logic
└── surface-key.ts    # SurfaceKey: N:1 mapping from surface keys to session IDs
```

## KEY PATTERNS

- **Namespace API**: `Session.create()`, `Session.get()`, `Session.addMessage()`, `Session.addPart()`. No class instances.
- **Storage.Adapter injection**: Default is `InMemoryStorage`. Swap via `Storage.configure(adapter)`. Adapter has `.session`, `.message`, `.part` sub-objects.
- **FileStorageAdapter**: Persistent storage with atomic write pattern. Writes to temp file, then renames to target (prevents corruption on crash).
- **TTL / lazy deletion**: `Session.create({ ttlMs })` sets `expiresAt`. `Session.get()` and `Session.list()` check expiry and auto-delete.
- **Bus events**: `Session.Event.Created`, `.Updated`, `.Deleted` published on mutation.
- **SurfaceKey routing**: N:1 mapping from surface-specific keys (DM, group, channel, thread, chat) to session IDs. Enables multi-surface session routing.
- **Snapshot.Provider**: Interface for tracking and restoring session state. `Snapshot.Diff` tracks added/removed/modified messages.
- **Backward compat**: `Session.storage` and `Session.messages` are Map-like shims for old tests. Use `Session.*` API for new code.

## ANTI-PATTERNS

- Do NOT access `Storage.getAdapter()` directly from outside this package — go through `Session.*` namespace.
- Do NOT import `./session` from other packages — import from `@openomni/session` (index re-exports).
