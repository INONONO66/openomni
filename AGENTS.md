# PROJECT KNOWLEDGE BASE


## OVERVIEW

OpenOmni — orchestration framework for LLM-powered autonomous agents. TypeScript monorepo (Bun + Turborepo) with 5 packages and 2 apps (CLI + Server).

## STRUCTURE

```
openomni/
├── apps/
│   ├── cli/             # CLI entry (yargs) — auth + config only
│   └── server/          # Hono server — Discord/Telegram/GitHub/WebSocket channels, tool providers, ingress router
├── packages/
│   ├── protocol/        # Shared Zod schemas (20 domains): error, tool, message, run, sink, bus, event, notification, adapter, plan, ingress, messenger, guardrail, event-log, agent, artifact, gate, hook, subagent
│   ├── session/         # Session CRUD, Bus pub/sub, Storage adapter (in-memory + SQLite), EventLog, Artifact, Snapshot, SurfaceKey, WorkerRun
│   ├── llm/             # LLM abstraction: providers, auth (API key + OAuth), streaming, retry, token/cost tracking, provider transforms
│   ├── agent/           # ChatAgent core (middleware-driven ReAct loop) + multi-agent runtime (messenger, registry, subagent/background tools, MCP)
│   │   ├── src/core/           # ChatAgent, budget, retry, tool-guard, memory, delegation, telemetry, middleware engine
│   │   │   ├── execution/      # StreamEngine, ToolExecutor, compaction, parallel-tools
│   │   │   └── middleware/     # Engine + builtins (budget, memory, tool-guard, compaction, post-tool, post-turn, idle-nudge) + legacy compat bridge
│   │   └── src/runtime/        # Multi-agent infrastructure
│   │       ├── messenger/      # AgentMessenger, BusTransport
│   │       ├── registry/       # AgentRegistry
│   │       ├── tools/          # SubagentTool, BackgroundOutputTool, BackgroundCancelTool
│   │       └── mcp/            # McpClient
│   └── openomni/        # Orchestration: Plan mode, DAG, task storage, Ingress, SubagentRuntime + BackgroundManager
├── turbo.json           # Build pipeline config
└── package.json         # Workspace root (bun@1.3.6)
```

## DEPENDENCY GRAPH

```
protocol ← session ← llm ← agent ← openomni ← { cli, server }
```

Each layer depends only on layers to its left. `protocol` is the leaf (zero internal deps). `cli` and `server` are sibling apps — neither depends on the other. See [ADR-003](docs/design-decisions/003-layered-package-architecture.md).

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add Zod schema / shared type | `packages/protocol/src/{domain}/index.ts` | 20 domains (see STRUCTURE) |
| Add/modify bus events | `packages/protocol/src/event/index.ts` + `event/agent-execution.ts` | `BusEvent.define()` pattern |
| Add subagent lifecycle events | `packages/protocol/src/subagent/index.ts` | `Subagent.Events.*` (worker runs + background tasks) |
| Add middleware hook timing | `packages/protocol/src/hook/index.ts` | 9 timings: pre_run, pre_turn, on_system_prompt, pre_tool_use, post_tool_use, post_turn, post_compaction, post_run, on_error |
| Agent profile schema | `packages/protocol/src/agent/index.ts` | `AgentProfile.Definition`, `AgentProfile.AgentBudget` |
| Session CRUD | `packages/session/src/session/` | Namespace-based API |
| Storage backend | `packages/session/src/storage/` | Implement `Storage.Adapter` (optional sub-objects: `artifact`, `eventLog`, `surfaceKey`) |
| Session event log | `packages/session/src/event-log/` | `EventLog.append/replay/listIncomplete/markComplete` |
| Surface → session mapping | `packages/session/src/surface-key/` | N:1 SurfaceKey registry |
| Worker run records (subagent) | `packages/session/src/worker-run/` | Event-sourced via `Storage.Adapter.eventLog` |
| Add LLM provider | `packages/llm/src/fetch/` + `packages/llm/src/oauth/` + `packages/llm/src/provider/provider.ts` | One file per provider; register SDK in `getSDK()` |
| Provider transforms | `packages/llm/src/transform/` | Message normalization + per-provider variants |
| Token usage / cost | `packages/llm/src/token/` | `TokenTracker.extractUsage`, `calculateCost` |
| Model catalog | `packages/llm/src/model/` | Fetches from models.dev |
| ChatAgent core | `packages/agent/src/core/` | ChatAgent, budget, retry, tool-guard, memory, delegation, telemetry |
| Middleware engine | `packages/agent/src/core/middleware/` | `MiddlewareEngine.create()` + built-ins in `builtin/` |
| Agent execution engine | `packages/agent/src/core/execution/` | StreamEngine, ToolExecutor, compaction, parallel-tools |
| Agent messenger | `packages/agent/src/runtime/messenger/` | AgentMessenger, BusTransport |
| Agent registry | `packages/agent/src/runtime/registry/` | AgentRegistry |
| Subagent / background tools | `packages/agent/src/runtime/tools/` | SubagentTool, BackgroundOutputTool, BackgroundCancelTool |
| MCP client | `packages/agent/src/runtime/mcp/` | McpClient |
| Plan Mode (PlanAgent) | `packages/openomni/src/plan/` | `PlanAgent.generate()` (one-shot), `PlanAgent.create()` (interactive with `plan_*` tools) |
| DAG utilities | `packages/openomni/src/dag/` | Pure: `build`, `validateAcyclic`, `getReady`, `complete` |
| Task storage | `packages/openomni/src/storage/` | `TaskStorage`, `FileTaskStore`, task types |
| Ingress engine | `packages/openomni/src/ingress/` | `IngressEngine.ingest()` — session resolve → project → mode dispatch |
| Subagent runtime | `packages/openomni/src/subagent/` | `SubagentRuntime` (spawn/send/resume/cancel/wait), `BackgroundManager`, `SubagentConsultation` |
| Plan schemas | `packages/protocol/src/plan/` | `Plan`, `PlanStep`, `PlanResult` |
| CLI commands | `apps/cli/src/cmd/` | `auth`, `config` only |
| Server tool providers | `apps/server/src/tool/` | 3 categories: `system/`, `agent/`, `mcp/` |
| Server channels | `apps/server/src/channel/` | Discord, Telegram, GitHub, WebSocket |
| Server ingress bridge | `apps/server/src/ingress/` | `buildInboundEvent()`, `detectMode()` |

## CONVENTIONS

See [Golden Principles](docs/golden-principles.md) for all coding invariants (enforced by `script/check-deps.ts` in CI).

Key patterns: Namespace exports (`Session.create()`), Zod-first types (`z.object` + `z.infer`), ESM only, discriminated unions, `BusEvent.define()` for events, middleware over hook callbacks for agent extension.

## MODES

Ingress supports two execution modes:

| Mode | Trigger | Handler | Output |
| --- | --- | --- | --- |
| `direct` | Default (no prefix) | `handleDirect` → `ChatAgent.run()` | LLM response text |
| `plan` | `/plan` prefix | `handlePlan` → `PlanAgent.generate()` | Structured `Plan` JSON |

## ANTI-PATTERNS (THIS PROJECT)

- **CLI deep imports**: `apps/cli/src/cmd/auth.ts` still imports `@openomni/llm/src/auth/registry` and `/auth/storage` directly. Known tech debt — do NOT extend.
- **Backward-compat hook shims**: `compat.ts` in `packages/agent/src/core/middleware/` converts legacy `ExecutionHooks` and `stepGuard` config to middleware. Deprecated — new code uses `middleware: [...]`.
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
bun run format         # biome

# Run CLI
bun run --cwd apps/cli dev           # dev mode
openomni auth login                  # after build + link
openomni config add                  # adapter configuration

# Run server
bun run --cwd apps/server dev        # Hono server with channels (set env tokens first)
```

## NOTES

- README.md describes project architecture, dependency graph, and getting started.
- `packages/protocol` publishes built `dist/` artifacts (`main: ./dist/index.js`). Other packages point `main` at source (`./src/index.ts`) for Bun's native TS support.
- Lint + format via Biome (`biome.json`). No ESLint.
- CI pipeline: `.github/workflows/ci.yml` — build, check-types, tests for all packages.
- `dist/` dirs are gitignored but some exist locally — they are build artifacts, not source.
- `@ai-sdk/anthropic` and `@ai-sdk/openai` are the two bundled providers. New providers via `@ai-sdk/openai-compatible` fallback.
- `packages/agent` is organized as `src/core/` (ChatAgent + middleware) and `src/runtime/` (messenger, registry, tools, mcp). The middleware engine is the current extension point; legacy hook-based config is routed through `middleware/compat.ts`.
- `packages/openomni` orchestrates plans, ingress, tasks, and subagent runtime. `SubagentRuntime` is session-locked; `BackgroundManager` wraps it for fire-and-forget execution with concurrency / depth limits.
- **Plan Mode** (`PlanAgent`) is implemented in `packages/openomni/src/plan/`. It generates a structured `Plan` via LLM and validates via gates.
- Plan protocol types live in `packages/protocol/src/plan/` — `Plan`, `PlanStep`, `PlanResult`.
- Subagent lifecycle events (`Subagent.Events.*`) are defined in `packages/protocol/src/subagent/index.ts` and published by `SubagentRuntime` / `BackgroundManager`.
