# Kernel Contract

This document carries the normative contract detail behind [Core Model](core-model.md): the guarantee split, authority evaluation, durable session contract, and Governor operating rules. It absorbs ADR-009 through ADR-013, which are retired; git history preserves the originals. Like all design docs, it describes targets — implementation truth lives in [Implementation Status](implementation-status.md). It does not sequence delivery or report live issue state; [epic #930](https://github.com/INONONO66/openomni/issues/930) is authoritative for that.

Deletion reconciliation: verified against merged `c4fb7748` on 2026-09-06. The retired task-ticket/completion, built-in memory, blob-store, and dialogue-store contracts are withdrawn, not future kernel obligations. Historical text remains in git history; [SLOP receipts](SLOP.md) distinguish deletion evidence from pending campaign gates. Surviving target sections below do not predeclare unmerged I04-I08/I05 behavior.

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

Consequently, mutating custom tools require boundary authorization; read-only tools (search, lookups) may remain directly attached. The dormant runtime integration client was deleted, so this target is not a claim of a shipped integration host. A device driver, like a channel adapter, is registered in `apps/openomni` behind a protocol port; core packages stay unchanged.

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

CLI coding agents (Claude Code, Codex, OpenCode) are installed applications: they bring their own agent loop, tools, and context management. The kernel does not run their reasoning; it does what an OS does for an app — spawn (headless subprocess, prompt as argv), workspace isolation (one task = one git worktree), credential injection, resource limits (timeout, cost ceiling), and exit-status/evidence collection. This is a connector-host target, not a live blob store or task-completion gate.

**Don't manage the inside; observe the boundary.** An installed app runs inside the Owner's local trust boundary; its own permission system, configured by the Owner, governs its internals. Control lives at three wires:

- **In** — dispatch decides what task enters; the credentials layer decides what secrets materialize; the worktree decides where it works.
- **Side (question bridge)** — a headless app needing a decision (permission prompt, clarification) opens a durable Wait; the attempt suspends and resumes instead of dying.
- **Out** — the target collects exit status, logs, usage, and tool evidence at the external boundary. Their storage/retention and connector execution are not implemented by the retired task-ticket or blob-store domains.

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
- **Worker egress** — what an executor may do outbound: which existing actors/channels it may contact, whether it may ask the Resident, and any explicitly granted lifecycle action on existing work. Worker egress never includes new Worker creation. A Worker contacting an external actor gets tools limited to result reporting, clarification, and artifact attachment; external responses are data, never instructions; its session is isolated from user sessions. No deleted memory policy point or built-in recall port confers authority.

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

Every native Resident or worker is a normal durable session row. The row carries `id`, nullable `parentId`, role (`resident | worker`), state, revision, generation pointers, and lease owner/fence/expiry. A worker row points to the session that commissioned it and owns an independent lease and revision; no separate task-ticket domain or synthetic `delegation-*` session identity is required.

`session({id, role, runner, tools, system})` is the sole live consumer surface. Durable existence is independent of the in-memory handle: terminal idle with an empty inbox releases runtime immediately, while `get()` and `watch()` read without waking it. A committed prompt or alarm doorbell rehydrates the runner from the tree. Before runner entry the current fence commits a `turn` intent with a pre-minted result ID and pinned tool/system/policy generation; the same ID seals one terminal. Heartbeat loss aborts the runner and prevents a stale late commit. Startup sweeps intent-without-terminal turns before channel binding and resumes from their last completed boundary, with a persisted budget of ten.

### Unified message boundary

`sendMessage({to, type, content, replyTo?, deadline?})` enters `gateway.ingest(sender, envelope)`. Session identity is authenticated separately from model input. A/B are compiled message pre-policy rows; post policy is obligation-only. The gateway consumes perimeter facts and L1-projected session facts, and never reads the session store. Session delivery calls the injected inbox commit; new child configuration and first prompt share its transaction. Only executed actor delivery has an accepted/rejected/unknown receipt. A session commit succeeds or throws.

A child terminal supplies parent mail with final text, terminal kind and the original reply binding. Admission must traverse the gateway before the atomic terminal-plus-parent write. Mandatory terminal mail answers the original request under its existing deadline/answer CAS; it never opens a new deadline-bearing request. Session admission commits the deadline alarm, child configuration and inbox in the same ledger transaction. Deadline alarms race replies on the source message action; only one answer/timeout winner changes state.

Table A's egress fact reads the authenticated peer's declared social budget and the destination session's current debit window without charging ingress. A missing peer entry is inapplicable to inbound traffic (unlike cold outbound outreach, which remains zero-default); a correlated Wait answer retains the reply exemption. Explicit do-not-contact, allowance, quiet-hour, cooldown and window/class restrictions select the existing compiled denial row. Correlation consumes the ordered immediate-to-root reply chain before broader thread/token/conversation evidence; multiple matches at the winning level remain ambiguous. Socket pre-admission refusal is an error frame, never an accepted receipt. Current implementation gaps are recorded in Implementation Status, not silently weakened here.

### Wait and existing-agent messaging

Existing-agent messaging requires an explicit grant and targets an already allocated actor/session. It creates no session, Worker, executor, or budget and cannot convey Worker-allocation authority. Fire-and-forget records its delivery outcome and creates no Wait. The awaited form creates exactly one durable Wait owned by the waiting session. `PendingAsk` and `PendingInteraction` were this primitive's transitional code names; #215 absorbed them and migration 0025 dropped their persisted tables — the durable Wait is the only wait primitive.

- **Suspend and restart**: the Wait is appended before suspension; process exit releases compute while the attempt, session, and Wait remain durable. Boot folds the Wait, and a correlated response resumes execution in a fresh process without creating a replacement Worker.
- **Deterministic correlation**: explicit reply/message, thread, and nonce-bound token identities take precedence over any single-open fallback. Duplicate response IDs are idempotent. Multiple matches are never guessed: the response is staged and disambiguation is dispatched to the Resident, or to the Owner for an Owner-initiated Wait.
- **Time and cancellation**: deadline expiry, cancellation, follow-up window, and policy-bounded reminders produce audit records. A late response inside the follow-up window attaches as supplementary information; after it, registered senders return to normal routing and unregistered senders remain blocked. Cancellation or expiry never silently reopens work.
- **Partial response**: a resolution policy may declare quorum N-of-M over expected responders. Responses attach as they arrive; quorum resolves the Wait. Deadline with fewer than N resolves with `partial: true`, and dependencies evaluate the responses that arrived rather than imposing an all-or-nothing join.

Contract fields: `{ id, ownerRef: { kind: session, id }, expectedResponders[], targetActorId?, endpointId?, channelId?, correlation: { tokenHash?, threadId?, replyToMessageId?, externalConversationId? }, allowedActions: (report_result | ask_clarification | attach_artifact | decline_task)[], resolutionPolicy, quorum?, status, deadline, cancelledAt?, partial, followUpWindow }`. Lifecycle is `open → resolved | follow_up | expired | cancelled`; every transition, timeout, cancellation, late or ambiguous response, duplicate, and partial continuation is recorded.

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

## 3. Machine and codemode contract

The machine endpoint is a raw WHERE surface: `MachineHost.list()` and stable
`get(id)` handles expose confined filesystem operations, `exec(cmd, cwd)`, and
`runCode`. Enrollment and daemon offer capabilities intersect fail-closed;
`shell.exec` is distinct from filesystem capabilities and is required for
`exec`. For each exec call the daemon re-resolves the effective export root pathname,
checks cwd containment, and spawns by pathname. Exec does not share the fs
branch's pinned-root invariant: replacing the export-root pathname before a
request changes where exec actually starts (fs keeps reading the root pinned at
attach), and a symlink swap between check and spawn is a bounded, accepted
TOCTOU for now (follow-up #938 in `docs/SLOP.md`). This is
not an OS shell sandbox: commands run as
the daemon user and may exercise that user's other OS authority once started;
Owner grants shell execution knowingly. Codemode consumes these handles through
one `run_code` cell runner, with per-tenant interpreter state and no legacy
machines or filesystem tools.

## 4. Turn termination, not task satisfaction

The old task-ticket, executor-kind, completion-admission and evidence-gate contracts were withdrawn by #940. There is no replacement ticket/evidence store or completion authority. The kernel records that a turn terminated; the model reading the returned letter judges satisfaction. Generic provider attempts remain children of model actions, not a revived task domain. The gateway/session-inbox boundary and retained Wait/approval ownership are distinguished in [Implementation Status](implementation-status.md).

### Session L3 execution contract (#937)

The session invokes stateless runAgent; every model step drains inbox before LLM, after LLM before tools, and after the tool wave, then compacts and evaluates stop policy. Tool waves retain whole-wave preflight/approval, positional results, sequential barriers, and immediate abort release without freeing live raw effects' controlling lease.

One logical `llm` owns ordered attempt children. Only the executor retries and re-admits policy/context; the provider processor performs one attempt. Visible assistant text or a tool call makes a later provider failure terminal. Failed billing remains in attempt evidence and additive usage, while failed partial messages never enter active history. Model/auth resolution, provider classification, retry-after and backoff belong to `@openomni/llm`; cross-provider fallback resolves its own credentials.

Stop policy is ordered: abort/deadline/budget, terminal text, exact-output repetition, toolless stall, blocked recurrence, live wait, continuation. Thresholds come from captured compiled obligations, not role-specific constants. Progress is committed effect/state change, not tool invocation. The neutral openIntent reader and pending executor approvals prevent premature completion. Only a still-armed action created in the current turn permits `waiting/live_wait`; waiting is not approval suspension or a successful result. Generic channel Wait remains a separate lifecycle boundary.

Full assistant/tool snapshots and compaction projections are append-only action results. Terminal resume gets new IDs/latest generation; crash-open recovery uses existing IDs/captured generation. A missing or changed captured executable catalog fails closed rather than substituting the newest definition. No retired task domain, public fact callback, legacy session API or physical history migration is introduced.

## 4. Governor Contract

### Access contract

**Permission formula: read-omniscient, write-minimal.** The target grants scheduled or periodic Governor analysis ambient authority to selectively query raw transcripts and complete ledger records without a per-query or per-analysis Owner grant. Its access contract requires every read to be bounded to a recorded analysis query and audited with the evaluation/loop, query scope, records accessed, time, and outcome; the target host rejects an unscoped read. Raw records stay outside Owner, Resident, Worker, and other user-facing session state; only derived findings may leave through the unchanged authorized result path.

The target read capability excludes policy, Skill, disclosure, remediation, egress, access-grant, write, and loosening authority. Governor writes remain confined to proposals plus the autonomous tightening tier below, and the role stays outside conversations.

**Two loops:**

- **Fast loop (incident-driven, the core).** An incident spawns a root-cause analysis: read the failed session's action evidence, report, raw transcript, ledger timeline, and policy/prompt state *at the time* — classify the cause, prescribe a structural fix so recurrence is impossible. Never an apology: reflection that leaves nothing in the environment repeats the mistake.
- **Slow loop (periodic).** Aggregation over the ledger: routing hints per task type, Resident evaluation-leniency calibration (accepted work the Owner keeps correcting), cost accounting.
**Jester scoring.** The Governor computes Jester precision only over mature, adjudicated `jester.raised` challenges: `B5 = adopted / (adopted + dismissed)`. When `adopted + dismissed = 0`, B5 is `insufficient_data` and no precision-based demotion decision is evaluated. Answers with evidence and concessions are reported as separate signals, not denominator states; muted volume is an independent kill signal.

**Incident lanes:**

| Lane | Triggers |
|---|---|
| Immediate | Owner unplanned intervention; `outcome = redone`; fabricated evidence caught by the gate; canary breach / rollback; 3rd recurrence of a fingerprint |
| Daily batch | attempt failures; `outcome = corrected` (after triage); Wait expired unanswered; budget hard-stops; cost anomalies |

**Storm collapse**: more than N similar incidents per hour collapse into one storm RCA. `environmental` causes (expired credentials, API outage) route to an ops alert, never a policy change — twenty workers failing on one dead API key is one infrastructure incident. **Triage before RCA** for soft signals: a single `corrected` with no fingerprint match is recorded only; preference-shaped corrections (tone, style) are not policy defects. Their persistence requires a separately designed consumer; no deleted memory-candidate port is implied. Two or more occurrences, or any hard signal, get a full RCA.

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

**RCA is a target analysis workflow, not a separate task-ticket contract.** Its report should identify a cause with evidence, propose a falsifiable prevention check, and correlate prior incidents. The Owner's dismissal rate of Governor proposals is a proposed calibration signal, not a currently wired completion store. There is no meta-Governor: if the dismissal rate climbs, fixing the Governor is the Owner's job. One level of recursion, then a person.

**Fabricated evidence is a first-class offense.** A claim whose `evidenceIds` do not resolve — or that read-back contradicts — is not a quality miss but a false report: immediate-lane RCA, permanently recorded on that executor's reliability track record, directly feeding promotion/trust decisions.

**Owner surface.** Proposals arrive as a weekly digest; immediate pings only for rollbacks, fabricated evidence, and third recurrences. Unreviewed proposals expire after N days (state preserved on the fingerprint). Governor spend is capped as a percentage of total system spend.

## 5. Removed built-in memory

#941 deleted the curated file stores, mutation tool, configuration and prompt injection without replacement. The engine/candidate/recall contracts and their old policy points are withdrawn from the active kernel contract. Any later memory or session-search design needs its own approved scope and real consumer; it is not inherited as shipped behavior.

## 6. Determinism, Replay, and Verification

Normative promotion of the 2026-07-09 determinism/verification round (machine-local research original: `foundation-formal.local.md`). The former verifier registry, task-completion admission and archived task replay were removed with their product owners; those historical issue labels are not a live API contract. The surviving principles below are targets, not evidence that a replacement verifier or replay library ships. Framing first, and honestly: this is an **accountability contract, not a correctness proof**. Determinism and accuracy are independent axes (a fully deterministic agent can be reliably wrong), and hallucination detection without an external oracle is impossible — so the contract makes behavior recorded, bounded, and replayable; it does not make outputs true.

### State and the ledger fold

- Internal state is a fold: `S = fold(apply, S₀, L)` over the append-only ledger, partitioned per owner key. `apply` is pure — no clock, no randomness, no live reads, no external calls. Nondeterministic values are captured **as events at write time** and never re-derived on replay.
- **Determinism contract = command-sequence identity**: same inputs must produce the same command sequence, not byte-identical outputs. A replay that attempts a step absent from the ledger fails **loudly** as a nondeterminism error — never silent fold corruption. A static replay-fidelity 1.0 on one golden trace is not accepted as determinism evidence.
- **The gate uses the durable ledger write for record-before-act**: target `Ledger.append(event, expectedHead)` is a per-owner-key serialized compare-and-append with retry on conflict. The gate evaluates against exactly the state it commits on and awaits that commit before acting, closing the check-then-act TOCTOU (two workers passing one budget gate). `bus.publish` is downstream observation/projection, not the append enforcement point. [Implementation Status](implementation-status.md) alone records the current durable-write path.
- **Provider attempts are execution instances, not task tickets.** The session executor records ordered attempt children under a model action; identical model inputs do not imply the same attempt.
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
- **Verifiers are deterministic code, sandboxed** (no network, no clock, no subprocess; deny-by-default) — purity by capability, not by naming convention. **No LLM-in-verifier.** Four families, strongest first: executable re-check > citation/quote match > frozen-NLI support > constrained-decoding validity (validity only, never promoted to truth). Every verifier's bench must demonstrate discrimination (returns `refuted` on a known-bad input).
- Language discipline: `replay-of-record` (reconstructing what happened — what this system provides) is never conflated with `deterministic regeneration` (re-running the model to identical outputs — not provided).

### Observability surface

The source of truth for a run is its session action tree and revisioned row; observations are at-most-once notifications, never replay truth. `s.get()` returns the authoritative lease/state/generation/open-turn snapshot and latest-turn tail without waking execution. `s.watch()` atomically opens a snapshot plus session-filtered subscription; a skipped revision emits a gap and the caller replaces state with `get()`. SQLite remains primary storage, and timelines or exports are derived views. Failure-step attribution by LLM judges is unreliable; durable action results are recorded at the boundary, not reconstructed afterward.

## 7. History

ADR-001 through ADR-008 established the conventions now stated directly in [Architecture](architecture.md) and [Core Model](core-model.md) — package namespacing, Zod-first schemas as the language-agnostic boundary, ring layering, and the durable-session/disposable-runtime split that makes suspension and resume nearly free — along with the persona-era workforce model that evolved into the current role model (Resident / Worker / Jester / Governor as actor profiles, not packages). All are retired; git history preserves the full records.
