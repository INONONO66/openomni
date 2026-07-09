# PROJECT KNOWLEDGE BASE


## OVERVIEW

OpenOmni — a single-Owner Agent OS. Agents earn autonomy through evidence, not self-report. See [Design Philosophy](docs/design-philosophy.md) (one page: three kernel primitives, two laws and a dial, four roles).

The Owner talks to one Resident (a judgment partner that executes nothing), which delegates to Workers (internal agents, external AI, humans — uniformly) through one gate and isolated sessions; everything lands on one ledger. TypeScript monorepo (Bun + Turborepo) with 7 packages and 1 app (Server).

The specification lives in [`docs/core-model.md`](docs/core-model.md) (actors/gate/ledger, roles incl. Governor and Jester, policy hook layer, three-tier vocabulary) and [`docs/architecture.md`](docs/architecture.md) (three communication verbs, package rings, migration phases). Normative contract detail (guarantee split, authority evaluation, work-item/evidence contracts, Governor rules, memory port) lives in [`docs/kernel-contract.md`](docs/kernel-contract.md). ADRs are retired — absorbed into these docs; git history preserves the originals. **Design docs describe targets; `docs/implementation-status.md` is the single source of truth for what is actually wired.**

## STRUCTURE

```
openomni/
├── apps/
│   └── server/          # Hono server — Discord/Telegram/GitHub/WebSocket channels, tool providers, ingress router
├── packages/
│   ├── protocol/        # Shared Zod schemas and cross-package contracts
│   ├── policy/          # Protocol-only policy engine primitive: dispatch, effect composition, registry
│   ├── session/         # Session CRUD, Bus pub/sub, Storage adapter (in-memory + SQLite), BusPersistence, Artifact, SurfaceKey, WorkerRun, WorkItemStore (universal work state), TraceContext
│   ├── llm/             # LLM abstraction: providers, auth (API key + proxy), streaming, retry, token/cost tracking, provider transforms
│   ├── agent/           # ChatAgent core (middleware-driven ReAct loop) + MCP client runtime — depends on session for observability (Bus, TraceContext)
│   │   ├── src/core/           # ChatAgent, budget, retry, policy engine, memory, delegation, telemetry
│   │   │   ├── execution/      # StreamEngine, ToolExecutor, compaction, parallel-tools
│   │   │   └── policy/         # Agent policy facade + builtins (budget, compaction, idle-nudge, tool-guard)
│   │   └── src/runtime/        # MCP client runtime
│   │       └── mcp/            # McpClient
│   ├── openomni/        # Product kernel: messaging, access, orchestration, ledger/evidence gates, tools runtime
│   └── coordinator/     # Multiprocess execution coordinator: on-demand worker manager, worker internals, IPC transport, recovery
├── turbo.json           # Build pipeline config
└── package.json         # Workspace root (bun@1.3.6)
```

## DEPENDENCY GRAPH

```
protocol ← policy ← agent ← openomni ← coordinator ← server
protocol ← session ← llm ──────┘
```

Each layer depends only on lower primitives. `protocol` is the leaf (zero internal deps). `policy` depends only on protocol and owns the generic policy engine/effect composition primitive. `agent` depends on `llm`, `session` for observability, and `policy` for the loop extension primitive, but it must not own OpenOmni product routing. `openomni` is the product kernel that owns messaging, access, and orchestration semantics. `server` is the runtime host app. See [Architecture](docs/architecture.md) — target rings; current split below.

## PACKAGE OWNERSHIP

The package boundary rule is strict: product meaning belongs in `packages/openomni`; lower packages provide primitives. When adding code, first ask whether the change decides "who talks to whom, under what authority, in which session/run, with what durable lifecycle". If yes, it belongs in `packages/openomni` unless it is a pure schema in `packages/protocol`.

| Package | Owns | Must not own |
| --- | --- | --- |
| `packages/protocol` | Zod schemas, wire contracts, event descriptors, storage adapter interfaces | Runtime decisions, routing helpers, authority evaluation, lifecycle orchestration |
| `packages/policy` | Generic policy dispatch, effect composition, middleware registry primitives over protocol contracts | Agent-specific built-ins, OpenOmni authority semantics, session-backed lifecycle decisions |
| `packages/session` | Durable state substrate: session/message/part CRUD, Bus, Bus persistence, storage adapters, indexed record stores | Communication routing, actor trust decisions, worker grant evaluation semantics, pending-reply precedence |
| `packages/llm` | Provider I/O, auth shape, message transforms, token/cost accounting, model catalog | Agent/session/workforce routing, policy, tool execution |
| `packages/agent` | Stateless ChatAgent loop, agent policy built-ins/facade, tool invocation protocol, generic runtime primitives | OpenOmni session-backed worker lifecycle, external actor authority, channel routing, durable background/pending interaction semantics |
| `packages/openomni` | Product kernel: messaging/routing, access control, Resident/Worker orchestration, worker lifecycle backed by session, ledger/evidence gates, tools runtime | Provider SDK behavior, raw channel transport, process supervision internals, storage adapter implementation |
| `packages/coordinator` | Isolated worker process execution: spawn/slot/idle/restart/cancel, IPC framing, primitive run delivery, crash recovery | Actor authority, pending interactions, channel/session routing, worker grant policy |
| `apps/server` | Runtime host: config/bootstrap, channel adapters, webhook/WebSocket/gateway transport, connector manifests, server-owned MCP/custom tool wiring | PendingAsk/PendingInteraction lookup, agent/session routing, access decisions, tool selection policy, orchestration semantics |

### Messaging Kernel Rule

All durable messaging should flow through an OpenOmni-owned kernel surface. Target direction:

```
raw channel event
  -> server channel adapter normalizes transport payload
  -> openomni messaging kernel receives a canonical MessageEnvelope/command
  -> kernel resolves principal, access, correlation, session, target, execution path
  -> kernel projects messages/events and returns response/writeback instructions
```

`apps/server` must not decide whether an inbound message is a PendingInteraction/PendingAsk reply versus a normal conversation; it should pass normalized transport facts to `openomni`. `session` may expose indexed lookups such as correlation queries, but match precedence and lifecycle transitions are kernel decisions. `coordinator` may deliver an input frame to a live run, but it must not decide why that run is the target.

### OpenOmni Internal Split

`packages/openomni` is allowed to be the product kernel, but it should be internally split by ownership:

| Kernel area | Responsibility |
| --- | --- |
| Messaging | Canonical inbound/internal/outbound envelope entry, correlation, target/session resolution, response/writeback routing |
| Access | Principal facts, blocklist/channel access/delegation grant/effective access decisions |
| Orchestration | Resident runtime, Worker run orchestration, session-backed worker runtime, async run scheduler |
| Ledger | Work item orchestration, completion reports, evidence, verification/read-back gates |
| Tools | Tool providers, tool executor, workspace lock, injection queue, schedule bridge; no high-level routing policy |
| Projection | Session message projection, Bus audit events, distilled writeback |

Existing `ingress/` and `dispatch/` are implementation stages of this kernel, not independent product surfaces. New cross-boundary behavior should prefer a central `messaging/` + `access/` facade and only then delegate to legacy ingress/dispatch handlers.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add Zod schema / shared type | `packages/protocol/src/{domain}/index.ts` | Cross-package contracts only; runtime logic lives in upper packages |
| Add/modify bus events | `packages/protocol/src/event/index.ts` + `event/agent-execution.ts` | `BusEvent.define()` pattern |
| Add worker run lifecycle events | `packages/protocol/src/worker-run/index.ts` | `WorkerRun.Events.*` |
| Add policy timing | `packages/protocol/src/policy/index.ts` | 13 timings: pre_run, pre_turn, on_system_prompt, pre_tool_use, post_tool_use, post_turn, post_compaction, post_run, on_error, pre_ingress, pre_tool_selection, pre_delegation |
| Agent profile schema | `packages/protocol/src/agent/index.ts` | `AgentProfile.Definition`, `AgentProfile.AgentBudget` |
| Session CRUD | `packages/session/src/session/` | Namespace-based API |
| Storage backend | `packages/session/src/storage/` | Implement `Storage.Adapter` (core session/message/part plus optional `artifact`, `eventLog`, `surfaceKey`, `workItem`, `workerRunState`) |
| Bus persistence observer | `packages/session/src/bus-persistence/` | Bus.observe() handler that persists non-ephemeral events to bus_event table |
| Bus query API | `packages/session/src/bus-persistence/query.ts` | BusQuery namespace for reading persisted events |
| Surface → session mapping | `packages/session/src/surface-key/` | N:1 SurfaceKey registry |
| WorkItem schemas + events | `packages/protocol/src/work-item/` | `WorkItem.Info`, `Blocker`, `Evidence`, `VerificationGate`, `Status`, `deriveStatus()`, `generateHash()`, `WorkItem.Events.*`; `index.ts` is the public facade |
| WorkItem storage interface | `packages/protocol/src/storage/index.ts` | `Storage.WorkItemSubAdapter` (get/set/list/remove) |
| WorkItemStore engine | `packages/session/src/work-item/index.ts` | CRUD + lifecycle (start/complete/fail/cancel/retry) + blockers + evidence + dependency readiness + cycle detection |
| Worker run records | `packages/session/src/worker-run/` | Direct DB table (worker_run_state), NOT event-sourced |
| WorkerRun state store | `packages/session/src/worker-run/state-store.ts` | Direct DB CRUD for worker_run_state table |
| Add LLM provider | `packages/llm/src/provider/provider.ts` + provider-specific auth/transform modules as needed | Register SDK in `getSDK()`; keep provider-specific request/auth behavior out of call sites |
| Provider transforms | `packages/llm/src/transform/` | Message normalization + per-provider variants |
| Token usage / cost | `packages/llm/src/token/` | `TokenTracker.extractUsage`, `calculateCost` |
| Model catalog | `packages/llm/src/model/` | Fetches from models.dev |
| ChatAgent core | `packages/agent/src/core/` | ChatAgent, budget, retry, policy engine, memory, delegation, telemetry |
| Policy engine primitive | `packages/policy/src/` | `PolicyEngine.create()`, `PolicyRegistry.create()`, effect composition |
| Agent policy built-ins | `packages/agent/src/core/policy/` | Agent-scoped facade + built-ins in `builtin/` |
| Agent execution engine | `packages/agent/src/core/execution/` | StreamEngine, ToolExecutor, compaction, parallel-tools |
| MCP client | `packages/agent/src/runtime/mcp/` | McpClient |
| Resident agent prompts | `packages/openomni/src/agents/resident/prompt/` | `ResidentAgent.getPrompt({ model })` — model-specific system prompt variants (Claude, GPT) |
| Messaging kernel | `packages/openomni/src/{messaging,ingress,dispatch}/` | OpenOmni-owned envelope routing, access evaluation, correlation, session/target resolution, projection |
| Ingress engine | `packages/openomni/src/ingress/` | Current inbound stage: authority middleware → session resolution → projection → resident/direct handler |
| Resident runtime (in-process) | `packages/openomni/src/resident/` | `ResidentRuntime` — handles resident-target ingress in-process, bypassing coordinator |
| Doc ↔ code gap tracking | `docs/implementation-status.md` | Single source of truth for implemented / dormant / planned components — check before trusting design docs' present tense |
| Owner-facing usage model | `docs/usage-model.md` | How the system is operated from the Owner's seat (target experience) |
| Principal / actor identity | `packages/protocol/src/actor/` + `packages/session/src/actor/` + `packages/openomni/src/ingress/actor-resolver.ts` | Schemas/storage are lower-level; principal resolution and access semantics belong in `openomni` |
| ChannelAccessRule / Blocklist | `packages/protocol/src/actor/` + `packages/session/src/{channel-grant,blacklist}/` | Storage lives in `session`; evaluation and precedence belong in `openomni` access |
| PendingInteraction | `packages/protocol/src/communication/pending-interaction.ts` + `packages/session/src/pending-interaction/` + `packages/openomni/src/dispatch/pending-interaction-routing.ts` | Durable external-response correlation; kernel owns match precedence and lifecycle transitions |
| Coordinator (on-demand workers) | `packages/coordinator/src/worker-manager/` | `OnDemandWorkerManager` — spawn on demand, idle shutdown, max-active cap (used by `apps/server/src/execution/coordinator.ts`) |
| Coordinator worker internals | `packages/coordinator/src/worker-manager/` + `worker-supervision/` | On-demand worker lifecycle; do not recreate legacy worker-pool facades |
| Coordinator IPC | `packages/coordinator/src/ipc/` | Unix socket transport, request/response framing |
| Coordinator recovery | `packages/coordinator/src/recovery/` | Marks interrupted worker runs failed after restart |
| Server tool providers | `apps/server/src/tool/` + `packages/openomni/src/execution-runtime/tool/` | Server owns `custom/` and MCP wiring; OpenOmni owns system/agent providers |
| `dispatch` tool | `packages/openomni/src/execution-runtime/tool/agent/tools/dispatch.ts` | Runtime-to-runtime/system egress command authority and audit boundary |
| Injection queue | `packages/openomni/src/execution-runtime/injection-queue.ts` | Async response delivery at turn.finish; keyed by runId |
| CronJob registry | `packages/openomni/src/execution-runtime/cron-job-registry.ts` | Storage-backed cron job registry; populated by Dispatch `schedule.create` |
| Server channels | `apps/server/src/channel/` | Discord, Telegram, GitHub, WebSocket |
| Server inbound bridge | `apps/server/src/ingress/` | Transitional adapter bridge; target direction is raw channel message → OpenOmni `MessageEnvelope` only |
| Product model | `docs/core-model.md` + `docs/kernel-contract.md` | Resident, Workers, System Governor, controlled inbound authority |
| Design philosophy | `docs/design-philosophy.md` | Why this project exists and the principles behind its design |

## CONVENTIONS

Key coding invariants and repository operating rules are maintained as internal references (`.local.md` files, not committed).

Key patterns: Namespace exports (`Session.create()`), Zod-first types (`z.object` + `z.infer`), ESM only, discriminated unions, `BusEvent.define()` for events, `PolicyEngine` for agent-loop extension, OpenOmni kernel for messaging/orchestration decisions.

## CODING BOUNDARY RULES

- Do not add product routing to `apps/server`. Channel code may authenticate transport, dedupe raw deliveries, normalize payloads, and send returned responses. It must not query `PendingAskStore`, `PendingInteractionStore`, `SurfaceKey`, `WorkerGrantStore`, or choose worker/resident targets except through an OpenOmni kernel API.
- Do not add authority decisions to `packages/session`. Store modules may persist records and provide indexed queries; `openomni` decides precedence, trust, grants, and lifecycle transitions.
- Do not add OpenOmni-specific durable lifecycle to `packages/agent`. Session-backed worker/background execution belongs in `packages/openomni`.
- Do not add process semantics to `packages/openomni`; worker process lifecycle and IPC stay in `packages/coordinator`.
- Do not add provider behavior outside `packages/llm`.
- Prefer narrowing public barrels. A symbol exported from a package is a contract; do not export helper stages just for convenience.

## MODES

Ingress supports a single execution mode: `direct`. All inbound events dispatch through `handleDirect` to the coordinator.

Target direction: the user and Resident may submit new inbound work; ordinary Workers cannot create new top-level inbound work unless explicitly granted manager authority.

## PRODUCT MODEL

> Product terminology: **Owner** (root), **Resident** (decides — judgment, no execution), **Worker** (does — internal AI, external AI, humans, even the Owner), **Governor** (fixes — post-hoc structural improvement), **Jester** (doubts — zero-authority real-time cross-check). Three-tier vocabulary in [`docs/core-model.md`](docs/core-model.md); authority-model detail in [`docs/kernel-contract.md`](docs/kernel-contract.md).

### Subjects

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Owner | The human operator | (No explicit type yet; identified by `ActorIdentity` with `TrustTier: owner`) |
| Resident | Always-on user-facing assistant | Ingress target agent + future Resident policy |
| Worker | Delegated execution actor (internal AI, external AI, human) | `WorkItem` attempts (formerly `WorkerRun`), `executorKind` |
| Actor | Any external entity that interacts with the system | (Planned: `ActorIdentity` / `ActorEndpoint` in `packages/protocol/src/actor/`) |
| System Governor | Low-privilege layer that adjusts Policy/Skill from execution evidence | Policy engine, Bus observers |

### Lifecycle / authority

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Self-loop session | Isolated internal work session for complex reasoning | `Session.createChild()`, `WorkerRun` |
| Controlled inbound | Only Owner / Resident / trusted managers create top-level work | `IngressAuthorityMiddleware` + future `effectiveAuthority` |
| Worker promotion | Ephemeral worker becomes persistent after repeated value | Future lifecycle schema |
| PendingInteraction | Durable registry correlating outbound requests with external responses | `PendingInteractionStore`; `PendingAskStore` remains a transitional resident.ask legacy surface |
| ChannelAccessRule (legacy ChannelGrant) | Per-channel access policy and ceiling | `Actor.ChannelGrant` schema + `ChannelGrantStore`; OpenOmni access owns evaluation |
| Blocklist (legacy Blacklist) | Absolute block list checked before all other access evaluation | `Actor.BlacklistEntry` schema + `BlacklistStore`; OpenOmni access owns evaluation |

### Kernel-Centered Message Flow

Inbound and outbound messaging should converge on the OpenOmni kernel. Adding a new channel should touch `apps/server/` only for raw transport and normalization, then route through `packages/openomni` for all messaging semantics.

| Layer | Path | Responsibility |
| --- | --- | --- |
| Server channel adapter | `apps/server/src/channel/` | Channel-specific transport; raw → canonical inbound facts/envelope. No durable routing decisions. |
| OpenOmni messaging kernel | `packages/openomni/src/{messaging,ingress,dispatch}/` | Principal resolution, blocklist/channel access/trust, PendingInteraction correlation, session/target resolution, dispatch/ingress stage selection, projection/writeback. |
| Execution primitives | `packages/agent`, `packages/coordinator`, `packages/llm`, `packages/session` | Loop execution, process execution, model I/O, and durable state. These primitives do not decide communication meaning. |

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
- `@ai-sdk/anthropic` and `@ai-sdk/openai` are the two bundled providers. Custom provider endpoints use the OpenAI provider with their catalog API URL as `baseURL`.
- `packages/agent` is organized as `src/core/` (ChatAgent + policy facade/built-ins) and `src/runtime/` (mcp). It has no durable session state ownership; session-backed orchestration lives in `packages/openomni`.
- `packages/openomni` is the product kernel. It owns messaging, access, Resident/Worker orchestration, ledger/evidence gates, and execution runtime tooling.
- `packages/coordinator` owns multiprocess execution: on-demand worker lifecycle, IPC transport (Unix socket), recovery of interrupted runs, credentials injection, and tool-permission policy. It depends on all lower packages. See `packages/coordinator/AGENTS.md` for its module map.
- WorkerRun lifecycle events live under `WorkerRun.Events.*` in `packages/protocol/src/worker-run/index.ts`.
