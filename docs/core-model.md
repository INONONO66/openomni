# Core Model

OpenOmni's product model is built around a small number of durable concepts: a single always-on assistant that owns the user relationship, a uniform class of delegated actors that do the actual work, and a separate structural layer that improves the system over time. This document describes how those pieces fit together.

## The Resident

The Resident is the only default user-facing identity. It's always on, always reachable, and owns the relationship with the user across sessions. It understands the user's goals, preferences, and context well enough to decide what to do next without asking for clarification every time.

The Resident's job is judgment, not execution. When a request arrives, it picks the cheapest sufficient response: answer directly, hand the work to a Worker, or open an isolated session for deeper reasoning. It evaluates what comes back and decides what to surface to the user.

The Resident does not do meta-work. It doesn't rewrite its own rules, restructure its own skills, or adjust system policy. That's the System Governor's job. The Resident can propose changes, but it cannot enact them unilaterally.

## Workers

Workers are everything that isn't the Resident. That includes internal AI agents, external tools like OpenCode or Claude Code, and humans acting in a defined role. The Resident treats them all the same way: as execution actors that can be called when needed and whose output must be evaluated before it reaches the user.

Workers are like applications. They're invoked for a purpose, they return a result, and they don't own the conversation. A Worker may use the tools it's been explicitly granted, but it doesn't manage other Workers and it doesn't create new top-level work on its own. Normal Workers report results, blockers, and follow-up suggestions back to whoever called them.

This uniformity is intentional. Whether a Worker is a local subprocess, a remote AI agent, or a human contractor, the Resident's interface to it is the same. The complexity of what a Worker does internally doesn't leak into the Resident's decision layer.

## System Governor

The System Governor is a separate, low-privilege layer that observes execution records and failures through the event bus, then adjusts Policy and Skills structurally. It doesn't participate in conversations. It doesn't respond to users. It watches what happens and makes the system better at handling similar situations in the future.

This separation matters. The Resident improving itself through reflection is a reliability risk: it conflates judgment with self-modification, and it means the system's behavior can drift in ways that are hard to audit. The Governor keeps those concerns separate. Structural improvements are observable, attributable, and reviewable.

The Governor can update routing preferences, skill definitions, and policy rules. It cannot rewrite core logic or safety constraints.

## Controlled Inbound Authority

All work enters through a single Inbound pipeline. The user can create work. The Resident can create work. Explicitly trusted manager Workers can create work. Normal Workers cannot.

This prevents unmanaged recursive work creation. Without this constraint, a Worker completing one task could spawn arbitrary new tasks, and the system would have no coherent picture of what it's doing or why. The Inbound pipeline is the chokepoint that keeps the work queue legible.

The user can also bypass the Resident and target a specific Worker directly. That's a user authority, not a general agent authority. When it happens, the Resident should still have visibility through session lineage so it doesn't lose global context.

## Execution Layers

The Resident picks the cheapest sufficient layer for each request:

**Direct** — the Resident handles it in the current session. No delegation, no forking. Used when the request is within the Resident's own competence and doesn't require specialist depth.

**Delegate** — the Resident hands the work to a Worker and waits for a result. The Worker runs in its own session. The Resident evaluates the output before deciding what to tell the user.

**Fork** — the Resident opens an isolated self-loop session for complex reasoning, planning, or multi-Worker coordination. This is not just a background task. It's a full work session where the Resident can restate the request, refine intent, summon Workers, review their outputs, and return a distilled result to the original session.

The original user-facing session stays clean. Internal reasoning, failed attempts, experiments, and Worker transcripts belong in child or self-loop sessions. The user sees decisions and results, not process.

## Session Hygiene

The user-facing session is a relationship and decision record, not a work log. Anything that isn't directly useful to the user — intermediate reasoning, Worker transcripts, failed attempts, planning iterations — goes in a child or self-loop session.

This keeps the primary session readable over time. It also makes the system's behavior auditable: you can trace a result back through the session tree to the Worker that produced it and the reasoning that accepted it.

## Worker Lifecycle

Workers start ephemeral. A Worker invoked once for a specific task has no durable identity. If the same Worker proves useful repeatedly, it can be promoted to a persistent Worker with a stable identity, its own rules, and accumulated skills.

The promotion path looks like this:

```
ephemeral invocation
  → repeated useful work
  → candidate for persistence
  → evaluation (usage rate, output adoption, correction rate, role stability)
  → persistent Worker with durable identity, rules, and skill history
```

Promotion is not automatic. It requires evidence of repeated value and a stable, reusable role definition. A Worker can also be paused or retired if its role becomes redundant or its output quality degrades.

## Memory Readiness

OpenOmni is designed to integrate with a long-term memory system (Anamnesis), but it doesn't depend on that system being present. The structural prerequisites are already in place:

- session lineage connects original sessions, self-loop sessions, and child Worker sessions;
- provenance records who produced a result and under what conditions;
- the event bus produces streams that a memory system can ingest;
- high-value outputs, preference signals, and behavioral changes can be marked as memory candidates.

Raw session history is not memory. Durable behavioral memory needs to be scoped, attributed, and reviewable. The Resident's personality, domain rules, tone, and routing preferences can evolve through the memory system. Core logic and safety policy cannot.

---

## How It Actually Works

Every inbound interaction passes through the same three layers — **server channel adapter → ingress → dispatch** — and diverges based on actor identity, channel kind, and PendingInteraction match.

- **server channel adapter** (`apps/server/`) — channel-specific transport. Adds the SDK detail; outputs a channel-agnostic `InboundMessage`.
- **ingress** (`packages/openomni/src/ingress/`) — channel-agnostic. Identifies the actor (`ActorResolver`) and resolves a default session candidate (`SessionResolver`). Hands off to dispatch.
- **dispatch** (`packages/openomni/src/dispatch/`) — boundary gate. Evaluates blacklist, PendingInteraction match (which may override the session candidate), channel grant, `TrustTier`; computes `effectiveAuthority`; persists the inbound message into the final session (`EventProjector`); routes to the right handler (Resident, Worker, system); manages PendingInteraction lifecycle.

The same three layers handle outbound: a Worker or the Resident calls `dispatch.submit(...)`, dispatch authorizes and routes to a server channel adapter (for human/A2A channels) or directly to an HTTP client (for `external_api`).

See [ADR-009 Scenarios](design-decisions/009-external-actor-authority-model.md#scenarios) for five end-to-end traces — Owner DM, Task Outreach, External reply (PI matched), Public channel unsolicited, External AI API call.

**Invariant**: a new channel only touches `apps/server/`. Ingress and dispatch must remain unchanged when adding a channel; if they need a change, the boundary is broken.

---

## Vocabulary

Seven categories. Each answers a different question — do not mix them.

### Product subjects (user-facing)

| Term | Description |
|---|---|
| **Owner** | The human operator. Has full authority. |
| **Resident** | The single always-on user-facing assistant. Owns judgment, not execution. |
| **Worker** | Any delegated execution actor — internal AI, external AI, external human. |
| **System Governor** | Low-privilege observer that proposes Policy / Skill changes from execution evidence. |
| **Actor** | Any external entity that interacts with the system. |

### External identity (ingress concerns)

| Term | Description |
|---|---|
| `ActorIdentity` | A canonical entity (one person, one external agent). |
| `ActorEndpoint` | An identity's address on a specific channel: `(channel, externalId)`. |
| `ActorRegistry` | Store mapping identities ↔ endpoints. |
| `ActorResolver` | `(channel, externalId) → ActorIdentity?`. |
| `ActorKind` | `human / ai_agent / service / resident / internal_worker / system`. |
| `TrustTier` | `owner / co_owner / manager / collaborator / observer / assigned_worker`. |

### Communication medium

| Term | Description |
|---|---|
| `Channel` | Transport kind: `telegram / discord / slack / email / a2a / ...`. |
| `Surface` | A specific instance of a channel (one bot, one workspace, one inbox). |
| `SurfaceKey` | Routing key for a surface. |
| `ChannelGrant` | Policy ceiling for a surface (`kind: trusted_channel | broadcast_channel | blocked_channel`, `defaultTier`, `inboundTreatment`). |
| `Blacklist` | Absolute block list (actor / endpoint / channel / pattern). |

### Message units

| Term | Description |
|---|---|
| `InboundMessage` | Server normalizer output. Channel-agnostic shape. |
| `InboundEvent` | Ingress-stamped event with resolved actor + default session candidate. |
| `DispatchCommand` | Single dispatch invocation: `action / actor / target / payload / correlation`. |
| `Envelope` | Wire-level external communication envelope. |
| `Message` | Persisted session record (`UserMessage / AssistantMessage`). |

### Session and execution

| Term | Description |
|---|---|
| `Session` | Conversation or work scope. |
| `SessionOwner` | Discriminated union: `actor | worker_run | system`. |
| `SessionOrigin` | How the session was initiated. |
| `SessionPurpose` | `user_conversation / worker_interaction / self_loop`. |
| `WorkerRun` | Durable execution record of a delegated task. |
| `executorKind` | `internal_chat_agent / external_api / a2a / human_channel`. |
| `ChatAgent` | LLM-driven execution loop. |
| `SubagentRuntime` | Session-locked spawn / send / resume / cancel / wait. |

### Authority and lifecycle (dispatch concerns)

| Term | Description |
|---|---|
| `PendingInteraction` | Durable registry entry for an outbound request awaiting an external response. Status: `open / resolved / follow_up / expired / cancelled`. |
| `WorkerGrant` | A Worker's egress permission set (separate axis from ChannelGrant). |
| `EffectiveAuthority` | 5-dimensional intersection: blacklist × channel × actor × session × PI. |

### Module names

| Term | Description |
|---|---|
| `Ingress` | Channel-agnostic entry: normalize → identify → resolve session candidate → hand off to dispatch. |
| `Dispatch` | Cross-boundary gate: authorize → route → deliver → project → track lifecycle. |
| `IngressEngine` / `DispatchRuntime` | Public entry points. |
| `SessionResolver` | Ingress submodule producing the default session candidate from `SurfaceKey`. |
| `EventProjector` | Dispatch-invoked utility that persists the inbound message into the final session after PI match resolution. |
| `DispatchHandler` | Per-action handler inside dispatch. |

See [ADR-009](design-decisions/009-external-actor-authority-model.md) for the authority model, routing precedence, and full scenario traces.
