# ADR-012: The Governor as an Incident-Driven Postmortem Engine

**Status**: Proposed

## Context

The System Governor has been the product's stated differentiator since the README's second paragraph, with zero implementing code. Meanwhile the common failure pattern of LLM agents is well known: *mistake → apology → (environment unchanged) → same mistake → apology*. The apology is worthless because reflection leaves nothing in the environment; the next session inherits the same trap.

The design discussions resolved the Governor's identity: not a report generator and not primarily a statistics accountant, but a **postmortem engine** — when a mistake happens, read the logs and the situation at the time, find why it happened, and change the structure so it cannot happen again. This is where three philosophy principles converge into one mechanism: P1 "harness first, prompt second" (when an agent fails, the environment was lacking), "failures are first-class data", and P8 "unplanned rescue is a defect signal".

This ADR consumes what [ADR-011](./011-task-ledger-evidence-gate.md)'s ledger records, inside [ADR-010](./010-agent-os-kernel-model.md)'s kernel/userland frame (the Governor is a userland daemon).

## Decision

**Permission formula: read-omniscient, write-minimal.** The Governor reads everything — including worker transcripts. The Resident's transcript isolation exists to prevent evaluation bias; the Governor's job is process autopsy, which requires the process. Its writes are confined to proposals plus the autonomous tier below. It never participates in conversations.

### Two loops

- **Fast loop (incident-driven)** — the core. An incident spawns a root-cause analysis (RCA): read the failed WorkItem, its report, the worker transcript, the journal timeline, and the policy/prompt state *at the time* — then classify the cause and prescribe a structural fix.
- **Slow loop (periodic)** — aggregation over the ledger: routing hints per task type, Resident evaluation-leniency calibration (accepted work the Owner keeps correcting), cost accounting.

### Incident lanes

| Lane | Triggers | Why |
| --- | --- | --- |
| Immediate | Owner unplanned intervention (P8); `outcome = redone`; **fabricated evidence caught by the gate**; canary breach / rollback; 3rd recurrence of a fingerprint | Strongest signals, rare enough to afford instantly |
| Daily batch | Worker run failures; `outcome = corrected` (after triage); PI expired unanswered; budget hard-stops; cost anomalies | Bulk signals; batching surfaces patterns single incidents hide |

**Storm collapse.** More than N similar incidents per hour collapse into a single storm RCA. The cause taxonomy includes `environmental` (expired credentials, API outage): environmental causes route to an ops alert, never to a policy change — twenty workers failing on one dead API key is one infrastructure incident, not twenty behavioral ones.

**Triage before RCA** (for soft signals like `corrected`): a single occurrence with no fingerprint match is recorded only. Preference-shaped corrections (tone, style) are routed to **memory candidates** ([ADR-013](./013-memory-engine-port.md)), not policy fixes — taste is memory, defects are structure. Two or more occurrences, or any hard signal, get a full RCA.

### Cause taxonomy → fix mapping

| Root cause | Structural fix | Autonomy tier |
| --- | --- | --- |
| Missing know-how | Skill addition/update | approval |
| Wrong worker/app/model for the task | Routing hint update | autonomous |
| Ambiguous instruction | Delegation / acceptance-criteria template improvement | approval |
| Gate didn't catch it | New verification check for that task type | approval (adds cost) |
| Over-broad permission/tool surface | Permission tightening | autonomous |
| Unrealistic budget/limits | Numeric adjustment | tighten: autonomous / loosen: approval |
| Model limitation | Model-tier escalation proposal for the task type | approval |
| Environmental | Ops alert to Owner | n/a |

### Autonomy boundary — tighten freely, loosen with approval

- **Autonomous**: routing hints; numeric *tightening* (lower retry caps, lower budgets, narrower tool sets); recording and alerting.
- **Approval required**: numeric loosening; skill/prompt/template changes; new verification checks; anything expanding any actor's autonomy.
- **Never (kernel-enforced floor)**: blacklist, social-budget ceilings, approval-tier definitions, safety constraints, kernel code, **its own write permissions**. Proposable, never self-applicable.
- **Rate limits**: at most one active change per fingerprint; at most M autonomous changes per day; every applied change is journaled as an event with a scope tag.

### The ratchet runs through the same pipeline

Every applied change opens a canary window (the next N tasks of the affected type). Two consecutive same-type failures inside the window → automatic rollback + an immediate-lane RCA *on the change itself* — a bad fix is just another incident whose root cause is a recent change, visible because changes are journaled. No separate regression machinery. Rollback triggers are simple counting rules, not statistics: a personal system's samples are too small for significance, and a false rollback costs only a restore.

### Recurrence ladder (fingerprints)

Each RCA matches-or-creates an incident fingerprint (cause category × task type × failure mode); matching against open fingerprints is mandatory before creating a new one (dedup discipline, as in an issue tracker).

1. First occurrence → fix proposed/applied.
2. Recurrence after the fix → **the fix failed**: reopen with the prior RCA as input, escalate priority.
3. Third occurrence → Owner escalation: "structure is not catching this."

### RCA is itself an ADR-011 WorkItem

Acceptance criteria: root cause identified with evidence references (journal event IDs); cause category assigned; fix proposed with a **falsifiable prevention check** ("fingerprint X recurrence = 0 over the next 4 weeks"); fingerprint matched-or-created. Completion report required. `outcome` tracked — the Owner's dismissal rate of Governor proposals is the Governor's own track record. There is no meta-Governor: if the dismissal rate climbs, fixing the Governor is the Owner's job (infinite regress stops here by design).

### Fabricated evidence is a first-class offense

A claim whose `evidenceIds` do not resolve — or that read-back contradicts — is not a quality miss but a false report: immediate-lane RCA, permanently recorded on that executor's reliability track record, directly feeding promotion/trust decisions.

### Owner surface

Proposals arrive as a weekly digest; immediate pings only for rollbacks, fabricated evidence, and third recurrences. Unreviewed proposals expire after N days (state preserved on the fingerprint). Governor spend is capped as a percentage of total system spend.

## Rationale

- **Why incident-driven rather than statistics-first?** A personal system's samples are small; statistics take months to say anything, while incidents carry signal from day one. Incident-driven design also solves cold start naturally.
- **Why may the Governor read transcripts when the Resident may not?** Isolation serves evaluation independence; autopsy serves causal truth. Different jobs, different access — and the Governor's write surface stays minimal, so omniscient reads do not become omnipotent writes.
- **Why "tighten freely, loosen with approval"?** Asymmetric risk: an over-tight system is slow but safe and self-reports its friction; an over-loose system fails open. The cheap direction gets autonomy.
- **Why no meta-Governor?** Every observer needs an observer only if the loop has no human. This system has exactly one: the Owner, whose dismissal behavior is recorded as the Governor's outcome signal. One level of recursion, then a person.

## Consequences

### Positive

- "The same mistake doesn't happen twice" becomes a mechanism instead of a hope; every Owner correction compounds.
- The dormant `BusQuery` gains its first consumer; the journal's existence is finally justified.
- Regression safety comes free from the same pipeline (changes are incidents too).

### Negative

- RCA quality is itself LLM work and can be wrong — mitigated by evidence-referenced claims, falsifiable prevention checks, and the recurrence ladder, but not eliminated.
- Fingerprint matching is fuzzy; mis-grouping incidents degrades recurrence detection.
- The proposal queue adds a standing Owner review obligation (bounded by the weekly digest design).

## Relationship to prior ADRs

- Userland daemon under ADR-010 §1/§4; consumes ADR-011's ledger and emits ADR-013 memory candidates from preference triage.
- ADR-007 (Policy Kernel v2) is the eventual mechanism by which approved fixes load as policy modules; Governor v0 ships with static policies plus Owner-applied diffs.
