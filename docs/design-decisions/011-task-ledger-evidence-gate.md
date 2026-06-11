# ADR-011: Task Ledger, Completion Reports, and the Evidence Gate

**Status**: Proposed

## Context

The design philosophy's founding claim — *completion requires evidence, not self-report* — is currently enforced nowhere. The 2026-06 audits found the full machinery built and dormant: `WorkItem` schemas (`Info`, `Blocker`, `Evidence`, `VerificationGate`, derived status, dependency cycle detection) and the `WorkItemStore` engine exist with **zero production callers**. A Worker can claim success with no evidence and the claim flows straight to the Resident's context. The situation the philosophy criticizes — "the agent reports success, but you cannot trust the report" — is the system's own default behavior.

Separately, three product needs converged in design discussions: Linear-style tracking of every task (who instructed it, who executes it, attempts, completion criteria), a mandatory written report accompanying every deliverable, and per-executor retry limits.

This ADR is the task-ledger half of the [ADR-010](./010-agent-os-kernel-model.md) evidence loop; [ADR-012](./012-governor-postmortem-engine.md) is the consumer half.

## Decision

Every Worker-lane task is tracked as a `WorkItem` — the existing store becomes the system's **process table**. Dispatch actions do not get tickets: atomic operations are already audited by the dispatch log, and ticketing them would be the slop ADR-010 §6 exists to avoid. *Tickets are for work that requires reasoning.* Subagent output is exempt end-to-end: it is intermediate reasoning the parent digests, not an independent deliverable (ADR-010 §6).

### Creation contract

A WorkItem cannot be created without at least one acceptance criterion (`acceptanceCriteria`, structurally enforced via schema `min(1)`). Defining "done" is part of delegating, not an afterthought — a short "done means" list (≤3 bullets) at delegation time; per-task-type templates accumulate later as Skills.

### Completion contract

Every completion claim must arrive as **deliverable + completion report**. The report is a written account whose claims each reference evidence records in the ledger:

```
completionReport {
  summary
  claims[]: { statement, evidenceIds[] }   // "tests pass" → test-run event id
                                           // "3 sellers contacted" → 3 dispatch receipts
  caveats, followUps
}
```

### Three-question verification

| Question | Answered by | Cost | Mechanism |
| --- | --- | --- | --- |
| **Did it happen?** | Code (gate) | ~0 | Each claim's `evidenceIds` must resolve to real ledger records (dispatch receipts, diffs, test runs, read-back checks). A claim without evidence is void; a report whose core claims lack evidence is **treated as work not done** and bounced before any LLM evaluation. |
| **Is it good?** | Resident | 1 LLM evaluation | Resident judges **report + deliverable + verified evidence only — never the worker transcript**. The report is simultaneously the isolation mechanism (independent judgment per design-philosophy §3) and the distillation unit (the only thing written back toward user-facing context). On failure the Resident names the issue and re-dispatches with it attached. |
| **Was it useful?** | Owner's behavior (`outcome`) | 0, delayed | adopted / corrected / redone / ignored — harvested retroactively by the Governor as ground truth. This also calibrates the Resident's own evaluation: accepted work the Owner keeps correcting is a Resident-leniency signal. |

The Resident-as-evaluator is consistent with "the entity that did the work doesn't grade it" — the Resident did not execute. Its residual selection bias ("I picked this worker") is checked by the third question, where time is the evaluator.

### Read-back verification

The "did it happen" gate generalizes beyond code: published content is re-fetched by URL; calendar/email writes are re-queried; research citations are checked by fetching sources and matching quoted passages (structurally blocking hallucinated citations); human work is evidenced by PendingInteraction resolution records. *Actions leave traces in the world; the gate re-observes the world rather than trusting the claim.*

### Retry policy

Defaults live on the executor profile (internal workers: 3; CLI apps: per application manifest; humans: not retries but a reminder policy under the social budget), overridable per item (`maxAttempts`). Exhaustion is **kernel-enforced**, not Resident goodwill: the item gains a `waiting_input` blocker and escalates to the Owner ("attempted N times, still failing — change approach?"). This is the structural backstop against cost-burning retry loops.

### Observability

The ledger doubles as the OS's `ps`: who instructed it (`originSessionId`), where it runs (`workSessionId`), who executes it (`workerRunId`, `executorKind`), attempts, deadlines, what it is blocked on. "Show open tasks" is a ledger query — the first Owner-facing task-manager surface, via chat command first, web view later.

### Schema deltas

Required on the existing `WorkItem.Info` (all else is already built — including derived status, blockers, dependencies with cycle detection, and bus events):

| Delta | Purpose |
| --- | --- |
| `originSessionId` / `workSessionId` (split the single `sessionId`) | "Who instructed" vs "where it runs" |
| `workerRunId` + `executorKind` | Join key to the evidence ledger and routing stats |
| `completionReport` | The deliverable-plus-writing obligation, claims → evidence refs |
| `maxAttempts` | Per-item retry override; defaults from executor profile |
| `outcome` (`adopted / corrected / redone / ignored`) | The usefulness signal the Governor weighs highest |

## Rationale

- **Why the gate before the evaluation?** Cost shape: an evidence-less bluff report is rejected by code without spending a single LLM call. The Resident's evaluation budget is spent only on work that verifiably happened.
- **Why criteria at delegation time, not judge-invented?** Post-hoc criteria drift and give the worker nothing to aim at. Criteria-first is TDD's logic: the worker optimizing toward known criteria is the intended behavior, not gaming.
- **Why a written report for everything?** One artifact solves three problems at once: evaluation input (judgment without transcript), session-hygiene distillation unit (raw worker output never enters user-facing context), and evidence index (claims bound to ledger records). For humans the reply itself is the writing — the system assembles the report from ask + reply + receipts; nobody hands a form to a marketplace seller. For CLI apps the final message is the report and the diff/exit-code/test-output are the cheapest evidence of all.
- **Why kernel-enforced retry exhaustion?** A runaway retry loop is a structural failure mode; guarding it with prompt goodwill would violate the kernel/userland rule (ADR-010 §1).

## Consequences

### Positive

- "No evidence = not done" becomes running code instead of a prompt line — the philosophy's keystone claim gets its first enforcement point.
- The dormant `WorkItemStore` gains its consumers; the dormant-engine pattern is broken where it matters most.
- Hallucinated citations, phantom sends, and false completion claims are blocked structurally.
- The Owner gets a task manager (`ps`) for free from the same records.

### Negative

- Every worker completion now carries report-writing overhead (small for LLM executors, zero for humans by design).
- Read-back verifiers are per-domain code that must be written and maintained.
- Acceptance-criteria discipline adds friction to delegation until templates accumulate.

## Relationship to prior ADRs

- Implements the evidence half of ADR-010 §4; ADR-012's Governor consumes what this ledger records.
- `executorKind` and PendingInteraction evidence link to ADR-009.
- Builds directly on the WorkItem domain shipped (but unwired) under the work-item engine plan.
