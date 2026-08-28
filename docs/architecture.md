# Architecture - Core Packages and One App

This document maps [Core Model](core-model.md) onto the post-#792 codebase. [Implementation Status](implementation-status.md) is authoritative for what is wired; [#459](https://github.com/INONONO66/openomni/issues/459) owns delivery ordering.

## Communication

External traffic enters through channel drivers and the channels gateway. The gateway resolves perimeter authority and physical context, records its route decision, then calls the `Gateway.Deliver` port injected by the sole app. Product execution and response rendering stay in the app. Observation uses `Bus.publish`; durable decisions use ledger store/append surfaces.

```text
surface event
  -> packages/channels driver
  -> packages/channels router (block -> wait -> channel -> actor -> surface)
  -> apps/openomni delivery port
  -> Resident / delegation / response
```

The same-domain inline delegation driver is the only deliberate in-process shortcut. Process and channel delegations still pass through durable admission and the single settlement fold.

## Ledger

`packages/ledger` owns the one durable database and typed store surfaces. It stores facts but does not decide product meaning. Perimeter stores are consumed by the channels router; session, delegation, memory-adjacent, and transcript stores are composed by the app. Cross-domain coupling happens through protocol IDs, not direct store reach-through.

`bus.publish` remains observation, not authorization. Record-before-act paths must commit through a durable store or append surface before the external action. The frozen WorkerRun table remains a read-only compatibility surface.

## Policy

`packages/policy` is the generic actor-agnostic engine. `packages/agent` dispatches the loop points it consumes. `packages/channels` owns perimeter policy. `apps/openomni` owns product composition and may select registrations without moving product semantics into the engine.

The old product-specific dispatch registrations and completion service were removed with their only implementation. Their protocol points remain contracts, not proof of a live consumer.

## Package Rings

```text
ring 0  @openomni/protocol        schemas and pure folds
ring 1  @openomni/telemetry       observation
        @openomni/ledger          durable stores
        @openomni/policy          pure policy engine
        @openomni/placement       pure target selection
ring 2  @openomni/llm             model access
        @openomni/ipc             thin transport
ring 3  @openomni/agent           stateless LLM loop

lateral driver/gateway band:
        @openomni/machines        machine attach and cell execution
        @openomni/channels        platform drivers plus perimeter router

composition:
        apps/openomni             the only product app and deployable host
```

Each package depends only on the allowlist in `script/check-deps.ts`. The app composes the rings and bands; it is not another reusable ring.

## Execution Targets and Driver Band

A machine is WHERE execution happens, never WHO is delegated to. `packages/machines` exposes attachment and cell execution over protocol/IPC contracts. `packages/placement` performs the pure capability fold. `apps/openomni` names the selected machine and injects the placement-gated tool door.

Delegation addresses WHO:

- `inline`: same-domain volatile child, awaited in turn;
- `process`: independent local process through the app's process driver;
- `channel`: registered external actor through the gateway send/Wait path.

The removed local worker manager is not part of the final topology. Process delegation in `apps/openomni/src/delegation/` is the live process path.

Band rules:

1. `machines` depends only on protocol and IPC.
2. `channels` driver code depends only on protocol; its judgment sub-band may additionally consume policy and perimeter ledger surfaces.
3. Registration happens in `apps/openomni`.
4. Drivers expose effects behind interfaces and never decide product admission.

## Perimeter Gateway

`packages/channels` owns:

- platform normalization and delivery;
- blacklist/channel/actor admission;
- Wait correlation and lifecycle;
- surface-to-session mapping;
- record-before-delivery route decisions;
- outbound grants and social-budget enforcement.

`apps/openomni` owns:

- Resident context and conduct;
- delegation admission and settlement;
- tool catalog and placement consumption;
- memory and session writeback;
- channel registration and injected gateway ports.

The gateway never reads transcript content. The app does not re-derive platform identity or bypass perimeter decisions.

## Work and Completion Contracts

`WorkItem` schemas and durable ledger surfaces remain core contracts. Terminal completion has one normative authority: current basis plus durable facts, Policy/Stakes/result/Owner authority, and a record-before-terminal admission. Every consumer must inherit it rather than adding a raw ledger completion shortcut. [Implementation Status](implementation-status.md) alone records current consumers.

## Historical Reconciliation

The repository previously split product behavior across a reusable-looking product kernel, a local worker coordinator, and a server host. The 2026-08-23 Owner ruling replaced that end state with one deployable app. PRs through #796 established the clean composition: channel drivers, durable boot, gateway conduct, compaction, machines, delegation transports, and memory. #792 therefore deletes rather than redistributes the old trees.

Historical design decisions still explain the surviving extractions:

- PolicyEngine moved to `packages/policy`.
- Bus moved to `packages/telemetry`; persistence stayed in ledger.
- IPC became the standalone `packages/ipc` transport.
- Channel drivers and perimeter judgment consolidated in `packages/channels`.
- Machine execution became the lateral `packages/machines` band.
- Product composition converged in `apps/openomni`.

Projection/export #766, old dispatch/evidence/effect services, local worker supervision, connector host plumbing, and the old distribution CLI were not ported without a live consumer. They may be re-filed only when the final app earns that behavior.

## Code Conventions

- Shared contracts are Zod-first and live in protocol.
- Decisions are pure functions; effects are injected drivers.
- Durable writes fail closed and occur before external action.
- Package imports use public barrels, never source deep imports.
- Resident, Worker, Governor, Jester, and Voice are roles, not packages.
- New abstractions require a second consumer.
