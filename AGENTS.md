# PROJECT KNOWLEDGE BASE


## OVERVIEW

OpenOmni — personal AI workforce infrastructure. Agents earn autonomy through evidence, not self-report. See [Design Philosophy](docs/design-philosophy.md) for full rationale.

The user talks to a single always-on Resident, which delegates work to Workers (internal agents, external AI, humans) through controlled inbound authority and isolated sessions. TypeScript monorepo (Bun + Turborepo) with 6 packages and 1 app (Server).

Product model lives in `docs/core-model.md`; the accepted architecture decisions are [ADR-005](docs/design-decisions/005-persona-workforce-runtime.md) (workforce model), [ADR-008](docs/design-decisions/008-lightweight-main-persona-on-demand-workers.md) (in-process Resident + on-demand workers, shipped), and [ADR-009](docs/design-decisions/009-external-actor-authority-model.md) (external actor authority + the canonical vocabulary). [ADR-010](docs/design-decisions/010-agent-os-kernel-model.md)–[013](docs/design-decisions/013-memory-engine-port.md) (proposed) frame the target as an Agent OS kernel (010) with a task ledger + evidence gate (011), an incident-driven Governor (012), and a pluggable memory port (013). **Design docs describe targets; `docs/implementation-status.md` is the single source of truth for what is actually wired.**

## STRUCTURE

```
openomni/
├── apps/
│   └── server/          # Hono server — Discord/Telegram/GitHub/WebSocket channels, tool providers, ingress router
├── packages/
│   ├── protocol/        # Shared Zod schemas and cross-package contracts
│   ├── session/         # Session CRUD, Bus pub/sub, Storage adapter (in-memory + SQLite), BusPersistence, Artifact, Snapshot, SurfaceKey, WorkerRun, WorkItemStore (universal work state), TraceContext
│   ├── llm/             # LLM abstraction: providers, auth (API key + proxy), streaming, retry, token/cost tracking, provider transforms
│   ├── agent/           # ChatAgent core (middleware-driven ReAct loop) + multi-agent runtime (messenger, registry, subagent/background tools, MCP) — depends on session for observability (Bus, TraceContext)
│   │   ├── src/core/           # ChatAgent, budget, retry, policy engine, memory, delegation, telemetry
│   │   │   ├── execution/      # StreamEngine, ToolExecutor, compaction, parallel-tools
│   │   │   └── policy/         # PolicyEngine + builtins (budget, memory, tool-permission, compaction, post-tool, post-turn, idle-nudge)
│   │   └── src/runtime/        # Multi-agent infrastructure
│   │       ├── messenger/      # AgentMessenger
│   │       ├── registry/       # AgentRegistry
│   │       ├── tools/          # SubagentTool, BackgroundOutputTool, BackgroundCancelTool
│   │       └── mcp/            # McpClient
│   ├── openomni/        # Orchestration: DAG, Ingress, Dispatch, ResidentRuntime, SubagentRuntime + BackgroundManager, BusTransport, execution runtime
│   └── coordinator/     # Multiprocess execution coordinator: on-demand worker manager, worker internals, IPC transport, recovery, credentials, tool-permission
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
| Resident agent prompts | `packages/openomni/src/agents/resident/prompt/` | `ResidentAgent.getPrompt({ model })` — model-specific system prompt variants (Claude, GPT) |
| DAG utilities | `packages/openomni/src/dag/` | Pure: `build`, `validateAcyclic`, `getReady`, `complete` |
| Bus transport (session bridge) | `packages/openomni/src/runtime/` | `BusTransport` — bridges `AgentMessenger.Transport` to the session bus |
| Ingress engine | `packages/openomni/src/ingress/` | `IngressEngine.ingest()` — session candidate resolve → dispatch.submit. Actor arrives pre-stamped; identity resolve (`ActorResolver`) is planned per ADR-009 |
| Resident runtime (in-process) | `packages/openomni/src/resident/` | `ResidentRuntime` — handles resident-target ingress in-process, bypassing coordinator (ADR-008) |
| Doc ↔ code gap tracking | `docs/implementation-status.md` | Single source of truth for implemented / dormant / planned components — check before trusting design docs' present tense |
| Owner-facing usage model | `docs/usage-model.md` | How the system is operated from the Owner's seat (target experience) |
| Actor identity (planned) | `packages/protocol/src/actor/` + `packages/session/src/actor/` | `ActorIdentity` / `ActorEndpoint` / `ActorRegistry` / `ActorResolver` per ADR-009 |
| ChannelGrant / Blacklist (planned) | `packages/protocol/src/actor/channel-grant`, `.../blacklist` | Per-channel policy ceiling and absolute block list per ADR-009 |
| PendingInteraction (planned successor) | `packages/protocol/src/communication/pending-interaction` | Successor to `PendingAsk`; not a pure rename — status enum (`open / resolved / follow_up / expired / cancelled`), `allowedActions`, `followUpWindow`, and `workerRunId / sessionId` strong-coupling all change. Lifecycle managed inside dispatch. |
| Subagent runtime | `packages/openomni/src/subagent/` | `SubagentRuntime` (spawn/send/resume/cancel/wait), `BackgroundManager`, `SubagentConsultation` |
| Coordinator (on-demand workers) | `packages/coordinator/src/worker-manager/` | `OnDemandWorkerManager` — spawn on demand, idle shutdown, max-active cap (used by `apps/server/src/execution/coordinator.ts`) |
| Coordinator worker internals | `packages/coordinator/src/worker-pool/` | Internal leaf modules used by `worker-manager`; no root or submodule barrel contract |
| Coordinator IPC | `packages/coordinator/src/ipc/` | Unix socket transport, request/response framing |
| Coordinator recovery | `packages/coordinator/src/recovery/` | Marks interrupted worker runs failed after restart |
| Server tool providers | `apps/server/src/tool/` + `packages/openomni/src/execution-runtime/tool/` | Server owns `custom/` and MCP wiring; OpenOmni owns system/agent providers |
| `dispatch` tool | `packages/openomni/src/execution-runtime/tool/agent/tools/dispatch.ts` | Runtime-to-runtime/system egress command authority and audit boundary |
| Injection queue | `packages/openomni/src/execution-runtime/injection-queue.ts` | Async response delivery at turn.finish; keyed by runId |
| CronJob registry | `packages/openomni/src/execution-runtime/cron-job-registry.ts` | Storage-backed cron job registry; populated by Dispatch `schedule.create` |
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

> Product terminology: **Owner** (the human operator), **Resident** (formerly Main Persona), **Worker** (formerly Sub Persona + external actors), **System Governor** (structural improvement layer). Full vocabulary in [`docs/core-model.md`](docs/core-model.md); authority model and scenarios in [ADR-009](docs/design-decisions/009-external-actor-authority-model.md).

### Subjects

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Owner | The human operator | (No explicit type yet; identified by `ActorIdentity` with `TrustTier: owner`) |
| Resident | Always-on user-facing assistant | Ingress target agent + future Resident policy |
| Worker | Delegated execution actor (internal AI, external AI, human) | `AgentRegistry`, `SubagentRuntime`, `WorkerRun`, `executorKind` |
| Actor | Any external entity that interacts with the system | (Planned: `ActorIdentity` / `ActorEndpoint` in `packages/protocol/src/actor/`) |
| System Governor | Low-privilege layer that adjusts Policy/Skill from execution evidence | Policy engine, Bus observers |

### Lifecycle / authority

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Self-loop session | Isolated internal work session for complex reasoning | `Session.createChild()`, `WorkerRun` |
| Controlled inbound | Only Owner / Resident / trusted managers create top-level work | `IngressAuthorityMiddleware` + future `effectiveAuthority` |
| Worker promotion | Ephemeral worker becomes persistent after repeated value | Future lifecycle schema |
| PendingInteraction | Durable registry correlating outbound requests with external responses | `PendingAskStore` (transitional) → `PendingInteractionStore` (planned) |
| ChannelGrant | Per-channel access policy and ceiling | (Planned: `packages/protocol/src/actor/channel-grant`) |
| Blacklist | Absolute block list checked before all other authority evaluation | (Planned: `packages/protocol/src/actor/blacklist`) |

### Three-layer message flow

Inbound (and outbound) messages traverse a strict three-layer chain — adding a new channel must only touch `apps/server/`, never ingress or dispatch.

| Layer | Path | Responsibility |
| --- | --- | --- |
| Server channel adapter | `apps/server/src/channel/` | Channel-specific transport; raw → `InboundMessage` (channel-agnostic shape). Implemented. |
| Ingress | `packages/openomni/src/ingress/` | Resolve default session candidate (`SessionResolver`), hand off to dispatch — implemented. Actor identification (`ActorResolver`) — planned per ADR-009. |
| Dispatch | `packages/openomni/src/dispatch/` | Cross-boundary gate. Implemented: policy authorize (WorkerGrant) → handler routing. Planned per ADR-009: blacklist → PendingInteraction match (may override session candidate) → channel grant → `TrustTier` → `effectiveAuthority`, dispatch-side projection, PI lifecycle. See `docs/implementation-status.md`. |

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
- `packages/coordinator` owns multiprocess execution: on-demand worker lifecycle, IPC transport (Unix socket), recovery of interrupted runs, credentials injection, and tool-permission policy. It depends on all lower packages. See `packages/coordinator/AGENTS.md` for its module map.
- Subagent lifecycle events (`Subagent.Events.*`) are defined in `packages/protocol/src/subagent/index.ts` and published by `SubagentRuntime` / `BackgroundManager`.
