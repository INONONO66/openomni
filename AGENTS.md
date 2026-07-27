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
│   ├── session/         # P2 structural ledger: one FULL writer, bounded query/blob, closed synchronous projections, lossy Bus observation
│   ├── llm/             # Provider I/O, Owner credential registry/sanitizer, explicit model environment, derived catalog cache
│   ├── agent/           # ChatAgent core (middleware-driven ReAct loop) + MCP client runtime — depends on session for observability (Bus, TraceContext)
│   │   ├── src/core/           # ChatAgent, budget, retry, policy engine, delegation, telemetry
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

`script/check-deps.ts` currently enforces the checked workspace dependency allowlist against both package manifests and source imports, including the protocol-only coordinator constraint. That is exact enforcement of today's package graph, not proof of the target ring topology; strict inward-only rings and root-barrel import rules are reserved for P3 (#456/#465). Current wiring and enforcement scope live in [`docs/implementation-status.md`](docs/implementation-status.md).

## PACKAGE OWNERSHIP

The package boundary rule is strict: product meaning belongs in `packages/openomni`; lower packages provide primitives. P2-04 is production-wired: OpenOmni owns native transitions and semantic services, session owns the single structural ledger runtime, server is thin host composition, coordinator owns worker process mechanics, and LLM owns credentials/provider behavior/cache. [`docs/implementation-status.md`](docs/implementation-status.md) is the sole shipped-state truth.

| Package | Owns | Must not own |
| --- | --- | --- |
| `packages/protocol` | Zod schemas, wire contracts, event descriptors, storage adapter interfaces | Runtime decisions, routing helpers, authority evaluation, lifecycle orchestration |
| `packages/policy` | Generic policy dispatch, effect composition, middleware registry primitives over protocol contracts | Agent-specific built-ins, OpenOmni authority semantics, session-backed lifecycle decisions |
| `packages/session` | Strict `p2-clean-v1` schema, one lifetime FULL writer, bounded query/blob access, closed synchronous projections/rebuild, lossy Bus | Product transition meaning, routing, authority, lifecycle policy, compatibility/upcast paths |
| `packages/llm` | Provider I/O, read-only Owner credential source, `SecretRegistry`, boundary sanitizer, explicit model environment, derived catalog/cache | Agent/session/workforce routing, policy, authoritative product state |
| `packages/agent` | Stateless ChatAgent loop, agent policy built-ins/facade, tool invocation protocol, generic runtime primitives | OpenOmni durable lifecycle, external actor authority, channel routing |
| `packages/openomni` | Product kernel: messaging/access/orchestration, native transitions, production semantic services under `src/ledger/production/`, evidence admission, effect scope | Provider behavior, raw transport, process supervision, SQLite structure |
| `packages/coordinator` | Isolated worker process execution: spawn/slot/idle/restart/cancel, IPC framing, primitive run delivery | Durable recovery, actor authority, routing, lifecycle meaning |
| `apps/server` | Thin runtime composition: host/transport/process/credential wiring, private Worker provisioning, producer ordering, shutdown | Ledger/kernel lifecycle meaning, second writer, credential/provider ownership, routing/access decisions |

### Messaging Kernel Rule

All communication meaning belongs to an OpenOmni-owned kernel surface. A server adapter normalizes transport input, then the kernel's route resolver determines principal, access, correlation, session, target, and the selected execution path. Resident conversation may remain in-process; only a route that crosses into a Worker or another external/shared effect uses dispatch. Session and coordinator primitives never choose the route. See [`docs/implementation-status.md`](docs/implementation-status.md) for the current implementation paths.

### OpenOmni Internal Split

`packages/openomni` is allowed to be the product kernel, but it should be internally split by ownership:

| Kernel area | Responsibility |
| --- | --- |
| Messaging | Canonical inbound/internal/outbound entry, correlation, target/session resolution, response/writeback routing |
| Access | Principal facts, blocklist/channel access/delegation grant/effective access decisions |
| Orchestration | Resident runtime, Worker orchestration, async scheduling through semantic services |
| Ledger | Native transition meaning, Work/Attempt/Wait, completion/evidence admission, schedule/effect and recovery services |
| Tools | Tool providers, tool executor, workspace lock, injection queue; no high-level lifecycle policy |
| Projection | Interpretation, bounded queries, and distilled writeback over session-owned structural projections |

`ingress/` and `dispatch/` are subordinate kernel stages, not independent product surfaces: route resolution precedes execution-path selection, and dispatch is reserved for Worker delivery or another boundary-crossing effect. Current file-level wiring is catalogued only in [`docs/implementation-status.md`](docs/implementation-status.md).

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add Zod schema / shared type | `packages/protocol/src/{domain}/index.ts` | Cross-package contracts only; runtime logic lives in upper packages |
| Add/modify bus events | `packages/protocol/src/event/index.ts` + `event/agent-execution.ts` | `BusEvent.define()` pattern |
| Add native lifecycle event/operation | `packages/protocol/src/{execution,ledger,wait}/` | Closed schemas; update only with the checked manifest and correct phase ownership |
| Add policy point | `packages/protocol/src/policy/point-registry.ts` | 19 registered points (`session.inbound.pre`, `dispatch.action.pre`, `run.lifecycle/turn/completion/error.*`, `prompt.context.pre`, `connection.llm.pre/post`, `tool.catalog/native/mcp.*`, `delegation.worker.pre/post`, `session.writeback.pre`), each with allowed effects, fail policy, required context. New points must pass the conformance gate (vocab/naming) |
| Agent profile schema | `packages/protocol/src/agent/index.ts` | `AgentProfile.Definition`, `AgentProfile.AgentBudget` |
| Structural ledger runtime | `packages/session/src/ledger/` | One writer, bounded query/blob, closed synchronous projection/rebuild |
| SQLite baseline lifecycle | `packages/session/src/storage/` + `packages/session/migration/0001_p2_clean_baseline/` | Accepts only `p2-clean-v1`; no compatibility import |
| Bus observation | `packages/session/src/bus/` | Lossy process-local observation only; never product state/evidence |
| Native Work/Attempt/Wait contracts | `packages/protocol/src/{work-item,execution,ledger,wait}/` | Runtime meaning is in OpenOmni production services |
| Production semantic services | `packages/openomni/src/ledger/production/` | Work/Attempt/Wait, messaging/access, schedule/effect, connector/artifact, completion, recovery |
| P2 production composition | `apps/server/src/bootstrap/{kernel-services,p2-runtime}.ts` | Thin host binding and sole runtime open/close |
| P2 shipped-state inventory | [`docs/implementation-status.md`](docs/implementation-status.md) | Includes closed 143-operation / 97-event catalog and explicit later-phase exclusions |
| Add LLM provider | `packages/llm/src/provider/provider.ts` + provider-specific auth/transform modules as needed | Register SDK in `getSDK()`; keep provider-specific request/auth behavior out of call sites |
| Provider transforms | `packages/llm/src/transform/` | Message normalization + per-provider variants |
| Token usage / cost | `packages/llm/src/token/` | `TokenTracker.extractUsage`, `calculateCost` |
| Model catalog | `packages/llm/src/model/` | Fetches from models.dev |
| ChatAgent core | `packages/agent/src/core/` | ChatAgent, budget, retry, policy engine, delegation, telemetry |
| Policy engine primitive | `packages/policy/src/` | `PolicyEngine.create()`, `PolicyRegistry.create()`, effect composition |
| Agent policy built-ins | `packages/agent/src/core/policy/` | Agent-scoped facade + built-ins in `builtin/` |
| Agent execution engine | `packages/agent/src/core/execution/` | StreamEngine, ToolExecutor, compaction, parallel-tools |
| MCP client | `packages/agent/src/runtime/mcp/` | McpClient |
| Resident agent prompts | `packages/openomni/src/agents/resident/prompt/` | `ResidentAgent.getPrompt({ model })` — model-specific system prompt variants (Claude, GPT) |
| Messaging kernel | `packages/openomni/src/ingress/` | `resolveRoute` owns inbound meaning and selects Resident, Worker, drop, or ambiguity effects; dispatch is used only by selected Worker/boundary-effect paths. See Implementation Status for exact files and wiring. |
| Doc ↔ code gap tracking | `docs/implementation-status.md` | Single source of truth for implemented / dormant / planned components — check before trusting design docs' present tense |
| Owner-facing usage model | `docs/usage-model.md` | How the system is operated from the Owner's seat (target experience) |
| Principal / actor identity and access | `packages/protocol/src/actor/` + `packages/openomni/src/{ingress,ledger/production}/` | Schemas are lower-level; OpenOmni owns resolution, durable configuration meaning, and access precedence |
| Wait lifecycle and correlation | `packages/protocol/src/wait/` + `packages/openomni/src/ledger/{transitions,reducers}/` + `packages/openomni/src/ledger/production/` | Native durable backing; broader existing-agent semantics remain #215 |
| Coordinator (on-demand workers) | `packages/coordinator/src/worker-manager/worker-pool.ts` | `createWorkerManager(config, ports)` — spawn on demand, idle shutdown, max-active cap; verbs are `deliver`/`send`/`cancel`/`stats` (never `dispatch`), typed failures via `WorkerDeliveryError` codes |
| Coordinator supervision | `packages/coordinator/src/worker-supervision/` | Process supervisor (`WorkerSupervisorOptions` config object; `events` sink required) |
| Coordinator IPC | `packages/coordinator/src/ipc/` | Unix socket transport, request/response framing — wire method names are frozen (Greg Young rule) |
| Boot recovery | `apps/server/src/bootstrap/recovery.ts` + `packages/openomni/src/ledger/production/` | Server orders startup; OpenOmni owns recovery transition meaning |
| Gate-side policy stamping | `packages/openomni/src/policy/resolver.ts` + `dispatch/handlers/worker.ts` | `worker.spawn` stamps a `policyPlan` (default: required `builtin:tool-permission` + `builtin:idle-nudge`) resolved from actor/target labels; custom rules injected at the composition root |
| Conformance gate | `script/lint-tools.ts` + `script/conformance/` | Vocab ratchet, tool lint, naming rules, earned check, Greg Young schema snapshot; runs pre-push + CI. `--self-test` proves discrimination; `--update` regenerates the schema snapshot (the diff is the Owner sign-off surface) |
| Server tool providers | `apps/server/src/tool/` + `packages/openomni/src/execution-runtime/tool/` | Server owns `custom/` and MCP wiring; OpenOmni owns system/agent providers |
| Connector host seams | `apps/server/src/connector/` | Provider-neutral process/credential transport only; installation discovery/UX remains unshipped |
| `dispatch` tool | `packages/openomni/src/execution-runtime/tool/agent/tools/dispatch.ts` | Runtime-to-runtime/system egress command authority and audit boundary |
| Injection queue | `packages/openomni/src/execution-runtime/injection-queue.ts` | Async response delivery at turn.finish; keyed by runId |
| Shipped-state inventory | [`docs/implementation-status.md`](docs/implementation-status.md) | Sole source for wired P2 behavior, derived model/cache behavior, memory status, and later-phase exclusions |
| Server channels | `apps/server/src/channel/` | Discord, Telegram, GitHub, WebSocket |
| Server inbound bridge | `apps/server/src/ingress/` | Transitional adapter bridge; target direction is raw channel message → OpenOmni `MessageEnvelope` only |
| Product model | `docs/core-model.md` + `docs/kernel-contract.md` | Resident, Workers, System Governor, controlled inbound authority |
| Design philosophy | `docs/design-philosophy.md` | Why this project exists and the principles behind its design |

## CONVENTIONS

Operating rules live in this file and the tracked `docs/` — gitignored `*.local.md` files are machine-local exploration scratch and must never be load-bearing for issues, docs, or PRs (2026-07-09 handoff-hardening rule; normative content gets promoted into `docs/kernel-contract.md` / `docs/architecture.md` or pasted into the issue).

Key patterns: Zod-first immutable contracts, ESM, discriminated unions, `BusEvent.define()` for observation, PolicyEngine interception, OpenOmni semantic services for all durable product transitions, and a single session-owned structural writer.

## CODING BOUNDARY RULES

- Do not add product lifecycle meaning to `apps/server`; its `kernel-services.ts` is thin composition only.
- Do not add authority, routing, or transition meaning to `packages/session`; it owns structural append/query/projection/blob mechanics only.
- Do not add OpenOmni-specific durable lifecycle to `packages/agent` or durable recovery to `packages/coordinator`.
- Do not add provider or credential behavior outside `packages/llm`.
- Prefer narrowing public barrels. A symbol exported from a package is a contract; do not export helper stages just for convenience.
- **P2-04 clean break is shipped:** production accepts exactly the fresh `p2-clean-v1` baseline, one lifetime FULL writer, and no legacy import/upcast, compatibility reader, dual/shadow writer, or durability fallback.
- Every authoritative transition/effect intent awaits the writer and its closed synchronous projections before act. `bus.publish` remains best-effort observation only.
- Production lifecycle meaning lives under `packages/openomni/src/ledger/production/`; server composes only structural ports and host dependencies.
- Worker transition/query/provisioning access is authenticated and run-bound. Credential material uses the private provider-scoped channel and requires post-provisioning acknowledgement before execution.
- Resident and Worker execution require the explicit validated model environment and credential binding. Model caches are derived and non-authoritative.
- `workspace-v1` and effect scope describe affected resources; they do not authorize. Every mutating or unknown native consumer must resolve scope and pass kernel policy before act.
- **P2-05–P2-07, C1, P3, and P4 are unshipped.** Verifier/stakes consumers, export/replay qualification, package/ring moves, Jester, Voice, and Governor must not be inferred from P2-04.

## EXECUTION DISCIPLINE

These rules are model-independent and non-negotiable; each has caught a merged-or-nearly-merged defect, including model-catalog drift, namespace-shadowed recursion, stale assertions, and inverted budget sentinels.

1. **Independent adversarial review before merge.** Every nontrivial PR gets a review by a separate agent/session that (a) reads the full diff skeptically, (b) re-runs the suites itself in a scratch worktree, and (c) tries to refute the PR body's claims rather than confirm them. The author's own green run is never sufficient — evidence-over-self-report is a repo law, and it applies to agents' reports about their own work first.
2. **Tests run with an explicit per-test timeout**: `bun test --timeout 15000`. A hang is a finding, not an inconvenience — proper tail calls make infinite self-recursion silent (no stack overflow), and the default run masks it. If the suite doesn't finish in ~1 minute, something is wrong; kill it and bisect.
3. **Verify your own side effects.** After committing, confirm with `git log`/`git status` — lefthook/biome can roll a commit back while printing success-looking output. After any tool claims success, prefer re-observing state (file on disk, PR state via `gh`, CI via checks API) over trusting the tool's report.
4. **Reconcile-first.** Issue bodies and audit findings decay as `main` moves. Before deleting or changing anything an issue claims is true, re-verify the claim on the current tree (zero-consumer grep proof for deletions) and record deltas in the PR body. A claim that turned out false gets corrected in the issue, not silently ignored.
5. **Conformance gate rules of engagement** (`bun run lint:tools`, pre-push + CI): shrinking a baseline in `script/conformance/` is autonomous and encouraged; **growing one requires Owner sign-off in review**. After the P2 fresh baseline, field renames/re-meanings are forbidden: changed meaning requires a new event type/version, with version readers added only for post-baseline evolution. This does not permit a pre-P2 compatibility/upcast bridge. Removals go through `lint-tools --update`, whose diff is the sign-off surface.
6. **Fresh clone/worktree**: run `bun install` and `turbo run build` (protocol `dist/`) before `lint-tools` or tests — otherwise they fail on missing build artifacts, which is not a code defect.
7. **Doc-state sync law**: `docs/implementation-status.md` and the phase issue move in the same PR as the change. An engine without a consumer does not count as shipped; a shipped change that docs still call planned is a defect.

## MODES

The target has one ingress route decision: `resolveRoute` selects the semantic target and execution path. Resident conversation does not cross dispatch; Worker delivery and other cross-boundary effects do. Current mode wiring is recorded only in [`docs/implementation-status.md`](docs/implementation-status.md).

Target direction: only the Resident originates a new Worker allocation. The Owner requests delegation through the Resident and may attach directly to existing actors as root. The Resident has no subagent lane. A Worker cannot spawn another Worker under any trust tier; it may use a same-domain, context-sharing `child_agent`, message an already-existing agent through policy-gated dispatch when granted, or ask the Resident via `resident.ask` to commission independent/cross-domain work. Existing-agent messaging transfers no allocation authority; its awaited form converges on the durable `Wait` contract in [`docs/kernel-contract.md`](docs/kernel-contract.md). Policy remains system-wide across actor profiles and communication boundaries, not Worker-owned.

## PRODUCT MODEL

> Product terminology: **Owner** (root), **Resident** (decides — judgment, no execution), **Worker** (does — internal AI, external AI, humans, even the Owner), **Governor** (fixes — post-hoc structural improvement), **Jester** (doubts — silence-first, seven-lens, and zero-authority). Three-tier vocabulary and role lanes live in [`docs/core-model.md`](docs/core-model.md); authority, Wait, Jester-host, and Governor-access detail lives in [`docs/kernel-contract.md`](docs/kernel-contract.md). These are target contracts; [`docs/implementation-status.md`](docs/implementation-status.md) alone says what is wired.

The normative role and lifecycle definitions live in [`docs/core-model.md`](docs/core-model.md) and [`docs/kernel-contract.md`](docs/kernel-contract.md). For current implementation locations and wired versus planned behavior, use [`docs/implementation-status.md`](docs/implementation-status.md) exclusively.

### Kernel-Centered Message Flow

A channel adapter owns transport normalization only. The OpenOmni kernel resolves identity, authority, correlation, session, target, and execution path. Resident conversation can execute in-process; dispatch is reserved for Worker delivery and other effects that cross actor, session, process, or shared-world boundaries. Lower execution and storage primitives do not decide communication meaning.

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
- `packages/coordinator` owns multiprocess execution: on-demand worker pool, process supervision/restart, and IPC transport. It owns no durable lifecycle meaning; server orders boot while OpenOmni production services own recovery transitions.
- Production execution identity is native Work/Attempt ledger state; no separate run-state store is authoritative.
