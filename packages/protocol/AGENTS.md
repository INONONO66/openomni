# packages/protocol

Shared type foundation. Zero internal dependencies. All cross-package Zod schemas live here.

## STRUCTURE

```
src/
├── index.ts              # Package barrel (re-exports all domains)
├── error/
│   └── index.ts          # NamedError base class + APIError
├── tool/
│   └── index.ts          # Tool namespace: State + Call/Result/Spec
├── message/
│   └── index.ts          # Message namespace: Part + Info + WithParts
├── run/
│   └── index.ts          # Run namespace: Outcome, Snapshot, Budget, RetryPolicy
├── sink/
│   └── index.ts          # Sink interface (TypeScript only, not Zod)
├── bus/
│   └── index.ts          # BusEvent namespace: define() factory
├── event/
│   └── index.ts          # Task.* and Agent.* event definitions
└── notification/
    └── index.ts          # Notification schemas
```

## KEY PATTERNS

- **NamedError factory**: `NamedError.create(name, zodSchema)` produces typed error classes with `.isInstance()` guard, `.toObject()` serialization, and `.Schema` for validation. All domain errors (AuthError, ProviderError, etc.) use this.
- **Namespace + Zod duality**: `Tool.State`, `Tool.Call`, `Tool.Result`, `Tool.Spec`, `Message.Part`, `Message.Info`, `Run.Outcome`, `Run.Snapshot`, `Run.Budget`, `Run.RetryPolicy` are both Zod schemas AND TypeScript types (same name). Access schema for validation, type for TS.
- **Discriminated unions**: `Tool.State` discriminates on `status`, `Message.Part` on `type`, `Message.Info` on `role`, `Run.Outcome` on `type`.
- **Sink interface**: Plain TS interface (NOT Zod) — the callback contract for streaming results. Uses `Tool.Call`, `Tool.Result`, `Run.Snapshot` types.
- **BaseEvent correlation**: All events extend `BaseEvent` with `traceId`, `runId?`, `taskId?`, `sessionId?`, `time`.

## ANTI-PATTERNS

- Do NOT add runtime logic here — this package is schemas/types only.
- Do NOT import from other `@openomni/*` packages — protocol is the dependency leaf.

## WHEN MODIFYING

- Adding a new error? Use `NamedError.create()` in `error/index.ts` and re-export from main `index.ts`.
- Adding a new event? Use `BusEvent.define()` in `event/index.ts` with `BaseEvent.extend()`.
- Adding a new message part? Add to `Message.Part` discriminated union in `message/index.ts`.
- Adding a new tool state? Add to `Tool.State` discriminated union in `tool/index.ts`.
- Adding a new run type? Add to `Run` namespace in `run/index.ts`.
- This package builds to `dist/` — run `bun run build` after changes.
