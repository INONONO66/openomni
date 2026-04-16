# Ingress Module

Single entry point that bridges inbound events to plan/direct execution modes.

## Pipeline

Every inbound event flows through three stages:

1. **Session resolution** (`session-resolver.ts`) — maps surface+workspace+channel to a session via `SurfaceKey` registry. Creates new sessions on first contact; reuses existing ones on repeat.
2. **Event projection** (`event-projector.ts`) — converts the `InboundEvent` into a `UserMessage` + `TextPart` and persists both to the resolved session.
3. **Mode dispatch** (`handlers.ts`) — routes to the correct handler based on `event.mode`:

| Mode     | Handler        | What it does                                                    |
|----------|----------------|-----------------------------------------------------------------|
| `plan`   | `handlePlan`   | Builds goal from session history, calls `PlanAgent.generate()`  |
| `direct` | `handleDirect` | Builds message array, runs a single `ChatAgent`                 |

## Session Bridge

`session-bridge.ts` manages session state per mode:

- **Plan mode**: stores/extracts `Plan` objects using a `__OPENOMNI_PLAN__` prefix convention on `TextPart`. Handles iterative planning by combining previous plans with user feedback.
- **Direct mode**: reads session messages into a flat `{ role, content }` array for `ChatAgent.run()`.

Plan payload normalization (Date revival after JSON round-trip) is imported from `../plan/plan-json`.

## Dependencies

- **Upstream**: `@openomni/protocol` (schemas), `@openomni/session` (storage), `@openomni/agent` (ChatAgent)
- **Sibling**: `../plan/` (PlanAgent, normalizePlanPayload)
- **Downstream**: consumed by `apps/server` (per-message `createMessageHandler` → `IngressEngine.ingest`) and any surface adapter that submits `InboundEvent`s
