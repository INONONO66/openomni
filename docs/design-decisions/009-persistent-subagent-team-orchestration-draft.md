# 009: Persistent Subagent Sessions for Team Orchestration (Superseded)

## Status

Superseded. The persistent-subagent pieces of this draft shipped as `SubagentRuntime` + `BackgroundManager` + `SubagentConsultation` in `packages/openomni/src/subagent/`. The Team-orchestrator pieces (dispatcher, review loop, handoff FSM) did not ship — callers now compose subagent runs explicitly instead.

### What shipped

- `WorkerRunRecord` / `Subagent.WorkerRunStatus` + event-sourced persistence (`packages/session/src/worker-run/`)
- `Session.createChild` / `Session.getWorkerMeta` / `updateWorkerMeta` for parent-child lineage
- `SubagentRuntime.spawn / spawnBackground / send / resume / cancel / wait` with per-session locking, soft / hard timeouts, and abort registry
- `BackgroundManager` with per-agent / total / depth / descendant concurrency limits and TTL-based result eviction
- `SubagentConsultation.consult` — fresh-session and active-session consultation modes
- Full set of `Subagent.Events.*` for observability

### What did NOT ship

- `TeamOrchestrator`, `ReviewLoop`, `StallDetector`, `RunLedger`, team-shaped event names
- Category / lane-based routing at the orchestrator layer
- Rejection / handoff state machine owned by the orchestrator

The original draft is kept below for historical context. It does not reflect the current architecture.

---

## Context

OpenOmni previously planned a Team Mode with ephemeral workers.

- A then-planned `packages/openomni/src/team/teammate.ts` would create a fresh `ChatAgent` for every step execution.
- A companion `packages/openomni/src/team/review-loop.ts` would also create a fresh reviewer agent for every review.
- `packages/agent/src/runtime/tools/subagent.ts` delegates by resolving an agent definition from `AgentRegistry`, creating a new `ChatAgent`, and returning final text.
- `packages/agent/src/runtime/registry/registry.ts` is an in-memory definition map, not a runtime directory for persistent child workers.
- `packages/session/src/session/index.ts` persists sessions and messages, but it did not yet model parent-child worker lineage, worker runs, or resumable child execution.

This keeps the execution model simple, but it does not satisfy the target interaction model for subagents and Team Mode:

1. The orchestrator should execute a plan step-by-step.
2. For each step, the orchestrator should dispatch exactly one task to one suitable subagent.
3. That subagent should have its own session.
4. The subagent should report its result back to the orchestrator.
5. The orchestrator should review the result.
6. On approval, the orchestrator should move to the next step with a new subagent session.
7. On rejection, the orchestrator should continue the same subagent session with feedback.
8. After a configurable rejection threshold, the failing subagent must produce a handoff document, and the step must continue in a fresh subagent session.

## Decision

OpenOmni will evolve Team Mode and subagent delegation around **persistent child sessions** with **separate run records**.

The core model is:

- A **worker session** represents the identity and transcript of a subagent.
- A **worker run** represents one concrete execution attempt inside that session.
- The **TeamOrchestrator** owns plan progression, review, rejection handling, handoff decisions, and worker replacement.
- A **step attempt** is always executed by exactly one worker session at a time.
- Rejection normally reuses the same worker session.
- Excessive rejection forces a handoff to a new worker session.

This preserves OpenOmni's deterministic Team Mode while adding session continuity to the workers that actually execute steps.

## Design Goals

### Functional goals

1. Give each delegated subagent its own durable session identity.
2. Allow the orchestrator to continue an existing worker session with feedback.
3. Allow a failed worker to produce an explicit handoff document before replacement.
4. Keep Team Mode deterministic at the orchestration layer.
5. Preserve `ChatAgent` as a stateless execution primitive.

### Non-goals

1. Do not turn Team Mode into a free-form swarm.
2. Do not introduce cross-step shared mutable state outside explicit session persistence.
3. Do not replace the existing DAG-driven plan semantics.
4. Do not require reviewer persistence in the first implementation phase.

## Core Invariants

1. **Exactly one active worker per step attempt.**
   A plan step may be retried, but each concrete attempt is owned by one worker session.

2. **The orchestrator remains the source of truth.**
   Subagents do not self-advance the plan. They only execute the assigned step and report back.

3. **Session identity survives runs.**
   A worker session can outlive an individual run and can be resumed later.

4. **Run records are append-only execution history.**
   A session may have multiple runs over time.

5. **Rejection does not imply session replacement.**
   The default rejection path is feedback into the same session.

6. **Handoff is explicit.**
   A replacement worker session must be created only after the previous worker emits a handoff document or the orchestrator records that handoff generation failed.

7. **Plan progression is serialized at the review boundary.**
   The next step does not start until the current step is accepted, skipped, or failed according to policy.

8. **Exactly one active step at runtime.**
   The plan schema may remain DAG-shaped, but the runtime executes at most one active step at a time in the first design phase.

9. **A live worker session is unique per step.**
   A step may have historical sessions across handoffs, but only one live worker session may exist for that step at any point in time.

10. **Acceptance closes the worker session for that step.**
    Once a step is accepted, the winning session becomes immutable for that step and may not receive more corrective retries.

11. **Review authority never belongs to the worker.**
    A worker may report uncertainty, blockage, or self-identified risk, but only the orchestrator and review layer may decide accept, reject, rotate, or advance.

12. **Consultation is allowed, but authority is not delegated.**
    A lower-cost worker may ask another capable agent for guidance, but the response is advisory input only. It never becomes an approval decision or step ownership transfer.

## Architecture Overview

### Layers

#### 1. Protocol layer

Add durable schemas for worker sessions, worker runs, and richer team ledger metadata.

#### 2. Session layer

Persist parent-child session lineage, worker metadata, worker runs, and resumable execution state.

#### 3. Agent primitive layer

Keep `ChatAgent` stateless. It should not become session-aware.

#### 4. Team orchestration layer

Own the session-backed worker runner here. Team orchestration should assign one worker per step, review results, retry within the same session, and hand off to a new session when needed.

## Data Model

### Worker session

A worker session is a child session linked to a parent session and optionally to a parent run.

Suggested metadata shape:

```ts
type WorkerSessionKind = "subagent" | "team-worker" | "consultation";

type WorkerSessionStatus =
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

interface WorkerSessionMeta {
  kind: WorkerSessionKind;
  parentSessionId?: string;
  parentRunId?: string;
  agentName: string;
  laneId?: string;
  spawnedBy: string;
  spawnDepth: number;
  workspaceId?: string;
  status: WorkerSessionStatus;
}
```

### Worker run

A worker run is one execution attempt within a worker session.

```ts
type WorkerRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

interface WorkerRun {
  runId: string;
  sessionId: string;
  parentRunId?: string;
  assignedStepId?: string;
  laneId?: string;
  title: string;
  prompt: string;
  status: WorkerRunStatus;
  startedAt: number;
  endedAt?: number;
  lastMessageId?: string;
  resumeCount: number;
}
```

### Team ledger enrichment

Each step ledger entry should capture worker linkage:

```ts
interface StepExecutionRecord {
  stepId: string;
  workerSessionId?: string;
  workerRunId?: string;
  sessionGeneration: number;
  laneId?: string;
  assignedAgent?: string;
  attempts: number;
  totalAttempts: number;
  sessionRejections: number;
  rejectionStreak: number;
  totalRejections: number;
  handoffCount: number;
  reviewDecision?: "accept" | "reject";
  handoffRequired?: boolean;
  handoffDocument?: string;
  terminalReason?: "accepted" | "failed_terminal" | "skipped";
  state: "ready" | "running" | "succeeded" | "failed" | "skipped";
}
```

## State Machines

### Worker session lifecycle

```txt
idle -> running -> waiting -> idle
                    \-> completed
                    \-> failed
                    \-> cancelled
                    \-> interrupted
```

Notes:

- `idle` means the session exists and can accept a new run.
- `running` means the current run is active.
- `waiting` means the worker is blocked on an external condition or orchestrator input.
- `completed` is terminal for the last known orchestration intent, but the session may later be reactivated.

### Worker run lifecycle

```txt
queued -> starting -> running -> succeeded
                            \-> failed
                            \-> waiting_input
                            \-> cancelled
                            \-> interrupted
```

### Step review lifecycle

```txt
ready
  -> assigned
  -> worker run completed
  -> review
    -> accept -> step succeeded -> next plan step
    -> reject -> same session retry
    -> reject threshold exceeded -> handoff generation -> new session retry
    -> unrecoverable -> step failed
```

### Review counters

- `sessionRejections`: rejection count for the current worker session only
- `totalAttempts`: total number of attempts across all sessions for the step
- `sessionGeneration`: increments whenever the orchestrator rotates to a new worker session

Both counters are required:

- `sessionRejections` decides when to hand off
- `totalAttempts` prevents infinite rotation loops across fresh sessions

## Target Team Flow

### Normal path

1. `TeamOrchestrator` selects the next ready plan step.
2. It resolves the appropriate subagent profile for that step.
3. It spawns a fresh worker session for the step.
4. The worker session executes exactly one assigned task.
5. The worker reports the result.
6. `ReviewLoop` evaluates the result.
7. If accepted, the step succeeds and orchestration advances to the next step.

### Rejection path

1. The reviewer rejects the result.
2. The orchestrator records rejection metadata.
3. The orchestrator sends reviewer feedback back into the same worker session.
4. A new run is created in the same session.
5. The worker retries the same step with added feedback context.

### Handoff path

1. The rejection threshold is exceeded.
2. The orchestrator asks the failing worker session to generate a handoff document.
3. The handoff document is stored in the team ledger and the child session transcript.
4. The orchestrator creates a fresh worker session for the same step.
5. The new session receives:
   - the original step description
   - prior reviewer feedback
   - the handoff document
6. The new session starts a new run and continues the step.

If handoff generation fails, the orchestrator must still synthesize a fallback handoff from:

- step goal
- expected output
- rejection history
- last known submission summary

### Consultation path

1. A worker may determine that it needs strategic guidance, validation of an approach, or clarification on tradeoffs.
2. The worker emits a consultation request instead of unilaterally changing step ownership.
3. The orchestrator may satisfy that request in one of two ways:
   - launch a fresh consultation child session
   - ask an already-active parent-linked session without writing the consultation into that session's durable transcript
4. A fresh consultation child session is used when the worker needs stronger guidance from another agent or model and does not need the full private transcript of an already-running parent session.
5. An active-session consultation is used when a worker needs to ask the agent that originally spawned it, or another already-active linked session that already holds detailed context.
6. In active-session consultation mode, the consulted session may use its existing history to answer, but the consultation exchange must not be appended to that session's durable visible transcript.
7. The consulted path returns guidance, not a completion decision.
8. The orchestrator injects the guidance back into the original worker session or uses it to revise retry instructions.
9. The original worker remains the owner of the step attempt unless the orchestrator explicitly triggers handoff rotation.

This enables a low-cost worker to ask a stronger agent for direction without breaking the single-owner rule for the step.

The first implementation should keep consultation simple and capability-based:

- whether the worker may ask other agents at all
- whether the consultation should spawn a fresh child session or query an already-active linked session
- whether the worker may target any compatible agent or only an allowlisted subset
- how many consultation rounds are allowed per run

## Package Boundaries

### `packages/protocol`

Add:

- `WorkerSessionMeta`
- `WorkerRun`
- team events for worker lifecycle
- team ledger fields for worker session/run linkage

Update:

- `PlanStepSchema` with optional execution hints such as `preferredLane` or `reuseWorker`
- `Team.RunLedgerEntry` with worker/session linkage

### `packages/session`

Add APIs:

- `Session.createChild(...)`
- `Session.listChildren(parentSessionId)`
- `Session.getWorkerMeta(sessionId)`
- `Session.updateWorkerMeta(sessionId, meta)`
- `WorkerRun.create(...)`
- `WorkerRun.get(runId)`
- `WorkerRun.listBySession(sessionId)`
- `WorkerRun.updateStatus(runId, status)`

Storage adapter changes:

- durable worker metadata storage
- durable worker run storage
- list and query methods for parent-child lineage and active runs

### `packages/agent`

Keep:

- `ChatAgent` as a stateless primitive

Do not add session-aware worker orchestration here.

This package should remain a pure execution primitive.

### `packages/openomni`

Change:

- add a session-backed worker runner in `src/team/` or adjacent orchestration runtime code
- `Teammate.execute()` into session-backed dispatch
- `TeamOrchestrator` into a worker allocator and review coordinator
- `RunLedger` into a worker-aware attempt ledger
- add the worker lifecycle and retry/handoff FSM here

This package owns:

- step dispatch
- session lifecycle policy
- rejection policy
- consultation policy
- handoff generation and rotation
- durable orchestration state

Keep for phase 1:

- `ReviewLoop` reviewer may remain ephemeral

## Runtime APIs

Suggested internal API:

```ts
SessionBackedTeammate.spawn({
  parentSessionId,
  parentRunId,
  agentName,
  title,
  prompt,
  assignedStepId,
  laneId,
}): Promise<{ sessionId: string; runId: string }>;

SessionBackedTeammate.send({
  sessionId,
  prompt,
  parentRunId,
}): Promise<{ runId: string }>;

SessionBackedTeammate.wait({
  sessionId,
  runId,
  timeoutMs,
}): Promise<{ status: string; output?: string }>;

SessionBackedTeammate.resume({
  sessionId,
}): Promise<{ resumed: boolean; runId?: string }>;

SessionBackedTeammate.cancel({
  sessionId,
  runId,
}): Promise<void>;

SessionBackedTeammate.requestConsultation({
  sessionId,
  runId,
  reason,
  question,
  targetAgent,
  mode,
}): Promise<{ consultationId: string }>;
```

## Orchestrator Policy

### Assignment policy

- Each ready step is assigned to one worker session.
- The worker selection algorithm may use `suggestedAgent`, category, or lane hints.
- The first implementation should keep a single-active-step runtime policy, even if the plan DAG allows broader parallelism.

### Rejection policy

Default policy:

1. First rejection: retry in the same session.
2. Second rejection: retry in the same session again unless the reviewer explicitly requests replacement.
3. Threshold reached: require handoff and replace the worker session.
4. If `totalAttempts` reaches the terminal threshold, fail the step and stop rotating sessions.

### Consultation policy

- A worker may request consultation when it is blocked on direction, architecture, tradeoffs, or confidence-sensitive decisions.
- Consultation does not transfer step ownership.
- Consultation output may be attached to the worker transcript as advisory context.
- Consultation does not reset rejection counters by itself.
- If consultation reveals that the current worker is unsuitable, only the orchestrator may trigger handoff or replacement.

The initial policy shape should stay minimal:

```ts
interface ConsultationCapability {
  enabled: boolean;
  maxRoundsPerRun: number;
  allowFreshSessionConsult: boolean;
  allowActiveSessionConsult: boolean;
  allowedTargets?: string[];
}
```

`allowedTargets` omitted means the worker may consult any compatible subagent. When present, it acts as a simple allowlist.

Suggested runtime request shape:

```ts
type ConsultationMode = "fresh-session" | "active-session";
```

- `fresh-session`: create a new consultation child session, ask the question, persist that child session normally
- `active-session`: query an already-active linked session that already has the needed history, but do not append the consultation exchange to that session's durable transcript

### Handoff policy

- Handoff generation is mandatory before replacement unless the worker session becomes unavailable.
- If handoff generation fails, the orchestrator records a structured fallback handoff from the review context.

## Team Mode Changes

### `Teammate`

Current role:

- wraps one `ChatAgent.run()` call

Target role:

- dispatches a plan step to a session-backed worker
- creates a new session for the first attempt
- reuses the same session for rejected retries
- creates a fresh session after handoff-triggered replacement

### `TeamOrchestrator`

Current role:

- runs steps and reviews inline

Target role:

- resolves worker profile
- spawns or reuses worker sessions
- waits for worker completion
- handles consultation requests
- runs review
- decides approve/reject/handoff/fail
- advances the plan only after review decision

### `ReviewLoop`

Phase 1 role:

- remain ephemeral
- return `accept | reject` plus feedback
- optionally trigger handoff generation prompt for the current worker

Future role:

- persistent reviewer session
- richer escalation strategy

## Observability

Add events for:

- `worker.session.spawned`
- `worker.run.started`
- `worker.run.completed`
- `worker.run.failed`
- `worker.session.resumed`
- `worker.session.cancelled`
- `team.step.assigned_to_worker`
- `team.step.rejected`
- `team.step.handoff_requested`
- `team.step.handoff_completed`
- `team.step.session_rotated`

This is required for UI visibility, debugging, and recovery after process restart.

## Failure Modes to Design Against

1. **Worker session drift**
   Reusing a session too broadly can contaminate later steps. Initial scope should be one worker session per plan step, not one worker reused across the whole plan.

2. **Invisible partial failure**
   A worker may fail after producing partial output. The run record must distinguish partial completion from success.

3. **Orchestrator-subagent authority confusion**
   Only the orchestrator may advance the plan.

4. **Handoff deadlock**
   If a worker is unable to generate a handoff, the orchestrator still needs a fallback replacement path.

5. **Resume ambiguity**
   Session status and run status must remain distinct so resumed workers do not corrupt prior runs.

6. **Infinite handoff rotation**
   Session-level rejection thresholds are not enough. A step-level total-attempt ceiling is mandatory.

7. **Consultation authority leak**
   A high-capability consulted agent must not silently become the real owner of the step. Consultation should remain bounded, observable, and non-terminal.

8. **Consultation abuse**
   A cheap worker could spam a stronger model for every hard decision. Consultation budgets and allowlists are required.

9. **Hidden history mutation**
   Active-session consultation must not silently pollute the consulted session's durable transcript. Temporary consultation context and canonical session history must remain distinct.

## Phased Implementation

### Phase 1: Session-backed subagent foundation

- Add worker session and worker run schemas
- Persist child lineage and run records
- Add spawn/send/wait/resume/cancel runtime APIs
- Rework orchestration dispatch to use session-backed workers

Success criteria:

- A child session has a durable identity.
- The parent can continue the same child session with another prompt.
- The system can inspect prior runs for that session.
- The orchestrator can recover the current step state from durable orchestration records.

### Phase 2: Consultation-capable workers

- Add bounded consultation requests from workers to stronger subagents
- Record consultation events and advisory outputs
- Keep consultation non-authoritative and under orchestrator control
- Support two consultation modes:
  - fresh child consultation session
  - active-session consultation without durable transcript writes on the consulted side

Success criteria:

- A low-cost worker can ask for guidance without losing ownership of the step.
- Advisor output is visible in the run history and does not bypass review.
- A worker can consult an already-active linked session without mutating that session's canonical history.

### Phase 3: Team step execution on persistent workers

- Replace ephemeral step execution with worker dispatch
- Record worker session/run linkage in the ledger
- Reuse the same worker session on rejection

Success criteria:

- A rejected step is retried in the same child session.
- Accepted steps advance deterministically.

### Phase 3: Handoff-driven worker replacement

- Add explicit handoff generation path
- Spawn fresh replacement sessions after threshold breaches
- Persist handoff artifacts and lineage

Success criteria:

- A repeatedly rejected worker can hand off to a new session without losing step context.

### Phase 4: reviewer persistence and richer lane logic

- persistent reviewer session
- lane/category-based routing refinement
- optional workspace binding per worker session

## Consequences

### Positive

- Matches the target mental model for subagents as real workers
- Gives Team Mode more realistic retry and recovery semantics
- Preserves OpenOmni's orchestrator-first design
- Creates a path toward workspace isolation and accumulated learning

### Negative

- Adds a new runtime state layer
- Requires storage and recovery design for worker runs
- Increases complexity in Team Mode and session persistence

## Open Questions

1. Should worker sessions be stored directly in `SessionInfo` or in a dedicated worker-session table keyed by session ID?
2. Should the first implementation allow step-level parallelism, or should it deliberately serialize the full plan until worker orchestration is proven?
3. Should handoff documents be stored as session parts, artifacts, or ledger-linked records?
4. When a replacement worker is created, should it receive the full child transcript, only the handoff, or a curated subset?

## Initial Recommendation

For the first implementation:

- use **one worker session per plan step**
- run the plan as **single-active-step** at runtime while keeping DAG structure in the protocol
- allow **same-session retries** on rejection
- allow **bounded consultation to stronger advisor agents** under orchestrator control
- require **handoff then replacement** after threshold breach
- keep the **reviewer ephemeral**
- keep `ChatAgent` **stateless**
- keep the **orchestrator as the only plan-advancing authority**

This gives OpenOmni the persistent subagent behavior the current design lacks without collapsing Team Mode into an unconstrained multi-agent swarm.
