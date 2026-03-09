# ADR-001: Namespace Pattern over Class Instances

**Status**: Accepted

## Context

Needed a consistent module API pattern across all packages. Options considered:

1. **Class instances** — `new Session()`, `new Provider()` — typical OOP approach
2. **Plain function exports** — `createSession()`, `getProvider()` — functional style
3. **TypeScript namespaces** — `Session.create()`, `Provider.getSDK()` — grouped functions

## Decision

All modules export TypeScript namespaces. Public API is `Namespace.method()`, never `new Class()`.

```typescript
// YES
export namespace Session {
  export function create(config: Config): Session { ... }
  export function get(id: string): Session | null { ... }
}

// NO
export class SessionManager {
  constructor(config: Config) { ... }
}
```

## Rationale

- **Tree-shaking friendly**: Bundlers can eliminate unused namespace members. Class instances pull in everything.
- **Explicit dependencies**: No hidden `this` state. Each function declares what it needs.
- **Test simplicity**: Call functions directly — no DI containers, no mock constructors.
- **Consistent with Zod pattern**: `z.object()` + `z.infer<>` produces types, not classes. Namespaces align naturally.

## Consequences

- `new` keyword is internal-only (implementation detail, never public API).
- State is managed via module-level variables or injected via `Storage.configure()` pattern.
- No inheritance hierarchies — composition via function calls instead.
- Sole exception: `NamedError.create()` produces class-like error constructors (required for `instanceof` checks).
