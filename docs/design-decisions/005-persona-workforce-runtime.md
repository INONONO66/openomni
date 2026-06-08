# ADR-005: Workforce Runtime Direction

**Status**: Accepted

> Originally titled "Persona Workforce Runtime Direction" and used the terms "Main Persona / Sub Persona". This document has been updated to the canonical product vocabulary — **Resident** (Main Persona) and **Worker** (Sub Persona + external actors). See [Core Model](../core-model.md) and [ADR-009](./009-external-actor-authority-model.md) for the full vocabulary and scenarios.

## Context

OpenOmni previously described itself as an orchestration layer for autonomous multi-agent work. That framing is still technically useful, but it under-specifies the product relationship model.

The intended product is a personal assistant that manages a workforce of specialized actors. The user should not need to choose the right agent for every task. The user should be able to talk to one Resident, and that Resident should decide whether to respond directly, delegate to a Worker, or create an isolated session for deeper work.

At the same time, the system must avoid unmanaged recursive work creation. If every Worker can submit new inbound work, the runtime becomes a swarm with unclear authority, unclear cost control, and polluted session history.

## Decision

OpenOmni will use a single-Resident workforce model:

- The **Resident** is the default user-facing identity and workforce manager.
- **Workers** are delegated execution actors that perform scoped work. They can be internal AI agents, external AI agents, or external humans. See [ADR-009](./009-external-actor-authority-model.md) for how non-internal Workers integrate.
- The **Owner** (the human operator) may target any Worker directly when needed.
- The **Resident** may submit internal inbound work to create new work items, scheduled work, or isolated sessions.
- Normal **Workers** may not submit new top-level inbound work unless explicitly granted manager authority.
- Complex work uses isolated self-loop sessions so the original user session remains a clean relationship and decision record.

The first domain Worker is the SNS / Viral Marketing Worker. Coding remains a first-class internal capability for building automations and improving OpenOmni itself, but it is not the first user-facing domain.

## Rationale

- **Clear user relationship**: The Owner has one default assistant identity (the Resident) instead of needing to operate many agents directly.
- **Controlled autonomy**: Internal inbound authority belongs to the Owner, the Resident, and trusted manager Workers only.
- **Session hygiene**: Original sessions store user-facing decisions and distilled results; internal reasoning and failed attempts live in child/self-loop sessions.
- **Auditable delegation**: Worker lineage, worker runs, and event records can explain who did what and why.
- **Natural growth model**: Temporary Workers can become persistent Workers after repeated useful work, instead of every generated agent becoming permanent by default.
- **Uniform Worker abstraction**: Internal AI, external AI, and external humans are all Workers when delegated work is involved. The `WorkerRun` lifecycle is uniform; only the executor and transport differ (see ADR-009 `executorKind`).

## Consequences

- Protocol needs Worker lifecycle and inbound authority contracts.
- Session metadata distinguishes original, self-loop, and child Worker sessions (see ADR-009 `SessionOwner / SessionOrigin / SessionPurpose`).
- Ingress supports internal submissions from authorized manager Workers while rejecting recursive submissions from ordinary Workers.
- Result integration distinguishes raw Worker transcripts from distilled writeback to the original session.
- Anamnesis integration should use session lineage and provenance rather than treating raw chat history as behavioral memory.

## Non-goals

- This decision does not require immediate implementation of Anamnesis.
- This decision does not make every Worker persistent.
- This decision does not allow Workers to rewrite core orchestration, safety, or permission logic.
- This decision does not make SNS automation fully autonomous; publishing and outbound engagement may still require approval gates.
