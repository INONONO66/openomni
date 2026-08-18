# packages/channels

Gateway band, stage 1 (`@openomni/channels`, extracted from `apps/server/src/channel` in #551 — a pure move, zero behavior change). Platform drivers that convert raw transport payloads to/from protocol `Channel` contracts: Discord (gateway + REST), Telegram (polling), GitHub (webhook), WebSocket, plus the channel authn/trigger judgment middleware. The target role is the perimeter gateway of [docs/gateway-design.md](../../docs/gateway-design.md) — router, delivery, and perimeter store semantics arrive at stage 2 (#707); today this package is drivers + authn only. Registration and composition stay in `apps/server` (`bootstrap/channels.ts`): adding a platform = one driver folder here + one registration line there.

## STRUCTURE

```
src/
├── index.ts          # Package barrel — adapters, WebSocketHandler, ChannelAuthnMiddleware, PublishPort
├── types.ts          # PublishPort (injected observation port), ChannelClient, InboundNormalizer
├── channel-authn.ts  # ChannelAuthnMiddleware facade over authn/
├── websocket.ts      # In-process WebSocket surface (token-gated)
├── authn/            # Perimeter judgment: policy-engine decisions, trigger/webhook/upgrade authn
├── discord/          # Discord gateway client + surface (mention-trigger by default)
├── telegram/         # Telegram polling surface
├── github/           # GitHub webhook surface (issue_comment.created, issues.opened)
└── support/          # Band-local helpers: chunk-text, dedupe, fetch-retry/sleep, trigger evaluation
```

## DEPENDENCIES (the band import contract)

Whitelist at stage 1: **{`@openomni/protocol`, `@openomni/ipc`, `@openomni/policy`}** — ledger joins at stage 2 when the perimeter store surfaces move in. The manifest declares only what the band actually imports today (protocol, policy); `ipc` is whitelisted as the driver-band transport contract and joins the manifest when a driver first consumes it (the dead-export ratchet refuses undeclared-use manifest entries). Enforced twice:

- `script/check-deps.ts` — package-level whitelist (manifest **and** source imports), plus the **S8 intra-package banding check**: only `src/authn/` (perimeter judgment) may import `@openomni/policy`; the driver sub-band (`discord/`, `github/`, `telegram/`, `support/`, `websocket.ts`) stays on the dumb-driver contract {protocol, ipc}. Drivers legitimately invoke the authn middleware today — that edge IS the stage-2 seam, cut when authn is promoted to the router band.
- `test/channel-band-boundary.test.ts` — the AST-level scan that traveled with the band move: every import in `src/**` must be a whitelisted package, a node builtin, or relative; policy only under `src/authn/`. Telemetry is NOT allowed — the pre-move allowance was dropped at extraction (trace-id minting lives in protocol; observation goes through the injected `PublishPort`).

No kernel (`@openomni/openomni`), no ledger, no telemetry, no brain imports — both sides meet only in protocol contracts, wired by `apps/server` through injected ports.

## CONTRACT

- Adapters are ingress-agnostic: inbound flows through the injected `onMessage(routingHandler)`; observation flows through the injected `PublishPort` (bound to `Bus.publish` by the composition root, to collectors/noops by tests).
- Normalizers are pure (`InboundNormalizer`): raw payload → `Channel.InboundMessage`, no side effects, no trigger authorization (that is `ChannelAuthnMiddleware`'s job — enforced by `script/lint-guards.ts`).
- Trace ids mint at genuine trace origins only (D11 — gateway events, inbound frames) via protocol's `newTraceId`.
- Surface identity speaks the protocol `Channel.SurfaceKey` codec; this package never routes sessions.

## CONSUMERS

`apps/server/src/bootstrap/channels.ts` (registration/composition root), `apps/server/test/handler/conversation-routing.test.ts` (DiscordNormalizer as a fixture).

## TESTS

`bun test` in this package. `test/channel-band-boundary.test.ts` is the import-contract gate; the rest cover the Discord gateway state machine, GitHub authn/client/normalizer, Telegram/Discord normalizers, trigger authn middleware, and the WebSocket surface. Standalone proof (#551): `cd packages/channels && bun install && bun test && bun run build`.
