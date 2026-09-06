# Architecture - Core Packages and One App

This document maps [Core Model](core-model.md) onto the post-#792 codebase. [Implementation Status](implementation-status.md) is authoritative for what is wired; [#459](https://github.com/INONONO66/openomni/issues/459) owns delivery ordering.

## Communication

External traffic enters through channel drivers and the channels gateway. The gateway resolves perimeter authority and physical context, records its route decision, then calls the `Gateway.Deliver` port injected by the sole app. Product execution and response rendering stay in the app. Observation is downstream of durable L0 action commits through an injected sink; the volatile bus is observation-only. Durable decisions use ledger store/append surfaces.

```text
surface event
  -> packages/channels driver
  -> packages/channels router (block -> wait -> channel -> actor -> surface)
  -> apps/openomni delivery port
  -> session.prompt() -> durable inbox -> fenced runner -> response
```

Resident and native workers enter the same session machine. The same-domain inline delegation driver remains the only deliberate in-process transport shortcut, but its worker is a normal parent-linked session with its own lease and revision. Process and channel delegations still pass through durable admission and the single settlement fold.

## Ledger

`packages/ledger` owns the one durable database and typed store surfaces. It stores facts but does not decide product meaning. A session's row, action tree, inbox, revision, lease fence, and generation pointers are durable; its live runner/controller is disposable `packages/agent` runtime state. Perimeter stores are consumed by the channels router, while the app composes delegation and session consumers. Cross-domain coupling happens through protocol IDs, not direct store reach-through.

`bus.publish` remains observation, not authorization or persistence. L0 action append commits before its injected observation sink is called. Record-before-act paths must commit through a durable store or append surface before the external action. `session.get()` reads authoritative state without waking a runner; `session.watch()` is at-most-once notification, and a revision gap requires a fresh `get()`.

## Policy

`packages/policy` is the generic actor-agnostic engine. `packages/agent` dispatches the loop points it consumes. `packages/channels` owns perimeter policy. `apps/openomni` owns product composition and may select registrations without moving product semantics into the engine.

The old product-specific dispatch registrations and completion service were removed with their only implementation. Their protocol points remain contracts, not proof of a live consumer.

## Package Rings

```text
ring 0  @openomni/protocol        schemas and pure folds
ring 1  @openomni/agent       observation
        @openomni/ledger          durable stores
        @openomni/policy          pure policy engine
        @openomni/placement       pure target selection
ring 2  @openomni/llm             model access
        @openomni/ipc             thin transport
ring 3  @openomni/agent           generic durable-session mechanics and stateless LLM loop

lateral driver/gateway band:
        @openomni/machines        raw machine WHERE endpoints
        @openomni/codemode        code facade and injected interpreter runner
        @openomni/channels        platform drivers plus perimeter router

composition:
        apps/openomni             the only product app and deployable host
```

Each package depends only on the allowlist in `script/check-deps.ts`. The app composes the rings and bands; it is not another reusable ring.

## Execution Targets and Driver Band

A machine is WHERE execution happens, never WHO is delegated to. `packages/machines` exposes list/get and raw fs/exec/runCode handles over protocol/IPC contracts. `packages/codemode` consumes only the structural machines port and protocol, owning machine object handles and per-tenant interpreters. The composition root injects the returned runner into a machine daemon; the brain facade does not spawn Python. Authorization occurs at kernel `tool.pre` and daemon offered/negotiated capability and export enforcement, not in an app VFS. The retained `run_code` adapter calls `cell.run` once. `openomni machine attach` supplies the production daemon composition.

Delegation addresses WHO:

- `inline`: same-domain volatile child, awaited in turn;
- `process`: independent local process through the app's process driver;
- `channel`: registered external actor through the gateway send/Wait path.

The removed local worker manager is not part of the final topology. Process delegation in `apps/openomni/src/delegation/` is the live process path. Native Resident and worker execution is assembled once behind `@openomni/agent` session handles; app adapters provide role-specific tools, system text, and runner configuration.

Band rules:

1. `machines` depends only on protocol and IPC; `codemode` depends on protocol and the machines port, never the reverse.
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

- Resident and worker role configuration;
- delegation admission and settlement;
- tool definitions and placement consumption;
- channel registration and injected gateway ports.

`packages/agent` owns generic session mechanics over ledger-owned durable facts: `SessionHandleStore` coordination, lease acquisition/heartbeat, durable inbox drain, turn envelopes, generation pinning, crash resume, and registry eviction on hibernation. Product-specific session identity, routing, role configuration, lifecycle policy, and ref-counted executable bindings remain in the app. The app never calls `ChatAgent.create` or rebuilds persisted history at a delivery boundary.

The gateway never reads transcript content. The app does not re-derive platform identity or bypass perimeter decisions.

## Session and Completion Contracts

A native worker is represented by a normal session row with role `worker` and its parent Resident/worker session in `parentId`; there is no WorkItem/Attempt ownership layer. A turn records its intent and pre-minted result ID before runner entry, then seals exactly one `result | interrupted | error` terminal under the current fence. Cross-session terminal delivery remains delegated to the messaging slice; this session layer only establishes durable identity and execution.

## Historical Reconciliation

The repository previously split product behavior across a reusable-looking product kernel, a local worker coordinator, and a server host. The 2026-08-23 Owner ruling replaced that end state with one deployable app. PRs through #796 established the clean composition: channel drivers, durable boot, gateway conduct, compaction, machines, delegation transports, and memory. #792 therefore deletes rather than redistributes the old trees.

Historical design decisions still explain the surviving extractions:

- Policy evaluation lives in `packages/policy` as the row compiler; `@openomni/agent` owns the single executor that applies pre/post verdicts.
- Bus moved to `packages/agent/src/observation` as volatile observation; reverse persistence was removed. L0 observation sink contracts live in protocol.
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
