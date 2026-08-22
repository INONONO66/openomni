# packages/channels

Gateway band, stage 2 (`@openomni/channels` — drivers extracted from `apps/server/src/channel` in #551; the perimeter router, wait service, and send kernel promoted from `packages/openomni` in #707). This package IS the perimeter gateway of [docs/gateway-design.md](../../docs/gateway-design.md): platform drivers convert raw transport payloads to/from protocol `Channel` contracts, and the router band owns every perimeter judgment — external route resolution (`route.decided` recording), wait correlation and the sole wait-store writes, channel/blacklist/actor admission, routed pre-run authority, the surface↔session map claim, and the #215 existing-agent send kernel (with #708 reply-grant instance materialization and the #219 active-egress budget gate). The brain (`packages/openomni`) is reached only through the injected `deliver` port (protocol `Gateway.Deliver`); registration and composition stay in `apps/server` (`bootstrap/index.ts` + `bootstrap/channels.ts`): adding a platform = one driver folder here + one registration line there, zero security review of the router.

## STRUCTURE

```
src/
├── index.ts          # Package barrel — adapters, WebSocketHandler, ChannelAuthnMiddleware, router surface
├── types.ts          # PublishPort (injected observation port), ChannelClient, InboundNormalizer
├── channel-authn.ts  # ChannelAuthnMiddleware facade over authn/
├── websocket.ts      # In-process WebSocket surface (token-gated)
├── authn/            # Perimeter judgment: policy-engine decisions, trigger/webhook/upgrade authn
├── router/           # Gateway router (#707): createGatewayRouter, resolve-route (external arms),
│   │                 #   routing-resolution (route.decided record + replay gate), routing-execution
│   │                 #   (wait/pending_ask resumption arms), authority (routed pre-run), actor-resolver
│   ├── wait/         # findWaitCandidates, matcher wrapper, WaitService (sole wait-store writer)
│   └── messaging/    # #215 send kernel: createExistingAgentMessaging, grant evaluation (scope-less + scope-aware
│                     #   arms), #708 reply-grant instance materialization (in-memory by ruling; durable store = #709),
│                     #   #219 social-budget egress gate (pure fold + EgressBudgetStore debits), audit events
├── discord/          # Discord gateway client + surface (mention-trigger by default)
├── telegram/         # Telegram polling surface
├── github/           # GitHub webhook surface (issue_comment.created, issues.opened)
└── support/          # Band-local helpers: chunk-text, dedupe, fetch-retry/sleep, trigger evaluation
```

## DEPENDENCIES (the band import contract)

Whitelist at stage 2: **{`@openomni/protocol`, `@openomni/ipc`, `@openomni/policy`, `@openomni/ledger`}** for `src/` (the manifest may additionally carry `@openomni/telemetry` for tests only — the llm/agent precedent). Enforced twice:

- `script/check-deps.ts` — package-level whitelist (manifest **and** source imports), plus the **S8 intra-package banding check**: only the judgment band (`src/router/`, `src/authn/`) may import `@openomni/policy` or `@openomni/ledger`; the driver sub-band (`discord/`, `github/`, `telegram/`, `support/`, `websocket.ts`, `channel-authn.ts`) stays on the dumb-driver contract {protocol, ipc} and may not relative-import into `src/router/`. Router files importing the ledger may name ONLY the perimeter store surfaces (ActorRegistry, BlacklistStore, ChannelGrantStore, WaitStore, SurfaceKey, PendingAskStore, PendingInteractionStore, EgressBudgetStore — the #219 debit ledger, written only by the send kernel) plus the scoped `LedgerAppend` port (append + headFact — never the master `Storage` entry) — brain surfaces (Session, WorkItem*, transcripts, artifacts) are unreachable, and namespace/default imports, wholesale re-exports, dynamic `import()`, and `require()` of the ledger are all refused (the static named clause is the only road).
- `test/channel-band-boundary.test.ts` — the AST-level scan: every import in `src/**` must be a whitelisted package, a node builtin, or relative; policy/ledger only under the judgment band. Telemetry is NOT allowed anywhere in `src/**` — observation goes through the injected sink (`PublishPort` for drivers, the router's `sink` port).

No kernel (`@openomni/openomni`) either way — both sides meet only in protocol contracts (`Gateway.Deliver`, `Gateway.Send*`) plus the ports `apps/server` injects.

## CONTRACT

- Adapters are ingress-agnostic: inbound flows through the injected `onMessage(routingHandler)` (bound to the router's `ingest` by the composition root); observation flows through injected sinks.
- The router is constructed ONCE (`createGatewayRouter({ sink, deliver, onPolicyDecision?, messaging? })`) — no post-construction mutation. `ingest` sanitizes gateway-derived fields off the inbound event at the trust boundary (audit A T2: `activation.durableSessionId`, `meta.channelGrant*`/`pendingAsk`; `inboundTreatment` keeps only the harmless `evidence_only` self-downgrade), records `route.decided` before anything acts (record-before-act, #510 C3), mints/claims the resident surface-session label before deliver (S1: the sessionId is an opaque label; session ROWS are brain domain), and never reads session content. A wait-correlated routed reply the fold rejects appends a correcting `route.not_delivered` fact on `route_correction:<scope>:<id>` before the typed rejection returns, so the ledger never claims a delivery that never happened (#743).
- Wire/persisted vocabulary is byte-frozen: `route.decided` stream ids and decision payloads, `route.not_delivered` corrections, `messaging.sent`/`messaging.denied`, wait rows, surface-key rows, egress-budget debit rows.
- Normalizers are pure (`InboundNormalizer`); trace ids mint at genuine trace origins only (D11) via protocol's `newTraceId`; surface identity speaks the protocol `Channel.SurfaceKey` codec.

## CONSUMERS

`apps/server/src/bootstrap/index.ts` (router construction + brain wiring), `bootstrap/channels.ts` (driver registration), `bootstrap/messaging.ts` (send-seam registry over the router's kernel), `bootstrap/recovery.ts` (WaitService.sweepExpired), `handler/conversation.ts` (router ingest); the brain's `message.send` tool reaches the send kernel only through an injected port (never an import).

## TESTS

`bun test` in this package. `test/channel-band-boundary.test.ts` is the import-contract gate; `test/router/` carries the promoted kernel-routing, wait, authority, and messaging suites (the brain is a deliver-port stub — see `test/router/_router-fixture.ts`); the rest cover the Discord gateway state machine, GitHub authn/client/normalizer, Telegram/Discord normalizers, trigger authn middleware, and the WebSocket surface. Standalone proof: `cd packages/channels && bun install && bun test && bun run build`.
