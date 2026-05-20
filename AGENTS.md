# PROJECT KNOWLEDGE BASE


## OVERVIEW

OpenOmni — personal AI workforce infrastructure. Agents earn autonomy through evidence, not self-report. See [Design Philosophy](docs/design-philosophy.md) for full rationale.

The user talks to a single always-on Resident, which delegates work to Workers (internal agents, external AI, humans) through controlled inbound authority and isolated sessions. TypeScript monorepo (Bun + Turborepo) with 6 packages and 1 app (Server).

Product model lives in `docs/core-model.md`; the accepted architecture decision is [ADR-005](docs/design-decisions/005-persona-workforce-runtime.md).

## STRUCTURE

```
openomni/
├── apps/
│   └── server/          # Hono server — Discord/Telegram/GitHub/WebSocket channels, tool providers, ingress router
├── packages/
│   ├── protocol/        # Shared Zod schemas and cross-package contracts
│   ├── session/         # Session CRUD, Bus pub/sub, Storage adapter (in-memory + SQLite), BusPersistence, Artifact, Snapshot, SurfaceKey, WorkerRun, WorkItemStore (universal work state), TraceContext
│   ├── llm/             # LLM abstraction: providers, auth (API key + OAuth), streaming, retry, token/cost tracking, provider transforms
│   ├── agent/           # ChatAgent core (middleware-driven ReAct loop) + multi-agent runtime (messenger, registry, subagent/background tools, MCP) — depends on session for observability (Bus, TraceContext)
│   │   ├── src/core/           # ChatAgent, budget, retry, policy engine, memory, delegation, telemetry
│   │   │   ├── execution/      # StreamEngine, ToolExecutor, compaction, parallel-tools
│   │   │   └── policy/         # PolicyEngine + builtins (budget, memory, tool-permission, compaction, post-tool, post-turn, idle-nudge)
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

Each layer depends only on layers to its left. `protocol` is the leaf (zero internal deps). `agent` depends on `llm` and `session` (for observability: Bus, TraceContext). `server` is the runtime host app. See [ADR-003](docs/design-decisions/003-layered-package-architecture.md).

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add Zod schema / shared type | `packages/protocol/src/{domain}/index.ts` | Cross-package contracts only; runtime logic lives in upper packages |
| Add/modify bus events | `packages/protocol/src/event/index.ts` + `event/agent-execution.ts` | `BusEvent.define()` pattern |
| Add subagent lifecycle events | `packages/protocol/src/subagent/index.ts` | `Subagent.Events.*` (worker runs + background tasks) |
| Add policy timing | `packages/protocol/src/policy/index.ts` | 13 timings: pre_run, pre_turn, on_system_prompt, pre_tool_use, post_tool_use, post_turn, post_compaction, post_run, on_error, pre_ingress, pre_tool_selection, pre_delegation |
| Agent profile schema | `packages/protocol/src/agent/index.ts` | `AgentProfile.Definition`, `AgentProfile.AgentBudget` |
| Session CRUD | `packages/session/src/session/` | Namespace-based API |
| Storage backend | `packages/session/src/storage/` | Implement `Storage.Adapter` (core session/message/part plus optional `artifact`, `eventLog`, `surfaceKey`, `backgroundTask`, `workItem`, `workerRunState`) |
| Bus persistence observer | `packages/session/src/bus-persistence/` | Bus.observe() handler that persists non-ephemeral events to bus_event table |
| Bus query API | `packages/session/src/bus-persistence/query.ts` | BusQuery namespace for reading persisted events |
| Surface → session mapping | `packages/session/src/surface-key/` | N:1 SurfaceKey registry |
| WorkItem schemas + events | `packages/protocol/src/work-item/index.ts` | `WorkItem.Info`, `Blocker`, `Evidence`, `VerificationGate`, `Status`, `deriveStatus()`, `generateHash()`, `WorkItem.Events.*` |
| WorkItem storage interface | `packages/protocol/src/storage/index.ts` | `Storage.WorkItemSubAdapter` (get/set/list/remove) |
| WorkItemStore engine | `packages/session/src/work-item/index.ts` | CRUD + lifecycle (start/complete/fail/cancel/retry) + blockers + evidence + dependency readiness + cycle detection |
| Worker run records (subagent) | `packages/session/src/worker-run/` | Direct DB table (worker_run_state), NOT event-sourced |
| WorkerRun state store | `packages/session/src/worker-run/state-store.ts` | Direct DB CRUD for worker_run_state table |
| Add LLM provider | `packages/llm/src/provider/provider.ts` + provider-specific auth/transform modules as needed | Register SDK in `getSDK()`; keep provider-specific request/auth behavior out of call sites |
| Provider transforms | `packages/llm/src/transform/` | Message normalization + per-provider variants |
| Token usage / cost | `packages/llm/src/token/` | `TokenTracker.extractUsage`, `calculateCost` |
| Model catalog | `packages/llm/src/model/` | Fetches from models.dev |
| ChatAgent core | `packages/agent/src/core/` | ChatAgent, budget, retry, policy engine, memory, delegation, telemetry |
| Policy engine | `packages/agent/src/core/policy/` | `PolicyEngine.create()` + built-ins in `builtin/` |
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
| Server tool providers | `apps/server/src/tool/` + `packages/openomni/src/execution-runtime/tool/` | Server owns `custom/` and MCP wiring; OpenOmni owns system/agent providers |
| `inbound_message` tool | `packages/openomni/src/execution-runtime/tool/agent/tools/inbound-message.ts` | Cross-sandbox IPC syscall — spawn/send/cancel/resume/schedule to resident or worker agents |
| Injection queue | `packages/openomni/src/execution-runtime/injection-queue.ts` | Async response delivery at turn.finish; keyed by runId |
| CronJob registry | `packages/openomni/src/execution-runtime/cron-job-registry.ts` | In-memory cron job registry; populated by `inbound_message` schedule action |
| Server channels | `apps/server/src/channel/` | Discord, Telegram, GitHub, WebSocket |
| Server ingress bridge | `apps/server/src/ingress/` | `buildInboundEvent()`, `detectMode()` |
| Product model | `docs/core-model.md` + `docs/design-decisions/005-persona-workforce-runtime.md` | Resident, Workers, System Governor, controlled inbound authority |
| Design philosophy | `docs/design-philosophy.md` | Why this project exists and the principles behind its design |

## CONVENTIONS

Key coding invariants and repository operating rules are maintained as internal references (`.local.md` files, not committed).

Key patterns: Namespace exports (`Session.create()`), Zod-first types (`z.object` + `z.infer`), ESM only, discriminated unions, `BusEvent.define()` for events, `PolicyEngine` for agent extension.

## MODES

Ingress supports a single execution mode: `direct`. All inbound events dispatch through `handleDirect` to the coordinator.

Target direction: the user and Resident may submit new inbound work; ordinary Workers cannot create new top-level inbound work unless explicitly granted manager authority.

## PRODUCT MODEL

> Product terminology: Resident (formerly Main Persona), Worker (formerly Sub Persona + external actors), System Governor (structural improvement layer). See `docs/core-model.md` for full model.

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Resident | Always-on user-facing assistant | Ingress target agent + future persona policy |
| Worker | Delegated execution actor (internal agent, external AI, human) | `AgentRegistry`, `SubagentRuntime`, `WorkerRun` |
| System Governor | Low-privilege layer that adjusts Policy/Skill from execution evidence | Policy engine, Bus observers |
| Self-loop session | Isolated internal work session for complex reasoning | `Session.createChild()`, `WorkerRun` |
| Controlled inbound | Only user/Resident/trusted managers create top-level work | Future `IngressEngine` authority policy |
| Worker promotion | Ephemeral worker becomes persistent after repeated value | Future lifecycle schema |

## ANTI-PATTERNS (THIS PROJECT)

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

- README.md describes the product model and design philosophy. Architecture details live in internal docs.
- `packages/protocol` publishes built `dist/` artifacts (`main: ./dist/index.js`). Other packages point `main` at source (`./src/index.ts`) for Bun's native TS support.
- Lint + format via Biome (`biome.json`). No ESLint.
- CI pipeline: `.github/workflows/ci.yml` — build, check-types, dependency checks, and direct Bun package/app tests; app manifests may not define test scripts.
- `dist/` dirs are gitignored but some exist locally — they are build artifacts, not source.
- `@ai-sdk/anthropic` and `@ai-sdk/openai` are the two bundled providers. New providers via `@ai-sdk/openai-compatible` fallback.
- `packages/agent` is organized as `src/core/` (ChatAgent + policy engine) and `src/runtime/` (messenger, registry, tools, mcp). It has no durable session state ownership; session-backed orchestration lives in `packages/openomni`. The policy engine is the extension point.
- `packages/openomni` orchestrates ingress, DAG utilities, and subagent runtime. It also owns `BusTransport` (session bus bridge) and the execution runtime (tool providers, worker middleware). `SubagentRuntime` is session-locked; `BackgroundManager` wraps it for fire-and-forget execution with concurrency / depth limits.
- `packages/coordinator` owns multiprocess execution: worker pool lifecycle, IPC transport (Unix socket), recovery of interrupted runs, credentials injection, and tool-permission policy. It depends on all lower packages. See `packages/coordinator/AGENTS.md` for its module map.
- Subagent lifecycle events (`Subagent.Events.*`) are defined in `packages/protocol/src/subagent/index.ts` and published by `SubagentRuntime` / `BackgroundManager`.
