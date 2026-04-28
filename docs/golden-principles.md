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
- Known exceptions: `apps/cli/src/cmd/auth.ts` (tech debt — tracked, do not extend)

## 2. Dependency Direction

```
protocol → session → llm → agent → openomni → coordinator → { cli, server }
```

Each package may depend only on packages to its LEFT. Packages may skip intermediate layers when a lower-layer contract is explicitly allowed. Reverse dependencies are build failures.

- `protocol`: zero `@openomni/*` deps (leaf)
- `session`: only `@openomni/protocol`
- `llm`: `@openomni/protocol`, `@openomni/session`
- `agent`: `@openomni/protocol`, `@openomni/llm`, and sanctioned `@openomni/session` observability primitives only
- `openomni`: any lower package
- `coordinator`: any lower package
- `cli`, `server`: any package; they do not depend on each other

`agent` must not own session lifecycle, conversation persistence, or durable state mutation. Session-backed orchestration belongs in `openomni`.

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
export namespace Plan {
  export const Schema = z.object({...});
  export const StepSchema = z.object({...});
  export type Step = z.infer<typeof StepSchema>;
}
export type Plan = z.infer<typeof Plan.Schema>;
```

This allows `Plan` to work as both a namespace (`Plan.Schema`, `Plan.Step`) and a type (`const p: Plan = ...`).
