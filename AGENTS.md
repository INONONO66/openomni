# PROJECT KNOWLEDGE BASE


## OVERVIEW

OpenOmni — personal AI workforce infrastructure. Agents earn autonomy through evidence, not self-report. See [Design Philosophy](docs/design-philosophy.md) for full rationale.

The user primarily talks to one Main Persona, which manages specialized Sub Personas through controlled delegation, isolated sessions, and auditable lineage. The first user-facing domain persona is SNS / viral marketing; coding remains a first-class internal capability for automation and self-improvement. TypeScript monorepo (Bun + Turborepo) with 6 packages and 1 app (Server).

Product direction lives in `docs/persona-workforce.md`; the accepted architecture decision is [ADR-005](docs/design-decisions/005-persona-workforce-runtime.md).

## STRUCTURE

```
openomni/
├── apps/
│   └── server/          # Hono server — Discord/Telegram/GitHub/WebSocket channels, tool providers, ingress router
├── packages/
│   ├── protocol/        # Shared Zod schemas and cross-package contracts
│   ├── session/         # Session CRUD, Bus pub/sub, Storage adapter (in-memory + SQLite), EventLog, Artifact, Snapshot, SurfaceKey, WorkerRun, Todo, TraceContext
│   ├── llm/             # LLM abstraction: providers, auth (API key + OAuth), streaming, retry, token/cost tracking, provider transforms
│   ├── agent/           # ChatAgent core (middleware-driven ReAct loop) + multi-agent runtime (messenger, registry, subagent/background tools, MCP) — depends on session for observability (Log, Bus, Telemetry, TraceContext)
│   │   ├── src/core/           # ChatAgent, budget, retry, tool-guard, memory, delegation, telemetry, middleware engine
│   │   │   ├── execution/      # StreamEngine, ToolExecutor, compaction, parallel-tools
│   │   │   └── middleware/     # Engine + builtins (budget, memory, tool-guard, compaction, post-tool, post-turn, idle-nudge) + legacy compat bridge
│   │   └── src/runtime/        # Multi-agent infrastructure
│   │       ├── messenger/      # AgentMessenger
│   │       ├── registry/       # AgentRegistry
│   │       ├── tools/          # SubagentTool, BackgroundOutputTool, BackgroundCancelTool
│   │       └── mcp/            # McpClient
│   ├── openomni/        # Orchestration: DAG, Ingress, SubagentRuntime + BackgroundManager, BusTransport, execution runtime
│   └── coordinator/     # Multiprocess execution coordinator: worker pool, IPC transport, recovery, credentials, tool-permission
├── turbo.json           # Build pipeline config
└── package.json         # Workspace root (bun@1.3.6)
```

## DEPENDENCY GRAPH

```
protocol ← session ← llm ← agent ← openomni ← coordinator ← server
```

Each layer depends only on layers to its left. `protocol` is the leaf (zero internal deps). `agent` depends on `llm` and `session` (for observability: Log, Bus, Telemetry, TraceContext). `server` is the runtime host app. See [ADR-003](docs/design-decisions/003-layered-package-architecture.md).

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add Zod schema / shared type | `packages/protocol/src/{domain}/index.ts` | Cross-package contracts only; runtime logic lives in upper packages |
| Add/modify bus events | `packages/protocol/src/event/index.ts` + `event/agent-execution.ts` | `BusEvent.define()` pattern |
| Add subagent lifecycle events | `packages/protocol/src/subagent/index.ts` | `Subagent.Events.*` (worker runs + background tasks) |
| Add middleware hook timing | `packages/protocol/src/hook/index.ts` | 9 timings: pre_run, pre_turn, on_system_prompt, pre_tool_use, post_tool_use, post_turn, post_compaction, post_run, on_error |
| Agent profile schema | `packages/protocol/src/agent/index.ts` | `AgentProfile.Definition`, `AgentProfile.AgentBudget` |
| Session CRUD | `packages/session/src/session/` | Namespace-based API |
| Storage backend | `packages/session/src/storage/` | Implement `Storage.Adapter` (core session/message/part plus optional `artifact`, `eventLog`, `surfaceKey`, `backgroundTask`, `task`, `todo`) |
| Session event log | `packages/session/src/event-log/` | `EventLog.append/replay/listIncomplete/markComplete` |
| Surface → session mapping | `packages/session/src/surface-key/` | N:1 SurfaceKey registry |
| Worker run records (subagent) | `packages/session/src/worker-run/` | Event-sourced via `Storage.Adapter.eventLog` |
| Add LLM provider | `packages/llm/src/provider/provider.ts` + provider-specific auth/transform modules as needed | Register SDK in `getSDK()`; keep provider-specific request/auth behavior out of call sites |
| Provider transforms | `packages/llm/src/transform/` | Message normalization + per-provider variants |
| Token usage / cost | `packages/llm/src/token/` | `TokenTracker.extractUsage`, `calculateCost` |
| Model catalog | `packages/llm/src/model/` | Fetches from models.dev |
| ChatAgent core | `packages/agent/src/core/` | ChatAgent, budget, retry, tool-guard, memory, delegation, telemetry |
| Middleware engine | `packages/agent/src/core/middleware/` | `MiddlewareEngine.create()` + built-ins in `builtin/` |
| Agent execution engine | `packages/agent/src/core/execution/` | StreamEngine, ToolExecutor, compaction, parallel-tools |
| Agent messenger | `packages/agent/src/runtime/messenger/` | AgentMessenger |
| Agent registry | `packages/agent/src/runtime/registry/` | AgentRegistry |
| Subagent / background tools | `packages/agent/src/runtime/tools/` | SubagentTool, BackgroundOutputTool, BackgroundCancelTool |
| MCP client | `packages/agent/src/runtime/mcp/` | McpClient |
| DAG utilities | `packages/openomni/src/dag/` | Pure: `build`, `validateAcyclic`, `getReady`, `complete` |
| Bus transport (session bridge) | `packages/openomni/src/runtime/` | `BusTransport` — bridges `AgentMessenger.Transport` to the session bus |
| Ingress engine | `packages/openomni/src/ingress/` | `IngressEngine.ingest()` — session resolve → project → mode dispatch |
| Subagent runtime | `packages/openomni/src/subagent/` | `SubagentRuntime` (spawn/send/resume/cancel/wait), `BackgroundManager`, `SubagentConsultation` |
| Coordinator (worker pool) | `packages/coordinator/src/worker-pool/` | Worker routing, supervision, session-tree affinity routing |
| Coordinator IPC | `packages/coordinator/src/ipc/` | Unix socket transport, request/response framing |
| Coordinator recovery | `packages/coordinator/src/recovery/` | Marks interrupted worker runs failed after restart |
| Server tool providers | `apps/server/src/tool/` + `packages/openomni/src/execution-runtime/tool/` | Server owns `custom/` and MCP wiring; OpenOmni owns system/agent/task/todo providers |
| Server channels | `apps/server/src/channel/` | Discord, Telegram, GitHub, WebSocket |
| Server ingress bridge | `apps/server/src/ingress/` | `buildInboundEvent()`, `detectMode()` |
| Persona workforce direction | `docs/persona-workforce.md` + `docs/design-decisions/005-persona-workforce-runtime.md` | Main Persona, Sub Personas, self-loop sessions, controlled inbound authority |
| Design philosophy | `docs/design-philosophy.md` | Why this project exists and the principles behind its design |

## CONVENTIONS

See [Golden Principles](docs/golden-principles.md) for hard coding invariants and [Repository Guidelines](docs/repository-guidelines.md) for operating rules, cleanup priorities, and documentation/test policy.

Key patterns: Namespace exports (`Session.create()`), Zod-first types (`z.object` + `z.infer`), ESM only, discriminated unions, `BusEvent.define()` for events, middleware over hook callbacks for agent extension.

## MODES

Ingress supports a single execution mode: `direct`. All inbound events dispatch through `handleDirect` to the coordinator.

Target direction: the user and Main Persona may submit new inbound work; ordinary Sub Personas cannot create new top-level inbound work unless explicitly granted manager authority.

## PERSONA WORKFORCE MODEL

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Main Persona | Default user-facing assistant and workforce manager | Ingress target agent + future persona policy |
| Sub Persona | Specialized worker identity for a domain or role | `AgentRegistry`, `SubagentRuntime` |
| Self-loop session | Isolated internal work session for complex reasoning | `Session.createChild()`, `WorkerRun` |
| Controlled inbound | Only user/Main/trusted managers create top-level work | Future `IngressEngine` authority policy |
| Persona promotion | Temporary worker becomes persistent after repeated value | Future persona lifecycle schema |

## ANTI-PATTERNS (THIS PROJECT)

- **Backward-compat hook shims**: `compat.ts` in `packages/agent/src/core/middleware/` converts legacy `ExecutionHooks` and `stepGuard` config to middleware. Deprecated — new code uses `middleware: [...]`.
- **`as any` in protocol**: `NamedError.create()` uses `(this as any).cause = options.cause`. This is the ONE exception; do not add more.

## COMMANDS

```bash
# Install
bun install

# Build all packages
bun run build          # or: turbo run build

# Tests
bun test               # direct Bun discovery, includes app tests
bun run test           # turbo run test; only workspaces with test scripts

# Type check
bun run check-types    # or: turbo run check-types

# Format
bun run format         # biome

# Run server
bun run --cwd apps/server dev        # Hono server with channels (set env tokens first)
```

## NOTES

- README.md describes product direction, project architecture, dependency graph, and getting started.
- `packages/protocol` publishes built `dist/` artifacts (`main: ./dist/index.js`). Other packages point `main` at source (`./src/index.ts`) for Bun's native TS support.
- Lint + format via Biome (`biome.json`). No ESLint.
- CI pipeline: `.github/workflows/ci.yml` — build, check-types, dependency checks, and direct Bun package/app tests; app manifests may not define test scripts.
- `dist/` dirs are gitignored but some exist locally — they are build artifacts, not source.
- `@ai-sdk/anthropic` and `@ai-sdk/openai` are the two bundled providers. New providers via `@ai-sdk/openai-compatible` fallback.
- `packages/agent` is organized as `src/core/` (ChatAgent + middleware) and `src/runtime/` (messenger, registry, tools, mcp). It has no durable session state ownership; session-backed orchestration lives in `packages/openomni`. The middleware engine is the current extension point; legacy hook-based config is routed through `middleware/compat.ts`.
- `packages/openomni` orchestrates ingress, DAG utilities, and subagent runtime. It also owns `BusTransport` (session bus bridge) and the execution runtime (tool providers, worker middleware). `SubagentRuntime` is session-locked; `BackgroundManager` wraps it for fire-and-forget execution with concurrency / depth limits.
- `packages/coordinator` owns multiprocess execution: worker pool lifecycle, IPC transport (Unix socket), recovery of interrupted runs, credentials injection, and tool-permission policy. It depends on all lower packages. See `packages/coordinator/AGENTS.md` for its module map.
- Subagent lifecycle events (`Subagent.Events.*`) are defined in `packages/protocol/src/subagent/index.ts` and published by `SubagentRuntime` / `BackgroundManager`.
