# PROJECT KNOWLEDGE BASE


## OVERVIEW

OpenOmni — a single-Owner Agent OS. Agents earn autonomy through evidence, not self-report. See [Design Philosophy](docs/design-philosophy.md) (one page: three kernel primitives, two laws and a dial, four roles).

The Owner talks to one Resident (a judgment partner that executes nothing), which delegates to Workers (internal agents, external AI, humans — uniformly) through one gate and isolated sessions; everything lands on one ledger. TypeScript monorepo (Bun + Turborepo) with 7 packages and 1 app (Server).

The specification lives in [`docs/core-model.md`](docs/core-model.md) (actors/gate/ledger, roles incl. Governor and Jester, policy hook layer, three-tier vocabulary) and [`docs/architecture.md`](docs/architecture.md) (three communication verbs, package rings, migration phases). Normative contract detail (guarantee split, authority evaluation, work-item/evidence contracts, Governor rules, memory port) lives in [`docs/kernel-contract.md`](docs/kernel-contract.md). ADRs are retired — absorbed into these docs; git history preserves the originals. **Design docs describe targets; `docs/implementation-status.md` is the single source of truth for what is actually wired.**

## STRUCTURE

```
openomni/
├── apps/
│   └── server/          # Hono server — Discord/Telegram/GitHub/WebSocket channels, tool providers, ingress bridge, composition root
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
│   └── coordinator/     # Multiprocess worker driver: on-demand worker pool, supervision, IPC transport — protocol-only deps, ports injected by the composition root
├── turbo.json           # Build pipeline config
└── package.json         # Workspace root (bun@1.3.6)
```

## DEPENDENCY GRAPH

```
protocol ← policy ← agent ← openomni ← server
protocol ← session ← llm ──────┘
protocol ← coordinator ← server
```

Each layer depends only on lower primitives. `protocol` is the leaf (zero internal deps). `policy` depends only on protocol and owns the generic policy engine/effect composition primitive. `agent` depends on `llm`, `session` for observability, and `policy` for the loop extension primitive, but it must not own OpenOmni product routing. `openomni` is the product kernel that owns messaging, access, and orchestration semantics. `coordinator` is **protocol-only** (session-free since #477): its event sink, tool relay, and inbound-wait ports are injected by the composition root (`apps/server/src/execution/coordinator.ts`). `server` is the runtime host app and composition root. Enforced by `script/check-deps.ts` (package.json **and** source imports). See [Architecture](docs/architecture.md) — target rings; current split below.

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
| Add policy point | `packages/protocol/src/policy/point-registry.ts` | 19 registered points (`session.inbound.pre`, `dispatch.action.pre`, `run.lifecycle/turn/completion/error.*`, `prompt.context.pre`, `connection.llm.pre/post`, `tool.catalog/native/mcp.*`, `delegation.worker.pre/post`, `session.writeback.pre`), each with allowed effects, fail policy, required context. New points must pass the conformance gate (vocab/naming) |
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
| Messaging kernel | `packages/openomni/src/{ingress,dispatch}/` | OpenOmni-owned envelope routing, access evaluation, correlation, session/target resolution, projection (a unified `resolveRoute` pipeline is #464; a `messaging/` facade is target direction, not yet a directory) |
| Ingress engine | `packages/openomni/src/ingress/` | Current inbound stage: authority middleware → session resolution → projection → resident/direct handler |
| Resident runtime (in-process) | `packages/openomni/src/resident/` | `ResidentRuntime` — handles resident-target ingress in-process, bypassing coordinator |
| Doc ↔ code gap tracking | `docs/implementation-status.md` | Single source of truth for implemented / dormant / planned components — check before trusting design docs' present tense |
| Owner-facing usage model | `docs/usage-model.md` | How the system is operated from the Owner's seat (target experience) |
| Principal / actor identity | `packages/protocol/src/actor/` + `packages/session/src/actor/` + `packages/openomni/src/ingress/actor-resolver.ts` | Schemas/storage are lower-level; principal resolution and access semantics belong in `openomni` |
| ChannelAccessRule / Blocklist | `packages/protocol/src/actor/` + `packages/session/src/{channel-grant,blacklist}/` | Storage lives in `session`; evaluation and precedence belong in `openomni` access |
| PendingInteraction | `packages/protocol/src/communication/pending-interaction.ts` + `packages/session/src/pending-interaction/` + `packages/openomni/src/dispatch/pending-interaction-routing.ts` | Durable external-response correlation; kernel owns match precedence and lifecycle transitions |
| Coordinator (on-demand workers) | `packages/coordinator/src/worker-manager/worker-pool.ts` | `createWorkerManager(config, ports)` — spawn on demand, idle shutdown, max-active cap; verbs are `deliver`/`send`/`cancel`/`stats` (never `dispatch`), typed failures via `WorkerDeliveryError` codes |
| Coordinator supervision | `packages/coordinator/src/worker-supervision/` | Process supervisor (`WorkerSupervisorOptions` config object; `events` sink required) |
| Coordinator IPC | `packages/coordinator/src/ipc/` | Unix socket transport, request/response framing — wire method names are frozen (Greg Young rule) |
| Boot recovery | `apps/server/src/execution/recovery.ts` | Marks interrupted worker runs after restart (moved out of coordinator in #477; invoked from bootstrap) |
| Gate-side policy stamping | `packages/openomni/src/policy/resolver.ts` + `dispatch/handlers/worker.ts` | `worker.spawn` stamps a `policyPlan` (default: required `builtin:tool-permission` + `builtin:idle-nudge`) resolved from actor/target labels; custom rules injected at the composition root |
| Conformance gate | `script/lint-tools.ts` + `script/conformance/` | Vocab ratchet, tool lint, naming rules, earned check, Greg Young schema snapshot; runs pre-push + CI. `--self-test` proves discrimination; `--update` regenerates the schema snapshot (the diff is the Owner sign-off surface) |
| Server tool providers | `apps/server/src/tool/` + `packages/openomni/src/execution-runtime/tool/` | Server owns `custom/` and MCP wiring; OpenOmni owns system/agent providers |
| `dispatch` tool | `packages/openomni/src/execution-runtime/tool/agent/tools/dispatch.ts` | Runtime-to-runtime/system egress command authority and audit boundary |
| Injection queue | `packages/openomni/src/execution-runtime/injection-queue.ts` | Async response delivery at turn.finish; keyed by runId |
| CronJob registry | `packages/openomni/src/execution-runtime/cron-job-registry.ts` | Storage-backed cron job registry; populated by Dispatch `schedule.create` |
| Server channels | `apps/server/src/channel/` | Discord, Telegram, GitHub, WebSocket |
| Server inbound bridge | `apps/server/src/ingress/` | Transitional adapter bridge; target direction is raw channel message → OpenOmni `MessageEnvelope` only |
| Product model | `docs/core-model.md` + `docs/kernel-contract.md` | Resident, Workers, System Governor, controlled inbound authority |
| Design philosophy | `docs/design-philosophy.md` | Why this project exists and the principles behind its design |

## CONVENTIONS

Operating rules live in this file and the tracked `docs/` — gitignored `*.local.md` files are machine-local exploration scratch and must never be load-bearing for issues, docs, or PRs (2026-07-09 handoff-hardening rule; normative content gets promoted into `docs/kernel-contract.md` / `docs/architecture.md` or pasted into the issue).

Key patterns: Namespace exports (`Session.create()`), Zod-first types (`z.object` + `z.infer`), ESM only, discriminated unions, `BusEvent.define()` for events, `PolicyEngine` for agent-loop extension, OpenOmni kernel for messaging/orchestration decisions.

## CODING BOUNDARY RULES

- Do not add product routing to `apps/server`. Channel code may authenticate transport, dedupe raw deliveries, normalize payloads, and send returned responses. It must not query `PendingAskStore`, `PendingInteractionStore`, `SurfaceKey`, `WorkerGrantStore`, or choose worker/resident targets except through an OpenOmni kernel API.
- Do not add authority decisions to `packages/session`. Store modules may persist records and provide indexed queries; `openomni` decides precedence, trust, grants, and lifecycle transitions.
- Do not add OpenOmni-specific durable lifecycle to `packages/agent`. Session-backed worker/background execution belongs in `packages/openomni`.
- Do not add process semantics to `packages/openomni`; worker process lifecycle and IPC stay in `packages/coordinator`.
- Do not add provider behavior outside `packages/llm`.
- Prefer narrowing public barrels. A symbol exported from a package is a contract; do not export helper stages just for convenience.

## EXECUTION DISCIPLINE

These rules are model-independent and non-negotiable; they exist because each one has caught a real merged-or-nearly-merged defect (2026-07-09 alone: a retired-model fallback contradicting its own PR's regenerated catalog, a namespace-shadowed self-recursion spinning at 100% CPU through green typechecks, a stale assertion, and an inverted unlimited-budget sentinel — all found by review, not by the author's green runs).

1. **Independent adversarial review before merge.** Every nontrivial PR gets a review by a separate agent/session that (a) reads the full diff skeptically, (b) re-runs the suites itself in a scratch worktree, and (c) tries to refute the PR body's claims rather than confirm them. The author's own green run is never sufficient — evidence-over-self-report is a repo law, and it applies to agents' reports about their own work first.
2. **Tests run with an explicit per-test timeout**: `bun test --timeout 15000`. A hang is a finding, not an inconvenience — proper tail calls make infinite self-recursion silent (no stack overflow), and the default run masks it. If the suite doesn't finish in ~1 minute, something is wrong; kill it and bisect.
3. **Verify your own side effects.** After committing, confirm with `git log`/`git status` — lefthook/biome can roll a commit back while printing success-looking output. After any tool claims success, prefer re-observing state (file on disk, PR state via `gh`, CI via checks API) over trusting the tool's report.
4. **Reconcile-first.** Issue bodies and audit findings decay as `main` moves. Before deleting or changing anything an issue claims is true, re-verify the claim on the current tree (zero-consumer grep proof for deletions) and record deltas in the PR body. A claim that turned out false gets corrected in the issue, not silently ignored.
5. **Conformance gate rules of engagement** (`bun run lint:tools`, pre-push + CI): shrinking a baseline in `script/conformance/` is autonomous and encouraged; **growing one requires Owner sign-off in review**. Schema evolution: field renames/re-meanings are forbidden — a changed meaning is a new event type, shapes evolve by upcast-on-read; removals go through `lint-tools --update`, whose diff is the sign-off surface.
6. **Fresh clone/worktree**: run `bun install` and `turbo run build` (protocol `dist/`) before `lint-tools` or tests — otherwise they fail on missing build artifacts, which is not a code defect.
7. **Doc-state sync law**: `docs/implementation-status.md` and the phase issue move in the same PR as the change. An engine without a consumer does not count as shipped; a shipped change that docs still call planned is a defect.

## MODES

Ingress supports a single execution mode: `direct`. All inbound events dispatch through `handleDirect` to the coordinator.

Target direction: only the Resident commissions new top-level Worker work. The Owner requests delegation through the Resident and may attach directly to existing actors as root. The Resident has no subagent lane. A Worker cannot spawn another Worker under any trust tier; it may use a same-domain, context-sharing `child_agent`, message an already-existing agent through policy-gated dispatch when granted, or ask the Resident via `resident.ask` to commission independent/cross-domain work.

## PRODUCT MODEL

> Product terminology: **Owner** (root), **Resident** (decides — judgment, no execution), **Worker** (does — internal AI, external AI, humans, even the Owner), **Governor** (fixes — post-hoc structural improvement), **Jester** (doubts — zero-authority real-time cross-check). Three-tier vocabulary in [`docs/core-model.md`](docs/core-model.md); authority-model detail in [`docs/kernel-contract.md`](docs/kernel-contract.md).

### Subjects

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Owner | The human operator | (No explicit type yet; identified by `ActorIdentity` with `TrustTier: owner`) |
| Resident | Always-on user-facing judgment shell; no subagent lane | Ingress target agent + future Resident-selected policy plan and judgment-only tool catalog |
| Worker | Delegated execution actor (internal AI, external AI, human) | `WorkItem` attempts (formerly `WorkerRun`), `executorKind` |
| Actor | Any external entity that interacts with the system | (Planned: `ActorIdentity` / `ActorEndpoint` in `packages/protocol/src/actor/`) |
| System Governor | Low-privilege layer that adjusts Policy/Skill from execution evidence | Policy engine, Bus observers |

### Lifecycle / authority

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Self-loop session | Isolated internal work session for complex reasoning | `Session.createChild()`, `WorkerRun` |
| Controlled inbound | Only Owner / Resident / trusted managers create top-level work | `IngressAuthorityMiddleware` + future `effectiveAuthority` |
| Worker promotion | Ephemeral worker becomes persistent after repeated value | Future lifecycle schema |
| PendingInteraction | Durable registry correlating outbound requests with external responses | `PendingInteractionStore`; `PendingAskStore` remains a transitional resident.ask legacy surface. Both collapse into the single `Wait { ownerRef }` primitive under #215 — see kernel-contract §2 |
| ChannelAccessRule (legacy ChannelGrant) | Per-channel access policy and ceiling | `Actor.ChannelGrant` schema + `ChannelGrantStore`; OpenOmni access owns evaluation |
| Blocklist (legacy Blacklist) | Absolute block list checked before all other access evaluation | `Actor.BlacklistEntry` schema + `BlacklistStore`; OpenOmni access owns evaluation |

### Kernel-Centered Message Flow

Inbound and outbound messaging should converge on the OpenOmni kernel. Adding a new channel should touch `apps/server/` only for raw transport and normalization, then route through `packages/openomni` for all messaging semantics.

| Layer | Path | Responsibility |
| --- | --- | --- |
| Server channel adapter | `apps/server/src/channel/` | Channel-specific transport; raw → canonical inbound facts/envelope. No durable routing decisions. |
| OpenOmni messaging kernel | `packages/openomni/src/{ingress,dispatch}/` | Principal resolution, blocklist/channel access/trust, wait correlation, session/target resolution, dispatch/ingress stage selection, projection/writeback. |
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

# Conformance gate (vocab ratchet, tool lint, naming, earned check, schema snapshot)
bun run lint:tools
bun run lint:tools --self-test   # discrimination bench
bun run script/check-deps.ts     # dependency direction + source-import scan

# Format
bun run format         # biome

# Run server
bun run --cwd apps/server dev        # Hono server with channels (set env tokens first)
```

## NOTES

- README.md describes the product model and design philosophy. Architecture details live in internal docs.
- `packages/protocol` publishes built `dist/` artifacts (`main: ./dist/index.js`). Other packages point `main` at source (`./src/index.ts`) for Bun's native TS support.
- Lint + format via Biome (`biome.json`). No ESLint.
- CI pipeline: `.github/workflows/ci.yml` — build, check-types, dependency checks (incl. `lint:tools` + `--self-test` conformance gate), and direct Bun package/app tests; app manifests may not define test scripts.
- `dist/` dirs are gitignored but some exist locally — they are build artifacts, not source.
- `@ai-sdk/anthropic` and `@ai-sdk/openai` are the two bundled providers. Custom provider endpoints use the OpenAI provider with their catalog API URL as `baseURL`.
- `packages/agent` is organized as `src/core/` (ChatAgent + policy facade/built-ins) and `src/runtime/` (mcp). It has no durable session state ownership; session-backed orchestration lives in `packages/openomni`.
- `packages/openomni` is the product kernel. It owns messaging, access, Resident/Worker orchestration, ledger/evidence gates, and execution runtime tooling.
- `packages/coordinator` owns multiprocess execution: on-demand worker pool (`worker-pool.ts`), supervision, and IPC transport (Unix socket). It depends **only on `@openomni/protocol`** — event sink / tool relay / inbound-wait ports are injected by the composition root, and boot recovery lives in `apps/server/src/execution/recovery.ts`. See `packages/coordinator/AGENTS.md` for its module map.
- WorkerRun lifecycle events live under `WorkerRun.Events.*` in `packages/protocol/src/worker-run/index.ts`.
