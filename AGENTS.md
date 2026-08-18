# PROJECT KNOWLEDGE BASE

Last verified against `origin/main`: 2026-08-19 (paths, dependency graph, and shipped-state claims re-checked; keep this stamp current when editing — doc-state sync law).

## OVERVIEW

OpenOmni — a single-Owner Agent OS. Agents earn autonomy through evidence, not self-report. See [Design Philosophy](docs/design-philosophy.md) (one page: three kernel primitives, two laws and a dial, four roles).

The Owner talks to one Resident (a judgment partner that executes nothing), which delegates to Workers (internal agents, external AI, humans — uniformly) through one gate and isolated sessions; everything lands on one ledger. TypeScript monorepo (Bun + Turborepo) with 10 packages and 1 app (Server).

The specification lives in [`docs/core-model.md`](docs/core-model.md) (actors/gate/ledger, roles incl. Governor and Jester, policy hook layer, three-tier vocabulary) and [`docs/architecture.md`](docs/architecture.md) (three communication verbs and package rings). Normative contract detail (guarantee split, authority evaluation, work-item/evidence contracts, Governor rules, memory port) lives in [`docs/kernel-contract.md`](docs/kernel-contract.md). The Owner-directed gateway pivot (channels = perimeter gateway, openomni = brain, SSOT single-ledger storage, engagement machine) is specified in [`docs/gateway-design.md`](docs/gateway-design.md) — a target design; nothing from it is wired yet. ADRs are retired — absorbed into these docs; git history preserves the originals. **Design docs describe targets; `docs/implementation-status.md` is the single source of truth for what is actually wired.**

Live delivery state, ordering, and checkpoints belong only in [GitHub #459](https://github.com/INONONO66/openomni/issues/459). Its milestones group work, dependency links define order, and leaf issues are the executable work; do not copy that inventory into this guide.

## STRUCTURE

```
openomni/
├── apps/
│   └── server/          # Hono server — tool providers, ingress bridge, channel/webhook registration, composition root
├── packages/
│   ├── protocol/        # Shared Zod schemas and cross-package contracts
│   ├── policy/          # Protocol-only policy engine primitive: dispatch, effect composition, registry
│   ├── telemetry/       # The observation channel: Bus pub/sub, trace-owning scoped emitter, span pairing, sink combinators — protocol-only deps (#606)
│   ├── session/         # Session CRUD, Storage adapter (in-memory + SQLite), BusPersistence, Artifact, SurfaceKey, frozen worker-run archive, WorkItemStore (universal work state)
│   ├── llm/             # LLM abstraction: providers, auth (API key + proxy), streaming, retry, token/cost tracking, provider transforms
│   ├── agent/           # ChatAgent core (middleware-driven ReAct loop) + MCP client runtime — depends on telemetry for observation
│   │   ├── src/core/           # ChatAgent, budget, retry, policy engine, memory, delegation, telemetry
│   │   │   ├── execution/      # StreamEngine, ToolExecutor, compaction, parallel-tools
│   │   │   └── policy/         # Agent policy facade + the last builtin (compaction)
│   │   └── src/runtime/        # MCP client runtime
│   │       └── mcp/            # McpClient
│   ├── openomni/        # Product kernel: messaging, access, orchestration, ledger/evidence gates, tools runtime
│   ├── ipc/             # Worker-process IPC transport contract: NDJSON framing, bidirectional Unix-socket client/server, protocol errors — protocol-only deps (#496)
│   ├── coordinator/     # Multiprocess worker driver: on-demand worker pool, supervision — protocol+ipc deps only, ports injected by the composition root
│   └── channels/        # Gateway band (stage 1, #551): Discord/Telegram/GitHub/WebSocket drivers + channel authn — {protocol, ipc, policy} deps, publish port injected
├── turbo.json           # Build pipeline config
└── package.json         # Workspace root (bun@1.3.6)
```

## DEPENDENCY GRAPH

```
protocol  ←  policy, telemetry, ipc          (ring 0 → 1)
telemetry ←  session, llm                     session adds durability
ipc       ←  coordinator                      process driver, session-free
protocol, ipc, policy            ←  channels  gateway drivers + authn (#551)
policy, llm, telemetry           ←  agent     the loop
everything                       ←  openomni  ←  server
```

Read as `X ← Y`: Y may depend on X. Exactly what `script/check-deps.ts`
allows, package by package — the table is the contract, the sketch is a
reading aid. Where a row names two sets, the second is `srcAllowedDeps`: the
package's tests may reach further than its runtime code, and the gate holds
`<pkg>/src/` to the narrower one.

| package | may depend on |
| --- | --- |
| `protocol` | — (leaf) |
| `policy` | protocol |
| `telemetry` | protocol |
| `ipc` | protocol |
| `session` | protocol, telemetry |
| `llm` | protocol, telemetry — `src/` protocol only |
| `coordinator` | protocol, ipc |
| `channels` | protocol, ipc, policy — policy confined to `src/authn/` (S8 banding) |
| `agent` | protocol, policy, llm, telemetry — `src/` protocol, policy, llm |
| `openomni` | any except itself |
| `server` | composition root |

`llm` and `agent` no longer reach the ledger at all: `Bus` moved to `telemetry` and the allowlists closed behind it (#606).

`policy` owns the generic policy engine/effect composition primitive. `telemetry` depends only on protocol and owns the observation channel; it must stay a leaf, because replacing it with no-ops has to leave observed behavior identical — it can never reach for storage or decisions (#606). `agent` owns the loop and must not own OpenOmni product routing. `openomni` is the product kernel that owns messaging, access, and orchestration semantics. `ipc` is the protocol-only worker-process transport contract (#496) — driver-band consumable, never a kernel/ledger/policy import. `coordinator` is session-free since #477: its event sink, tool relay, and inbound-wait ports are injected by the composition root (`apps/server/src/execution/coordinator.ts`). `channels` is the gateway band at stage 1 (#551, [docs/gateway-design.md](docs/gateway-design.md) §1/§9): platform drivers + channel authn, whitelist {protocol, ipc, policy} with policy confined to `src/authn/` by the S8 intra-package banding check (ledger joins at stage 2); it observes through an injected publish port and never imports the kernel or telemetry. `server` is the runtime host app and composition root. Enforced by `script/check-deps.ts` (package.json **and** source imports). See [Architecture](docs/architecture.md) — target rings; current split below.

## PACKAGE OWNERSHIP

The package boundary rule is strict: product meaning belongs in `packages/openomni`; lower packages provide primitives. When adding code, first ask whether the change decides "who talks to whom, under what authority, in which session/run, with what durable lifecycle". If yes, it belongs in `packages/openomni` unless it is a pure schema in `packages/protocol`.

| Package | Owns | Must not own |
| --- | --- | --- |
| `packages/protocol` | Zod schemas, wire contracts, event descriptors, storage adapter interfaces | Runtime decisions, routing helpers, authority evaluation, lifecycle orchestration |
| `packages/policy` | Generic policy dispatch, effect composition, middleware registry primitives over protocol contracts | Agent-specific built-ins, OpenOmni authority semantics, session-backed lifecycle decisions |
| `packages/session` | Durable state substrate: session/message/part CRUD, Bus persistence (the journal writer; `Bus` itself is `packages/telemetry`), storage adapters, indexed record stores | Communication routing, actor trust decisions, worker grant evaluation semantics, pending-reply precedence |
| `packages/llm` | Provider I/O, auth shape, message transforms, token/cost accounting, model catalog | Agent/session/workforce routing, policy, tool execution |
| `packages/agent` | Stateless ChatAgent loop, agent policy built-ins/facade, tool invocation protocol, generic runtime primitives | OpenOmni session-backed worker lifecycle, external actor authority, channel routing, durable background/pending interaction semantics |
| `packages/openomni` | Product kernel: messaging/routing, access control, Resident/Worker orchestration, worker lifecycle backed by session, ledger/evidence gates, tools runtime | Provider SDK behavior, raw channel transport, process supervision internals, storage adapter implementation |
| `packages/ipc` | Worker-process IPC transport: NDJSON framing, bidirectional Unix-socket client/server (reverse server → owner-device connections included), typed transport errors | Kernel/ledger/policy imports, authorization decisions, run semantics, serializable message schemas (those stay in `protocol`) |
| `packages/coordinator` | Isolated worker process execution: spawn/slot/idle/restart/cancel, primitive run delivery, crash recovery | Actor authority, pending interactions, channel/session routing, worker grant policy, IPC transport internals (moved to `packages/ipc` in #496) |
| `packages/channels` | Gateway band (stage 1): Discord/Telegram/GitHub/WebSocket drivers, envelope normalization, channel authn/trigger judgment, delivery clients | Session content, kernel/brain imports, storage engines, telemetry imports (publish port is injected), routing/perimeter store semantics (arrive at stage 2, #707) |
| `apps/server` | Runtime host: config/bootstrap, channel registration, webhook/WebSocket/gateway transport wiring, connector process drivers and stored-installation wiring, server-owned MCP/custom tool wiring | PendingAsk/PendingInteraction lookup, agent/session routing, access decisions, tool selection policy, orchestration semantics, channel adapter implementations (moved to `packages/channels` in #551) |

### Messaging Kernel Rule

All durable messaging should flow through an OpenOmni-owned kernel surface. Target direction:

```
raw channel event
  -> channels gateway driver (packages/channels, registered by apps/server) normalizes transport payload
  -> openomni messaging kernel receives a canonical inbound message/command
  -> kernel resolves principal, access, correlation, session, target, execution path
  -> kernel projects messages/events and returns response/writeback instructions
```

`apps/server` must not decide whether an inbound message is a PendingInteraction/PendingAsk reply versus a normal conversation; it should pass normalized transport facts to `openomni`. `session` may expose indexed lookups such as correlation queries, but match precedence and lifecycle transitions are kernel decisions. `coordinator` may deliver an input frame to a live run, but it must not decide why that run is the target.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add Zod schema / shared type | `packages/protocol/src/{domain}/index.ts` | Cross-package contracts only; runtime logic lives in upper packages |
| Add/modify bus events | legacy families in `packages/protocol/src/event/`; new domains colocate `events.ts` beside their schema (e.g. `packages/protocol/src/wait/events.ts`) | `BusEvent.define()` pattern |
| Add policy point | `packages/protocol/src/policy/point-registry.ts` | 18 registered points (`dispatch.action.pre`, `run.lifecycle/turn/completion/error.*`, `work.complete.pre`, `prompt.context.pre`, `connection.llm.pre/post`, `tool.catalog/native/mcp.*`, `delegation.worker.pre/post`), each with allowed effects, fail policy, required context. New points must pass the conformance gate (vocab/naming) |
| Agent profile schema | `packages/protocol/src/agent/index.ts` | `AgentProfile.Definition`, `AgentProfile.AgentBudget` |
| Session CRUD | `packages/session/src/session/` | Namespace-based API |
| Storage backend | `packages/session/src/storage/` | Implement `Storage.Adapter` (core session/message/part plus optional `artifact`, `eventLog`, `surfaceKey`, `workItem`, `workerRunState`) |
| Bus persistence observer | `packages/session/src/bus-persistence/` | Bus.observe() handler that persists non-ephemeral events to bus_event table |
| Bus query API | `packages/session/src/bus-persistence/query.ts` | BusQuery namespace for reading persisted events |
| Surface → session mapping | `packages/session/src/surface-key/` | N:1 SurfaceKey registry |
| WorkItem schemas + events | `packages/protocol/src/work-item/` | `WorkItem.Info`, `Blocker`, `Evidence`, `Status`, `deriveStatus()`, `generateHash()`, `WorkItem.Events.*`; `index.ts` is the public facade (`VerificationGate` deleted in #498 — zero writers/readers) |
| WorkItem storage interface | `packages/protocol/src/storage/index.ts` | `Storage.WorkItemSubAdapter` (get/create/compareAndSet/list/remove) |
| WorkItemStore substrate | `packages/session/src/work-item/index.ts` | CRUD + non-completion lifecycle + blockers + evidence + dependency readiness + cycle detection; raw `complete()` is a typed refusal because product completion authority belongs in OpenOmni |
| WorkItem completion authority | `packages/openomni/src/work-item/` | Pure durable+proposed fact fold, trusted Policy/Stakes/result/Owner authority resolver, origin projector, atomic record-before-terminal admission service (six-scenario Manual QA driver lives in `packages/openomni/test/harness/`) |
| Windowed Stakes primitive | `packages/openomni/src/ledger/` | Deterministic consequence calculator, criterion treatment, and per-host capability seams (replay driver lives in `packages/openomni/test/harness/`); WorkItem completion now consumes the Stakes resolver seam while authorized Voice remains unwired |
| Worker run records | `packages/session/src/worker-run/` | Direct DB table (worker_run_state), NOT event-sourced |
| Worker-run frozen archive | `packages/session/src/worker-run/state-store.ts` | Session-internal read-only archive of `worker_run_state`; writes throw `worker_run_frozen` (#510 D2b), vocabulary owned here since #498 |
| Add LLM provider | `packages/llm/src/provider/` (`index.ts` + `sdk.ts`) + auth/transform modules as needed | Register SDK in `getSDK()`; keep provider-specific request/auth behavior out of call sites |
| Provider transforms | `packages/llm/src/transform/` | Message normalization + per-provider variants |
| Token usage / cost | `packages/llm/src/token/` | `TokenTracker.extractUsage`, `calculateCost` |
| Model catalog | `packages/llm/src/model/` | Fetches from models.dev |
| ChatAgent core | `packages/agent/src/core/` | ChatAgent, budget, retry, policy engine, memory, delegation, telemetry |
| Policy engine primitive | `packages/policy/src/` | `PolicyEngine.create()`, `PolicyRegistry.create()`, effect composition |
| Agent policy built-ins | `packages/agent/src/core/policy/` | Agent-scoped facade + built-ins in `builtin/` |
| Agent execution engine | `packages/agent/src/core/execution/` | StreamEngine, ToolExecutor, compaction, parallel-tools |
| MCP client | `packages/agent/src/runtime/mcp/` | McpClient |
| Resident agent prompts | `packages/openomni/src/agents/resident/prompt/` | `ResidentAgent.getPrompt({ model })` — model-specific system prompt variants (Claude, GPT) |
| Messaging kernel | `packages/openomni/src/{ingress,dispatch}/` | OpenOmni-owned envelope routing, access evaluation, correlation, session/target resolution, projection (the unified `resolveRoute` pipeline shipped with #464 / PR #485; a `messaging/` facade remains target direction, not yet a directory) |
| Ingress engine | `packages/openomni/src/ingress/` | Shipped inbound stage: kernel `resolveRoute` five-stage pipeline (blacklist → wait correlation → channel ceiling → actor identity → surface default) publishes exactly one `RoutingDecision`, then session resolution/projection → resident/direct handler |
| Resident runtime (in-process) | `packages/openomni/src/resident/` | `ResidentRuntime` — handles resident-target ingress in-process, bypassing coordinator |
| Doc ↔ code gap tracking | `docs/implementation-status.md` | Single source of truth for implemented / dormant / planned components — check before trusting design docs' present tense |
| Owner-facing usage model | `docs/usage-model.md` | How the system is operated from the Owner's seat (target experience) |
| Principal / actor identity | `packages/protocol/src/actor/` + `packages/session/src/actor/` + `packages/openomni/src/ingress/actor-resolver.ts` | Schemas/storage are lower-level; principal resolution and access semantics belong in `openomni` |
| ChannelAccessRule / Blocklist | `packages/protocol/src/actor/` + `packages/session/src/{channel-grant,blacklist}/` | Storage lives in `session`; evaluation and precedence belong in `openomni` access |
| PendingInteraction | `packages/protocol/src/communication/pending-interaction.ts` + `packages/session/src/pending-interaction/` + `packages/openomni/src/dispatch/pending-interaction-routing.ts` | Frozen legacy external-response correlation (#548): the store is read-only (writes throw the typed FrozenError), kernel owns match precedence via the upcast-on-read Wait view, and lifecycle transitions belong to the durable Wait primitive |
| Coordinator (on-demand workers) | `packages/coordinator/src/worker-manager/worker-pool.ts` | `createWorkerManager(config, ports)` — spawn on demand, idle shutdown, max-active cap; verbs are `deliver`/`send`/`cancel`/`stats` (never `dispatch`), typed failures via `WorkerDeliveryError` codes |
| Coordinator supervision | `packages/coordinator/src/worker-supervision/` | Process supervisor (`WorkerSupervisorOptions` config object; `events` sink required) |
| Worker IPC transport | `packages/ipc/src/` | Unix socket transport, request/response framing — wire method names are frozen (Greg Young rule); standalone `@openomni/ipc` since #496, driver-band consumable |
| Boot recovery | `apps/server/src/execution/recovery.ts` | Marks interrupted worker runs after restart (moved out of coordinator in #477; invoked from bootstrap) |
| Gate-side policy stamping | `packages/openomni/src/policy/resolver.ts` + `dispatch/handlers/worker.ts` | `worker.spawn` stamps a `policyPlan` (default: required `builtin:tool-permission` + `builtin:idle-nudge`) resolved from actor/target labels; custom rules injected at the composition root |
| Conformance gate | `script/lint-tools.ts` + `script/conformance/` | Vocab ratchet, tool lint, naming rules, earned check, Greg Young schema snapshot; runs pre-push + CI. `--self-test` proves discrimination; `--update` regenerates the schema snapshot (the diff is the Owner sign-off surface). The coverage and dead-export ratchets (`script/check-coverage-ratchet.ts`, `script/check-dead-exports.ts`) keep their baselines beside the schema snapshot under the same rule: shrinking is autonomous, growing needs Owner sign-off. `knip.json`'s `workspaces` map **overrides** knip's defaults per workspace — it does not select which workspaces are analysed. Every workspace matched by the root `package.json` globs is analysed either way, and an unlisted one gets the default `project` of `**/*.ts`, which is wider than most listed blocks. What the ratchet genuinely does not see is exports reachable from an entry file |
| Server tool providers | `apps/server/src/tool/` + `packages/openomni/src/execution-runtime/tool/` | Server owns `custom/` and MCP wiring; OpenOmni owns system/agent providers |
| Connector host seams | `apps/server/src/connector/` | Current process driver, persisted-installation resolution, question bridge, and read-back; first-party definitions/discovery/registry are absent, while discover/register/consent/smoke-verify remains planned. See `docs/implementation-status.md`. |
| `dispatch` tool | `packages/openomni/src/execution-runtime/tool/agent/tools/dispatch.ts` | Runtime-to-runtime/system egress command authority and audit boundary |
| Injection queue | `packages/openomni/src/execution-runtime/injection-queue.ts` | Async response delivery at turn.finish; keyed by runId |
| CronJob registry | `packages/openomni/src/execution-runtime/cron-job-registry.ts` | Storage-backed cron job registry; populated by Dispatch `schedule.create` |
| Channel drivers | `packages/channels/src/` | Discord, Telegram, GitHub, WebSocket (gateway band stage 1, #551; registered in `apps/server/src/bootstrap/channels.ts`) |
| Server inbound bridge | `apps/server/src/ingress/` | Adapter bridge supplying normalized transport facts only (server-side routing back doors were deleted by #485) |
| Product model | `docs/core-model.md` + `docs/kernel-contract.md` | Resident, Workers, System Governor, controlled inbound authority |
| Design philosophy | `docs/design-philosophy.md` | Why this project exists and the principles behind its design |

## CONVENTIONS

Operating rules live in this file and the tracked `docs/` — gitignored `*.local.md` files are machine-local exploration scratch and must never be load-bearing for issues, docs, or PRs (2026-07-09 handoff-hardening rule; normative content gets promoted into `docs/kernel-contract.md` / `docs/architecture.md` or pasted into the issue).

Key patterns: Namespace exports (`Session.create()`), Zod-first types (`z.object` + `z.infer`), ESM only, discriminated unions, `BusEvent.define()` for events, `PolicyEngine` for agent-loop extension, OpenOmni kernel for messaging/orchestration decisions.

### Module & file structure

These rules exist because the 2026-08 repo-wide audit traced real defects (a dead
policy path kept alive by its own tests, two Discord gateway bugs caused directly by
a satellite split) to violations of each one.

1. **A file is named for what it owns, not for its layer.** Role-noun suffixes that
   could be swapped without changing meaning (`-manager`/`-service`/`-authority`/
   `-boundary`/`-gateway`/`-coordinator`/`-helper`/`-util`) are a confession the seam
   is fake. If two sibling files could trade names, merge them.
2. **Split a module only when one of these is true**: (a) a second consumer exists
   (abstraction is earned by the second consumer, never in advance); (b) a real trust
   boundary separates the halves; (c) the halves have independent lifecycles (one can
   change without the other). "The file is getting long" is not on this list — line
   count is a review signal, never a split criterion.
3. **Sub-30-LOC single-importer files get folded back** into their importer (#453
   hygiene). A file that exists only to break an import cycle the split itself
   created is the same defect — fix the shape instead.
4. **One enforcement layer per invariant per phase.** Pick the owner (zod schema,
   pure fold, service entry, or write time) and delete the other copies.
   Re-validation is legitimate only across a real `await` or a trust boundary —
   in-process re-checking of a value the same factory produced is slop. When deleting
   a duplicated check, name the surviving layer in a comment and keep/add a pinning
   test that fails if that layer regresses (assert the specific reason/error, not
   just "it rejects").
5. **One exported owner per convention.** Digest/canonical-JSON, reason-code strings,
   idempotency keys, event-name literals, error base classes (`NamedError` across
   package boundaries): defined once, imported everywhere. Two spellings of the same
   convention in different packages is a bug seed even while all tests pass.
6. **No smuggled fields, no unreachable fallbacks.** If a consumer needs a field, it
   goes in the schema — never `as`-cast around it. `?? default` where the left side
   cannot be nullish, defensive re-checks of what the type system already guarantees,
   and `default:` branches after an exhaustive `never` check are deletions, not style.
7. **Durable writes fail closed.** A storage seam that silently skips persistence
   when an adapter is absent (warn-and-return) is forbidden; absence of the adapter
   is an error. Optional sub-adapters exist for test fakes only and must never guard
   a production write path.
8. **Test structure mirrors these rules.** One shared fixture builder per package
   (`test/helpers/`), no per-file clones; every invariant is tested at exactly its
   owning layer; no bare `.toThrow()` (assert the message or typed code); no
   parse-echo tests that feed a literal through zod and read the same literal back.
9. **Vocabulary**: forbidden nouns `runtime`, `task`, `envelope` in new protocol/
   kernel surfaces (#497 convergence); reserved single-meaning nouns `Outcome`,
   `CompletionReport`, `Grant`, `Wait`. Korean names are path-level only (driver
   band); exported symbols and protocol nouns stay English.

## CODING BOUNDARY RULES

- Do not add product routing to `apps/server`. Channel code may authenticate transport, dedupe raw deliveries, normalize payloads, and send returned responses. It must not query `PendingAskStore`, `PendingInteractionStore`, `SurfaceKey`, `WaitStore`, `WorkerGrantStore`, `ChannelGrantStore`, `BlacklistStore`, or choose worker/resident targets except through an OpenOmni kernel API.
- Do not add authority decisions to `packages/session`. Store modules may persist records and provide indexed queries; `openomni` decides precedence, trust, grants, and lifecycle transitions.
- Do not add OpenOmni-specific durable lifecycle to `packages/agent`. Session-backed worker/background execution belongs in `packages/openomni`.
- Do not add process semantics to `packages/openomni`; worker process lifecycle and IPC stay in `packages/coordinator`.
- Do not add provider behavior outside `packages/llm`.
- Prefer narrowing public barrels. A symbol exported from a package is a contract; do not export helper stages just for convenience.
- Driver-band packages (approved target: `remote` remote execution, `browser` browser use, `machines` machine handles) may import only `@openomni/protocol` and `@openomni/ipc`; registration happens only in `apps/server`, and each must build/test standalone (repo-extractable). Package names are path-level only — exported symbols, protocol nouns, and LLM tool names stay English. See [Architecture § Execution Targets and the Driver Band](docs/architecture.md).
- `channels` is promoted from driver band to **gateway** (Owner 2026-08-18/19, [docs/gateway-design.md](docs/gateway-design.md)): package whitelist {protocol, ipc, policy, ledger}, with its `drivers/` sub-band held to {protocol, ipc}. Perimeter routing/authority (the resolveRoute pipeline) moves there at gateway stage 2; until then it remains in `packages/openomni`.
- Outbound target selection (which model/machine/driver executes) is the ring-1 `@openomni/placement` pure decision package (approved target); do not grow placement decisions inside kernel dispatch or `apps/server`. Inbound routing (`resolveRoute`) is gateway-owned per docs/gateway-design.md §8.4 (pre-stage-2: still in the kernel).

## EXECUTION DISCIPLINE

These rules are model-independent and non-negotiable; they exist because each one has caught a real merged-or-nearly-merged defect (2026-07-09 alone: a retired-model fallback contradicting its own PR's regenerated catalog, a namespace-shadowed self-recursion spinning at 100% CPU through green typechecks, a stale assertion, and an inverted unlimited-budget sentinel — all found by review, not by the author's green runs).

1. **Independent adversarial review before merge.** Every nontrivial PR gets a review by a separate agent/session that (a) reads the full diff skeptically, (b) re-runs the suites itself in a scratch worktree, and (c) tries to refute the PR body's claims rather than confirm them. The author's own green run is never sufficient — evidence-over-self-report is a repo law, and it applies to agents' reports about their own work first.
2. **Tests run with an explicit per-test timeout**: `bun test --timeout 15000`. A hang is a finding, not an inconvenience — proper tail calls make infinite self-recursion silent (no stack overflow), and the default run masks it. If the suite doesn't finish in ~1 minute, something is wrong; kill it and bisect.
3. **Verify your own side effects.** After committing, confirm with `git log`/`git status` — lefthook/biome can roll a commit back while printing success-looking output. After any tool claims success, prefer re-observing state (file on disk, PR state via `gh`, CI via checks API) over trusting the tool's report.
4. **Reconcile-first.** Issue bodies and audit findings decay as `main` moves. Before deleting or changing anything an issue claims is true, re-verify the claim on the current tree (zero-consumer grep proof for deletions) and record deltas in the PR body. A claim that turned out false gets corrected in the issue, not silently ignored.
5. **Conformance gate rules of engagement** (`bun run lint:tools`, pre-push + CI): shrinking a baseline in `script/conformance/` is autonomous and encouraged; **growing one requires Owner sign-off in review**. Schema evolution: field renames/re-meanings are forbidden — a changed meaning is a new event type, shapes evolve by upcast-on-read; removals go through `lint-tools --update`, whose diff is the sign-off surface.
6. **Fresh clone/worktree**: run `bun install` and `turbo run build` (protocol `dist/`) before `lint-tools` or tests — otherwise they fail on missing build artifacts, which is not a code defect.
7. **Doc-state sync law**: `docs/implementation-status.md` and the applicable leaf issue under [#459](https://github.com/INONONO66/openomni/issues/459) move in the same PR as the change. An engine without a consumer does not count as shipped; a shipped change that docs still call planned is a defect.

## MODES

Ingress supports a single execution mode: `direct`. All inbound events dispatch through `handleDirect` to the coordinator.

Target direction: only the Resident originates a new Worker allocation. The Owner requests delegation through the Resident and may attach directly to existing actors as root. The Resident has no subagent lane. A Worker cannot spawn another Worker under any trust tier; it may use a same-domain, context-sharing `child_agent`, message an already-existing agent through policy-gated dispatch when granted, or ask the Resident via `resident.ask` to commission independent/cross-domain work. Existing-agent messaging transfers no allocation authority; its awaited form converges on the durable `Wait` contract in [`docs/kernel-contract.md`](docs/kernel-contract.md). Policy remains system-wide across actor profiles and communication boundaries, not Worker-owned.

## PRODUCT MODEL

> Product terminology: **Owner** (root), **Resident** (decides — judgment, no execution), **Worker** (does — internal AI, external AI, humans, even the Owner), **Governor** (fixes — post-hoc structural improvement), **Jester** (doubts — silence-first, seven-lens, and zero-authority). Three-tier vocabulary and role lanes live in [`docs/core-model.md`](docs/core-model.md); authority, Wait, Jester-host, and Governor-access detail lives in [`docs/kernel-contract.md`](docs/kernel-contract.md). These are target contracts; [`docs/implementation-status.md`](docs/implementation-status.md) alone says what is wired.

### Subjects

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Owner | The human operator | (No explicit type yet; identified by `ActorIdentity` with `TrustTier: owner`) |
| Resident | Always-on user-facing judgment shell; no subagent lane | Ingress target agent + future Resident-selected policy plan and judgment-only tool catalog |
| Worker | Delegated execution actor (internal AI, external AI, human) | `WorkItem` records plus the legacy `WorkerRun` store and `executorKind`; distinct `WorkItem` attempt records are a target contract |
| Actor | Any external entity that interacts with the system | `ActorIdentity` / `ActorEndpoint` schemas, SQLite `ActorRegistry`, ingress `ActorResolver`, and canonical `trustTier` projection are wired |
| Jester | Silence-first, seven-lens semantic cross-check with no dispatch authority | Target lifecycle is not wired; see `docs/implementation-status.md` |
| System Governor | Read-omniscient/write-minimal post-hoc structural improvement; raw reads stay scoped, audited, and outside user-facing sessions | Policy engine and Bus observers exist; the Governor loop is not wired |

### Lifecycle / authority

| Concept | Meaning | Current hooks |
| --- | --- | --- |
| Self-loop session | Isolated internal work session for complex reasoning | `Session.createChild()`, `WorkerRun` |
| Controlled inbound | Owner and explicitly authorized actors may submit top-level requests; only the Resident may turn a request into a new Worker assignment | `IngressAuthorityMiddleware` + Resident-only `worker.spawn` dispatch policy |
| Worker promotion | Ephemeral worker becomes persistent after repeated value | Future lifecycle schema |
| PendingInteraction | Frozen read-only archive of pre-#548 outbound-request correlation rows | `PendingInteractionStore` (writes frozen #548) and `PendingAskStore` (writes frozen #510 D2a) both answer correlation via upcast-on-read only; new correlation lives in the single `Wait { ownerRef }` primitive (#215) — see kernel-contract §2 |
| ChannelAccessRule (legacy ChannelGrant) | Per-channel access policy and ceiling | `Actor.ChannelGrant` schema + `ChannelGrantStore`; OpenOmni access owns evaluation |
| Blocklist (legacy Blacklist) | Absolute block list checked before all other access evaluation | `Actor.BlacklistEntry` schema + `BlacklistStore`; OpenOmni access owns evaluation |

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

# Quality ratchets + metrics (baselines in script/conformance/; --update rewrites a
# baseline from current state — the diff is the sign-off surface)
bun run script/check-coverage-ratchet.ts   # per-package line-coverage ratchet (reads coverage/lcov.info from prior `bun test --coverage` runs; --update, --self-test)
bun run script/check-dead-exports.ts       # knip dead-export ratchet (--update, --self-test)
bun run script/report-source-metrics.ts    # writes source-metrics.json (no gate; CI artifact)

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
- Worker-run lifecycle is WorkItem attempt facts (`work_item.attempt_*`); the protocol `worker-run` namespace and its telemetry events were retired in #498 (the frozen archive vocabulary lives session-internally in `packages/session/src/worker-run/state-store.ts`).
