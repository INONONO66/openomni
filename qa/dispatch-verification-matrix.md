# Communication Dispatch Verification Matrix

Verification record for the communication/dispatch authority update.

## Current scope

- Dispatch is egress command authority only; owner/external inbound and cron fire stay on Ingress.
- Public/model-callable `inbound_message` is removed with no compatibility alias.
- Owner inbound is normalized to Resident target and Resident identity, even when channel metadata hints at a worker.
- Workers ask Resident through awaited `resident.ask`; workers do not directly ask the owner.
- `PendingAsk` and `WorkerGrant` are durable session state with SQLite migration coverage.
- Worker egress other than `resident.ask` requires an active matching `WorkerGrant`; `worker.spawn` is denied by default.

## Commands and results

| Check | Command | Result | Notes |
| --- | --- | --- | --- |
| Diff hygiene | `git diff --check` | PASS | No whitespace errors. |
| Typecheck | `bun run check-types` | PASS | Turbo reported 10/10 successful tasks. |
| Focused dispatch/communication tests | `bun test apps/server/test/execution/worker-runner.test.ts packages/openomni/test/dispatch/runtime.test.ts packages/openomni/test/dispatch/handlers.test.ts packages/session/test/storage/drizzle-db.test.ts packages/session/test/pending-ask/store.test.ts packages/session/test/worker-grant/store.test.ts packages/protocol/test/communication/schema.test.ts apps/server/test/ingress-bridge.test.ts` | PASS | Covers worker `resident.ask`, dispatch policy, handler target checks, migration, durable stores, and bridge normalization/correlation. |
| Full tests | `bun test` | PASS | 2547 pass / 10 skip / 0 fail across 263 files. |
| Public-surface grep | `rg -n "inbound_message|createInboundMessageTool|\\bInboundMessage\\b" ...` | PASS | No model/tool-facing `inbound_message` surface remains; raw `Adapter.InboundMessage` remains only for server channel ingress. |

## Authority assertions

- `apps/server/src/ingress/bridge.ts` maps owner inbound to Resident target and Resident agent metadata.
- `packages/openomni/src/ingress/cron-adapter.ts` continues to fire via internal Ingress, not Dispatch.
- `apps/server/src/execution/worker-runner.ts` exposes worker dispatch as awaited `resident.ask` only.
- `packages/openomni/src/dispatch/policy.ts` fail-closes unknown worker actions, denies `worker.spawn`, and requires `WorkerGrant` for worker scope/external/schedule egress.
- `packages/openomni/src/dispatch/policy.ts` does not trust `target.labels` for manager grant context; manager-constrained grants fail closed until server-owned classification is wired.
- `packages/session/src/worker-grant/index.ts` treats explicit empty scope lists as deny-all, requires manager constraint context, keeps evaluation read-only for expired grants, and exposes explicit `cleanupExpired()` for durable expiration transitions.
- `apps/server/src/ingress/bridge.ts` reads `PendingAskStore.findByCorrelation()` for correlated owner replies, scopes weak message/thread identifiers by endpoint/channel, marks conflicting hints ambiguous, and attaches matched ask metadata for Resident mediation.

## Watch items

- External actor reply execution paths are still future integration work; when implemented, add an end-to-end test proving external replies enter as result data rather than instructions.
- Broad worker egress from a worker process remains intentionally narrow today. If grant-authorized non-Resident egress is exposed to workers later, route it through the server authority rather than adding worker-local handlers.
