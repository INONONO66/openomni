# Persona Runtime Roadmap

This roadmap translates the persona workforce direction into implementation phases. It is intentionally staged so OpenOmni can gain the workforce model without introducing uncontrolled autonomy or memory pollution.

## Current Foundations

OpenOmni already has several primitives that map naturally to the persona workforce model:

| Capability | Current primitive | Gap |
| --- | --- | --- |
| Stable user-facing sessions | `SurfaceKey`, `IngressSessionResolver` | No explicit original/self-loop/writeback policy |
| Child work sessions | `Session.createChild()`, `workerMeta` | No `self-loop` session kind |
| Delegated execution | `SubagentRuntime.spawn/send/resume/wait` | No persona lifecycle or promotion model |
| Background work | `BackgroundManager` | Parent lineage must be preserved for workforce tasks |
| Execution attempts | `WorkerRun` | No persona evaluation summary |
| Persona definitions | `AgentProfile.Definition`, `AgentRegistry` | No durable promoted persona registry |
| Memory retrieval | `ChatAgentConfig.memory`, memory middleware | No reflection/write candidate lifecycle |

## Target Contracts

These are the contracts the runtime should eventually expose. Names are provisional.

### Persona profile

Describes a persistent or temporary persona.

- `personaId`
- `displayName`
- `kind`: `main | domain | specialist | reviewer | utility`
- `lifecycle`: `trial | active | promoted | paused | retired`
- `domain`: `sns | coding | research | review | custom`
- `tools` and `permissions`
- `memoryPolicy`
- `promotionPolicy`

### Inbound authority

Controls who can submit new top-level work.

- `external`: user, surface, API
- `internalManager`: Main Persona or trusted manager persona
- `worker`: ordinary Sub Persona; cannot create new top-level inbound work by default

### Self-loop session

Represents isolated internal reasoning.

- parent original session
- initiating persona
- target domain persona, if any
- reason: clarification, planning, review, recovery, scheduled reflection
- distilled writeback target

### Distilled writeback

Controls what is written back to the original session.

- summary
- decisions
- user-visible result
- links to worker runs / child sessions
- memory candidates
- hidden internal transcript reference

### Memory candidate

Marks high-value information for Anamnesis or future memory processing.

- source session / worker run
- author persona
- scope: user, domain, project, persona, session
- category: preference, rule, lesson, failure, decision, skill
- confidence and verification evidence

## Implementation Phases

### Phase 1: Authority and lineage

- Add explicit metadata conventions for original, self-loop, and child persona sessions.
- Preserve parent session lineage for background and delegated work.
- Document which actors can submit external or internal inbound events.
- Add tests around session lineage when implementation starts.

### Phase 2: Self-loop runtime

- Add a small orchestration layer that creates self-loop sessions for Layer 3 work.
- Keep the original session clean by writing only distilled results back.
- Start with manual or rule-based triggers: complex request, explicit user request, recovery, or scheduled review.

### Phase 3: Persona lifecycle

- Introduce persona lifecycle metadata.
- Track repeated ephemeral worker usage and output adoption.
- Produce persona promotion candidates instead of promoting automatically.
- Keep persistent persona creation behind policy or user approval initially.

### Phase 4: SNS domain persona

- Define the first domain persona around SNS / viral marketing.
- Start with research, drafts, content planning, and analytics.
- Keep public posting, comments, and outbound DMs behind approval gates until trust and policy are established.

### Phase 5: Memory readiness

- Emit memory candidates from completed work and user corrections.
- Do not treat raw session transcripts as durable behavioral memory.
- Use session lineage and worker provenance as the input stream for Anamnesis.

## Non-goals for the First Implementation

- No unrestricted recursive task creation.
- No automatic rewriting of core orchestration or safety policy.
- No automatic promotion of every generated worker into a persistent persona.
- No fully autonomous public social posting by default.
- No dependency on Anamnesis before the runtime can produce scoped, attributed memory candidates.
