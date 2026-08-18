# Ingress Module (brain plane)

Brain inbound stage for the OpenOmni kernel since gateway stage 2 (#707). The
external routing plane (the #464 `resolveRoute` pipeline's external arms, wait
correlation, authority middleware, actor resolution) lives in the gateway
router (`packages/channels/src/router/`); this module consumes the router's
deliveries and keeps the internal path. openomni never imports channels — the
seam is the protocol `Gateway.Deliver` contract, wired by `apps/server`.

## Pipeline

Two entries on `createBrainEngine(deps)`:

1. **`deliver(input)`** — the gateway's Deliver consumer. Parses
   `Gateway.Deliver` at the seam (trust but validate shape), resolves the
   resident `AgentDef` through the injected `externalAgentResolver` (the
   perimeter no longer embeds brain material), then:
   - **pending-interaction deliveries** (`decision.pendingInteractionId`) go
     to dispatch work placement (`pending-interaction-delivery.ts`, §8.5) —
     no session, no projection, exactly the pre-flip order;
   - otherwise: coordinator-presence check for worker targets, `Received`
     publish, session resolution — **resident**: lazy materialization of the
     router-minted session label (`IngressSessionResolver.materializeResident`,
     idempotent create-if-absent; a crash between the gateway's map claim and
     deliver converges by re-delivery); **worker**: placement stays brain
     judgment via `IngressSessionResolver.resolve` — then projection
     (`event-projector.ts`) and mode dispatch (`handlers.ts`).
2. **`ingestInternal(event)`** — internal-origin events (cron fire, dispatch
   `resident.ask`) never cross the perimeter. `internal-route.ts` keeps the
   internal arm of the routing fold and its own `route.decided` recording
   path (same fact strings, same `route:<scope>` stream family, same
   record-before-act append discipline as the router's external path).

## Boundary Rules

- Do not add server/channel-specific logic here. Raw transport normalization
  belongs in the gateway drivers; admission/routing judgment belongs in the
  gateway router; execution belongs here.
- Do not re-derive perimeter verdicts: the delivered event carries the routed
  actor/treatment stamps verbatim (S4) — consume, never recompute.
- The internal path's resident surface-session claim (`session-resolver.ts`
  claim loop) is a recorded brain-side write residue on a perimeter surface,
  scoped to internal mode. Do not extend it to external flows.
- Writeback and projection policy belongs in OpenOmni, but low-level message
  persistence still goes through `@openomni/ledger`.

## Session Bridge

`session-bridge.ts` reads session messages into a flat `{ role, content }`
array for `ChatAgent.run()` — it is the S1 reason the session plane stays
brain-side.

## Dependencies

- **Upstream**: `@openomni/protocol` (schemas incl. `Gateway.Deliver`,
  `extractSurfaceKey`, `extractText`), `@openomni/ledger` (storage),
  `@openomni/agent` (ChatAgent)
- **Downstream**: consumed by `apps/server` (bootstrap wires
  `createGatewayRouter({ deliver: brainEngine.deliver, … })`; cron and
  dispatch resident.ask call `ingestInternal` directly)
