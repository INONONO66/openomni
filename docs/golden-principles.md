# Golden Principles

> Invariants that MUST hold across all packages. Violations should be caught by linting or CI.

## 1. Package Boundaries

- Cross-package imports go through `index.ts` barrel only.
- **Forbidden**: `from "@openomni/llm/src/auth/storage"` (deep import)
- **Allowed**: `from "@openomni/llm"` (barrel import)
- Known exceptions: `apps/cli/src/cmd/auth.ts` (tech debt — tracked, do not extend)

## 2. Dependency Direction

```
protocol → session → llm → agent → openomni → cli
```

Each package may depend only on packages to its LEFT. Reverse dependencies are build failures.

- `protocol`: zero `@openomni/*` deps (leaf)
- `session`: only `@openomni/protocol`
- `llm`: `@openomni/protocol`, `@openomni/session`
- `agent`: `@openomni/protocol`, `@openomni/llm`, `@openomni/session`
- `openomni`: any `@openomni/*`
- `cli`: any `@openomni/*`

## 3. Zod-First Types

- New types MUST be defined as `z.object(...)` first, then `type X = z.infer<typeof X>`.
- Schema and type share the same name.
- No standalone `interface` or `type` for cross-package contracts.

## 4. Namespace Pattern

- Modules export TypeScript namespaces: `Session.create()`, `Auth.get()`, `Provider.Model`.
- No class instances for public API.
- `new` keyword is internal-only.

## 5. Error Handling

- Errors wrap with `NamedError.create(name, zodSchema)`.
- No empty catch blocks: `catch(e) {}` is forbidden.
- No `as any` or `@ts-ignore` (sole exception: `NamedError.create()` in protocol).

## 6. Testing

- New features require tests.
- Bug fixes require regression tests.
- Tests mirror `src/` structure in `test/` dirs.
- `bun test` must pass before commit.

## 7. File Hygiene

- Every subdirectory has `index.ts` that re-exports public API.
- No `utils.ts` or `helpers.ts` catch-all files.
- ESM only: `"type": "module"`, imports use `from "./foo"` (no `.ts` extension).
