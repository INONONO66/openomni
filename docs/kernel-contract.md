# Kernel Contract

This document carries the normative contract detail behind [Core Model](core-model.md): the guarantee split, the authority evaluation, the work-item and evidence contracts, the Governor's operating rules, and the memory port. It absorbs ADR-009 through ADR-013, which are retired; git history preserves the originals. Like all design docs, it describes targets — implementation truth lives in [Implementation Status](implementation-status.md).

## 1. Kernel and Userland

Every behavioral claim in this project is classified as exactly one of:

- **Kernel (structural guarantee)** — enforced by code; cannot be bypassed by any prompt. Violations are impossible, not discouraged.
- **Userland (convention)** — guided by prompts, skills, and actor profiles. May be violated; violations are observable in the ledger and become Governor evidence.

Documentation may use "guaranteed", "cannot", or "never" only for kernel items. Everything else is "expected" or "by convention". The kernel enforces; userland persuades.

| Guarantee | Enforced where |
|---|---|
| All boundary-crossing effects pass the gate (single chokepoint) | dispatch |
| Authority evaluation (blacklist → wait correlation → channel ceiling → tier → session) | dispatch, before any handler |
| Budget hard-stops (tokens, money, social budget ceilings) | dispatch / agent loop |
| Tool permission, fail-closed | tool pipeline |
| Session ownership and isolation | ledger |
| Ledger appends (append-only; every decision recorded with the facts it used) | bus |
| WorkItem creation requires ≥1 acceptance criterion | schema (`min(1)`) |
| Completion claims without resolvable evidence are bounced before any LLM evaluation | evidence gate (`work.complete.pre`) |
| Retry exhaustion (attempts > `maxAttempts` → blocker + Owner escalation) | kernel, not Resident goodwill |
| Worker memory recall is task-scoped | `memory.recall.pre` |
| Memory snapshot character budgets | memory built-in layer |
| Boot contract (below) | server boot |

### Lanes and the effect-radius rule

Work executes in exactly one Lane — built-in / action / worker / subagent (see [Core Model § Lanes](core-model.md#lanes); the original three-lane list is superseded by the four-lane table there). The lane is chosen by how much reasoning execution still requires, not by size or difficulty. Spawning a Worker for an atomic action is waste; multi-step work in the Owner's session is pollution. Felt overhead is the design signal: if a lane feels absurd for the task, the task is in the wrong lane.

What separates a plain tool from dispatch is the **radius of the effect**:

- **Tool = sandbox-local effect.** Confined to the executor's own workspace and run (read/grep in its worktree, run its own tests). Guarded by fail-closed tool permission; legitimately invisible to the rest of the system, because nothing outside the sandbox can be affected.
- **Dispatch = boundary-crossing effect.** Anything touching shared state or other actors: other sessions, humans, schedules, devices, the physical world. Must pass the gate (authorize → route → audit). A living-room light is shared world state; a file in your own worktree is not.

Consequently, mutating MCP/custom tools sit behind dispatch handlers; read-only tools (search, lookups) may remain directly attached. A device driver, like a channel adapter, lives in `apps/server` plus one handler registration — the kernel stays unchanged.

Subagent vs Worker are different species, not tiers of one thing:

| | Subagent | Worker |
|---|---|---|
| OS analogue | thread | process |
| Context | selectively inherits the parent's | none inherited — task scope only |
| Identity | none — another angle on the parent's problem | own profile (prompt / tools / model / credentials) |
| Lifecycle | dies with the parent | durable WorkItem attempt — survives and resumes |
| Ledger | no ticket — part of the parent's work | always ticketed |
| Verification | exempt — intermediate reasoning the parent digests | gated — an independent deliverable |

Choose by one question: does the task need my context (extension) or its own footing (independence)? Needing a different domain's expertise is the strongest independence signal. Workers are always isolated processes, even for small jobs — agent tasks are dominated by LLM latency, so process spawn cost is noise, and a "lightweight in-process worker" would buy nothing and cost a third semantics. Workers may spawn their own subagents internally.

**Peek budget.** The Resident's per-turn tool-call budget makes the delegation rule structural: light perception is free, but a task that survives the peek budget without resolving is by definition beyond judgment scope, and the Resident's only remaining move is dispatch.

### Boot contract

Promises survive power loss:

1. Scheduled jobs are persisted; server boot reloads due schedules from the durable cron store. Cron fires enter through dispatch as a system actor (`system:cron`) — no separate internal ingestion path.
2. Open PendingInteractions are restored at boot; a reply arriving after a restart wakes exactly the work that was waiting for it.
3. Interrupted attempts are recovered and offered for resume.

### Installed applications — the connector contract

CLI coding agents (Claude Code, Codex, OpenCode) are installed applications: they bring their own agent loop, tools, and context management. The kernel does not run their reasoning; it does what an OS does for an app — spawn (headless subprocess, prompt as argv), workspace isolation (one task = one git worktree), credential injection, resource limits (timeout, cost ceiling), and exit-status/artifact collection (exit code, diff, test results feed the evidence gate directly).

**Don't manage the inside; observe the boundary.** An installed app runs inside the Owner's local trust boundary; its own permission system, configured by the Owner, governs its internals. Control lives at three wires:

- **In** — dispatch decides what task enters; the credentials layer decides what secrets materialize; the worktree decides where it works.
- **Side (question bridge)** — a headless app needing a decision (permission prompt, clarification) emits a normalized PendingInteraction event; the attempt suspends and resumes instead of dying.
- **Out** — terminal result events route to work completion, where logs, artifacts, token usage, and tool calls are recorded before the evidence gate decides what claims count.

**Native log ingestion.** The connector tails the app's own transcripts (JSONL logs, stream-json), stores the raw log as a WorkItem artifact, and projects key events (tool calls, errors, token usage) into the ledger. One mechanism yields: hard evidence for app claims ("tests ran" = the tool-call record exists), autopsy material for Governor RCA, real cost numbers, and a liveness signal for stall detection (no log activity for N minutes → nudge, or kill and mark interrupted). Raw logs never enter sessions — artifact plus ledger projection only.

**The connector definition is the public ABI.** The kernel is not a package manager: binaries are installed by the Owner's tooling. Installing an app means installing its connector — a declarative, Zod-validated definition (data, not code): how to detect the binary and its version (`testedVersions` range), how to spawn headless, where its logs live and how to parse them, how the question bridge is materialized, what evidence it can emit, what credentials and capabilities it requires, and its initial routing profile. A third party integrates their agent by writing one file, never touching the kernel.

Install lifecycle: **detect → register → consent → wire → verify.** Consent is the app-store moment ("Claude Code requests: git, network, `ANTHROPIC_API_KEY`. Allow?") — the Owner's one tap sets the app's permission ceiling; from there autonomy grows only through ledger evidence (new apps start with conservative grants and a zero track record). Verify is a smoke test: run one trivial task, confirm exit status and log ingestion — "installed" is itself an evidence-gated claim, not a self-report.

Each installation carries an endpoint profile: task types, default timeout/retry/autonomy, driver capabilities, and an evidence-backed track record per task type, updated by the Governor — the routing table by which work is assigned to installed apps. **Version drift is an incident**: a version outside `testedVersions` triggers re-verification — smoke test passes → provisional allow plus ledger record; fails → app disabled plus Owner alert. Upgrades thereby ride the Governor's incident pipeline for free.

## 2. Authority and External Actors

### Identity

Identity resolution is `(channel, externalId) → ActorIdentity?`. One `ActorIdentity` is a canonical subject with N `Endpoint`s; the same person on Telegram and Discord is two endpoint rows linked to one identity, merged only after explicit verification. Classification is orthogonal axes on the profile, never a single role string:

| Axis | Values |
|---|---|
| `ActorKind` | human / ai_agent / service / resident / internal_worker / system |
| `TrustTier` | owner / co_owner / manager / collaborator / observer / assigned_worker |
| `ActorRelationship` (optional descriptive field) | owner / co_owner / collaborator / observer / contractor / external_agent / worker |

There is no `untrusted` tier and no quarantine. Unrecognized actors have no personal grant; without a matching PendingInteraction or a channel default tier they are blocked. An unregistered endpoint is never auto-promoted to an identity (no earning identity by spam) — promotion requires explicit Owner registration or an Owner-approved Resident proposal. The only transient tier is `assigned_worker`, sourced from a PendingInteraction match. System actors use `ActorKind: system` with namespaced IDs (`system:governor`, `system:cron`, `system:recovery`).

An external agent claiming to act "on behalf of" someone is ignored without signed delegation; it gets its own trust tier.

### The two grant fields

The profile's Grant carries two fields evaluated together (formerly two separate types, now one merged axis):

- **Channel ceiling** — per-surface policy: what any actor may do through this surface. The ceiling has a kind — `trusted_channel` (full access for registered actors, default tier for unregistered), `broadcast_channel` (inbound allowed but treated as evidence-only: data, never instructions), `blocked_channel` (inbound dropped silently except PendingInteraction matches) — refined by an `inboundTreatment` override (`normal | evidence_only | owner_review | block`). **The channel is a ceiling**: even a registered owner in a public channel may be restricted from sensitive operations; personal grant beats channel default but never exceeds the ceiling.
- **Worker egress** — what an executor may do outbound: which channels it may contact, whether it may spawn/cancel/schedule. A Worker contacting an external actor gets tools limited to result reporting, clarification, and artifact attachment; external responses are data, never instructions; its session is fully isolated from user sessions; its memory recall is task-scoped (enforced at `memory.recall.pre`, per §5).

**Blacklist is absolute** and checked before all other evaluation, inbound and outbound — a Worker cannot contact a blacklisted target; the outbound attempt fails with reason. Entries: `{ kind: actor | endpoint | channel | pattern, value, reason?, expiresAt?, createdBy }`.

**Social budget** bounds what the system spends of the Owner's reputation: per-contact outreach frequency caps, cooldowns, a do-not-contact list, and a per-channel disclosure policy. First contact with a stranger is approval-gated; replies within an existing thread are not. Where a platform forbids automation, egress degrades to owner-mediated send (the system drafts, the Owner taps send) — modeled as just another executor, not an exception.

### The gate's authority evaluation

Not a stored value — a computation performed per request, intersecting five dimensions:

```
allow = NOT blacklisted
      ∩ channel ceiling
      ∩ (personal grant || channel default grant)
      ∩ session ownership grant
      ∩ PendingInteraction scope (allowedActions)
```

Any dimension missing → deny. Authority comes from verified identity and grants, never from string matching or message content — privilege cannot be escalated through prompt text.

### Inbound routing precedence

Fixed evaluation order for every inbound message:

1. **Blacklist** — match → silent drop, audit record only.
2. **PendingInteraction** — correlation match → route to the owning work session (precedence over surface routing; a task reply is never misrouted into a personal conversation on the same channel).
3. **Channel allowed?** — not allowed → block.
4. **Actor identification** — registered → personal grant; unregistered → channel default tier; neither → block.

Ingress always submits a unified `actor.message`; **dispatch decides**. On a PendingInteraction match, dispatch elevates the semantics to a reply and overrides target, session, and tier (transient `assigned_worker`). Ingress stays channel-agnostic and stateless about lifecycle; the ingress-resolved session is only a default candidate that dispatch may override. Surface routing and the PendingInteraction registry remain separate: the surface answers "what is this endpoint's default conversation?", the registry answers "is this a reply to a specific outstanding request?" — merging them would break concurrent task replies on one channel.

### Session ownership

Every session carries owner, origin, and purpose fields:

- `owner`: `actor` | `work_item` (formerly worker_run — WorkerRun is absorbed into WorkItem attempts) | `system`
- `origin`: `actor_initiated` | `resident_initiated` | `worker_initiated` | `pending_response`
- `purpose`: `user_conversation` | `worker_interaction` | `self_loop`

Rules: a human's first message → actor-owned `user_conversation`; the Resident assigning work to an external actor → work-item-owned `worker_interaction` child session; an external actor answering assigned work routes into the existing work session — no new session. "Response sessions" are not a type; they are a routing result via PendingInteraction. User-facing sessions stay clean: the Owner never sees the seller conversation directly, only the distilled report.

### Wait — waiting on the world

The kernel's blocking-wait primitive, used uniformly for every wait on external latency: a human reply, an A2A response, a slow API, a CI run. One primitive absorbs what were four — PendingAsk, PendingInteraction, WorkItem blockers, and WorkerRun wait states — with `ownerRef: workItem | session` naming who is waiting (#215). Throughout this document, `PendingInteraction` is the transitional code name for the workItem-owned Wait until #215 lands.

- **Suspend**: registering a Wait ends the worker process (resources drop to zero); the WorkItem attempt and its session remain durable.
- **Wake**: a correlation-matched inbound routes to the owning work session and resumes execution in a fresh process — even days later.
- **Time semantics**: expiry, follow-up window, and politeness-aware retry (reminders to humans are policy-bounded — e.g. one nudge after N days, then conclude with partial results).
- **Partial response is a normal mode**: a Wait may declare a quorum N-of-M over correlated responses; responses attach as they arrive; the Wait completes on quorum or expiry, whichever comes first. On expiry with partial responses it resolves with `partial: true`, and downstream WorkItem dependencies evaluate with what arrived — never all-or-nothing joins.

Contract fields: `{ id, ownerRef: { kind: workItem | session, id }, targetActorId?, endpointId, channelId, correlation: { tokenHash?, threadId?, replyToMessageId?, externalConversationId? }, allowedActions: (report_result | ask_clarification | attach_artifact | decline_task)[], quorum?, status, expiresAt, followUpWindow }`.

Lifecycle: `open → resolved | follow_up | expired | cancelled`. Correlation matching precedence: `replyToMessageId` → `threadId` → `tokenHash` → single-open fallback. Ambiguity is a routing outcome, not a status: multiple open matches are never guessed — dispatch routes a disambiguation request to the Resident (or the Owner, for Owner-initiated ones) and holds the message in a per-actor staging slot. After resolution, messages within `followUpWindow` still route to the same work item as supplementary information; after the window, normal routing applies. If the interaction expired before the reply, the attempt has already failed — the late sender is blocked (unregistered) or treated as normal conversation (registered). Correlation tokens are single-use/nonce-bound; duplicate IDs are idempotent. A callback with no correlation is an orphan — the Resident is notified; it is never auto-attached to the latest work item. Fan-out is 1 work item + N PendingInteractions, each resolving independently.

### Executor kinds

`executorKind` is a WorkItem field:

| executorKind | Execution | PendingInteraction |
|---|---|---|
| `internal_chat_agent` | internal agent loop | no |
| `external_api` | HTTP/SDK call | optional (slow APIs) |
| `a2a` | A2A protocol message | yes |
| `human_channel` | message via channel | yes (always) |
| `connector_endpoint` | installed application (§1) | via question bridge |

For installed apps the coarse kind is recorded for retry and reporting metadata; provider identity lives in the connector installation and its endpoint. Spawning a `human_channel` or `a2a` executor does not start an agent loop — it sends a message and enters `waiting_input`. A Worker may control other Workers only with `TrustTier: manager` and an egress grant permitting worker-control actions.

### Scenario traces

Five decision-relevant traces; every one passes server adapter → ingress → dispatch.

1. **Owner DM (baseline).** Telegram DM → ingress resolves `(telegram, tg_kim)` → owner identity → dispatch: no blacklist, no PendingInteraction, trusted channel, owner tier → allow → Resident delivery on the Owner's surface session.
2. **Task outreach.** The Resident spawns a `human_channel` executor targeting an unknown seller: blacklist checked on the target, resident tier may spawn → child session (work-item-owned, `worker_interaction`), attempt enters `waiting_input`, a PendingInteraction opens (`tokenHash`, allowedActions `[report_result, ask_clarification, decline_task]`, 24h follow-up window) → outbound message carries the token. The Owner's session stays clean.
3. **External reply, matched.** Seller replies hours later; identity resolution returns null (unregistered) → dispatch: blacklist no, correlation matches the open interaction → semantics elevated to reply, target/session overridden to the work session, transient `assigned_worker` tier, action within `allowedActions` → allow; interaction `open → resolved`; the reply is projected into the work session, the attempt resumes, completes, and the distilled result returns to the Resident. The seller never becomes a registered identity.
4. **Public channel, unsolicited.** Unknown Slack member mentions the bot: no interaction match; channel ceiling is `broadcast_channel` / default tier `observer` / `evidence_only` → message accepted as data, never instruction; the Resident may reply, ignore, or notify the Owner — no worker spawn allowed. (`inboundTreatment: block` → silent drop with audit record; `owner_review` → queued for approval.)
5. **External AI API call.** The Resident spawns an `external_api` executor (provider/model target): blacklist no, tier allows → child work session; execution is a raw HTTP client, not a channel adapter; synchronous, so no PendingInteraction; response completes the attempt and the distilled result returns to the Resident.

## 3. Work Items and the Evidence Gate

Every Worker-lane task is a `WorkItem` — the process table. Dispatch actions do not get tickets (atomic operations are already audited by the dispatch record); subagent output is exempt end-to-end (intermediate reasoning the parent digests). Tickets are for work that requires reasoning.

**Creation contract.** A WorkItem cannot be created without at least one acceptance criterion (schema-enforced `min(1)`). Defining "done" is part of delegating — a short "done means" list (≤3 bullets) at delegation time; per-task-type templates accumulate as Skills.

**Fields.** `originSessionId` (who instructed) / `workSessionId` (where it runs); `executorKind` and attempt records (formerly a separate WorkerRun — absorbed into `WorkItem.attempts`); acceptance criteria; blockers; dependencies with cycle detection; derived status; deadlines; `maxAttempts`; `completionReport`; `outcome`. The ledger doubles as `ps`: "show open tasks" is a ledger query — chat command first, web view later.

**Completion contract.** Every completion claim arrives as deliverable + CompletionReport:

```
completionReport {
  summary
  claims[]: { statement, evidenceIds[] }   // "tests pass" → test-run event id
                                           // "3 sellers contacted" → 3 dispatch receipts
  caveats, followUps
}
```

One artifact, three jobs: evaluation input (judgment without transcript), distillation unit (raw worker output never enters user-facing context), evidence index (claims bound to ledger records). For humans, the reply itself is the writing — the system assembles the report from ask + reply + receipts. For installed apps, the final message is the report and the diff/exit-code/test-output are the evidence.

**Verification — three questions, three parties:**

| Question | Answered by | Cost | Mechanism |
|---|---|---|---|
| Did it happen? | code (the evidence gate, `work.complete.pre`) | ~0 | every claim's `evidenceIds` must resolve to real ledger records. A claim without evidence is void; a report whose core claims lack evidence is **treated as work not done** and bounced before any LLM evaluation. |
| Is it good? | Resident | 1 LLM evaluation | judges report + deliverable + verified evidence only — never the worker transcript. On failure, names the issue and re-dispatches with it attached. |
| Was it useful? | Owner's behavior (`outcome`) | 0, delayed | adopted / corrected / redone / ignored — harvested retroactively by the Governor as ground truth; also calibrates the Resident's evaluation leniency. |

The structural gate runs first for cost shape: an evidence-less bluff is rejected without spending an LLM call. The Resident-as-evaluator is consistent with "the entity that did the work doesn't grade it"; its residual selection bias is checked by the third question, where time is the evaluator.

**Read-back verification.** The gate re-observes the world rather than trusting the claim: published content is re-fetched by URL; calendar/email writes are re-queried; research citations are checked by fetching sources and matching quoted passages (structurally blocking hallucinated citations); human work is evidenced by PendingInteraction resolution records.

**Retry policy.** Defaults live on the executor profile (internal workers: 3; installed apps: per connector definition; humans: not retries but a reminder policy under the social budget), overridable per item via `maxAttempts`. Exhaustion is kernel-enforced: the item gains a `waiting_input` blocker and escalates to the Owner ("attempted N times, still failing — change approach?"). This is the structural backstop against cost-burning retry loops.

## 4. Governor Contract

**Permission formula: read-omniscient, write-minimal.** The Governor reads everything, including raw worker transcripts (the Resident's transcript isolation serves evaluation independence; autopsy serves causal truth — different jobs, different access). Its writes are confined to proposals plus the autonomous tier below. It never participates in conversations.

**Two loops:**

- **Fast loop (incident-driven, the core).** An incident spawns a root-cause analysis: read the failed WorkItem, its report, the raw transcript, the ledger timeline, and the policy/prompt state *at the time* — classify the cause, prescribe a structural fix so recurrence is impossible. Never an apology: reflection that leaves nothing in the environment repeats the mistake.
- **Slow loop (periodic).** Aggregation over the ledger: routing hints per task type, Resident evaluation-leniency calibration (accepted work the Owner keeps correcting), cost accounting.

**Incident lanes:**

| Lane | Triggers |
|---|---|
| Immediate | Owner unplanned intervention; `outcome = redone`; fabricated evidence caught by the gate; canary breach / rollback; 3rd recurrence of a fingerprint |
| Daily batch | attempt failures; `outcome = corrected` (after triage); PendingInteraction expired unanswered; budget hard-stops; cost anomalies |

**Storm collapse**: more than N similar incidents per hour collapse into one storm RCA. `environmental` causes (expired credentials, API outage) route to an ops alert, never a policy change — twenty workers failing on one dead API key is one infrastructure incident. **Triage before RCA** for soft signals: a single `corrected` with no fingerprint match is recorded only; preference-shaped corrections (tone, style) become memory candidates (§5), not policy fixes — taste is memory, defects are structure. Two or more occurrences, or any hard signal, get a full RCA.

**Cause taxonomy → fix mapping:**

| Root cause | Structural fix | Autonomy tier |
|---|---|---|
| Missing know-how | skill addition/update | approval |
| Wrong worker/app/model for the task | routing hint update | autonomous |
| Ambiguous instruction | delegation / acceptance-criteria template improvement | approval |
| Gate didn't catch it | new verification check for that task type | approval (adds cost) |
| Over-broad permission/tool surface | permission tightening | autonomous |
| Unrealistic budget/limits | numeric adjustment | tighten: autonomous / loosen: approval |
| Model limitation | model-tier escalation proposal | approval |
| Environmental | ops alert to Owner | n/a |

**Autonomy boundary — tighten freely, loosen with approval:**

- Autonomous: routing hints; numeric tightening (lower retry caps, lower budgets, narrower tool sets); recording and alerting.
- Approval required: numeric loosening; skill/prompt/template changes; new verification checks; anything expanding any actor's autonomy.
- Never (kernel-enforced floor): blacklist, social-budget ceilings, approval-tier definitions, safety constraints, kernel code, its own write permissions. Proposable, never self-applicable.
- Rate limits: at most one active change per fingerprint; at most M autonomous changes per day; every applied change is journaled with a scope tag.

**Regression ratchet.** Every applied change opens a canary window (the next N tasks of the affected type). Two consecutive same-type failures inside the window → automatic rollback plus an immediate-lane RCA on the change itself — a bad fix is just another incident whose root cause is a recent change, visible because changes are journaled. No separate regression machinery; rollback triggers are simple counting rules, not statistics (a personal system's samples are too small for significance, and a false rollback costs only a restore).

**Fingerprints are an index, never a taxonomy that constrains diagnosis.** `IncidentFingerprint` = cause category × task type × failure mode. Matching against open fingerprints is mandatory before creating a new one. Recurrence ladder: (1) first occurrence → fix proposed/applied; (2) recurrence after the fix → the fix failed: reopen with the prior RCA as input, escalate priority; (3) third occurrence → Owner escalation ("structure is not catching this").

**RCA is itself a WorkItem.** Acceptance criteria: root cause identified with evidence references (ledger event IDs); cause category assigned; fix proposed with a falsifiable prevention check ("fingerprint X recurrence = 0 over the next 4 weeks"); fingerprint matched-or-created. Completion report required; `outcome` tracked — the Owner's dismissal rate of Governor proposals is the Governor's own track record. There is no meta-Governor: if the dismissal rate climbs, fixing the Governor is the Owner's job. One level of recursion, then a person.

**Fabricated evidence is a first-class offense.** A claim whose `evidenceIds` do not resolve — or that read-back contradicts — is not a quality miss but a false report: immediate-lane RCA, permanently recorded on that executor's reliability track record, directly feeding promotion/trust decisions.

**Owner surface.** Proposals arrive as a weekly digest; immediate pings only for rollbacks, fabricated evidence, and third recurrences. Unreviewed proposals expire after N days (state preserved on the fingerprint). Governor spend is capped as a percentage of total system spend.

## 5. Memory Port

### Built-in layer (zero engines required, ships first)

- **Two bounded curated stores**, injected into the Resident's system prompt as a frozen snapshot at session start: system notes (environment facts, conventions, lessons; ~800-token budget) and the Owner profile (identity, preferences, communication style; ~500-token budget). The memory tool has `add` / `replace` / `remove` and deliberately no `read` — content is always already in context. Mid-session writes persist to disk but render only from the next session, preserving the prefix cache.
- **Hard character budgets are kernel-grade**: memory cannot bloat context; growth forces curation — replace and remove are first-class.
- **Session search** is a separate axis: FTS5 full-text over the session store, exposed as an on-demand tool (millisecond queries, zero token cost until used). Episodic recall without any engine and without curation effort.
- Memory writes ride the autonomy tiers: log-and-report by default; an optional write-approval mode gates every write behind the Owner.

### The engine port

`Memory.Engine`, Zod-first:

```
ingest(candidate)            // consume memory candidates (async, fire-and-forget)
recall(query, scope)         // retrieval for context assembly — scope filter is MANDATORY
profile(actorId, question?)  // actor modeling ("what does the Owner prefer for X?")
feedback(memoryId, outcome)  // recalled memory was useful / wrong — engines learn from outcomes too
```

Transport-agnostic (in-process, HTTP, or MCP). Zero engines configured = built-in layer only, fully functional. Multiple engines may coexist (one for semantic search, one for actor modeling), all fed from the same candidate stream. External engines augment — never replace — the built-in layer.

### Kernel-side scope filter

Recall results are filtered by executor scope: the Resident recalls across the Owner scope; a Worker recalls only within its task scope. **The filter lives on the port — enforced at the `memory.recall.pre` policy point — not in engine goodwill.** A Worker contacting an external human must not be able to recall the Owner's unrelated private context; that is a security invariant, and security invariants do not live in userland.

### Memory-candidate format

```
MemoryCandidate {
  content
  scope: owner | domain | project | persona | session   // "persona" predates the current role model
  category: preference | rule | lesson | failure | decision | skill
  provenance: { workItemHash?, sessionId, author }
  confidence
}
```

Three sources: WorkItem completion (high-value outcomes, §3), Governor preference triage (§4), and explicit Owner requests. Engines consume the stream; the built-in curated stores are maintained by the Resident itself via the memory tool.

### Wiring and precedence

Snapshot injection and persistence nudges ride existing policy points (`prompt.context.pre`, `run.turn.post`; the original pre-v2 timing names are superseded); candidate emission rides work-completion ledger events. The memory engine never blocks execution: ingest failure degrades to "candidate stays queued"; recall failure degrades to "built-in snapshot only".

**Originals win.** Memory is a compressed view of the ledger; on conflict the original record wins, and when memory is load-bearing the Resident re-checks the source before acting on it.

## 6. Determinism, Replay, and Verification

Normative promotion of the 2026-07-09 determinism/verification round (machine-local research original: `foundation-formal.local.md`). Mechanized by the #467 conformance gate. Framing first, and honestly: this is an **accountability contract, not a correctness proof**. Determinism and accuracy are independent axes (a fully deterministic agent can be reliably wrong), and hallucination detection without an external oracle is impossible — so the contract makes behavior recorded, bounded, and replayable; it does not make outputs true.

### State and the ledger fold

- Internal state is a fold: `S = fold(apply, S₀, L)` over the append-only ledger, partitioned per owner key. `apply` is pure — no clock, no randomness, no live reads, no external calls. Nondeterministic values are captured **as events at write time** and never re-derived on replay.
- **Determinism contract = command-sequence identity**: same inputs must produce the same command sequence, not byte-identical outputs. A replay that attempts a step absent from the ledger fails **loudly** as a nondeterminism error — never silent fold corruption. A static replay-fidelity 1.0 on one golden trace is not accepted as determinism evidence.
- **The gate is a per-owner-key serialized compare-and-append**: `append(event, expectedHead)` with retry on conflict. The gate evaluates against exactly the state it commits on, closing the check-then-act TOCTOU (two workers passing one budget gate).
- **Attempts are content-addressed**: `k = h(handler_code_hash, model_id, canonical(input), upstream_keys, dep_lockfile_hash)`. Code or model changes invalidate automatically; identical re-execution results cut off downstream propagation early. Cache keys are not replay keys — replay verifies the recorded environment fingerprint and re-executes loudly on drift.
- **Event schema evolution**: field renames and semantic re-meanings are forbidden (content-addressing cannot detect them) — a changed meaning is a new event type; shape evolution is upcast-on-read. Enforced as a lint in #467.
- **External effects are not fold state**: they follow intent → idempotent effect (keyed by event id) → confirmed/failed → boot reconciliation. The ledger is authoritative for internal state and eventually-consistent, via reconciliation, for the world.
- **Hash chain stance (2026-07-09 reconciliation)**: the chain stays on the write path; boot verifies the tail only — a broken tail becomes a `chain-break` event plus a Governor incident, never a boot refusal; full-chain verification runs only as the offline restore-drill gate (#226).

### Verification typing

`judge(claim, evidence, S) → { verified | asserted | refuted } × checked_predicate`.

- `verified` always stores **which predicate was checked** ("URL returned 200 and contains the quoted string" — not "the claim is true"). `guaranteed` remains reserved for code-enforced kernel behavior.
- Admission: a completion report is admitted iff no claim is `refuted`, and either its stakes are below threshold or every claim is `verified`. Stakes are computed from **kernel-observed windowed ledger state**, never actor self-report (#469) — N small actions in a window accumulate to the stakes of the large action they compose.
- A claim with no deterministic verifier is typed `asserted` — a first-class trust signal, not a silent pass. A **high-stakes `asserted` raises to the Owner**.
- **Verifiers are deterministic code, sandboxed** (no network, no clock, no subprocess; deny-by-default) — purity by capability, not by naming convention. **No LLM-in-verifier.** Four families, strongest first: executable re-check > citation/quote match > frozen-NLI support > constrained-decoding validity (validity only, never promoted to truth). Every verifier's bench must demonstrate discrimination (returns `refuted` on a known-bad input).
- Language discipline: `replay-of-record` (reconstructing what happened — what this system provides) is never conflated with `deterministic regeneration` (re-running the model to identical outputs — not provided).

### Observability surface

The single source of truth for a run is **one wide, flat, greppable structured event per step** (run id, step, op, model, tokens, deterministic verdict `ok|warn|error` assigned at emit time, state hash, prompt hash). Timelines, trees, diffs, and judgments are derived views. The ledger export is derived JSONL over these events — SQLite remains the primary store; the export is regenerable and rotated, and it is the substrate the Governor (and any coding agent) greps. Failure-step attribution by LLM judges is unreliable; verdicts are attached deterministically at emit, not reconstructed afterward.

## 7. History

ADR-001 through ADR-008 established the conventions now stated directly in [Architecture](architecture.md) and [Core Model](core-model.md) — package namespacing, Zod-first schemas as the language-agnostic boundary, ring layering, and the stateless-agent substrate (durable sessions, disposable worker processes) that makes suspension and resume nearly free — along with the persona-era workforce model that evolved into the current role model (Resident / Worker / Jester / Governor as actor profiles, not packages). All are retired; git history preserves the full records.
