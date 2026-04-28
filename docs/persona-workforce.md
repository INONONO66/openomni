# Persona Workforce Direction

OpenOmni is a personal AI workforce infrastructure. The user primarily talks to one persistent Main Persona, and that persona hires, summons, evaluates, promotes, pauses, or retires specialized Sub Personas across domains.

This document describes the product direction. It is not a claim that every capability below is implemented today.

## Product Thesis

OpenOmni is not an agent gateway and not a generic swarm. It is a personal workforce layer with a durable relationship model:

```txt
User
  ↕
Main Persona
  ├─ SNS / Viral Marketing Persona
  ├─ Coding Persona
  ├─ Research Persona
  ├─ Reviewer Persona
  └─ Future domain personas
```

The Main Persona acts as the user's personal assistant and chief-of-staff. It owns the relationship with the user, understands the user's goals and preferences, and decides when to act directly or employ another persona.

The first domain persona is the SNS / Viral Marketing Persona. Coding remains a first-class internal capability because the system must be able to build automations, improve tooling, and operate its own development workflow, but coding is not the first user-facing domain.

## Core Concepts

### Main Persona

The Main Persona is the only default user-facing identity. It may:

- answer simple requests directly;
- delegate work to a Sub Persona;
- submit new work through the inbound pipeline;
- create isolated self-loop sessions for complex reasoning;
- evaluate Sub Persona output before reporting back to the user;
- propose changes to persona behavior, rules, skills, or tone.

The Main Persona must not silently rewrite core system logic. It can evolve personality, rules, routing preferences, and skills within policy boundaries.

### Sub Persona

A Sub Persona is a specialized worker identity. It may perform assigned work and may use explicitly granted tools, but it does not own workforce management.

Normal Sub Personas cannot submit new top-level inbound work. They report results, blockers, and follow-up suggestions back to the Main Persona or the caller that invoked them.

### Direct User Targeting

The user may bypass the Main Persona and target a specific persona directly. Direct targeting is a user authority, not a general agent authority.

Recommended policy:

- default path: user → Main Persona;
- explicit path: user → named persona;
- direct-to-persona work should still be visible to the Main Persona through session lineage, summaries, or event records so the personal assistant does not lose global context.

### Controlled Inbound Authority

OpenOmni has two inbound paths:

```txt
External inbound
  User / surface / API → IngressEngine → target persona

Internal inbound
  Main Persona → inbound.submit → IngressEngine → new work item
```

Only the user, the Main Persona, and explicitly trusted manager personas may create internal inbound work. This prevents unmanaged recursive work creation by ordinary Sub Personas.

## Three-Layer Execution Model

The Main Persona chooses the cheapest sufficient execution layer.

| Layer | Name | Use when | Session behavior |
| --- | --- | --- | --- |
| 1 | Direct | The Main Persona can answer or act without specialist help | Original session only |
| 2 | Delegate | A known Sub Persona can complete the work | Child persona session |
| 3 | Fork | The request needs deeper reasoning, debate, planning, or multi-persona coordination | New isolated self-loop session |

Layer 3 is not just a background task. It is an isolated work session where the Main Persona or domain persona can restate the request, refine intent, summon Sub Personas, review outputs, and return a distilled result to the original session.

The original session should remain a clean relationship and decision record. Internal reasoning, failed attempts, experiments, and worker transcripts belong in child/self-loop sessions.

## Persona Lifecycle

Sub Personas start as ephemeral workers unless they are deliberately defined as persistent personas.

```txt
ephemeral worker
  → repeated useful work
  → persona candidate
  → evaluation
  → approval or policy acceptance
  → persistent persona
```

Suggested lifecycle states:

- `trial` — a temporary worker role is being tested;
- `active` — the persona is available for recurring work;
- `promoted` — the persona has durable identity, rules, and skill history;
- `paused` — the persona should not receive new work until reviewed;
- `retired` — the persona is archived and unavailable by default.

Promotion should consider repeat usage, output adoption rate, correction rate, role stability, and whether the persona has a reusable prompt/rule/skill combination.

## First Domain: SNS / Viral Marketing

The first domain persona should be the SNS / Viral Marketing Persona. It owns strategy and execution support for social content, while the Main Persona remains the user's general assistant.

Responsibilities may include:

- brand voice and account positioning;
- trend and meme scouting;
- content ideas and calendars;
- platform-specific copywriting;
- hooks, CTAs, and campaign experiments;
- performance analysis and follow-up recommendations.

Publishing, commenting, and outbound DMs should begin with approval gates. Drafting, research, planning, and analysis can be more autonomous.

## Memory and Anamnesis

Anamnesis is the intended long-term memory substrate, but OpenOmni should remain memory-ready before depending on the full memory system.

OpenOmni should provide:

- session lineage for original, self-loop, and child persona sessions;
- provenance for who produced a result and why;
- event streams that can later be ingested by Anamnesis;
- memory candidate markers for high-value lessons, preferences, rules, and persona changes.

Raw session history is not the same as memory. Durable behavioral memory should be scoped, attributed, and reviewable. Core logic and safety policy should not be rewritten by memory reflection. Personality, domain rules, tone, skills, and routing preferences may evolve within policy boundaries.

## Competitive Positioning

OpenOmni should not compete primarily on channel breadth or minimal implementation size.

- OpenClaw is positioned around a local-first personal assistant gateway with broad channel and companion-app coverage.
- Hermes Agent is positioned around a growing autonomous agent with memory, skill creation, and learning loops.
- NanoClaw is positioned around a lightweight auditable personal assistant with container isolation.

OpenOmni's distinct position is a memory-ready persona workforce: one Main Persona manages a controlled hierarchy of Sub Personas, isolates internal work from the original user session, and uses session lineage and event records to make delegated work auditable.

## Current Implementation Hooks

Existing primitives that support this direction:

- `IngressEngine` and `SurfaceKey` keep external surfaces attached to stable sessions.
- `Session.createChild()` and `workerMeta` can represent child persona and self-loop lineage.
- `SubagentRuntime` and `BackgroundManager` provide delegated and asynchronous execution foundations.
- `WorkerRun` records execution attempts for child sessions.
- `AgentRegistry` is the current seed of a persona registry.
- `ChatAgentConfig.memory` and memory middleware are the current Anamnesis retrieval attachment point.

Known gaps:

- no explicit `self-loop` session kind;
- no formal inbound authority model;
- no persona lifecycle schema;
- no distilled writeback policy for original sessions;
- no memory reflection lifecycle or Anamnesis write gate;
- no durable registry for dynamically promoted personas.
