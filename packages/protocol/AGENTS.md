# packages/protocol

Shared type foundation. Zero internal dependencies. All cross-package Zod schemas live here.

## STRUCTURE

```
src/
├── index.ts    # NamedError base, error classes, Message/Tool/Run types, Sink interface
├── bus.ts      # BusEvent.define() — typed event descriptor factory
└── events.ts   # Task.* and Agent.* event definitions (uses BusEvent.define)
```

## KEY PATTERNS

- **NamedError factory**: `NamedError.create(name, zodSchema)` produces typed error classes with `.isInstance()` guard, `.toObject()` serialization, and `.Schema` for validation. All domain errors (AuthError, ProviderError, etc.) use this.
- **Namespace + Zod duality**: `Tool.State`, `Message.Part`, `Message.Info` are both Zod schemas AND TypeScript types (same name). Access schema for validation, type for TS.
- **Discriminated unions**: `Tool.State` discriminates on `status`, `Message.Part` on `type`, `Message.Info` on `role`, `RunOutcome` on `type`.
- **Sink interface**: Plain TS interface (NOT Zod) — the callback contract for streaming results.
- **SessionKey**: Template literal type `agent:${string}:main | agent:${string}:subagent:${string} | task:${string}:run:${string}`.
- **BaseEvent correlation**: All events in `events.ts` extend `BaseEvent` with `traceId`, `runId?`, `taskId?`, `sessionId?`, `time`.

## ANTI-PATTERNS

- Do NOT add runtime logic here — this package is schemas/types only.
- Do NOT import from other `@openomni/*` packages — protocol is the dependency leaf.

## WHEN MODIFYING

- Adding a new error? Use `NamedError.create()` and export from `index.ts`.
- Adding a new event? Use `BusEvent.define()` in `events.ts` with `BaseEvent.extend()`.
- Adding a new message part? Add to `Message.Part` discriminated union in `index.ts`.
- This package builds to `dist/` — run `bun run build` after changes.
