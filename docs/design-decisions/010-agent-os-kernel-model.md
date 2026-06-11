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

**Installation — the connector definition is the public ABI.** OpenOmni is not a package manager: binaries are installed by the Owner's existing tooling (brew, bun). Installing an app means installing its **connector** — a printer driver, not a printer. The unit is a *declarative* `AppConnector` definition (Zod-validated data, not code): how to detect the binary and its version (`testedVersions` range), how to spawn headless, where its logs live and how to parse them, how its question bridge is materialized, what evidence it can emit, what credentials and capabilities it **requires**, and its initial routing profile. Because the definition is data conforming to a published schema, a third party can integrate their agent by writing one file and never touching the kernel — this is what passes the [T1 third-party test](../agent-os-definition.md) as an OS rather than as a framework.

Install lifecycle: **discover → register → consent → wire → verify**.

- *discover* — detect installed binaries and versions.
- *consent* — the app-store moment: "Claude Code requests: git, network, `ANTHROPIC_API_KEY`. Allow?" The Owner's one tap sets the app's permission ceiling; from there autonomy grows only through ledger evidence (new apps start with conservative grants and a zero track record).
- *wire* — materialize bridge hooks and credential mappings.
- *verify* — a smoke test: run one trivial task, confirm exit status and log ingestion. "Installed" is itself an evidence-gated claim, not a self-report.

**Version drift is an incident.** CLI agents update frequently and break flags and log formats. A version outside `testedVersions` triggers re-verification: smoke test passes → provisional allow + journal record; fails → app disabled + Owner alert. App upgrades thereby ride the §8 incident pipeline for free.

The same lifecycle generalizes later to other package kinds — channel drivers, device drivers, memory engines (ADR-013 port) — but only executor apps are in scope now; building an app store before having three working connectors would be metaphor cosplay.

### 4. Evidence ledger with userland daemons

The journal (`BusPersistence`) plus the work ledger (`WorkItemStore`: evidence, verification gates) form the **single feedback substrate**. The kernel only appends; improvement logic lives in userland daemons that read it:

- **Governor v0** — a scheduled worker that aggregates `BusQuery` stats and WorkerRun history, then emits (a) routing hints injected into the Resident's context and (b) policy/skill change proposals as reviewable diffs, applied only after Owner approval.
- Later daemons (same pattern, no kernel changes): cost accounting, worker promotion review, anomaly detection.

Verification gates are wired into the kernel exit path: a worker's completion claim passes through `VerificationGate.automated` (deterministic checks — typecheck, tests, output shape) before the result is written back. **A completion claim without evidence is not a completion.**

One ledger, three consumers: worker promotion, model/app routing, and approval relaxation ("autonomy earned through evidence") all read the same records.

### 5. Durable boot contract

The OS qualification test: **promises survive power loss.**

- Target: scheduled jobs are persisted and a boot runner reloads due schedules from the durable `CronJobRegistry` store.
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

### 7. The task ledger — graduated to ADR-011

Every Worker-lane task is a `WorkItem` (the dormant store becomes the process table); creation requires acceptance criteria; completion requires **deliverable + completion report** whose claims reference ledger evidence — *no evidence = work not done*, bounced by code before any LLM evaluation. Verification is three questions answered by three parties: did it happen (gate), is it good (Resident, transcript-isolated), was it useful (Owner's `outcome`, the Governor's ground truth). Retry limits are per-executor with kernel-enforced exhaustion. Full decision record: [ADR-011](./011-task-ledger-evidence-gate.md).

### 8. The Governor — graduated to ADR-012

The Governor is a **postmortem engine**: an incident (failure, Owner correction, unplanned rescue, fabricated evidence) triggers a root-cause analysis over logs and the situation at the time, producing a structural fix so the same mistake cannot recur — never just an apology. Permission formula *read-omniscient, write-minimal*; autonomy boundary *tighten freely, loosen with approval* over a kernel-enforced floor; the regression ratchet runs through the same RCA pipeline (a bad fix is just another incident). Full decision record: [ADR-012](./012-governor-postmortem-engine.md).

### 9. Memory — graduated to ADR-013

Hermes-Agent pattern: a built-in layer that always works (two bounded curated stores injected as a frozen snapshot + FTS5 session search) plus a pluggable `Memory.Engine` port (`ingest / recall / profile / feedback`) with a **kernel-side mandatory scope filter** — Workers recall task scope only. Anamnesis is the first plugin, not a dependency. Full decision record: [ADR-013](./013-memory-engine-port.md).

### Resource model addendum: social budget

Outbound contact with humans spends a resource token budgets do not measure: the Owner's reputation. Budgets gain a third axis alongside tokens and money — per-contact outreach frequency caps, cooldowns, a do-not-contact list, and a disclosure policy (agent-identified vs Owner-voiced, per channel). First contact with a stranger is approval-gated; replies within an existing thread are not. Where a platform forbids automation, egress degrades gracefully to **owner-mediated send** (the system drafts, the Owner taps send) — modeled as just another executor, not an exception.

## Scenario — marketplace inquiry, end-to-end

One trace through every mechanism. Owner: *"Ask the sellers of these 3 marketplace listings for price and condition; when replies come in, compare and recommend."*

1. **Ingress** — Telegram driver normalizes raw → `InboundMessage`; ingress resolves actor and session candidate; dispatch (kernel gate) authorizes and projects into the Resident session.
2. **Shell judgment** — not a direct answer, not an atomic action, needs reasoning → Worker lane (§6). A `WorkItem` is created; creation fails without acceptance criteria, so the Resident writes them: *3 sellers contacted / price + condition obtained / unresponsive marked after 2 days* (ADR-011).
3. **Execution** — the worker sends 3 messages via `dispatch.submit("external.ask")`. The kernel checks the social budget: first contact with strangers → approval gate or owner-mediated send (addendum). Three dispatch receipts land in the journal.
4. **`await world`** — 3 PendingInteractions registered; the worker process exits (resources → 0). A reboot would restore the open PIs (§5). Two days later seller A replies: PI correlation match precedes SurfaceKey routing — the reply wakes *that* WorkerRun, not a personal chat session (§2).
5. **Partial completion** — seller C never replies; on expiry the "mark unresponsive" criterion is satisfied. Partial response is a normal mode.
6. **Evidence gate** — the worker submits deliverable + completion report; claims reference receipts and PI resolutions. An evidence-less claim would void; fabricated evidence would be a first-class offense on the executor's record (ADR-011, ADR-012).
7. **Evaluation** — the Resident judges report + deliverable + verified evidence (never the transcript) against the criteria, then delivers the distilled recommendation to the Owner.
8. **Outcome and learning** — the Owner uses the recommendation (`outcome: adopted`) — ground truth in the ledger. A preference surfaces ("Owner prefers in-person pickup") → memory candidate → `Memory.Engine` ingest (ADR-013). Had the Owner redone the work, the Governor's immediate lane would run an RCA and fix the structure (ADR-012).

Every boundary crossed dispatch; every action left a journal record; every wait survived process death; every claim needed evidence; every reaction fed the loop.

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

1. Task ledger + completion-report gate wiring on the worker lane ([ADR-011](./011-task-ledger-evidence-gate.md) — WorkItemStore exists; schema deltas plus exit-path wiring).
2. Governor v0 ([ADR-012](./012-governor-postmortem-engine.md)): incident-triggered RCA pipeline + daily-batch lane + fingerprint registry, with the slow aggregation loop as a scheduled BusQuery consumer (first journal reader; closes the loop).
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

## Relationship to other ADRs

- Builds on ADR-005 (workforce model) and ADR-009 (external actors, authority axes, PI schema).
- Names and completes ADR-008's shipped runtime (disposable processes / durable sessions) as the preemption substrate.
- Reframes ADR-007 (Policy Kernel v2) as the future "loadable policy module" mechanism rather than a competing governance design.
- Spawned [ADR-011](./011-task-ledger-evidence-gate.md) (task ledger & evidence gate), [ADR-012](./012-governor-postmortem-engine.md) (Governor postmortem engine), and [ADR-013](./013-memory-engine-port.md) (memory engine port) — each graduated from a section of this record once its design matured.
