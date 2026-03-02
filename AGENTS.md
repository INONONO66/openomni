# PROJECT KNOWLEDGE BASE

**Generated:** 2025-02-09
**Commit:** 9ee94b4
**Branch:** main

## OVERVIEW

OpenOmni — multi-agent task orchestration framework for LLM-powered autonomous agents. TypeScript monorepo (Bun + Turborepo) with 5 packages and 1 CLI app.

## STRUCTURE

```
openomni/
├── apps/cli/            # CLI entry point (yargs + @clack/prompts)
├── packages/
│   ├── protocol/        # Shared Zod schemas: Message, Tool, Run, Sink, Events
│   ├── session/         # Session CRUD, Bus pub/sub, Storage adapter, Compaction
│   ├── llm/             # LLM abstraction: providers, OAuth, streaming, retry
│   ├── agent/           # Pure ChatAgent primitive: stateless LLM + Tool ReAct loop
│   └── openomni/        # Orchestration: legacy agent code (RunWorker, TaskManager, IngressEngine, etc.)
├── turbo.json           # Build pipeline config
└── package.json         # Workspace root (bun@1.3.6)
```

## DEPENDENCY GRAPH

```
protocol  ←  session  ←  llm  ←  agent (pure ReAct)  ←  openomni (orchestration + legacy)  ←  cli
    └──────────────────────┘              ↑
    └─────────────────────────────────────┘
    └──────────────────────┘         ↑
    └────────────────────────────────┘
```

`protocol` is the leaf — zero internal deps. `session` depends on `protocol`. `llm` depends on `protocol` + `session`. `agent` (pure ChatAgent) depends on `protocol` + `llm`. `openomni` depends on all four. `cli` depends on all five.

## WHERE TO LOOK

| Task                         | Location                                              | Notes                                                                |
| ---------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Add Zod schema / shared type | `packages/protocol/src/{domain}/index.ts`             | 8 domains: error, tool, message, run, sink, bus, event, notification |
| Add/modify events            | `packages/protocol/src/event/index.ts`                | BusEvent.define() pattern                                            |
| Session CRUD                 | `packages/session/src/session/`                       | Namespace-based API                                                  |
| Storage backend              | `packages/session/src/storage/`                       | Implement `StorageAdapter` interface                                 |
| Add LLM provider             | `packages/llm/src/fetch/` + `packages/llm/src/oauth/` | One file per provider                                                |
| Provider SDK wiring          | `packages/llm/src/provider/provider.ts`               | `getSDK()` function                                                  |
| Model catalog                | `packages/llm/src/model/`                             | Fetches from models.dev                                              |
| ChatAgent (stateless ReAct) | `packages/agent/src/chat-agent.ts`                    | create(), run(), stream() stub                                       |
| Agent profile/graph          | `packages/openomni/src/legacy/agent/`                 | Graph validation, routing, messaging                                 |
| Task lifecycle               | `packages/openomni/src/legacy/task/`                  | State machine, manager, checkpoint, recovery                         |
| Orchestration loop           | `packages/openomni/src/legacy/`                       | Envelope → Router → Dispatcher → Supervisor                          |
| Triggers (cron/fs/webhook)   | `packages/openomni/src/legacy/trigger/`               | EventQueue + schedulers                                              |
| CLI commands                 | `apps/cli/src/cmd/`                                   | One file per command group                                           |

## CONVENTIONS

- **Namespace pattern**: All modules export TypeScript namespaces (`Session.create()`, `Auth.get()`, `Provider.Model`, `Message.Part`). NOT class instances.
- **Zod-first types**: Schemas defined as `z.object(...)`, then `type X = z.infer<typeof X>`. Schema and type share the same name.
- **ESM only**: All packages use `"type": "module"`. Imports use `from "./foo"` (no `.ts` extension in source, bundler resolution).
- **No shared tsconfig**: Each package has its own `tsconfig.json` (ES2020, bundler moduleResolution, strict).
- **Index re-exports**: Every subdir has `index.ts` that re-exports public API. Never import from internal files across package boundaries (CLI does reach into internals — see anti-patterns).
- **In-memory by default**: Storage adapters default to `InMemoryStorage`. Production adapters injected via `Storage.configure()`.
- **BusEvent pattern**: Events defined with `BusEvent.define(name, zodSchema)` in protocol, published via `Bus.publish()` in session.
- **Testing**: Bun test runner (`bun test`). Tests mirror `src/` structure in `test/` dirs. No shared test utils.
- **Discriminated unions**: `z.discriminatedUnion()` for Tool.State, Message.Part, Message.Info, RunOutcome.

## ANTI-PATTERNS (THIS PROJECT)

- **CLI imports internals**: `apps/cli` imports deep paths like `@openomni/llm/src/auth/storage` and `@openomni/agent/src/task/manager` instead of package index. Known tech debt — do NOT extend this pattern.
- **Backward compat shims**: `Session.storage` and `Session.messages` exist for test compatibility. Use `Session.create/get/addMessage` API for new code.
- **`as any` in protocol**: `NamedError.create()` uses `(this as any).cause = options.cause`. This is the ONE exception; do not add more.

## COMMANDS

```bash
# Install
bun install

# Build all packages
bun run build          # or: turbo run build

# Test individual package
bun test               # in package dir
turbo run test         # all packages

# Type check
bun run check-types    # or: turbo run check-types

# Format
bun run format         # prettier

# Run CLI
bun run --cwd apps/cli dev           # dev mode
openomni auth login                  # after build + link
openomni agent --mode direct         # test agent
openomni agent --mode orchestrated   # full pipeline
```

## NOTES

- README.md is stock Turborepo template — does NOT describe this project.
- `packages/protocol` publishes built `dist/` artifacts (`main: ./dist/index.js`). Other packages point `main` at source (`./src/index.ts`) for Bun's native TS support.
- No ESLint config present (referenced in scripts but not configured).
- No CI/CD workflows yet (`.github/workflows/` absent).
- `dist/` dirs are gitignored but some exist locally — they are build artifacts, not source.
- `@ai-sdk/anthropic` and `@ai-sdk/openai` are the two bundled providers. New providers via `@ai-sdk/openai-compatible` fallback.
- `packages/agent` is now a pure ChatAgent primitive — stateless, no session dependency. Use `@openomni/agent` for the ReAct loop.
- `packages/openomni` contains all legacy orchestration code (moved as-is from packages/agent in Phase 1). Use `@openomni/openomni` for RunWorker, TaskManager, IngressEngine, etc.
