# Implementation Status

Single source of truth for current wiring between accepted design and running code. Target semantics live in [Core Model](core-model.md), [Kernel Contract](kernel-contract.md), [Architecture](architecture.md), and [Machines and Delegation](machines-and-delegation.md). Delivery ordering remains in [#459](https://github.com/INONONO66/openomni/issues/459).

**Legend**: implemented and wired | dormant contract | designed, not implemented. Last verified against `origin/main`: 2026-08-28 (`5349950e`).

## Deployed shape

| Component | Status | Code | Notes |
| --- | --- | --- | --- |
| Sole OpenOmni app | implemented and wired | `apps/openomni/` | The only composition root and deployable app. It owns boot/shutdown, Resident chat, channel registration, gateway binding, machine attachment, delegation, code mode, compaction wiring, and curated memory. |
| Channel drivers | implemented and wired | `packages/channels/src/{discord,github,telegram,websocket.ts}`, `apps/openomni/src/channels.ts` | Discord, GitHub, Telegram, and WebSocket drivers are registered by the app. |
| Perimeter gateway | implemented and wired | `packages/channels/src/router/`, `apps/openomni/src/gateway.ts` | Resolves blacklist, Wait correlation, channel ceiling, actor identity, and surface sessions; records route decisions before delivery. The app injects the delivery and observation ports. |
| Resident | implemented and wired | `apps/openomni/src/resident.ts` | Judgment-oriented ChatAgent with evidence-only execution denial, persisted session history, compaction, and a per-session frozen memory snapshot. |
| Session and journal durability | implemented and wired | `packages/ledger/src/`, `apps/openomni/src/index.ts` | SQLite storage, BusPersistence, session expiry, Wait expiry, and delegation recovery are composed at boot. Journal shutdown drains before storage closes. |
| Machine body | implemented and wired | `packages/machines/`, `apps/openomni/src/tools/{machines,run-code}.ts` | Enrollment/offer intersection gates attached-machine capabilities. `kernel.py` cells and the in-cell tool bridge are available through placement-gated tools. |
| Delegation kernel | implemented and wired | `apps/openomni/src/delegation/`, `packages/ledger/src/delegation/` | Durable record-before-act admission, inline/process/channel transports, one settlement fold, deadlines, restart recovery, await/cancel, and Owner-session wake delivery. |
| WorkItem delegation wiring | implemented and wired | `apps/openomni/src/delegation/work-item-linkage.ts`, `apps/openomni/src/work-item/completion.ts`, `apps/openomni/src/tools/work-items.ts` | Every `assign` commissions a WorkItem with an allocated attempt at admission; settlement demotes worker output to unverified Evidence and closes the attempt via `Delegation.settlementToAttemptOutcome` — never auto-completing. The Resident-only `work_items`/`complete_work` tools admit completion solely through verified, evidence-backed criterion judgments under the ledger completion-admission writer. |
| CLI and npm deployment | implemented and wired | `apps/openomni/src/cli/`, `apps/openomni/script/build-npm-package.ts` | `openomni start/onboard/daemon/doctor/logs` with TS-owned launchd and systemd user-unit generation, `~/.openomni/env` loading, a `GET /health` endpoint, and a dependency-free npm staging build (`bun run --cwd apps/openomni build:npm`) whose bundle is boot-tested against real migrations. |
| Curated memory | implemented and wired | `apps/openomni/src/memory/`, `apps/openomni/src/tools/memory.ts` | Bounded system/Owner stores, atomic writes, Resident-only add/replace/remove, snapshot frozen on first session delivery. |
| Agent loop | implemented and wired | `packages/agent/src/core/` | Stateless loop, policy interception, placement gate, retry, budgets, parallel tools, and compaction. Product lifecycle remains outside the package. |
| Policy engine | implemented and wired where consumed | `packages/policy/`, `packages/agent/src/core/policy/` | Generic evaluation and agent-loop points survive. Removed product-specific registration sites are not counted as wired. |
| Drive-loop worker policy | implemented and wired | `apps/openomni/src/delegation/drive-loop.ts`, `apps/openomni/src/delegation/worker-loop.ts` | Assigned native worker runs (inline/process transports) are driven goal-style: continuation cap 8, repetition streak 3, toolless-stall streak 3, live work counts as progress, and a blocked claim is believed only on its third recurrence. Ask/notify runs once; the channel driver is never driven. Attempt terminals record transport-reported usage (tokens, seconds) as visibility only. |
| IPC transport | implemented and wired | `packages/ipc/`, `packages/machines/`, `apps/openomni/src/delegation/process-driver.ts` | Thin bidirectional transport used by machines and process delegation. |

## Durable contracts retained in core packages

| Contract | Status after #792 | Notes |
| --- | --- | --- |
| `Wait` | implemented and wired | Protocol fold, ledger store, gateway correlation, app boot sweep, and channel-delegation resume remain live. |
| `WorkItem` | implemented and wired | Protocol and ledger CRUD/attempt/evidence contracts are consumed by the app's delegation wiring: `assign` is the live WorkItem producer. |
| WorkItem completion authority | implemented and wired | The one-authority, basis-bound, record-before-terminal rules from `kernel-contract.md` are consumed by `apps/openomni/src/work-item/completion.ts` through the ledger completion-admission writer; no ledger shortcut exists. |
| Stakes | contract-inherited, not currently wired | Consequence and escalation semantics remain normative. The deleted calculator/host seam is not claimed as shipped. |
| `effectiveAuthority` | contract-inherited, not currently wired | Multi-axis authority semantics remain documented. Perimeter authority still runs in the channels gateway; the deleted dispatch implementation is gone. |
| Frozen PendingAsk/PendingInteraction rows | read-only compatibility | Protocol upcasts and ledger read validation remain because the gateway Wait correlation still consumes their archived view. No writer is live. #585's surviving read-validation fixes remain in ledger and are not deleted. |
| Frozen WorkerRun rows | read-only compatibility | Ledger archive compatibility remains; no local worker manager writes them. |
| Effect streams | substrate only | Protocol/ledger intent storage remains, but the removed product driver/reconciler and admin surface are not wired. |
| Command stream vocabulary | dormant contract | The protocol stream class remains for compatibility; #792 removes its sole producer. |

## Removed or absorbed with #792

The legacy product kernel, local-process coordinator, and old server host were deleted rather than redistributed. Their product-only suites, conformance fixture, distribution scripts, CI jobs, baselines, and dependency rules were removed in the same change.

| Former capability | Disposition |
| --- | --- |
| Projection/JSONL export from #766 | Deleted with its only implementation per the Owner no-slop ruling; re-fileable if the sole app earns a consumer. |
| Old dispatch, WorkerGrant evaluation, completion service, verifier registry, read-back executors, effect reconciler | Deleted with the old product kernel. Their protocol/ledger contracts survive only where independently consumed or normatively inherited. |
| Local worker pool/supervisor and worker-entry host | Deleted with the local-process coordinator/host. The app's delegation process transport is the live process path. |
| Old CLI/onboard/systemd generator and bundled npm distribution | Deleted with the old host, then re-owned by the sole app in #803: `openomni` CLI, launchd/systemd generation, and npm staging live in `apps/openomni`. The stale `deploy/` bash band and `qa/server-daemon` (both targeting the deleted apps/server) are deleted. |
| Connector process host, question bridge, and product dispatch handlers | Deleted. Connector execution and #216-class installation lifecycle are deferred; schema and ledger installation primitives alone do not count as a consumer. |
| Old cron registry/runner, injection queue, child-agent lane, broad tool providers, server admin/observability routes | Deleted with their only consumers; not reported as available in the sole app. |
| Legacy compaction wrapper/bench | Deleted. The surviving app composes the core agent compaction path directly and has production-shaped tests. |
| Defect #735 | Deleted with its only code path. |
| Defect #585 | Not wholly deleted: its pending-row validation fixes remain in `packages/ledger`; only product-kernel consumers disappeared. |

## Planned, not implemented

- Connector installation/execution beyond retained protocol and storage primitives (#216 class).
- Memory.Engine / FTS5 session search (#220).
- P4 role surfaces (Governor, Jester, Voice).
- Stakes and effective-authority consumers; any such work must inherit their contracts rather than recreating legacy code.
