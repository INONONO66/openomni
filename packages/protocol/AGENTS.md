# packages/protocol

Shared type foundation. Zero internal dependencies. All cross-package Zod schemas live here.

Protocol defines schemas plus pure folds — no effects, storage, or I/O. It may describe communication, actor, dispatch, work, IPC, and storage contracts, but it must not decide routing, authority, lifecycle precedence, or execution policy. Product meaning belongs in `apps/openomni`; lower primitive behavior belongs in its owning package.

## STRUCTURE

```
src/
├── index.ts              # Package barrel: all public domains
├── actor/                # Actor.Identity / Endpoint, TrustTier, blacklist schemas
├── app-connector/        # Connector definition, consent, installation, and lifecycle schemas
├── artifact/             # Artifact.Meta (positive version and non-empty mimeType/createdAt)
├── bus/                  # BusEvent.define() + injected BusEvent.Sink contract
├── channel/              # Channel surfaces, messages, config, and surface-key codec
├── command/              # Command request/result schemas
├── communication/        # PendingAsk and PendingInteraction legacy contracts
├── cron/                 # Cron job schemas and event descriptors
├── engagement/           # Engagement schemas, events, and pure transition fold
├── error/                # NamedError factory and shared protocol errors
├── event/                # Ingress, LLM, MCP, operational, policy, tool, and worker-driver descriptors
├── execution/            # Execution.Request / Result and Driver contracts
├── gateway/              # Gateway delivery/send/wait contracts and messaging events
├── ingress/              # Inbound contracts plus payload, route-record, surface-key, and target helpers
├── ipc/                  # Version-2 generic envelopes plus current method parameter/result schemas
├── ledger/               # Append/adopt/chain contracts and frozen stream payload registry
├── mcp/                  # MCP server config schemas
├── message/              # Message.Part variants, Message.Info, Message.WithParts
├── model/                # Model.Ref and model status
├── policy/               # 18-point registry, contracts, plan, permissions, resources, and effects
├── storage/              # Storage.WorkItemSubAdapter interface
├── token/                # Token usage contracts
├── tool/                 # Tool.Spec / Call / Result / State
├── trace/                # TraceContext schema and newTraceId()
├── transcript/           # Transcript facts and pure fold
├── wait/                 # Wait schemas, events, matching/upcasts, and pure folds
├── work-item/            # WorkItem schemas, attempt identity, completion admission, events, status, and linkage
└── worker-bootstrap/     # Worker bootstrap payload contracts
```

Namespace additions are gated: `script/lint-tools.ts` (#467) enforces a grandfathered baseline with a no-new-violations ratchet against the core-model Tier-1/2 vocabulary, and the schema-snapshot lint flags field removals/renames (regenerate via `--update` — that diff is the review sign-off surface).

## KEY PATTERNS

- **NamedError factory**: `NamedError.create(name, zodSchema)` produces typed error classes with `.isInstance()` guard, `.toObject()` serialization, and `.Schema` for validation. `ProviderError` (in `@openomni/llm`) uses this.
- **Namespace + Zod duality**: Schemas and types share the same name (e.g., `Tool.State` is both a Zod schema and a TS type). Access schema for validation, type for TS.
- **Discriminated unions**: `Tool.State` on `status`, `Message.Part` on `type`, `Message.Info` on `role`, `Policy.PolicyDecision` on `verdict`, and `Ingress.InboundEvent` on `mode`. `DirectEvent` (`mode: "direct"`) is external inbound; `InternalEvent` (`mode: "internal"`) is system-origin input such as cron. The external `ingest()` path rejects internal events for security. LLM `Run.Outcome` and its streaming `Sink` are owned by `@openomni/llm`, not protocol.
- **Event correlation**: Event descriptors define their own schemas and carry the relevant trace/run/session identity. There is no exported universal `BaseEvent` contract.
- **Policy points**: `policy/point-registry.ts` registers 18 policy points (`dispatch.action.pre`, `run.lifecycle.pre/post`, `run.turn.pre/post`, `run.completion.pre`, `run.error.error`, `work.complete.pre`, `prompt.context.pre`, `connection.llm.pre/post`, `tool.catalog.pre`, `tool.native.pre/post`, `tool.mcp.pre/post`, `delegation.worker.pre/post`), each with allowed-effects whitelist, default fail policy (pre-boundary fail-closed, post fail-open), required context, and input schema (`point-contract.ts`). Generic agent-loop `run.completion.pre` and WorkItem contract-closing `work.complete.pre` are distinct points. `Policy.PolicyPlan` is defined in `policy/index.ts`. `Policy.PolicyDecision` verdict is one of `allow | deny | pending`. A legacy `Policy.Timing` alias survives for pre-v2 timing names; do not build new code on it.
- **Storage sub-adapters**: `Storage.WorkItemSubAdapter` in `storage/index.ts` — pure interface contract with no runtime logic. Implementation lives in `@openomni/ledger`.
- **WorkItem namespace**: `work-item/index.ts` is the public facade. `work-item/schemas.ts` defines `WorkItem.Info`; `attempt.ts` owns attempt, fingerprint, cache/replay key, and nondeterminism contracts; `completion-admission.ts` defines stable criteria, claims, observations, requests, admissions, and terminal receipts. Rows parse through `WorkItem.Info` directly. `work-item/events.ts` preserves the shipped `Completed` meaning and carries distinct request/admission/CompletedV2 descriptors; `status.ts`, `hash.ts`, and `terminal-linkage.ts` own pure lifecycle derivation and linkage validation.
- **Execution/IPC contracts**: `execution/`, `ipc/`, and `worker-bootstrap/` describe worker requests, responses, and bootstrap payloads only. Process delegation lifecycle lives in the product app.
- **AppConnector namespace**: `app-connector/index.ts` defines installed-app connector schema contracts. Runtime install, consent, and process execution live above protocol.
- **Trace contract**: `trace/index.ts` defines `TraceContext` and the shared `newTraceId()` origin helper.

## CONTRACT BOUNDARY

Allowed here:

- Zod schemas and inferred TypeScript types.
- Bus event descriptors via `BusEvent.define()`.
- Storage adapter interfaces.
- Wire/request/response contracts for IPC, execution, ingress, dispatch, and tools.
- Pure helpers that are strictly schema-local, such as ID/hash formatting or status derivation when no storage/runtime facts are consulted.

Not allowed here:

- PendingInteraction/PendingAsk match precedence.
- Actor trust, channel grant, or blacklist evaluation.
- Session or target resolution.
- Dispatch/ingress handler routing.
- Provider behavior, process supervision, storage implementation, or agent-loop execution.

If a helper needs data from stores, runtime context, channel facts, or policy decisions, it does not belong in protocol.

## FUTURE PRODUCT MODEL CONTRACTS

The product model is documented in `docs/core-model.md`. Future schemas should live here when they become implementation work:

- Resident/Worker profile and lifecycle contracts;
- inbound authority / actor role contracts;
- self-loop session metadata;
- distilled writeback records;
- memory candidate records for Anamnesis ingestion.

Keep these as protocol contracts only. Runtime policy and storage implementations belong in upper packages.

Future WorkItem-attempt and Jester-evaluation shapes are contracts only: they add no behavior, dispatch authority, scheduling, or durable lifecycle to this package. They must extend the canonical existing namespaces rather than introduce a new Tier-2 noun; runtime meaning remains with the kernel and its host. See the [kernel contract](../../docs/kernel-contract.md) for the normative attempt and Jester lifecycle.

## ANTI-PATTERNS

- Do NOT add effects, storage, or I/O here. Runtime helpers must remain pure folds or schema-local derivations.
- Do NOT import from other `@openomni/*` packages — protocol is the dependency leaf.
- Do NOT add authority or communication-kernel shortcuts here. Add the schema here, then implement semantics in `apps/openomni`.

## WHEN MODIFYING

- Adding a new error? Use `NamedError.create()` in `error/index.ts` and re-export from `src/index.ts`.
- Adding a new event? Use `BusEvent.define()` in the relevant domain and include the identity fields required by that event family.
- Adding a new message part? Add a variant to `Message.Part` in `message/index.ts`.
- Adding a new tool state? Add to `Tool.State` discriminated union in `tool/index.ts`.
- Adding a new policy point? Register it in `policy/point-registry.ts` with a full contract (allowed effects, fail policy, required context, input schema) and coordinate with the engine in `packages/policy` — point additions are protocol vocabulary and ride the #467 gate.
- Adding a new storage sub-adapter interface? Add it to `storage/index.ts` as a named interface under the `Storage` namespace.
- Adding a work-item field? Update `WorkItem.Info` in `work-item/schemas.ts`. If it affects status derivation, update `deriveStatus()` in `work-item/status.ts`.
- Adding a work-item event? Extend `WorkItem.Events` in `work-item/events.ts` with a `BusEvent.define()` call.
- Adding a new worker request or IPC field? Update `execution/`, `ipc/`, or `worker-bootstrap/` here first, then adapt coordinator/openomni/server callers.
- Adding trace metadata? Update `trace/index.ts`; helper functions stay in `@openomni/ledger`.
- This package builds to `dist/` — run `bun run build` after changes.

_Edited 2026-08-10 per Owner-approved clean-room corpus (local docs/corpus, session record)._

_2026-08-19: gateway stage 0 (#706) landed `gateway/` — `Gateway.Deliver`/`Send`/`WaitControl` contracts, `ReplyGrantRule`, perimeter/conduct trust vocabulary (docs/gateway-design.md §2–§3). `openomni/messaging/schema.ts` re-exports the Send vocabulary from here; grant EVALUATION stays above protocol (contract boundary). Wiring lands at gateway stage 2+._

_2026-08-19: gateway stage 4 (#709) landed `engagement/` — the durable delegation machine (gateway-design §5): `Engagement.Record`/`Terms`/`State`, the pure `transition`/`expire` fold (legal edges only; a reported term crossing FORCES `awaiting_user_approval` — the fold takes `termCrossed`/`ownerApproved` as input FACTS and never evaluates money, criteria, or dialogue), `Engagement.Events` (`user_audit` transitions), the `engagement:<id>` stream registry entry, and `Wait.Correlation.engagementId` (resumption context only — never a matching key). Tier-2 Owner addition in docs/core-model.md._
