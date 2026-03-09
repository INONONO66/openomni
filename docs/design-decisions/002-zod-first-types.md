# ADR-002: Zod-First Type Definitions

**Status**: Accepted

## Context

Cross-package type contracts need both runtime validation and compile-time safety. Options:

1. **TypeScript interfaces only** — No runtime validation. Consumers trust input shape.
2. **Zod schemas only** — `z.infer<>` for types. Runtime + compile-time in one definition.
3. **Dual definitions** — Separate `interface` and `z.object()`. Types diverge over time.

## Decision

All shared types are defined as Zod schemas first, then derived via `z.infer<>`. Schema and type share the same name.

```typescript
export const Event = z.object({
  id: z.string(),
  type: z.literal("task.started"),
  time: z.number(),
});
export type Event = z.infer<typeof Event>;
```

## Rationale

- **Single source of truth**: One definition, two uses (validation + type). No drift between runtime and compile-time.
- **Discriminated unions**: `z.discriminatedUnion()` naturally models `Tool.State`, `Message.Part`, `Run.Outcome` — patterns central to this codebase.
- **Serialization-ready**: Zod schemas serialize to JSON Schema. Useful for tool specs, API boundaries, event contracts.
- **Validation at boundaries**: Parse external input (LLM responses, API payloads) with `.parse()` — fail fast with structured errors.

## Consequences

- No standalone `interface` or `type` for cross-package contracts. Internal-only types may use plain TS.
- `protocol` package builds to `dist/` because downstream consumers need compiled Zod schemas.
- Runtime-only constructs (callbacks, class instances) extend Zod types via `& { ... }` intersection (e.g., `AgentDef` adds `toolExecutor` callback).
