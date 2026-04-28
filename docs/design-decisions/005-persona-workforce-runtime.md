# ADR-005: Persona Workforce Runtime Direction

**Status**: Accepted

## Context

OpenOmni previously described itself as an orchestration layer for autonomous multi-agent work. That framing is still technically useful, but it under-specifies the product relationship model.

The intended product is a personal assistant that manages a workforce of specialized AI personas. The user should not need to choose the right agent for every task. The user should be able to talk to one Main Persona, and that Main Persona should decide whether to respond directly, delegate to a Sub Persona, or create an isolated session for deeper work.

At the same time, the system must avoid unmanaged recursive work creation. If every Sub Persona can submit new inbound work, the runtime becomes a swarm with unclear authority, unclear cost control, and polluted session history.

## Decision

OpenOmni will use a persona workforce model:

- The **Main Persona** is the default user-facing identity and workforce manager.
- **Sub Personas** are specialized worker identities that perform delegated domain work.
- The **user** may target any persona directly.
- The **Main Persona** may submit internal inbound work to create new work items, scheduled work, or isolated sessions.
- Normal **Sub Personas** may not submit new top-level inbound work unless explicitly granted manager authority.
- Complex work uses isolated self-loop sessions so the original user session remains a clean relationship and decision record.

The first domain persona is the SNS / Viral Marketing Persona. Coding remains a first-class internal capability for building automations and improving OpenOmni itself, but it is not the first user-facing domain.

## Rationale

- **Clear user relationship**: The user has one default assistant identity instead of needing to operate many agents directly.
- **Controlled autonomy**: Internal inbound authority belongs to the user, the Main Persona, and trusted manager personas only.
- **Session hygiene**: Original sessions store user-facing decisions and distilled results; internal reasoning and failed attempts live in child/self-loop sessions.
- **Auditable delegation**: Persona lineage, worker runs, and event records can explain who did what and why.
- **Natural growth model**: Temporary workers can become persistent personas after repeated useful work, instead of every generated agent becoming permanent by default.

## Consequences

- Protocol will eventually need persona lifecycle and inbound authority contracts.
- Session metadata will need to distinguish original, self-loop, and child persona sessions.
- Ingress should support internal submissions from authorized manager personas while rejecting recursive submissions from ordinary workers.
- Result integration should distinguish raw worker transcripts from distilled writeback to the original session.
- Anamnesis integration should use session lineage and provenance rather than treating raw chat history as behavioral memory.

## Non-goals

- This decision does not require immediate implementation of Anamnesis.
- This decision does not make every Sub Persona persistent.
- This decision does not allow personas to rewrite core orchestration, safety, or permission logic.
- This decision does not make SNS automation fully autonomous; publishing and outbound engagement may still require approval gates.
