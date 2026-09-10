# packages/channels

2026-09-07, #969 Owner answers: `router/request/owner-answer.ts` accepts only the typed gateway arm with injected `authenticateAnswer` evidence. WebSocket `onRequestAnswer` composes with that same `ingest`; credentials never enter message recording or request actions. Upgrade-token authentication and ordinary text provenance remain separate.

2026-09-07, #969 request cutover: `router/request/` owns physical correlation and authenticated responder matching only. `GatewayRouterPorts.requests` injects kernel `list/open/answer/receipt`; channels has no request store, lifecycle fold, control API, or deadline sweep. Original message action ids identify requests. All/quorum, chain precedence, endpoint/channel pins, driver receipts, grants, budgets, and physical idempotency remain gateway responsibilities. `@openomni/agent` is a test-only dependency for real kernel/SQLite acceptance tests.

Gateway band, stage 2 (`@openomni/channels`; drivers and perimeter judgment were consolidated here in #551/#707). This package IS the perimeter gateway of [docs/gateway-design.md](../../docs/gateway-design.md): platform drivers convert raw transport payloads to/from protocol `Channel` contracts, and the router band owns every perimeter judgment — external route resolution (`route.decided` recording), physical request correlation over injected kernel ports, channel/blacklist/actor admission, routed pre-run authority, the surface↔session map claim, and the #215 existing-agent send kernel (with #708 reply-grant instance materialization and the #219 active-egress budget gate). The app brain is reached only through the injected `deliver` port (protocol `Gateway.Deliver`); registration and composition stay in `apps/openomni` (`index.ts` + `channels.ts`): adding a platform = one driver folder here + one registration line there; the new driver gets normal review, but the router's judgment surface needs no re-review because the driver sub-band cannot reach it (S8 banding).

## STRUCTURE

```
src/
├── index.ts          # Package barrel — adapters, WebSocketHandler, router surface
├── types.ts          # PublishPort (injected observation port), ChannelClient, InboundNormalizer
├── websocket.ts      # In-process WebSocket surface (token-gated)
├── authn/            # Perimeter judgment: policy-engine decisions, trigger/webhook/upgrade authn
├── router/           # Gateway router (#707): createGatewayRouter, resolve-route (external arms),
│   │                 #   routing-resolution (route.decided record + replay gate), routing-execution
│   │                 #   (typed request-answer handoff), authority (routed pre-run), actor-resolver,
│   │                 #   raw-fact blacklist matching and channel-grant ranking/default treatment
│   ├── request/      # physical precedence and authenticated responder matcher over injected requests
│   │                 # request state transitions belong to the kernel, never this package
│   └── messaging/    # #215 send kernel: createExistingAgentMessaging, grant evaluation (scope-less + scope-aware
│                     #   arms), #708 reply-grant instance materialization (in-memory by ruling; durable store = #709),
│                     #   #219 social-budget egress gate (pure fold + EgressBudgetStore debits), audit events
├── provider/         # ChannelProvider contract + shipped registry + every shipped driver
│   │                 #   (docs/provisioning-and-providers.md §4): each driver folder exports one
│   │                 #   provider declaring id, ingest mode, credentials/settings zod schemas,
│   │                 #   capabilities (deliver/webhook/render policy), operator preconditions,
│   │                 #   and pure create(); the websocket loopback surface deliberately stays
│   │                 #   outside the registry. Each driver's format.ts is the single source for
│   │                 #   its outbound render policy — the provider declares it, the surface applies it.
│   ├── discord/      # Discord gateway client + surface (mention-trigger by default)
│   ├── telegram/     # Ordered long-poll surface; offset advances only after successful handoff
│   ├── github/       # Webhooks with retryable 5xx failures and delivery-marker comment read-back
│   └── slack/        # Socket Mode surface (two tokens: xoxb- bot + xapp- app-level; ack-before-dispatch,
│                     #   fresh-URL reconnect) with workspace-mandatory TEAM:USER endpoint keys
└── support/          # Band-local helpers: format renderers/chunking, bounded dedupe, fetch retry, trigger evaluation
```

## DEPENDENCIES (the band import contract)

Whitelist at stage 2: **{`@openomni/protocol`, `@openomni/policy`, `@openomni/ledger`}** for `src/` (ipc left the whitelist once no channels source imported it; re-admit only with a real driver consumer) (the manifest may additionally carry `@openomni/agent` for tests only — the llm/agent precedent). `zod` is additionally admitted package-wide: pure schema validation with no I/O and no authority, required because providers declare their credential/settings schemas in-band (§4). Enforced twice:

- `script/check-deps.ts` checks manifest and source imports plus S8 banding. Only `src/router/` and `src/authn/` may import policy/ledger; driver files cannot reach router internals. Allowed ledger names are ActorRegistry, BlacklistStore, ChannelGrantStore, ReplyGrantStore, EgressBudgetStore, SurfaceKey, and LedgerAppend. No standalone lifecycle store or master Storage entry is allowed. The agent dependency is test-only.
- `test/channel-band-boundary.test.ts` — the AST-level scan: every import in `src/**` must be a whitelisted package, a node builtin, or relative; policy/ledger only under the judgment band. Telemetry is NOT allowed anywhere in `src/**` — observation goes through the injected sink (`PublishPort` for drivers, the router's `sink` port).

No app import from this package: both sides meet in protocol contracts (`Gateway.Deliver`, `Gateway.Send*`) plus injected ports.

## CONTRACT

- Providers are the uniform driver contract: `ChannelProvider.create()` is pure construction (no I/O until `surface.start()`), runtime seams (`deliveryRoute`, `webhookHandler`) must match the declared `capabilities`, the provider's own `credentials`/`settings` schemas ARE the validation layer where credentials and knobs enter the system (one enforcement layer — the app's gates call them, never a parallel table), `capabilities.render` is the surface's actual outbound policy (dialect mapping + chunk limit, single-sourced from the driver's `format.ts`), and `preconditions` is the verbatim operator checklist `provision_status` reports — `test/provider-contract.test.ts` enforces all of it and `test/provider-golden.test.ts` freezes each provider's exact normalized inbound shape.
- Adapters are ingress-agnostic: inbound flows through the injected `onMessage(routingHandler)` (bound to the router's `ingest` by the composition root); observation flows through injected sinks.
- The router is constructed ONCE (`createGatewayRouter({ sink, deliver, onPolicyDecision?, messaging? })`) — no post-construction mutation. `ingest` sanitizes gateway-derived fields off the inbound event at the trust boundary (audit A T2: `activation.durableSessionId`, `meta.channelGrant*`; `inboundTreatment` keeps only the harmless `evidence_only` self-downgrade), records `route.decided` before anything acts (record-before-act, #510 C3), mints/claims the resident surface-session label before deliver (S1: the sessionId is an opaque label; session ROWS are brain domain), and never reads session content. A request-correlated routed reply the kernel rejects appends a correcting `route.not_delivered` fact on `route_correction:<scope>:<id>` before the typed rejection returns, so the ledger never claims a delivery that never happened (#743).
- Wire/persisted vocabulary is byte-frozen: `route.decided` stream ids and decision payloads, `route.not_delivered` corrections, `messaging.sent`/`messaging.denied`, archived legacy rows, surface-key rows, egress-budget debit rows.
- GitHub filtered/unsupported deliveries remain successful 200 responses. A handler throw, comment read-back failure, or authenticated comment POST failure returns 500 and releases the in-memory delivery claim so GitHub can retry. A missing GitHub token is different: `postComment()` publishes a warning and returns normally, so the webhook returns 200 without posting a reply. Outbound comments carry the encoded delivery id in a hidden marker; retries read all comment pages first and do not repost when that marker already exists.
- Telegram consumes each returned batch in `update_id` order. Text-message updates are checkpointed only after the awaited `onMessage` handoff succeeds; a failed handoff leaves that update and every later update eligible for retry. Non-text updates require no handoff and are checkpointed in sequence.
- Normalizers are pure (`InboundNormalizer`); trace ids mint at genuine trace origins only (D11) via protocol's `newTraceId`; surface identity speaks the protocol `Channel.SurfaceKey` codec.

## CONSUMERS

`apps/openomni/src/gateway.ts` (router construction + brain wiring), `channels.ts` (driver registration), and `index.ts` (boot recovery and composition); the brain's `message.send` tool reaches the send kernel only through an injected port (never an import).

## TESTS

`bun test` in this package. `test/channel-band-boundary.test.ts` is the import-contract gate; `test/router/` carries the promoted kernel-routing, request correlation, authority, and messaging suites (including real request-kernel/SQLite acceptance; ordinary routing fixtures use injected ports). Driver tests include GitHub retry/read-back dedupe, Telegram offset-after-handoff behavior, and Slack Socket Mode protocol pins (ack-before-dispatch, fresh-URL reconnect, dedupe/forget, workspace-mandatory delivery keys) alongside authn, normalizers, Discord gateway, triggers, and WebSocket coverage. Standalone proof: `cd packages/channels && bun install && bun test && bun run build`.
