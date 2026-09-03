# packages/protocol

Shared type foundation. Zero internal dependencies. All cross-package Zod schemas live here.

Protocol defines schemas plus pure folds — no effects, storage, or I/O. It may describe communication, actor, dispatch, work, IPC, and storage contracts, but it must not decide routing, authority, lifecycle precedence, or execution policy. Product meaning belongs in `apps/openomni`; lower primitive behavior belongs in its owning package.

## STRUCTURE

```
src/
├── index.ts              # Package barrel: all public domains
├── actor/                # Actor.Identity / Endpoint, TrustTier, blacklist schemas
├── app-connector/        # Connector definition, consent, installation, and lifecycle schemas
├── bus/                  # BusEvent.define() + injected BusEvent.Sink contract
├── channel/              # Channel surfaces, messages, config, and surface-key codec
├── cron/                 # Cron job schemas
├── error/                # NamedError factory and shared protocol errors
├── event/                # Ingress, LLM, MCP, operational, policy, and tool descriptors
├── gateway/              # Gateway delivery/send/wait contracts and messaging events
├── ingress/              # Inbound contracts plus payload, route-record, surface-key, and target helpers
├── ipc/                  # Version-2 generic envelopes plus machine wire method schemas
├── ledger/               # Append/adopt/chain contracts and frozen stream payload registry
├── mcp/                  # MCP server config schemas
├── message/              # Message.Part variants, Message.Info, Message.WithParts
├── model/                # Model.Ref and model status
├── policy/               # 18-point registry, contracts, plan, permissions, resources, and effects
├── storage/              # Storage namespace: sub-adapter interface contracts (single file)
├── token/                # Token usage contracts
├── tool/                 # Tool.Spec / Call / Result / State
├── trace/                # TraceContext contract and pure UUID-to-trace-id codec
├── transcript/           # Transcript facts and pure fold
├── wait/                 # Wait schemas, events, matching, and pure folds
```

Namespace additions are gated: `script/lint-tools.ts` (#467) enforces a grandfathered baseline with a no-new-violations ratchet against the core-model Tier-1/2 vocabulary, and the schema-snapshot lint flags field removals/renames (regenerate via `--update` — that diff is the review sign-off surface).

## KEY PATTERNS

- **NamedError factory**: `NamedError.create(name, zodSchema)` produces typed error classes with `.isInstance()` guard, `.toObject()` serialization, and `.Schema` for validation. `ProviderError` (in `@openomni/llm`) uses this.
- **Namespace + Zod duality**: Schemas and types share the same name (e.g., `Tool.State` is both a Zod schema and a TS type). Access schema for validation, type for TS.
- **Discriminated unions**: `Tool.State` on `status`, `Message.Part` on `type`, `Message.Info` on `role`, `Policy.PolicyDecision` on `verdict`, and `Ingress.InboundEvent` on `mode`. `DirectEvent` (`mode: "direct"`) is external inbound; `InternalEvent` (`mode: "internal"`) is system-origin input such as cron. The external `ingest()` path rejects internal events for security. LLM `Run.Outcome` and its streaming `Sink` are owned by `@openomni/llm`, not protocol.
- **Event correlation**: Event descriptors define their own schemas and carry the relevant trace/run/session identity. There is no exported universal `BaseEvent` contract.
- **Policy points**: `policy/policy-point.ts` registers 18 policy points (`dispatch.action.pre`, `run.lifecycle.pre/post`, `run.turn.pre/post`, `run.completion.pre`, `run.error.error`, `prompt.context.pre`, `connection.llm.pre/post`, `tool.catalog.pre`, `tool.native.pre/post`, `tool.mcp.pre/post`, `delegation.worker.pre/post`), each with allowed-effects whitelist, default fail policy (pre-boundary fail-closed, post fail-open), required context, and input schema — contract vocabulary, registry, and per-point input validators live in that one file. Generic agent-loop `run.completion.pre` are distinct points. `Policy.PolicyPlan` is defined in `policy/index.ts`. `Policy.PolicyDecision` verdict is one of `allow | deny | pending`. A legacy `Policy.Timing` alias survives for pre-v2 timing names; do not build new code on it.
- **Storage sub-adapters**: `storage/index.ts` holds the `Storage` namespace of pure interface contracts — no runtime logic. Implementations live in `@openomni/ledger`.
- **IPC contracts**: `ipc/` describes the generic wire envelopes and the machine wire method schemas only. Process delegation lifecycle lives in the product app.
- **AppConnector namespace**: `app-connector/index.ts` defines installed-app connector schema contracts. Runtime install, consent, and process execution live above protocol.
- **Trace contract**: `trace/index.ts` defines `TraceContext` and the pure `traceIdFromUuid()` format codec. Runtime entropy belongs to telemetry or the consuming driver package.

## CONTRACT BOUNDARY

Allowed here:

- Zod schemas and inferred TypeScript types.
- Bus event descriptors via `BusEvent.define()`.
- Storage adapter interfaces.
- Wire/request/response contracts for IPC, ingress, and tools.
- Pure helpers that are strictly schema-local, such as ID/hash formatting or status derivation when no storage/runtime facts are consulted.

Not allowed here:

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


## ANTI-PATTERNS

- Do NOT add effects, storage, or I/O here. Runtime helpers must remain pure folds or schema-local derivations.
- Do NOT import from other `@openomni/*` packages — protocol is the dependency leaf.
- Do NOT add authority or communication-kernel shortcuts here. Add the schema here, then implement semantics in `apps/openomni`.

## WHEN MODIFYING

- Adding a new error? Use `NamedError.create()` in `error/index.ts` and re-export from `src/index.ts`.
- Adding a new event? Use `BusEvent.define()` in the relevant domain and include the identity fields required by that event family.
- Adding a new message part? Add a variant to `Message.Part` in `message/index.ts`.
- Adding a new tool state? Add to `Tool.State` discriminated union in `tool/index.ts`.
- Adding a new policy point? Register it in `policy/policy-point.ts` with a full contract (allowed effects, fail policy, required context, input schema) and coordinate with the engine in `packages/policy` — point additions are protocol vocabulary and ride the #467 gate.
- Adding a new storage sub-adapter interface? Add it as a named interface inside the `Storage` namespace in `storage/index.ts`.
- Adding a new IPC method or field? Update `ipc/` here first, then adapt the machines/openomni callers.
- Adding trace metadata? Update `trace/index.ts`; helper functions stay in `@openomni/ledger`.
- This package builds to `dist/` — run `bun run build` after changes.

_Edited 2026-08-10 per Owner-approved clean-room corpus (local docs/corpus, session record)._

_2026-08-19: gateway stage 0 (#706) landed `gateway/` — `Gateway.Deliver`/`Send`/`WaitControl` contracts, `ReplyGrantRule`, perimeter/conduct trust vocabulary (docs/gateway-design.md §2–§3). `openomni/messaging/schema.ts` re-exports the Send vocabulary from here; grant EVALUATION stays above protocol (contract boundary). Wiring lands at gateway stage 2+._