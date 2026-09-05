# Kernel Contract

This document carries the normative contract detail behind [Core Model](core-model.md): the guarantee split, authority evaluation, durable session contract, Governor operating rules, and memory port. It absorbs ADR-009 through ADR-013, which are retired; git history preserves the originals. Like all design docs, it describes targets — implementation truth lives in [Implementation Status](implementation-status.md). It does not sequence delivery or report live issue state; [epic #930](https://github.com/INONONO66/openomni/issues/930) is authoritative for that.

## 1. Kernel and Userland

Every behavioral claim in this project is classified as exactly one of:

- **Kernel (structural guarantee)** — enforced by code; cannot be bypassed by any prompt. Violations are impossible, not discouraged.
- **Userland (convention)** — guided by prompts, skills, and actor profiles. May be violated; violations are observable in the ledger and become Governor evidence.

These are target guarantees. [Implementation Status](implementation-status.md) alone records which mechanisms are currently wired.

### Lanes and the effect-radius rule

The target gives the Resident `built-in`, `action`, and `worker` lanes but no `subagent` lane; a Worker receives sandbox-local built-ins/actions but no Worker-allocation lane. Lane choice follows how much reasoning and independence execution requires, not size or difficulty. Worker messages, Wait, same-domain subagents, `resident.ask`, and policy grants never transfer allocation authority. The communication vocabulary is fixed: `ingress.submit` enters, `dispatch.submit` crosses a boundary, and `bus.publish` projects observations but is not a command-delivery or durable-ledger-write surface.

What separates a plain tool from dispatch is the **radius of the effect**:

- **Tool = sandbox-local effect.** Confined to the executor's own workspace and run (read/grep in its worktree, run its own tests). Guarded by fail-closed tool permission; legitimately invisible to the rest of the system, because nothing outside the sandbox can be affected.
- **Dispatch = boundary-crossing effect.** Anything touching shared state or other actors: other sessions, humans, schedules, devices, the physical world. Must pass the gate (authorize → route → audit). A living-room light is shared world state; a file in your own worktree is not.

Consequently, mutating MCP/custom tools sit behind dispatch handlers; read-only tools (search, lookups) may remain directly attached. A device driver, like a channel adapter, is registered in `apps/openomni` behind a protocol port; core packages stay unchanged.

Subagent vs Worker are different species, not tiers of one thing:

| | Subagent | Worker |
|---|---|---|
| OS analogue | thread | process |
| Context | selectively inherits the parent's | none inherited — task scope only |
| Identity | none — another angle on the parent's problem | own profile (prompt / tools / model / credentials) |
| Lifecycle | dies with the parent | durable child session — survives runtime release and resumes |
| Ledger | no ticket — part of the parent's work | normal session row with `parentId`, role, tree, revision, and lease |
| Verification | exempt — intermediate reasoning the parent digests | gated — an independent deliverable |

Target coordination contract: a subagent is a same-domain, context-sharing extension of a Worker, bounded to the parent grant. The Resident profile receives no subagent lane, and the Worker profile receives no Worker-allocation lane. When a Worker discovers work with independent footing — especially a different domain, permission profile, or verification regime — the target permits either an explicit policy-gated message to an already-existing agent or `resident.ask`; the Resident decides whether to commission a separate Worker. Neither coordination path creates another session, Worker, executor, or budget.

**Target Peek budget.** A Resident per-turn tool-call budget separates light perception from execution. Work that remains unresolved after that budget moves beyond judgment scope, so the target next step is a bounded action or Resident-origin Worker commission rather than a subagent.

### Target boot contract

Promises survive power loss:

1. Due schedules re-enter through unified ingress without a separate scheduling authority.
2. A reply arriving after restart wakes exactly the work or session that was waiting without allocating a replacement Worker.
3. Interrupted attempts remain identifiable and resumable after boot recovery.

### Installed applications — the connector contract

CLI coding agents (Claude Code, Codex, OpenCode) are installed applications: they bring their own agent loop, tools, and context management. The kernel does not run their reasoning; it does what an OS does for an app — spawn (headless subprocess, prompt as argv), workspace isolation (one task = one git worktree), credential injection, resource limits (timeout, cost ceiling), and exit-status/artifact collection (exit code, diff, test results feed the evidence gate directly).

**Don't manage the inside; observe the boundary.** An installed app runs inside the Owner's local trust boundary; its own permission system, configured by the Owner, governs its internals. Control lives at three wires:

- **In** — dispatch decides what task enters; the credentials layer decides what secrets materialize; the worktree decides where it works.
- **Side (question bridge)** — a headless app needing a decision (permission prompt, clarification) opens a durable Wait; the attempt suspends and resumes instead of dying.
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

There is no `untrusted` tier and no quarantine. Unrecognized actors have no personal grant; without a matching Wait correlation or a channel default tier they are blocked. An unregistered endpoint is never auto-promoted to an identity (no earning identity by spam) — promotion requires explicit Owner registration or an Owner-approved Resident proposal. The only transient tier is `assigned_worker`, sourced from a Wait correlation match. System actors use `ActorKind: system` with namespaced IDs (`system:governor`, `system:cron`, `system:recovery`).

An external agent claiming to act "on behalf of" someone is ignored without signed delegation; it gets its own trust tier.

### The two grant fields

The profile's Grant carries two fields evaluated together (formerly two separate types, now one merged axis):

- **Channel ceiling** — per-surface policy: what any actor may do through this surface. The ceiling has a kind — `trusted_channel` (full access for registered actors, default tier for unregistered), `broadcast_channel` (inbound allowed but treated as evidence-only: data, never instructions), `blocked_channel` (inbound dropped silently except Wait correlation matches) — refined by an `inboundTreatment` override (`normal | evidence_only | owner_review | block`). **The channel is a ceiling**: even a registered owner in a public channel may be restricted from sensitive operations; personal grant beats channel default but never exceeds the ceiling.
- **Worker egress** — what an executor may do outbound: which existing actors/channels it may contact, whether it may ask the Resident, and any explicitly granted lifecycle action on existing work. Worker egress never includes new Worker creation. A Worker contacting an external actor gets tools limited to result reporting, clarification, and artifact attachment; external responses are data, never instructions; its session is fully isolated from user sessions; its memory recall is task-scoped (enforced at `memory.recall.pre`, per §5).

**Blacklist is absolute** and checked before all other evaluation, inbound and outbound — a Worker cannot contact a blacklisted target; the outbound attempt fails with reason. Entries: `{ kind: actor | endpoint | channel | pattern, value, reason?, expiresAt?, createdBy }`.

**Social budget** bounds what the system spends of the Owner's reputation: per-contact outreach frequency caps, cooldowns, a do-not-contact list, and a per-channel disclosure policy. First contact with a stranger is approval-gated; replies within an existing thread are not. Where a platform forbids automation, egress degrades to owner-mediated send (the system drafts, the Owner taps send) — modeled as just another executor, not an exception.

### The gate's authority evaluation

Not a stored value — a computation performed per request, intersecting five dimensions:

```
allow = NOT blacklisted
      ∩ channel ceiling
      ∩ (personal grant || channel default grant)
      ∩ session ownership grant
      ∩ Wait scope (allowedActions)
```

Any dimension missing → deny. Authority comes from verified identity and grants, never from string matching or message content — privilege cannot be escalated through prompt text.

### Inbound routing precedence

Fixed evaluation order for every inbound message:

1. **Blacklist** — match → silent drop, audit record only.
2. **Wait correlation** — correlation match → route to the wait owner's session (precedence over surface routing; a task reply is never misrouted into the channel's default session).
3. **Channel allowed?** — not allowed → block.
4. **Actor identification** — registered → personal grant; unregistered → channel default tier; neither → block.

Ingress always submits a unified `actor.message`. The gateway's routing decision — wait/surface precedence — is authoritative for which session receives the message ([gateway-design.md](gateway-design.md) §8.5). On a Wait correlation match the router delivers into the wait owner's session with `waitContext` attached (wait id plus the matched allowed action) under a transient `assigned_worker` tier; dispatch decides brain-side work placement, never delivery re-routing. Ingress stays channel-agnostic and stateless about lifecycle. Surface routing and the wait store remain separate: the surface answers "what is this endpoint's default session?", the wait store answers "is this a reply to a specific outstanding request?" — merging them would break concurrent task replies on one channel.

### Durable session identity and runtime ownership

Every native Resident or worker is a normal durable session row. The row carries `id`, nullable `parentId`, role (`resident | worker`), state, revision, generation pointers, and lease owner/fence/expiry. A worker row points to the session that commissioned it and owns an independent lease and revision; there is no WorkItem/Attempt or synthetic `delegation-*` session identity.

`session({id, role, runner, tools, system})` is the sole live consumer surface. Durable existence is independent of the in-memory handle: terminal idle with an empty inbox releases runtime immediately, while `get()` and `watch()` read without waking it. A committed prompt or alarm doorbell rehydrates the runner from the tree. Before runner entry the current fence commits a `turn` intent with a pre-minted result ID and pinned tool/system/policy generation; the same ID seals one terminal. Heartbeat loss aborts the runner and prevents a stale late commit. Startup sweeps intent-without-terminal turns before channel binding and resumes from their last completed boundary, with a persisted budget of ten.

### Wait and existing-agent messaging

Existing-agent messaging requires an explicit grant and targets an already allocated actor/session. It creates no session, Worker, executor, or budget and cannot convey Worker-allocation authority. Fire-and-forget records its delivery outcome and creates no Wait. The awaited form creates exactly one durable Wait owned by the waiting session. `PendingAsk` and `PendingInteraction` were this primitive's transitional code names; #215 absorbed them and migration 0025 dropped their persisted tables — the durable Wait is the only wait primitive.

- **Suspend and restart**: the Wait is appended before suspension; process exit releases compute while the attempt, session, and Wait remain durable. Boot folds the Wait, and a correlated response resumes execution in a fresh process without creating a replacement Worker.
- **Deterministic correlation**: explicit reply/message, thread, and nonce-bound token identities take precedence over any single-open fallback. Duplicate response IDs are idempotent. Multiple matches are never guessed: the response is staged and disambiguation is dispatched to the Resident, or to the Owner for an Owner-initiated Wait.
- **Time and cancellation**: deadline expiry, cancellation, follow-up window, and policy-bounded reminders produce audit records. A late response inside the follow-up window attaches as supplementary information; after it, registered senders return to normal routing and unregistered senders remain blocked. Cancellation or expiry never silently reopens work.
- **Partial response**: a resolution policy may declare quorum N-of-M over expected responders. Responses attach as they arrive; quorum resolves the Wait. Deadline with fewer than N resolves with `partial: true`, and dependencies evaluate the responses that arrived rather than imposing an all-or-nothing join.

Contract fields: `{ id, ownerRef: { kind: workItem | session, id }, expectedResponders[], targetActorId?, endpointId?, channelId?, correlation: { tokenHash?, threadId?, replyToMessageId?, externalConversationId? }, allowedActions: (report_result | ask_clarification | attach_artifact | decline_task)[], resolutionPolicy, quorum?, status, deadline, cancelledAt?, partial, followUpWindow }`. Lifecycle is `open → resolved | follow_up | expired | cancelled`; every transition, timeout, cancellation, late or ambiguous response, duplicate, and partial continuation is recorded.

### Jester evaluation and authorized egress

1. The kernel host creates an `evaluationId`, assembles bounded allowed input, and invokes the Jester.
2. The Jester returns only `silent` or `{ semanticQuestion, lens, fingerprint }`. It returns no target, command, rendered prose, authority verdict, or effect. Its lens is exactly one of `premise | evidence | scope_tunnel_vision | alternative | consistency | stakes | audience_tone`.
3. The host records `jester.evaluated`. Silence terminates. For a challenge the host independently applies mute/cooldown, system-wide policy, kernel-observed stakes, and the existing notification budget. A suppressed target result remains silent.
4. For an authorized result, the host passes exactly one semantic question to Voice and then to `dispatch.submit`, record-before-act. The Voice target is rendering-only and preserves the question, lens, disposition, and silence state. Only verified delivery creates `jester.raised` linked to the evaluation and receipt. `bus.publish` observes these records and is not a delivery path.
5. Later records under the same ID may be `answered_with_evidence` with evidence references or `conceded`. A mature adjudicated raised challenge becomes exactly one of `adopted | dismissed`; `muted` is independent Owner control rather than an adjudication.

The required base discrimination set is exactly fourteen fixtures:

| Lens | Positive fixture | Negative fixture |
| --- | --- | --- |
| `premise` | Unsupported premise | Explicit supported premises |
| `evidence` | Claim outruns or conflicts with evidence | Claim bounded by evidence |
| `scope_tunnel_vision` | Material scope omitted | Scope deliberately sufficient |
| `alternative` | Material alternative ignored | Alternatives considered or immaterial |
| `consistency` | Conflicts with a recorded decision | Consistent or explicit supersession |
| `stakes` | Treatment mismatched to observed stakes | Proportional treatment |
| `audience_tone` | Material audience/register mismatch | Appropriate audience/register |

Cross-cutting proofs cover silence, one-question selection for multi-lens input, cooldown, mute, and Voice preservation; they do not add a lens.

### L2 action executor

Every native `prompt`, `turn`, `llm`, and `tool` operation crosses the session-pinned executor, which evaluates the compiled pre bucket before the body runs and the post bucket over the result. Each evaluation commits its own `policy.decision` action, so the durable tree carries the verdict even when nothing else is appended.

Who owns the action record differs by kind. `llm` and `tool` operations are executor-owned: the executor commits an intent before invoking the body and exactly one linked terminal result (`executed`, `blocked_post`, or typed `failed`); a retried model call adds a child `attempt` intent/result pair per attempt. `prompt` and `turn` are decided over records the session machine already owns, the durable inbox action and the turn envelope, so the executor adds policy decisions and a verdict, never a duplicate intent or result. A pre denial never invokes the body, and for the executor-owned kinds it commits no intent. Post denial records `reverted` when a reverter exists and `irreversible` otherwise. Tool lifecycle observations are projections emitted only after the corresponding intent/result commit; observations are never authority or truth.

Policy authority is the immutable compiled row snapshot pinned by the durable session generation. There is no caller-owned callback policy engine or callback registration surface. The OpenOmni boot composition seeds the kernel's mandatory policy rows into durable storage before sessions are materialized; a generation without the mandatory row compiles to a fail-closed snapshot and refuses the turn.

### Executor kinds

`executorKind` is a WorkItem field:

| executorKind | Execution | Wait |
|---|---|---|
| `internal_chat_agent` | internal agent loop | no |
| `external_api` | HTTP/SDK call | optional (slow APIs) |
| `a2a` | A2A protocol message | yes |
| `human_channel` | message via channel | yes (always) |
| `connector_endpoint` | installed application (§1) | via question bridge |

For installed apps the coarse kind is recorded for retry and reporting metadata; provider identity lives in the connector installation and its endpoint. Spawning a `human_channel` or `a2a` executor does not start an agent loop — it sends a message and enters `waiting_input`. Workers never spawn new Workers, regardless of trust tier. A Worker may communicate with an already-existing agent when its egress grant permits, ask the Resident to allocate independent work, or use a separately granted lifecycle action on existing work.

### Scenario traces

Five target decision traces; every one passes channel adapter → ingress → dispatch.

1. **Owner DM (baseline).** Telegram DM → ingress resolves `(telegram, tg_kim)` → owner identity → dispatch: no blacklist, no wait correlation, trusted channel, owner tier → allow → Resident delivery on the Owner's surface session.
2. **Task outreach.** The Resident spawns a `human_channel` executor targeting an unknown seller: blacklist checked on the target, resident tier may spawn → child session (work-item-owned, `worker_interaction`), attempt enters `waiting_input`, a Wait opens (`tokenHash`, allowedActions `[report_result, ask_clarification, decline_task]`, 24h follow-up window) → outbound message carries the token. The Owner's session stays clean.
3. **External reply, matched.** Seller replies hours later; identity resolution returns null (unregistered) → dispatch: blacklist no, correlation matches the open Wait → semantics elevated to reply, target/session overridden to the work session, transient `assigned_worker` tier, action within `allowedActions` → allow; the Wait moves `open → resolved`; the reply is projected into the work session, the attempt resumes, completes, and the distilled result returns to the Resident. The seller never becomes a registered identity.
4. **Public channel, unsolicited.** Unknown Slack member mentions the bot: no wait match; channel ceiling is `broadcast_channel` / default tier `observer` / `evidence_only` → message accepted as data, never instruction; the Resident may reply, ignore, or notify the Owner — no worker spawn allowed. (`inboundTreatment: block` → silent drop with audit record; `owner_review` → queued for approval.)
5. **External AI API call.** The Resident spawns an `external_api` executor (provider/model target): blacklist no, tier allows → child work session; execution is a raw HTTP client, not a channel adapter; synchronous, so no Wait; response completes the attempt and the distilled result returns to the Resident.

## 3. Work Items and the Evidence Gate

Every independently delegated task is a `WorkItem` — the process table. Dispatch actions do not get tickets (atomic operations are already audited by the dispatch record); same-domain subagent output is exempt end-to-end (intermediate reasoning the parent digests). Tickets are for work that requires independent reasoning.

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

**Contract-closing authority (#490).** Because every unit of OpenOmni work is a WorkItem contract, `completed` is not a Worker exit status, Todo/Goal projection, criterion verdict, or generic `passed` bit. It is the kernel's durable declaration that the obligation represented by the **current contract revision and basis** may be closed. Four layers remain distinct:

| Layer | Meaning | May commit `CompletionTerminalReceipt`? |
|---|---|---|
| Progress projection | Plan/Todo state such as pending, in-progress, or done | No |
| Attempt outcome | One execution settled as succeeded, failed, interrupted, or cancelled | No |
| Criterion result | Current evidence yields `verified`, `refuted`, `inconclusive`, or `asserted` for one stable criterion ID | No |
| WorkItem lifecycle | The durable obligation remains open, blocked, failed, cancelled, or completed | Only through completion admission |

Owner outcome (`adopted | corrected | redone | ignored`) is a later calibration signal and never rewrites the historical admission.

The target fact flow is domain-neutral:

```text
WorkItem contract revision + stable acceptance criteria
  -> ClaimSubmitted
  -> ObservationRecorded
  -> CriterionResult
  -> CriterionResultInvalidated?
  -> work.complete.requested
  -> work.complete.pre
  -> CompletionAdmission
  -> commit CompletionTerminalReceipt(admissionId) by WorkItem row CAS
  -> publish work_item.completed.v2 observer projection (best-effort)
```

- A **claim** is claimant testimony bound to one criterion, never a verdict.
- An **observation** records producer, subject, basis, provenance/artifacts, parents, and observation time; it carries no generic truth bit.
- A **criterion result** records one scoped verdict, the exact checked predicate for `verified`, `refuted`, or `inconclusive` results, observation and verifier references, assumptions, basis, scope, and residual risk. An `asserted` result carries no `checkedPredicate`, because no predicate was checked.
- An executable verifier result may satisfy only the persisted criterion whose text exactly matches that checked predicate. Citation support is the explicit exception because its frozen classifier evaluates the persisted criterion text directly. An unrelated green predicate never closes another criterion.
- Invalidation is a separate append-only fact. A historical result remains true of its recorded basis but is excluded from the current effective-result fold after contract, subject, assumption, verifier, artifact, or basis drift.
- **CompletionAdmission** records contract revision, current basis, effective result IDs, unresolved criterion IDs, policy/stakes references, residual risks, reason codes, and exactly one decision: `admit | block | escalate | owner_override`. Owner override carries a receipt and never promotes an underlying result to `verified`.

The completion decision performs no evidence acquisition: no command, network, clock, subprocess, LLM, sensor, or connector call. Producers run before the boundary and submit typed facts without creating domain profiles or alternate completion authorities in the kernel. The admission fold sees only stable criteria, current results and invalidations, blockers, basis/revision, policy, stakes, and Owner authority. An effect intent recorded in the WorkItem's current attempt scope that is outcome-less or `unknown` folds as an unresolved blocker: admission cannot admit until reconciliation records its terminal `confirmed` or `failed` outcome or Owner overrides with a receipt.

Terminal ordering is record-before-act:

```text
fold current contract/evidence state
  -> dispatch work.complete.pre
  -> append CompletionAdmission(expectedHead)
  -> confirm contractRevision/basis by CAS
  -> commit CompletionTerminalReceipt(admissionId) by WorkItem row CAS
  -> publish work_item.completed.v2 observer projection (best-effort)
```

The origin projector must map Resident, external actor (API/A2A/human), replay, recovery, and identity-qualified SDK/internal integrations into the same canonical origin classes without a fallback branch. No caller may bypass admission through a direct store completion. A stale expected head, contract revision, criterion set, blocker, result, policy, or basis forces re-evaluation rather than completion.

**Verification — three questions, three parties:**

| Question | Answered by | Cost | Mechanism |
|---|---|---|---|
| Did it happen? | code | ~0 | Every claim's `evidenceIds` must resolve to passing WorkItem-local evidence. Observations and scoped criterion results are distinct facts; completion admission consumes their current fold and cannot infer truth from claimant self-report. |
| Is it good? | Resident | 1 LLM evaluation | judges report + deliverable + verified evidence only — never the worker transcript. On failure, names the issue and re-dispatches with it attached. |
| Was it useful? | Owner's behavior (`outcome`) | 0, delayed | adopted / corrected / redone / ignored — harvested retroactively by the Governor as ground truth; also calibrates the Resident's evaluation leniency. |

The structural gate runs first for cost shape: an evidence-less bluff is rejected without spending an LLM call. The Resident-as-evaluator is consistent with "the entity that did the work doesn't grade it"; its residual selection bias is checked by the third question, where time is the evaluator.

**Read-back verification.** The gate re-observes the world rather than trusting the claim: published content is re-fetched by URL; calendar/email writes are re-queried; research citations are checked by fetching sources and matching quoted passages (structurally blocking hallucinated citations); human work is evidenced by Wait resolution records.

**Retry policy.** Defaults live on the executor profile (internal workers: 3; installed apps: per connector definition; humans: not retries but a reminder policy under the social budget), overridable per item via `maxAttempts`. Exhaustion is kernel-enforced: the item gains a `waiting_input` blocker and escalates to the Owner ("attempted N times, still failing — change approach?"). This is the structural backstop against cost-burning retry loops.

## 4. Governor Contract

### Access contract

**Permission formula: read-omniscient, write-minimal.** The target grants scheduled or periodic Governor analysis ambient authority to selectively query raw transcripts and complete ledger records without a per-query or per-analysis Owner grant. Its access contract requires every read to be bounded to a recorded analysis query and audited with the evaluation/loop, query scope, records accessed, time, and outcome; the target host rejects an unscoped read. Raw records stay outside Owner, Resident, Worker, and other user-facing session state; only derived findings may leave through the unchanged authorized result path.

The target read capability excludes policy, Skill, disclosure, remediation, egress, access-grant, write, and loosening authority. Governor writes remain confined to proposals plus the autonomous tightening tier below, and the role stays outside conversations.

**Two loops:**

- **Fast loop (incident-driven, the core).** An incident spawns a root-cause analysis: read the failed WorkItem, its report, the raw transcript, the ledger timeline, and the policy/prompt state *at the time* — classify the cause, prescribe a structural fix so recurrence is impossible. Never an apology: reflection that leaves nothing in the environment repeats the mistake.
- **Slow loop (periodic).** Aggregation over the ledger: routing hints per task type, Resident evaluation-leniency calibration (accepted work the Owner keeps correcting), cost accounting.
**Jester scoring.** The Governor computes Jester precision only over mature, adjudicated `jester.raised` challenges: `B5 = adopted / (adopted + dismissed)`. When `adopted + dismissed = 0`, B5 is `insufficient_data` and no precision-based demotion decision is evaluated. Answers with evidence and concessions are reported as separate signals, not denominator states; muted volume is an independent kill signal.

**Incident lanes:**

| Lane | Triggers |
|---|---|
| Immediate | Owner unplanned intervention; `outcome = redone`; fabricated evidence caught by the gate; canary breach / rollback; 3rd recurrence of a fingerprint |
| Daily batch | attempt failures; `outcome = corrected` (after triage); Wait expired unanswered; budget hard-stops; cost anomalies |

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

Normative promotion of the 2026-07-09 determinism/verification round (machine-local research original: `foundation-formal.local.md`). Mechanized primitives now include the #467 vocabulary/tool/schema checks, deterministic verifier registry, and replay-conformance library driver. The registry is intentionally scoped-result-only and the replay functions operate on supplied records; #490 owns completion admission, #510 owns durable ledger wiring, and #493 owns archived projection/replay integration. Framing first, and honestly: this is an **accountability contract, not a correctness proof**. Determinism and accuracy are independent axes (a fully deterministic agent can be reliably wrong), and hallucination detection without an external oracle is impossible — so the contract makes behavior recorded, bounded, and replayable; it does not make outputs true.

### State and the ledger fold

- Internal state is a fold: `S = fold(apply, S₀, L)` over the append-only ledger, partitioned per owner key. `apply` is pure — no clock, no randomness, no live reads, no external calls. Nondeterministic values are captured **as events at write time** and never re-derived on replay.
- **Determinism contract = command-sequence identity**: same inputs must produce the same command sequence, not byte-identical outputs. A replay that attempts a step absent from the ledger fails **loudly** as a nondeterminism error — never silent fold corruption. A static replay-fidelity 1.0 on one golden trace is not accepted as determinism evidence.
- **The gate uses the durable ledger write for record-before-act**: target `Ledger.append(event, expectedHead)` is a per-owner-key serialized compare-and-append with retry on conflict. The gate evaluates against exactly the state it commits on and awaits that commit before acting, closing the check-then-act TOCTOU (two workers passing one budget gate). `bus.publish` is downstream observation/projection, not the append enforcement point. [Implementation Status](implementation-status.md) alone records the current durable-write path.
- **Attempt identity is execution-instance identity, not content identity.** `attemptId` is opaque, immutable, and globally unique; `attemptSeq` is monotonically allocated per WorkItem by serialized append and never reused; nullable `retryOf` points to a prior `attemptId` as lineage, not equivalence. Identical retries coexist as separate rows with different IDs/sequences.
- **Equivalence is separate.** `contentFingerprint` covers canonical task input, handler/reducer code, model/config, upstream fingerprints, and dependency-lock identity. `environmentFingerprint` covers relevant runtime/OS/architecture, dependency/tool/policy/verifier/schema versions, provider/model parameters, and redacted configuration identity; secrets contribute only non-reversible version/reference IDs. Both fingerprints may repeat across attempts.
- **Replay/cache vocabulary is re-fileable, not shipped**: the `cacheKey`, `replayKey`, and `nondeterminismManifest` protocol schemas were removed when #493 closed as superseded (Owner no-slop ruling; the deterministic-replay ambition tracks #459). The three laws below bind the re-filed contract, not current wiring — [Implementation Status](implementation-status.md) records the current state.
- **Cache identity is lookup-only.** `cacheKey` is an explicit equivalence lookup derived from the content fingerprint plus a declared deterministic environment subset, never a row key. A hit still creates a new attempt and records `reusedFromAttemptId`.
- **Replay identity is replay-of-record only.** `replayKey` binds an immutable archived range/cassette, environment fingerprint, schema/upcast versions, and the nondeterminism-manifest hash. It is never a cache key.
- **Nondeterminism is manifest data.** `nondeterminismManifest` captures consumed clocks/time zones, random seeds/bytes, model sampling/output/provider request ID, network/tool/device responses, ordering/concurrency choices, generated IDs, environment reads, and human/source inputs. Secrets remain redacted with provenance/version. Missing inputs, unexpected commands, or incompatible environment/upcast fail loudly.
- **Replay has zero live effects.** Recorded outputs substitute for LLM, network, tool, and device calls. A what-if or fork is a separately labeled new attempt, never replay.
- **Event schema evolution**: field renames and semantic re-meanings are forbidden (content-addressing cannot detect them) — a changed meaning is a new event type; shape evolution is upcast-on-read. Enforced as a lint in #467.
- **External effects are not fold state**: they follow intent → idempotent effect (keyed by event id) → confirmed/failed → boot reconciliation. The ledger is authoritative for internal state and eventually-consistent, via reconciliation, for the world.
- **Hash chain stance (2026-07-09 reconciliation)**: the chain stays on the write path; boot verifies the tail only — a broken tail becomes a `chain-break` event plus a Governor incident, never a boot refusal; full-chain verification runs only as the offline restore-drill gate (#226).

### Verification typing

`judge(claim, evidence, S) → { verified | asserted | refuted | inconclusive } × checked_predicate`.

- `verified` always stores **which predicate was checked** ("URL returned 200 and contains the quoted string" — not "the claim is true"). `guaranteed` remains reserved for code-enforced kernel behavior.
- `inconclusive` means an applicable proof attempt could not decide the criterion from the current information; it does not silently pass at low stakes. Verifier crash, malformed output, or capability violation is a separate verification-error fact and also blocks the affected required criterion.
- A claim with no deterministic verifier is typed `asserted` — a first-class trust signal, not a silent pass. A **high-stakes `asserted` raises to the Owner**.
- Admission (#490): missing, `refuted`, `inconclusive`, invalidated, basis-mismatched, or verification-error required criteria block. An explicit policy may admit a low-stakes `asserted` criterion while recording residual risk; high-stakes unresolved assertions escalate to the Owner. Owner override is a separate admission receipt and never changes the underlying verdict. Stakes are computed from **kernel-observed windowed ledger state**, never actor self-report (#469) — N small actions in a window accumulate to the stakes of the large action they compose.
- **Verifiers are deterministic code, sandboxed** (no network, no clock, no subprocess; deny-by-default) — purity by capability, not by naming convention. **No LLM-in-verifier.** Four families, strongest first: executable re-check > citation/quote match > frozen-NLI support > constrained-decoding validity (validity only, never promoted to truth). Every verifier's bench must demonstrate discrimination (returns `refuted` on a known-bad input).
- Language discipline: `replay-of-record` (reconstructing what happened — what this system provides) is never conflated with `deterministic regeneration` (re-running the model to identical outputs — not provided).

### Observability surface

The source of truth for a run is its session action tree and revisioned row; observations are at-most-once notifications, never replay truth. `s.get()` returns the authoritative lease/state/generation/open-turn snapshot and latest-turn tail without waking execution. `s.watch()` atomically opens a snapshot plus session-filtered subscription; a skipped revision emits a gap and the caller replaces state with `get()`. SQLite remains primary storage, and timelines or exports are derived views. Failure-step attribution by LLM judges is unreliable; durable action results are recorded at the boundary, not reconstructed afterward.

## 7. History

ADR-001 through ADR-008 established the conventions now stated directly in [Architecture](architecture.md) and [Core Model](core-model.md) — package namespacing, Zod-first schemas as the language-agnostic boundary, ring layering, and the durable-session/disposable-runtime split that makes suspension and resume nearly free — along with the persona-era workforce model that evolved into the current role model (Resident / Worker / Jester / Governor as actor profiles, not packages). All are retired; git history preserves the full records.
