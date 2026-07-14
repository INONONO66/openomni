# Core Model — The OS Specification

This document specifies the system that [Design Philosophy](design-philosophy.md) states in one page. Philosophy owns ten nouns; this document owns their fields, formats, and states. Implementation truth lives in [Implementation Status](implementation-status.md); package-level structure in [Architecture](architecture.md).

## The System in One Paragraph

Input channels (Telegram, Discord, CLI, email, cron, other agents) are adapters injected by the server. Everything they receive enters through one ingress, is routed, and crosses boundaries only through one gate (dispatch) — to the Resident, to the Owner, to a specific Worker session, or out to an external human. Every step lands in the ledger. The Owner converses with the Resident; Workers execute in isolation; the Jester doubts in real time; the Governor fixes structurally after the fact.

## Actors and Authority Profiles

Every subject is an actor with one **authority profile**:

| Profile field | Meaning |
|---|---|
| `TrustTier` | owner / co-owner / manager / collaborator / observer / assigned_worker |
| `Grant` | ceiling on what the actor may do — channel ceilings and egress permissions on one axis |
| `SocialBudget` | contact frequency caps and cooldowns for outreach to this actor |
| `Voice register` | the tone contract for this relationship (formality, emoji, length, warmth) |
| `Blacklist` | absolute block |

Identity is `ActorIdentity` (one canonical subject) with N `Endpoint`s (`channel × externalId`). Humans are not a special case: an external seller, a friend, and the Owner in the physical world are all actors, and all executable work is uniformly a Worker assignment regardless of whether the executor is silicon or human.

## The Gate

### Three verbs, one exception

All communication in the system reduces to three verbs:

1. **`ingress.submit`** — the world enters. Channel adapters normalize everything (Owner messages, external humans, CLI apps, cron) into one schema. Adapters are defined and injected in `apps/server`; adding a channel touches nothing else.
2. **`dispatch.submit`** — anything crosses a boundary. Delivering to the Resident, escalating to the Owner, messaging an external human, targeting a session, spawning or cancelling a Worker: the same verb with a different target.
3. **`bus.publish`** — something is recorded. Observation only; the bus never carries commands.

The single exception is the **subagent**: an in-process extension of its parent runtime (function-call communication, no ticket, dies with the parent). The production `child_agent` runtime implements this exception and always dispatches and audits `delegation.worker.pre/post`; optional injected delegation policies may return deny or pending for a spawn, while parent-tool bounding and nesting denial are unconditional structural controls — *the gate has one exception; policy interception has none.*

### Lanes

The gate routes each request to the cheapest sufficient lane:

| Lane | Used for |
|---|---|
| Built-in | judgment and read-only perception in place |
| Action | one atomic world mutation, no further reasoning |
| Worker | independent execution in an isolated session with its own profile |
| Subagent | context-inheriting parallel reasoning inside the parent |

Spawning a Worker for an atomic action is waste; doing multi-step work in the Owner's session is pollution.

### Policy — the cross-cutting hook layer

Policy is not a gate-internal feature: it is a system-wide interception layer (LSM-style). The protocol registers policy points, each with a contract — allowed effect types, default fail policy, required context schema. The registered points cover inbound (`session.inbound.pre`), the gate (`dispatch.action.pre`), the agent loop per turn (`run.turn.pre/post`, `run.lifecycle.*`, `run.completion.pre`, `run.error.error`), LLM connections (`connection.llm.pre/post`), prompt and writeback (`prompt.context.pre`, `session.writeback.pre`), tools (`tool.catalog/native/mcp.*`), and delegation (`delegation.worker.pre/post`). The target model also names four planned points: `memory.recall.pre` (scope filter), `egress.render.pre` (voice contract), `work.complete.pre` (the evidence gate), and `schedule.fire.pre` (cron constraints).

The rulebook:

1. Conflict composition: **deny > pending > allow**; priority orders evaluation, never verdict strength.
2. Engine failure: side-effect-boundary (pre) points **fail closed** with an incident event; post points fail open. Silent skips are forbidden.
3. Hot-path discipline: policies are pure and synchronous — **a policy never calls an LLM**. LLM-grade watching is an actor's job (the Jester subscribes to the bus); *policies block, actors speak*.
4. No recursion: a policy returns a verdict and declares effects; it never invokes verbs. Effects are applied by the host.
5. Effects outside a point's `allowedEffects` are rejected at registration, not dropped at runtime.
6. Registering or changing a policy is itself a dispatched action: the Owner freely; the Governor autonomously only in the tightening direction; loosening requires Owner approval; nobody else at all.
7. `pending` is the escalation primitive — it carries timeout, resume, and expiry semantics, isomorphic to Wait.
8. Every decision is recorded with the facts it used. Volume is solved by encoding, never by not recording.
9. Per-point context schemas are enforced; there is no universal context shape.

### Waiting on the world

Outbound requests that need an external answer open a **Wait** (open → resolved / follow-up / expired / cancelled) with `ownerRef: workItem | session`. One primitive absorbs what were four: PendingAsk, PendingInteraction, WorkItem blockers, and WorkerRun wait states (#215). The system sleeps at zero cost; a matching reply — even days later — wakes exactly the right work item. (Transitional code name: `PendingInteraction`, until #215 lands.)

## The Ledger

One append-only history. `bus.publish` is the only write; everything else is a view:

| View | What it shows |
|---|---|
| `Session` | an isolation scope of the history, linked by lineage (parent/child/self-loop) |
| `Transcript` | the raw record of a session — exported in agent-greppable form |
| `WorkItem` | the process-table row: acceptance criteria, attempts, executor, evidence, verdict, outcome |
| `CompletionReport` | a Worker's exit format — deliverable plus claims, each referencing evidence |
| `Receipt` | an objection, the evidence shown, and the Owner's acknowledgment of an override |
| `Memory` | a compressed view; on conflict the original wins; Workers receive task-scoped slices only |

Rules: **record maximally, access selectively** — noise is a viewing problem, not a recording problem. Raw transcripts are the Governor's fuel (see below), which is why greppable export is a kernel requirement, not a nice-to-have. `Outcome` (adopted / corrected / redone / ignored) is the Owner's post-hoc signal that calibrates everything downstream.

## The Roles

### Resident — decides

The default interface. It owns the relationship and global context — not exclusive access. It executes nothing: it answers, delegates, evaluates, and challenges.

The challenge rules:

1. **Evidence-gated**: an objection must cite the ledger, memory, or an original source. Without a citation it is demoted to a question.
2. **Trigger**: the hard machinery (receipts) engages only when a dispatchable action or a durable decision is at stake; in plain conversation, disagreement is just conversation.
3. **One round, then disagree-and-commit**: if the Owner overrides after seeing the evidence, the receipt is recorded and the action proceeds. No repeated nagging. The difference between "just do it" and "I understand the risk, do it" is not tone — it is the existence of a receipt.
4. **Intensity is learned, not designed**: initial thresholds ride the stakes dial; thereafter the Governor scores override outcomes (when the Resident objected and was overridden — who turned out right?) and calibrates.

### Worker — does

Any delegated executor: internal agents, external CLI apps (Claude Code, OpenCode), external humans, the Owner. Uniform contract: isolated session, task-scoped slice of data and permission, exit through a CompletionReport whose claims carry evidence. Human executors are verification-waived but never recording-waived — a one-line chat report suffices and the Resident writes the ledger entry.

Split criteria (when one Worker becomes two): split when **permission profiles differ** (web egress vs filesystem) or **verification regimes differ** (source citation vs test suite). An implementation-bound five-minute lookup is the coding Worker's subagent; an independently verifiable investigation is a separate research Worker.

Workers start ephemeral and earn persistence through ledger evidence (usage, adoption, correction rate); they are demoted the same way.

### Governor — fixes

A separate low-privilege observer, never in conversations. Two loops: an incident-driven fast loop (mistake → root cause from the situation's raw records → a structural fix so recurrence is impossible — never an apology) and a periodic slow loop (routing hints, calibration, cost accounting).

Design commitments (grounded in Meta-Harness, arXiv:2603.28052 — summary-fed improvement loops are the losing ablation; independent proposers over raw traces win):

- **Reads raw**: delegation-time judgment reads distilled reports; the improvement loop reads raw transcripts through selective access (grep-style). Its minimal implementation is literally a scheduled coding-agent session over the ledger store.
- **Proposals are evaluated before adoption**: the ledger doubles as a regression corpus — past work items with recorded outcomes are the search set for replay/canary evaluation.
- **Reward tiering**: domains with code-checkable rewards (tests, structural verification) get full search loops; Owner-subjective domains (adopted/ignored signals — sparse, slow) get proposal-only changes. Semantic evaluation stays independent of the adoption signal (Goodhart guard).
- **Write formula**: read-omniscient, write-minimal — tightening is autonomous, loosening needs the Owner, safety constraints are untouchable. Its primary output form is a policy attached to a hook point, which makes improvement observable as a diff.
- `IncidentFingerprint` is an index over incidents, never a taxonomy that constrains diagnosis.

### Jester — doubts

A real-time smoke alarm for discourse, filling the quadrant "who checks the judge, live". It is a cheap-detector → expensive-verifier cascade: it produces suspicion cheaply; the Resident or a Worker does the evidence work.

1. **Zero authority** — it can only speak; it blocks and writes nothing.
2. **Questions only** — it cannot cite evidence (cheap model), so structurally it may only ask; the Resident must answer with evidence or concede. That exchange, visible to the Owner, is the cross-validation.
3. **Deliberately blind** — it sees a philosophy digest, the tail of the decision log, memory index one-liners, and the current utterance; never the Resident's reasoning.
4. **Silence is the default** — scored on precision; missed catches are acceptable (the Governor sweeps later); getting muted is death.
5. **On the ledger like everyone** — every flag is recorded; the Governor scores hit/miss and tunes or retires it.
6. Tone is an audience property: Jester speaks to the Owner, so it uses whatever register the Owner prefers.

### Voice — a component, not a role and not a policy

Tone is a property of the audience, not of a component. Owner-facing output may be raw and technical. Anything leaving through a human channel passes the Voice component: rendering in the recipient's per-relationship register, consistent over time. An `egress.render.pre` policy may *oblige* rendering; the Voice component *performs* it — policies decide, components execute.

## External Interaction

The assistant is **openly known**: people understand that messaging the Owner's account or bot reaches the Owner's assistant. There is no impersonation problem — only a response-quality bar.

Flow: external message → ingress resolves the actor → the Resident judges *does this need the Owner?* Pure logistics (confirming a set appointment, sharing known facts) auto-answers in that contact's voice register; money, commitments, emotional weight, or novel requests escalate. What auto-answers is configurable per surface (routing settings ride the existing grant machinery). Every auto-reply is on the ledger — the Owner can always see what was said in their name. Hard rule: asked directly "are you human?", the assistant does not lie.

## Data

**Omnivorous in what it can observe, conservative in what it assumes, scoped in what it exposes.**

- **Capability-first**: connectors mount widely; by default nothing is read until needed, then originals are read directly.
- **Ingestion is earned per domain**: always-on observation starts with small structured domains (calendar, tasks) and expands only where ledger evidence shows proactive intervention actually helped — the same promotion pattern as Workers.
- The Resident never trusts memory over originals; when memory is load-bearing, it re-checks the source.
- Workers receive task-scoped slices only, enforced at `memory.recall.pre`.

## Vocabulary — Three Tiers

**Tier 1 (philosophy, exactly ten):** Actor, Gate, Ledger, Evidence, Stakes, Owner, Resident, Worker, Jester, Governor.

**Tier 2 (specification):** authority profile and its fields (TrustTier, Grant, SocialBudget, voice register, Blacklist), ActorIdentity, Endpoint, Channel, Surface, Command, Lane, Subagent, Policy and policy points, Wait, Session, Transcript, WorkItem, CompletionReport, Receipt, Memory, Outcome, Voice.

**Tier 3 (implementation):** packages and modules — see [Architecture](architecture.md). `IngressEngine`, `DispatchRuntime`, `DispatchHandler`, `ActorRegistry`, `EventProjector`, `Connector` are module names, never concepts.

**Demotions and removals:** ChannelGrant/WorkerGrant/TrustTier/SocialBudget → profile fields; EffectiveAuthority → removed as a concept (it is a computation); WorkerRun → removed (absorbed into WorkItem.attempts); Escalation/PendingAsk/PendingInteraction → absorbed into Wait (#215); InboundMessage/InboundEvent/Envelope/Message → wire formats; SessionOwner/Origin/Purpose → session fields; executorKind → WorkItem field; IncidentFingerprint → Governor index field; MemoryCandidate → ingestion format; ApplicationManifest → app-Worker profile field; ExecutionLane → Lane; System Governor → Governor. The word **"runtime" is banned** as a standalone noun — say agent loop, worker process, or kernel.
