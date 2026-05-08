# Golden Principles

> Invariants that MUST hold across all packages. Violations should be caught by linting or CI.

## Enforcement Notes

- `§1 Package Boundaries` + `§2 Dependency Direction`: enforced by `script/check-deps.ts` and the pre-push hook.
- `§5 Error Handling` (no `as any`, no empty catch): enforced by Biome lint rules (warn-level) and `script/check-deps.ts`.
- `§6 Testing`: coverage is reported via `bunfig.toml` (`text` + `lcov`), with no threshold yet.
- Commit format: enforced by commitlint via `.commitlintrc.yml`.
- Format + lint: enforced by Biome (`biome.json`) and Lefthook pre-commit.

## 1. Package Boundaries

- Cross-package imports go through `index.ts` barrel only.
- **Forbidden**: `from "@openomni/llm/src/auth/storage"` (deep import)
- **Allowed**: `from "@openomni/llm"` (barrel import)

## 2. Dependency Direction

```
protocol → session → llm → agent → openomni → coordinator → server
```

Each package may depend only on packages to its LEFT. Packages may skip intermediate layers when a lower-layer contract is explicitly allowed. Reverse dependencies are build failures.

- `protocol`: zero `@openomni/*` deps (leaf)
- `session`: only `@openomni/protocol`
- `llm`: `@openomni/protocol`, `@openomni/session`
- `agent`: `@openomni/protocol`, `@openomni/llm`, and sanctioned `@openomni/session` observability primitives only
- `openomni`: any lower package
- `coordinator`: any lower package
- `server`: any package; runtime host app

`agent` must not own session lifecycle, conversation persistence, or durable state mutation. Session-backed orchestration belongs in `openomni`.

## 3. Zod-First Types

- New types MUST be defined as `z.object(...)` first, then `type X = z.infer<typeof X>`.
- Schema and type share the same name.
- No standalone `interface` or `type` for cross-package contracts.
- Cross-package contracts live in `@openomni/protocol`; upper packages must not redefine them with parallel Zod schemas.
- Runtime wrappers around protocol contracts are allowed only when they add behavior, such as persistence, bus publication, or host-specific normalization.

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
- App tests must be reachable from the standard local and CI test matrix. If a workspace lacks a `test` script, document the exception or add one.
- Avoid tautological assertions such as `expect(true).toBe(true)` unless the test is explicitly compile-time or no-throw oriented and documents that intent.
- Tool changes require tests for permission denial, timeout, path containment, and error-shaped results where applicable.
- Persistence changes require migration, idempotency, and recovery coverage.

## 7. File Hygiene

- Every subdirectory has `index.ts` that re-exports public API.
- No `utils.ts` or `helpers.ts` catch-all files.
- ESM only: `"type": "module"`, imports use `from "./foo"` (no `.ts` extension).
- Build artifacts such as `dist/` are not source. Do not rely on generated tests or generated declarations when assessing coverage or public APIs.

## 8. Code Style

### Comments

- **WHY only**: comments explain _why_, never _what_. The code itself communicates what it does.
- **No banner comments**: `// ───`, `// ===`, `// ---`, `// ***` visual separators are forbidden. Namespace and function names provide structure.
- **No numbered steps**: `// 1. Resolve`, `// Step 2: Load` procedural markers are forbidden. Code flow is the sequence.
- **No obvious JSDoc**: if the function name already says it, don't repeat it in a doc comment. `/** Creates a user */ function createUser()` is noise.
- **TODO is OK**: `// TODO:` with a specific description of what needs to change and why.
- **Business logic OK**: domain knowledge that isn't obvious from code (`// FK constraint requires inserting message before parts`).
- **Algorithm OK**: naming a non-trivial algorithm (`// Kahn's algorithm for cycle detection`).

### Naming

- Variables/functions: `camelCase`, verbs (`resolveProvider`, `buildAgent`).
- Types/interfaces: `PascalCase`, nouns (`AgentSpec`, `ModelFamily`).
- Constants: `SCREAMING_SNAKE` only for true constants (magic numbers, config values). Functions and objects use `camelCase`.
- Booleans: `is/has/can/should` prefix (`isStreaming`, `hasCredentials`).

### Structure

- **Data over code**: prefer declarative config objects over repetitive functions.
- **One way to do it**: if a factory exists, always use the factory. No ad-hoc alternatives.
- **No premature abstraction**: don't create interfaces, generics, or wrappers until a second use case appears.
- **`readonly` preferred**: immutable interface fields use `readonly`.

### Declaration Merging Pattern

When a namespace's primary type conflicts with the namespace name, use declaration merging:

```typescript
export namespace Todo {
  export const Schema = z.object({...});
  export const ItemSchema = z.object({...});
  export type Item = z.infer<typeof ItemSchema>;
}
export type Todo = z.infer<typeof Todo.Schema>;
```

This allows `Todo` to work as both a namespace (`Todo.Schema`, `Todo.Item`) and a type (`const todo: Todo = ...`).

## 9. Runtime Ownership

- `agent` owns stateless execution behavior only. It may use `session` for sanctioned observability primitives but must not create sessions, mutate durable conversation state, or own recovery.
- `openomni` owns session-backed orchestration: ingress, subagent runtime, and execution runtime.
- `coordinator` owns multiprocess execution: worker pools, IPC, recovery, credential injection, and non-interactive permission policy.
- `apps/server` wires runtime packages to external surfaces. Host-specific payload types may live there, but reusable contracts must move down to `protocol`.
- `apps/cli` has been removed. Channel adapters, conversation runtime, and operator-facing server setup belong in `apps/server` or documented server/operator flows.

## 10. Documentation Freshness

- Structure, command, runtime-mode, package-boundary, or public-contract changes must update docs in the same change.
- Root `AGENTS.md` is the fast map. Package `AGENTS.md` files are local maps. Detailed policy belongs in committed `docs/` pages.
- New ADR files must be added to `docs/design-decisions/index.md`, including drafts.
- `docs/quality-score.md` must be updated when test counts, lint posture, or package quality materially changes.
- Local insight files (`*.local.md`) are reference material, not source-of-truth. Promote stable policy into committed docs before relying on it.

See [Repository Guidelines](./repository-guidelines.md) for the current cleanup backlog and operating guidance.
