# ADR-010: Agent OS Kernel Model

**Status**: Proposed

## Context

OpenOmni has, piece by piece, built the skeleton of an operating system without naming it one:

- `DispatchRegistry` maps `action → handler` — structurally a syscall table.
- `PolicyEngine` exposes 13 fixed timings (`pre_run`, `pre_tool_use`, `pre_delegation`, `dispatch.authorize`, ...) — structurally kernel hook points.
- `BusPersistence` writes a hash-chained, append-only event journal — structurally an audit log.
- The injection queue delivers async responses only at `turn.finish` — structurally signal delivery at safe points.
- Sessions are durable while worker processes are disposable (ADR-008) — structurally cheap preemption: process state lives on disk, not in the process.

Meanwhile, three audits (2026-06) surfaced a consistent failure pattern: **engines get built, consumers never get wired**. `WorkItemStore` (evidence, verification gates), `BusQuery`, the `self-loop` session kind, and the writeback policy hook are all complete and dormant — zero production callers. The philosophy ("evidence over self-report", "structure determines behavior") is real in three narrow places (worker-spawn denial, budget hard-stop, tool-guard) and prompt-only everywhere else.

Separately, the Worker abstraction is wider than originally framed. "Workers" now means:

1. internal ChatAgent threads,
2. **installed applications** — CLI coding agents (Claude Code, Codex, OpenCode) spawned as subprocesses with their own agent loops,
3. external AI services (API / A2A),
4. **external humans** — e.g. asking a marketplace seller for a price, emailing a specific person and awaiting the reply,
5. the Owner themselves (one-tap approval-mediated sends).

What unifies 2–5 is not "delegation" but **asynchronous latency**: fire a request, suspend, and resume correctly when the world responds — seconds for an API, days for a human. No mainstream agent runtime survives this; their execution model is a synchronous loop with timeouts.

We need an organizing model that (a) names what is already built correctly, (b) defines what "structurally guaranteed" means so docs stop overclaiming, and (c) makes the async-world primitive first-class.

## Decision

Adopt the **OS kernel model** as the organizing architecture. Five commitments:

### 1. Kernel / userland split

Every behavioral claim in this project is classified as exactly one of:

- **Kernel (structural guarantee)** — enforced by code; cannot be bypassed by any prompt. The kernel surface is: the dispatch gate (single ingress/egress chokepoint), authority evaluation (blacklist → PI match → channel grant → trust tier → effective authority, per ADR-009), budget hard-stops, tool permission (fail-closed), session ownership, and evidence-ledger appends.
- **Userland (convention)** — guided by prompts, skills, and agent definitions. May be violated; violations are observable in the journal and become Governor evidence.

Documentation may use the words "guaranteed", "cannot", or "never" only for kernel items. Everything else is "expected" or "by convention". *The kernel enforces; userland persuades.*

### 2. `await world` — PendingInteraction as the blocking-wait primitive

`PendingInteraction` (ADR-009 §6) is promoted from "external actor bookkeeping" to **the kernel's blocking I/O primitive**, used uniformly for every wait on external latency: a human's reply, an external agent's A2A response, a slow API, a CI run.

Semantics:

- **Suspend**: registering a PI ends the worker process (resources drop to zero); the WorkerRun and its session remain durable.
- **Wake**: an inbound message matching the PI's correlation routes to the owning WorkerRun session (PI match precedes SurfaceKey routing) and resumes execution in a fresh process.
- **Time semantics**: expiry, follow-up window, and *politeness-aware retry* — reminders to humans are policy-bounded (e.g. one nudge after N days, then conclude with partial results).
- **Partial response is a normal mode**: a task waiting on 3 humans may legitimately complete with 1 reply after expiry. Readiness is judged by WorkItem dependencies, not by all-or-nothing joins.

### 3. Installed applications — CLI agents as a first-class executor

Extend `executorKind` (ADR-009 §7) with `local_cli_agent`. CLI coding agents are **applications installed on the OS**: they bring their own agent loop, tools, and context management. OpenOmni does not run their reasoning; it does exactly what an OS does for an app:

- spawn (`Bun.spawn`, headless mode, prompt as argv),
- workspace isolation (one task = one git worktree),
- credential injection (coordinator credentials layer),
- resource limits (timeout, cost ceiling),
- exit-status and artifact collection (exit code, diff, test results → feeds verification gates directly).

The `AgentRegistry` grows an **application manifest** per app: capabilities, cost profile, and an evidence-backed track record (success rate per task type), updated by the Governor — the routing table by which work is assigned to apps.

**Connector philosophy: don't manage the inside, observe the boundary.** An installed app runs inside the Owner's local trust boundary — the OS does not sandbox it or re-permission its internals; the app's own permission system, configured by the Owner, governs what happens inside. Over-managing the inside is explicitly rejected. OS control lives at three wires:

- **In** — dispatch decides what task enters; the credentials layer decides what secrets materialize; the worktree decides where it works.
- **Side (question bridge)** — when a headless app needs a decision (permission prompt, clarification), the connector bridges it into the kernel as `resident.ask` (e.g. Claude Code's permission-prompt hook → dispatch → Resident answers within policy or escalates to the Owner). The run suspends and resumes instead of dying.
- **Out** — exit code, diff, and final message form the completion report; the §7 evidence gate decides what claims count.

**Native log ingestion.** Apps keep their own transcripts (JSONL session logs, stream-json output). The connector tails them and (a) stores the raw log as a WorkItem artifact, (b) projects key events — tool calls, errors, token usage — into the journal as app-internal evidence. This single mechanism gives the §7 gate hard evidence for app claims ("tests ran" = the tool-call record exists), gives §8 RCA its autopsy material for app-executed work (the log is the transcript-equivalent), gives cost tracking real token numbers, and gives **stall detection a liveness signal** (no log activity for N minutes → nudge, or kill and mark interrupted). Raw logs never enter sessions — artifact plus journal projection only.

### 4. Evidence ledger with userland daemons

The journal (`BusPersistence`) plus the work ledger (`WorkItemStore`: evidence, verification gates) form the **single feedback substrate**. The kernel only appends; improvement logic lives in userland daemons that read it:

- **Governor v0** — a scheduled worker that aggregates `BusQuery` stats and WorkerRun history, then emits (a) routing hints injected into the Resident's context and (b) policy/skill change proposals as reviewable diffs, applied only after Owner approval.
- Later daemons (same pattern, no kernel changes): cost accounting, worker promotion review, anomaly detection.

Verification gates are wired into the kernel exit path: a worker's completion claim passes through `VerificationGate.automated` (deterministic checks — typecheck, tests, output shape) before the result is written back. **A completion claim without evidence is not a completion.**

One ledger, three consumers: worker promotion, model/app routing, and approval relaxation ("autonomy earned through evidence") all read the same records.

### 5. Durable boot contract

The OS qualification test: **promises survive power loss.**

- Scheduled jobs are persisted (the in-memory `CronJobRegistry` is replaced by a durable store reloaded at boot).
- Open PendingInteractions are restored at boot; a reply arriving after a restart wakes exactly the work that was waiting for it.
- Interrupted runs are recovered (existing recovery module) and offered for resume.

### 6. Execution lanes and the effect-radius rule

Work executes in exactly one of three lanes. The lane is chosen by **how much reasoning execution still requires**, not by size or difficulty:

| Lane | OS analogue | Criterion | Examples |
| --- | --- | --- | --- |
| **Built-in** (Resident direct) | shell built-in | Judgment and perception only — no world mutation | Answer from context, clarify intent, peek at a file (read-only) |
| **Dispatch action** (syscall) | volume key, `kill` | World mutation whose execution needs **zero further reasoning** — the Resident already did the only thinking (decide + compose); what remains is a deterministic call | Turn off a light, send one composed message, create a calendar event, schedule a job |
| **Worker** (process) | launching an application | Execution requires its own reasoning loop — multiple steps, intermediate judgment, partial failure, a completion claim worth verifying | Research, refactoring, negotiation, anything with a verification gate |

Spawning a worker for an atomic action is waste ("slop"); doing multi-step work in the Resident's session is pollution. Felt overhead is the design signal: if a lane feels absurd for the task, the task is in the wrong lane.

**The effect-radius rule** — what separates a plain tool from dispatch. Mechanically `dispatch` is itself a tool; the difference is the radius of the effect:

- **Tool = sandbox-local effect.** Confined to the agent's own workspace and run (read/grep in its worktree, run its own tests). Guarded by tool-permission (fail-closed), invisible to the rest of the system — and legitimately so, because nothing outside the sandbox can be affected.
- **Dispatch = boundary-crossing effect.** Anything touching shared state or other actors: other sessions, humans, schedules, devices, the physical world. Must pass the kernel gate (authorize → route → audit). *A living-room light is shared world state; a file in your own worktree is not.*

The kernel invariant restated for tools: **every boundary-crossing effect goes through dispatch — no side doors.** Consequently, mutating MCP/custom tools must sit behind dispatch handlers; read-only MCP tools (search, lookups) may remain directly attached. The Resident's current direct MCP/custom attachment is an open side door and is removed by the shell demotion.

**Subagent vs worker — extension vs independence.** These are different species, not tiers of one thing:

| | Subagent (`SubagentRuntime`) | Worker (`OnDemandWorkerManager`) |
| --- | --- | --- |
| OS analogue | thread | process |
| Context | selectively inherits the parent's | none inherited — task scope only |
| Identity | none — another angle on the parent's problem | own profile (prompt / tools / model / credentials) |
| Lifecycle | dies with the parent | durable WorkerRun — survives and resumes |
| Ledger | no ticket — part of the parent's work | always ticketed, §7 full course |
| Verification | exempt — output is intermediate reasoning the parent digests | gated — output is an independent deliverable |

Choose by one question: **does the task need my context (extension) or its own footing (independence)?** Needing a different domain's expertise is the strongest independence signal — a domain specialist wants its own profile, and the parent's context would be pollution, not help. The same axis decides verification automatically: extensions are exempt, independents are gated.

Workers are **always isolated processes**, even for small jobs. Agent tasks are dominated by LLM latency (tens of seconds to minutes), so the 1–2s process spawn is noise; a "lightweight in-process worker" would buy nothing and cost a third semantics. What it would have optimized — felt latency — was never the bottleneck. Workers may spawn their own subagents internally (processes have threads), which is how `SubagentRuntime` already runs per ADR-008.

**Device/world control pattern.** Extends the channel invariant: the driver (e.g. a Home Assistant adapter) lives in `apps/server/`, a `device.*` handler is registered in the dispatch registry, and the kernel stays unchanged. *A new device, like a new channel, only touches `apps/server/` plus a handler registration.*

**Peek budget.** The Resident's per-turn tool-call budget (the existing budget hard-stop, e.g. ~5 calls) makes the delegation rule structural rather than prompted: light perception is free, but a task that survives the peek budget without resolving is, by definition, beyond judgment scope — and the Resident's only remaining move is `dispatch`.

### 7. The task ledger — completion reports and the evidence gate

Every Worker-lane task is tracked as a `WorkItem` — the existing (currently dormant) store becomes the system's **process table**. Dispatch actions do not get tickets: atomic operations are already audited by the dispatch log, and ticketing them would be the slop §6 exists to avoid. *Tickets are for work that requires reasoning.*

**Creation contract.** A WorkItem cannot be created without at least one acceptance criterion (`acceptanceCriteria`, structurally enforced via schema `min(1)`). Defining "done" is part of delegating, not an afterthought — a short "done means" list (≤3 bullets) at delegation time; per-task-type templates accumulate later as Skills.

**Completion contract.** Every completion claim must arrive as **deliverable + completion report**. The report is a written account whose claims each reference evidence records in the ledger:

```
completionReport {
  summary
  claims[]: { statement, evidenceIds[] }   // "tests pass" → test-run event id
                                           // "3 sellers contacted" → 3 dispatch receipts
  caveats, followUps
}
```

Verification then runs as three questions, answered by three different parties:

| Question | Answered by | Cost | Mechanism |
| --- | --- | --- | --- |
| **Did it happen?** | Code (gate) | ~0 | Each claim's `evidenceIds` must resolve to real ledger records (dispatch receipts, diffs, test runs, read-back checks). A claim without evidence is void; a report whose core claims lack evidence is **treated as work not done** and bounced before any LLM evaluation. |
| **Is it good?** | Resident | 1 LLM evaluation | Resident judges **report + deliverable + verified evidence only — never the worker transcript**. The report is simultaneously the isolation mechanism (independent judgment per design-philosophy §3) and the distillation unit (the only thing written back toward user-facing context). On failure the Resident names the issue and re-dispatches with it attached. |
| **Was it useful?** | Owner's behavior (`outcome`) | 0, delayed | adopted / corrected / redone / ignored — harvested retroactively by the Governor as ground truth. This also calibrates the Resident's own evaluation: accepted work the Owner keeps correcting is a Resident-leniency signal. |

**Retry policy.** Defaults live on the executor profile (internal workers: 3; CLI apps: per application manifest; humans: not retries but a reminder policy under the social budget), overridable per item (`maxAttempts`). Exhaustion is **kernel-enforced**, not Resident goodwill: the item gains a `waiting_input` blocker and escalates to the Owner ("attempted N times, still failing — change approach?"). This is the structural backstop against cost-burning retry loops.

**Read-back verification.** The "did it happen" gate generalizes beyond code: published content is re-fetched by URL; calendar/email writes are re-queried; research citations are checked by fetching sources and matching quoted passages (structurally blocking hallucinated citations); human work is evidenced by PI resolution records. *Actions leave traces in the world; the gate re-observes the world rather than trusting the claim.*

**Observability.** The ledger doubles as the OS's `ps`: who instructed it (`originSessionId`), where it runs (`workSessionId`), who executes it (`workerRunId`, `executorKind`), attempts, deadlines, what it is blocked on. "Show open tasks" is a ledger query — the first Owner-facing task-manager surface, via chat command first, web view later.

**Schema deltas** required on the existing `WorkItem.Info` (all else is already built — including derived status, blockers, dependencies with cycle detection, and bus events):

| Delta | Purpose |
| --- | --- |
| `originSessionId` / `workSessionId` (split the single `sessionId`) | "Who instructed" vs "where it runs" |
| `workerRunId` + `executorKind` | Join key to the evidence ledger and routing stats |
| `completionReport` | The deliverable-plus-writing obligation, claims → evidence refs |
| `maxAttempts` | Per-item retry override; defaults from executor profile |
| `outcome` (`adopted / corrected / redone / ignored`) | The usefulness signal the Governor weighs highest |

### 8. The Governor — incident-driven structural improvement

The Governor is a **postmortem engine**, not a report generator. A mistake that ends in an apology changes nothing: the next session inherits the same trap and falls into it again. The Governor exists so that every mistake either changes the structure that allowed it, or is consciously accepted and recorded. (This is where P1 "harness first", "failures are first-class data", and P8 "unplanned rescue is a defect signal" converge into one mechanism.)

**Permission formula: read-omniscient, write-minimal.** The Governor reads everything — including worker transcripts. The Resident's transcript isolation exists to prevent evaluation bias; the Governor's job is process autopsy, which requires the process. Its writes are confined to proposals plus the autonomous tier below. It never participates in conversations.

**Two loops:**

- **Fast loop (incident-driven)** — the core. An incident spawns a root-cause analysis (RCA): read the failed WorkItem, its report, the worker transcript, the journal timeline, and the policy/prompt state *at the time* — then classify the cause and prescribe a structural fix.
- **Slow loop (periodic)** — aggregation over the ledger: routing hints per task type, Resident evaluation-leniency calibration (accepted work the Owner keeps correcting), cost accounting.

**Incident lanes:**

| Lane | Triggers | Why |
| --- | --- | --- |
| Immediate | Owner unplanned intervention (P8); `outcome = redone`; **fabricated evidence caught by the gate**; canary breach / rollback; 3rd recurrence of a fingerprint | Strongest signals, rare enough to afford instantly |
| Daily batch | Worker run failures; `outcome = corrected` (after triage); PI expired unanswered; budget hard-stops; cost anomalies | Bulk signals; batching surfaces patterns single incidents hide |

**Storm collapse.** More than N similar incidents per hour collapse into a single storm RCA. The cause taxonomy includes `environmental` (expired credentials, API outage): environmental causes route to an ops alert, never to a policy change — twenty workers failing on one dead API key is one infrastructure incident, not twenty behavioral ones.

**Triage before RCA** (for soft signals like `corrected`): a single occurrence with no fingerprint match is recorded only. Preference-shaped corrections (tone, style) are routed to **memory candidates**, not policy fixes — taste is memory, defects are structure. Two or more occurrences, or any hard signal, get a full RCA.

**Cause taxonomy → fix mapping:**

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

**Autonomy boundary — tighten freely, loosen with approval:**

- **Autonomous**: routing hints; numeric *tightening* (lower retry caps, lower budgets, narrower tool sets); recording and alerting.
- **Approval required**: numeric loosening; skill/prompt/template changes; new verification checks; anything expanding any actor's autonomy.
- **Never (kernel-enforced floor)**: blacklist, social-budget ceilings, approval-tier definitions, safety constraints, kernel code, **its own write permissions**. Proposable, never self-applicable.
- **Rate limits**: at most one active change per fingerprint; at most M autonomous changes per day; every applied change is journaled as an event with a scope tag.

**The ratchet runs through the same pipeline.** Every applied change opens a canary window (the next N tasks of the affected type). Two consecutive same-type failures inside the window → automatic rollback + an immediate-lane RCA *on the change itself* — a bad fix is just another incident whose root cause is a recent change, visible because changes are journaled. No separate regression machinery. Rollback triggers are simple counting rules, not statistics: a personal system's samples are too small for significance, and a false rollback costs only a restore.

**Recurrence ladder (fingerprints).** Each RCA matches-or-creates an incident fingerprint (cause category × task type × failure mode); matching against open fingerprints is mandatory before creating a new one (dedup discipline, as in an issue tracker).

1. First occurrence → fix proposed/applied.
2. Recurrence after the fix → **the fix failed**: reopen with the prior RCA as input, escalate priority.
3. Third occurrence → Owner escalation: "structure is not catching this."

**RCA is itself a §7 WorkItem.** Acceptance criteria: root cause identified with evidence references (journal event IDs); cause category assigned; fix proposed with a **falsifiable prevention check** ("fingerprint X recurrence = 0 over the next 4 weeks"); fingerprint matched-or-created. Completion report required. `outcome` tracked — the Owner's dismissal rate of Governor proposals is the Governor's own track record. There is no meta-Governor: if the dismissal rate climbs, fixing the Governor is the Owner's job (infinite regress stops here by design).

**Fabricated evidence is a first-class offense.** A claim whose `evidenceIds` do not resolve — or that read-back contradicts — is not a quality miss but a false report: immediate-lane RCA, permanently recorded on that executor's reliability track record, directly feeding promotion/trust decisions.

**Owner surface.** Proposals arrive as a weekly digest; immediate pings only for rollbacks, fabricated evidence, and third recurrences. Unreviewed proposals expire after N days (state preserved on the fingerprint). Governor spend is capped as a percentage of total system spend.

### 9. Memory — built-in curation plus a pluggable engine port

Memory follows the Hermes-Agent pattern ([NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent)): a small **built-in memory that always works**, plus a **pluggable external engine port** that augments — never replaces — it. Anamnesis is the first intended plugin, not a dependency; Honcho/Mem0-class providers fit the same port. In OS terms: built-in curated notes are pinned RAM pages, the session store is disk, and the external engine is indexed cold storage.

**Built-in layer (engine-independent, ships first):**

- **Two bounded curated stores**, injected into the Resident's system prompt as a **frozen snapshot** at session start: system notes (environment facts, conventions, lessons; ~800-token budget) and the Owner profile (identity, preferences, communication style; ~500-token budget). The memory tool has `add` / `replace` / `remove` and deliberately **no `read`** — content is always already in context. Mid-session writes persist to disk but render only from the next session, preserving the prefix cache (Hermes's frozen-snapshot pattern, adopted wholesale).
- **Hard character budgets are the structural constraint** (§1 kernel-grade): memory cannot bloat context; growth forces curation — replace and remove are first-class, not afterthoughts.
- **Session search** as a separate axis: FTS5 full-text over the existing session store, exposed as an on-demand tool (millisecond queries, zero token cost until used). Episodic recall without any engine and without curation effort.
- Memory writes ride the autonomy tiers: log-and-report by default, an optional write-approval mode gates every write behind the Owner (Hermes `write_approval` ≈ our Tier 2).

**The engine port (`Memory.Engine`, Zod-first, following the `Storage.Adapter` precedent):**

```
ingest(candidate)            // consume MemoryCandidates (async, non-blocking, fire-and-forget)
recall(query, scope)         // retrieval for context assembly — scope filter is MANDATORY
profile(actorId, question?)  // dialectic user/actor modeling ("what does the Owner prefer for X?")
feedback(memoryId, outcome)  // recalled memory was useful / wrong — engines learn from §7 outcomes too
```

Transport-agnostic (in-process, HTTP, or MCP — Anamnesis is a separate project and will likely sit behind HTTP/MCP). Zero engines configured = built-in layer only, fully functional. Multiple engines may coexist (one for semantic search, one for user modeling), all fed from the same candidate stream.

**Scope filtering is the OpenOmni-specific addition** Hermes does not need: recall results are filtered by executor scope. The Resident recalls across the Owner scope; a Worker recalls only within its task scope — this is how ADR-009 §9's "memory scoped to the relevant task" becomes enforceable. The scope filter lives on the port (kernel side), not in engine goodwill.

**The candidate stream already exists by construction.** `MemoryCandidate { content, scope: owner|domain|project|persona|session, category: preference|rule|lesson|failure|decision|skill, provenance: { workItemHash?, sessionId, author }, confidence }` — emitted from three sources designed in earlier sections: §7 WorkItem completion (high-value outcomes), §8 Governor triage (preference-shaped corrections — "taste is memory, defects are structure"), and explicit Owner requests. Engines consume the stream; the built-in curated store is maintained by the Resident itself via the memory tool.

**Wiring is existing hooks, not new plumbing**: frozen-snapshot injection at the `on_system_prompt` policy timing; periodic persistence nudges at `post_turn`/idle timings; candidate emission on `work_item.completed` bus events. The memory engine never blocks execution — ingest failures degrade to "candidate stays queued," recall failures degrade to "built-in snapshot only."

### Resource model addendum: social budget

Outbound contact with humans spends a resource token budgets do not measure: the Owner's reputation. Budgets gain a third axis alongside tokens and money — per-contact outreach frequency caps, cooldowns, a do-not-contact list, and a disclosure policy (agent-identified vs Owner-voiced, per channel). First contact with a stranger is approval-gated; replies within an existing thread are not. Where a platform forbids automation, egress degrades gracefully to **owner-mediated send** (the system drafts, the Owner taps send) — modeled as just another executor, not an exception.

## Rationale

- **Why a kernel/userland line instead of more policies?** The audits showed the philosophy failing not from too little enforcement but from an unmarked boundary: docs claimed structural guarantees for prompt conventions. Naming the line makes "Structure Determines Behavior" a checkable spec instead of an aspiration — and makes prompt-based control legitimate rather than embarrassing, because it is explicitly userland.
- **Why promote PendingInteraction to the core primitive?** The differentiated capability of a *personal* agent OS is real-world tasks, and real-world tasks are dominated by waiting on people. Durable sessions + disposable processes (already shipped in ADR-008) make day-scale suspension nearly free. This is the one capability the existing substrate is uniquely positioned to deliver.
- **Why model CLI agents as applications?** They already self-manage execution; wrapping them in our ReAct loop would duplicate their runtime. Treating them as `exec()`-style apps reuses the exact services the coordinator already provides (isolation, credentials, limits, recovery) and makes their artifacts (diffs, exit codes) the cheapest possible verification evidence.
- **Why daemons instead of an in-kernel Governor?** Improvement logic will change weekly; the kernel must not. Reading the journal from userland means Governor iterations never destabilize execution — the same reason auditd consumers live outside the kernel.
- **Why a social budget?** Token budgets bound what the system spends; nothing bounds what it spends *of the Owner*. Outreach without frequency/disclosure limits is the highest-blast-radius failure mode this system can have.

## Consequences

### Positive

- Docs and code get a shared vocabulary for "guaranteed vs expected"; overclaiming becomes a lint-able offense.
- The dormant engines (WorkItemStore, BusQuery, writeback hook) get named consumers; "built but unwired" stops being invisible.
- One abstraction (`dispatch.submit` + PI + ledger) covers internal threads, CLI apps, external AI, humans, and the Owner — no special cases.
- Preemption, resume, and crash recovery come almost free from existing session durability.

### Negative

- The Resident must be demoted to a **shell**: read-only perception (`read`/`glob`/`grep`) plus `dispatch` and consultation — its current full toolset (`filesystem`, `execution` categories in `apps/server/src/ingress/bridge.ts`) contradicts the model and must be cut. The delegation tax this surfaces is acceptable: dispatch actions cover atomic mutations, subagent consultation covers context-bound reasoning, and worker spawn cost is noise against LLM latency.
- PendingInteraction is a non-trivial migration (`PendingAsk` → PI is "not a pure rename", per ADR-009).
- Durable cron and boot-time PI restoration add schema and recovery surface.
- Politeness/retry policy for humans is genuinely new design work with no upstream prior art.

### Implementation order (dependency-driven)

1. Task ledger + completion-report gate wiring on the worker lane (§7 — WorkItemStore exists; schema deltas plus exit-path wiring).
2. Governor v0 (§8): incident-triggered RCA pipeline + daily-batch lane + fingerprint registry, with the slow aggregation loop as a scheduled BusQuery consumer (first journal reader; closes the loop).
3. `PendingAsk` → `PendingInteraction` migration + correlation routing (requires ActorIdentity foundations from ADR-009).
4. `local_cli_agent` executor + application manifest (first installed app: Claude Code, dogfooding OpenOmni's own development).
5. Durable cron + boot contract.
6. Resident shell demotion: cut `execution`/mutating tools, add the peek budget, move mutating MCP/custom tools behind dispatch handlers.
7. Social budget axis on outbound dispatch.

## Non-goals

- Multi-tenancy. This is a single-Owner personal OS; that constraint is a moat, not a limitation.
- A general framework or agent marketplace.
- Fully autonomous outbound contact with humans. Approval gates on first contact are designed policy (vision P8), not friction to be optimized away.
- Implementing ADR-007's full policy VM. Dynamic policy loading is the eventual mechanism by which Governor proposals take effect, but Governor v0 ships with static policies plus Owner-applied diffs.
- Rewriting runtime components in systems languages (Rust / Go / Elixir) now. Deferred, not rejected: candidates are the coordinator/kernel daemons (many concurrent waits, watchers, log tailers — BEAM-style supervision trees map naturally onto this architecture), the journal hot path, and worker-entry idle memory footprint. The kernel contracts (dispatch action schemas, IPC framing, Zod-defined protocol) are the language-agnostic boundary that makes incremental polyglot rewrites possible later — and the decision to rewrite should come from the cost/latency ledger (evidence), not instinct. For years the bottleneck will be LLM latency and token cost, not runtime performance.

## Relationship to prior ADRs

- Builds on ADR-005 (workforce model) and ADR-009 (external actors, authority axes, PI schema).
- Names and completes ADR-008's shipped runtime (disposable processes / durable sessions) as the preemption substrate.
- Reframes ADR-007 (Policy Kernel v2) as the future "loadable policy module" mechanism rather than a competing governance design.
