# Implementation Status

Single source of truth for the gap between accepted design and running code. Other docs (core-model, AGENTS.md, ADRs) link here instead of restating status inline.

**Legend**: ✅ implemented and wired · 🔌 dormant — built and tested, zero production callers · 🚧 partial · 📋 designed, not implemented · Last verified: **2026-06-12** (update this date when re-auditing).

> Project rule of thumb behind this file: an engine without a consumer does not count as shipped. "Built" and "wired" are tracked separately because the recurring failure mode here is completed schemas/stores that nothing calls.

## Three-layer message flow (ADR-009)

| Component | Status | Code | Notes |
| --- | --- | --- | --- |
| Server channel adapters (Discord/Telegram/GitHub/WS) | ✅ | `apps/server/src/channel/` | Raw → `InboundMessage` |
| IngressEngine (session candidate resolve → project → dispatch) | ✅ | `packages/openomni/src/ingress/engine.ts` | |
| `ActorResolver` / `ActorIdentity` / `ActorEndpoint` / `ActorRegistry` | 📋 | `packages/protocol/src/actor/` (planned) | Zero code. Actor arrives pre-stamped as an untyped `{ role, id, kind }` blob; ingress does **not** resolve identity yet |
| DispatchRuntime (policy authorize → handler routing) | ✅ | `packages/openomni/src/dispatch/runtime.ts` | Actions: `resident.ask`, `worker.spawn/send/resume/cancel`, `schedule.create/cancel` |
| WorkerGrant evaluation | ✅ | `packages/openomni/src/dispatch/policy.ts` | The only authority axis currently evaluated |
| Blacklist | 📋 | — | Checked nowhere |
| ChannelGrant (+ inbound treatment ceiling) | 📋 | — | |
| `TrustTier` enum + evaluation | 📋 | — | Loose string field on `Dispatch.ActorContext`; never evaluated. Ingress authority still string-matches roles |
| `effectiveAuthority` (5-axis intersection) | 📋 | — | |
| `PendingAsk` (transitional) | ✅ | `packages/protocol/src/communication/`, `packages/session/src/pending-ask/` | |
| `PendingInteraction` (successor; correlation routing, follow-up window) | 📋 | — | Not a pure rename of PendingAsk (status enum, `allowedActions`, `workerRunId` coupling all change). No PI-match session override exists in dispatch |
| `executorKind` on WorkerRun (`external_api` / `a2a` / `human_channel`) | 📋 | — | Internal ChatAgent execution only today |
| `local_cli_agent` executor (CLI agents as installed apps) | 📋 | — | ADR-010 §3 — connector philosophy: observe the boundary, don't manage the inside |
| `AppConnector` schema (declarative connector definition = public ABI) | ✅ | `packages/protocol/src/app-connector/` | ADR-010 §3 schema shipped: detect/spawn/logs/question bridge/evidence/requires/profile; install lifecycle and runtime wiring remain pending below |
| Install lifecycle (discover → register → consent → wire → smoke-verify; version-drift re-verification) | 📋 | — | ADR-010 §3 — consent sets the app's permission ceiling; "installed" is itself evidence-gated; drift rides the ADR-012 incident pipeline |
| App question bridge (permission/clarification prompt → `resident.ask`, suspend/resume) | 📋 | — | ADR-010 §3 |
| Native app log ingestion (raw → artifact, key events → journal; liveness for stall detection) | 📋 | — | ADR-010 §3 — also the evidence + RCA + cost source for app work |
| Outbound external actions (`external.ask`, `a2a.ask`, `api.ask`) | 📋 | — | Dispatch tool exposes generic `dispatch` + `resident.ask` only |
| `device.*` world-control dispatch actions (driver in `apps/server/`, handler in registry) | 📋 | — | ADR-010 §6 — atomic world mutations as syscalls, no worker spawn |

## Evidence loop (design-philosophy §1/§3, ADR-010 §4)

| Component | Status | Code | Missing consumer |
| --- | --- | --- | --- |
| WorkItem schemas (`Info`, `Blocker`, `Evidence`, `VerificationGate`, `deriveStatus`) | ✅ | `packages/protocol/src/work-item/` | — |
| `WorkItemStore` (full CRUD + lifecycle + evidence + gates) | ✅ | `packages/session/src/work-item/`, `packages/openomni/src/dispatch/handlers/worker.ts` | Wired consumer: `worker.spawn` requires at least one acceptance criterion, creates/starts a ledger item, returns `workItemHash`, reflects failed/interrupted/cancelled coordinator results, and gates succeeded results on an evidence-backed completion report |
| WorkItem schema deltas (`originSessionId`/`workSessionId` split, `workerRunId`+`executorKind`, `completionReport`, `maxAttempts`, `outcome`) | ✅ | `packages/protocol/src/work-item/` | ADR-011 schema shipped; runtime completion gating is tracked in the row below |
| Completion-report evidence gate (claims → evidence refs; unevidenced = not done) | ✅ | `packages/session/src/work-item/`, `packages/openomni/src/dispatch/handlers/worker.ts` | Deterministic gate: `WorkItemStore.complete()` requires a completion report whose claim evidence IDs resolve to passing ledger evidence; `worker.spawn` succeeded results without a valid evidence-backed report remain blocked instead of completed. Read-back executor work remains pending below |
| ReadBackCheck evidence records + store helper | ✅ | `packages/protocol/src/work-item/`, `packages/session/src/work-item/` | Shipped structured `ReadBackCheck` records for URL fetch, API query, and citation match observations plus `WorkItemStore.addReadBackEvidence()` to persist read-back results as verification evidence |
| Runtime read-back executors (re-fetch URL, re-query API, citation-in-source matching) | 📋 | — | ADR-011 — connector/channel executors must perform the actual external observation and feed `ReadBackCheck` records into the ledger |
| Internal worker retry default + kernel-enforced exhaustion blocker | ✅ | `packages/session/src/work-item/`, `packages/openomni/src/dispatch/handlers/worker.ts` | Internal `worker.spawn` ledger items are tagged `executorKind: internal_chat_agent`, default to `maxAttempts: 3`, and `WorkItemStore.retry()` refuses exhausted items after recording a `waiting_input` escalation blocker. Owner-visible notification / failed-item surfacing remains pending below |
| App manifest retry defaults + human reminder policy + Owner-visible exhaustion escalation | 📋 | — | ADR-011 — CLI apps should inherit per-application manifest defaults; humans are not retried, they need reminder policy under the social budget; exhausted failed items still need an Owner-facing notification or ledger surface |
| Owner adoption signal (`outcome`: adopted/corrected/redone/ignored) | 📋 | — | ADR-011 — Governor's ground truth; also calibrates Resident evaluation leniency |
| Task ledger view ("show open tasks" — the OS's `ps`) | ✅ | `apps/server/src/handler/conversation.ts` | Authenticated local WebSocket chat command returns a capped pending/running/blocked WorkItem diagnostic from `WorkItemStore`; unauthenticated WebSocket and external-channel actor-scoped visibility remain future work because current `WorkItem` / `InboundMessage` schemas have no owner, trust-tier, or channel-grant field; web view also remains future work |
| Bus persistence (hash-chained event journal) | ✅ | `packages/session/src/bus-persistence/` | — |
| `BusQuery` (stats, errors, worker-run history, chain verify) | ✅ | `packages/session/src/bus-persistence/query.ts`, `apps/server/src/server/routes.ts` | Wired consumer: token-protected `GET /observability/sessions/:sessionId/events` returns event stats, redacted error metadata, worker-run history, and hash-chain verification. Governor aggregation remains pending below |
| Token/cost tracking (per call, per message) | ✅ | `packages/llm/src/token/` | Aggregation (per agent/task type, success-rate correlation) absent |
| System Governor (postmortem engine: incident RCA + slow aggregation loop) | 📋 | — | Zero code. v0 scoped in ADR-012: two lanes (immediate / daily batch), storm collapse, triage (defect vs preference→memory candidate) |
| Incident fingerprint registry (cause × task type × failure mode; recurrence ladder) | 📋 | — | ADR-012 — match-before-create dedup discipline |
| Governor autonomy boundary + change journal (tighten autonomous / loosen approval / kernel floor) | 📋 | — | ADR-012 — every applied change journaled with scope tag; rate limits |
| Regression ratchet (canary window + counting-rule rollback → RCA on the change itself) | 📋 | — | ADR-012 — no separate machinery; runs through the same RCA pipeline |
| Fabricated-evidence handling (unresolvable claims → immediate RCA + executor reliability record) | 📋 | — | ADR-012 |
| Memory candidates (`MemoryCandidate` schema + emission from `work_item.completed` / Governor triage / Owner request) | 📋 | — | ADR-013 — prerequisites (lineage, provenance, bus) exist; no candidate emission |
| Built-in curated memory (frozen-snapshot system-prompt injection, bounded budgets, add/replace/remove tool) | 📋 | — | ADR-013 — Hermes pattern; injection via `on_system_prompt` policy timing |
| Session search tool (FTS5 over session store) | 📋 | — | ADR-013 — episodic recall, zero engines required |
| `Memory.Engine` port (ingest/recall/profile/feedback; transport-agnostic; mandatory scope filter) | 📋 | `packages/protocol/src/memory/` (planned) | ADR-013 — Anamnesis is the first plugin, not a dependency |

## Resident model (core-model, ADR-008, ADR-010)

| Component | Status | Code | Notes |
| --- | --- | --- | --- |
| `ResidentRuntime` (in-process, bypasses coordinator for conversation) | ✅ | `packages/openomni/src/resident/runtime.ts`, `ingress/engine.ts` | |
| Resident toolset = judgment-only (shell model) | 📋 | `apps/server/src/ingress/bridge.ts` | **Contradicts core-model today**: Resident currently gets `["filesystem", "execution", "delegation", "mcp", "custom"]` — full read/write/edit/bash. Demotion to read-only + dispatch is ADR-010 step 6 |
| Peek budget (per-turn tool-call cap making delegation structural) | 📋 | — | ADR-010 §6 — reuses existing budget hard-stop; profile config only |
| Mutating MCP/custom tools behind dispatch (read-only may stay direct) | 📋 | — | ADR-010 §6 effect-radius rule; direct attachment today is an unaudited side door |
| Intent classification (direct vs delegate) | 📋 | — | Pure in-context LLM choice; no classifier, no routing data |
| Fork / self-loop sessions | 🔌 | `packages/protocol/src/policy/resource.ts` | `"self-loop"` enum value exists; no code path creates one |
| Distilled writeback (worker output summarized before user session) | 🚧 | `packages/openomni/src/ingress/session-bridge.ts` | Raw worker output written directly by default; `writeback.commit` policy hook exists but optional; hygiene comes from session separation only |
| Cost-based model routing ("expensive thinks, cheap works") | 📋 | `apps/server/src/bootstrap/index.ts` | Single `resolveModel(config)` model for Resident and all workers |

## Runtime substrate (ADR-008 — shipped)

| Component | Status | Code | Notes |
| --- | --- | --- | --- |
| On-demand worker manager (spawn on demand, idle shutdown, max active) | ✅ | `packages/coordinator/src/worker-manager/manager.ts` | Used by `apps/server/src/execution/coordinator.ts` |
| Subagent as bound extension (context-inheriting, ticketless, gate-exempt) | ✅ | `packages/openomni/src/subagent/` | `SubagentRuntime` + `BackgroundManager` — NOT a worker tier; workers are always isolated processes (ADR-010 §6) |
| Extension-vs-independence routing (subagent vs worker choice in Resident flow) | 📋 | — | ADR-010 §6 — "needs my context, or its own footing?"; domain expertise = independence signal |
| Worker supervisor internals | ✅ | `packages/coordinator/src/worker-pool/supervisor.ts` | Shared process supervisor used by `worker-manager`; legacy `createWorkerPool` facade removed |
| SessionRouting helper | ✅ | `packages/coordinator/src/worker-pool/session-routing.ts`, `packages/coordinator/src/worker-manager/manager.ts` | `worker-manager` uses a `SessionRouter` instance for live session-to-slot affinity; singleton `SessionRouting.route/complete` remains test-covered for fixed worker-index routing |
| Crash recovery (mark interrupted at boot) | ✅ | `packages/coordinator/src/recovery/` | |
| Injection queue (async delivery at turn.finish) | ✅ | `packages/openomni/src/execution-runtime/injection-queue.ts` | |
| Cron job registry persistence | ✅ | `packages/openomni/src/execution-runtime/cron-job-registry.ts`, `packages/session/src/storage/sqlite-cron-job-adapter.ts` | `schedule.create` jobs persist in SQLite and survive `Storage` reinitialize; `schedule.cancel` removes persisted jobs |
| Cron firing loop / boot runner | ✅ | `packages/openomni/src/execution-runtime/cron-job-runner.ts`, `apps/server/src/bootstrap/index.ts` | Server boot starts `CronJobRunner`, which reloads stored jobs, initializes missing `nextFireAt`, fires due jobs through `CronAdapter.fire(job)`, emits `cron_job.fired`, and advances the next fire time. Cron grammar is numeric five-field UTC; downtime fires at most once per tick, not once per missed interval |
| Boot-time PendingInteraction restoration | 📋 | — | Depends on PI existing |

## Structural guarantees (kernel surface, ADR-010 §1)

Claims that are actually enforced in code today — docs may say "cannot" only about these:

| Guarantee | Code |
| --- | --- |
| Workers cannot create top-level work (`worker.spawn/cancel/resume/schedule` denied) | `packages/openomni/src/ingress/middleware/ingress-authority.ts` |
| Budget hard-stop ends execution at limits (turns, tool calls, wall time) | `packages/agent/src/core/execution/stream-policy-dispatch.ts` |
| Tool permission is fail-closed | `packages/agent/src/core/policy/builtin/tool-guard.ts` |

Everything else behavior-shaping (delegation judgment, session hygiene, evidence-over-self-report, tool restraint) is currently **prompt convention** (`packages/openomni/src/agents/resident/prompt/`), i.e. userland.

## Known schema/doc debt

| Item | Action |
| --- | --- |
| `AgentProfile.Definition.permissions` is defined but ignored at runtime (warning + `policyPlan` supersedes) | Remove the field or wire it; a schema field that lies violates ADR-002's intent |
| `docs/vision.local.md` (v0.2) predates single-mode ingress and current package layout | Refresh or mark archived |
| `docs/persona-runtime-roadmap.local.md` uses pre-ADR-009 vocabulary (Main/Sub Persona) | Re-vocabulary or fold into ADR-010 ordering |

## Maintenance

When a 📋/🔌 item ships, flip it here in the same PR. When adding a new engine, add its **consumer** as a row at the same time — unwired engines must be visible.
