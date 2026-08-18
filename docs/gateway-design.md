# Gateway architecture — final design (v2)

Status: Owner-directed, finalized 2026-08-19. Supersedes v1 (2026-08-18) and
five locked clauses (§8). Reference structure: clawhip
(https://github.com/Yeachan-Heo/clawhip) — routing/normalization/delivery
layer with the brain outside it. Issue reconciliation (§9) is the only
remaining pre-implementation step.

## 0. North-star fit

Product thesis: single window + agent command; the ledger is the safety
mechanism that makes delegation trustworthy. This design gives the thesis its
missing physical shape: the **gateway IS the single window** (every inbound
and outbound crossing goes through one perimeter with one ledger), and the
**engagement machine (§5) IS the delegation safety mechanism** (what the
agent promised, whom it awaits, when the user must approve — durable, not
context-resident).

## 1. Topology — four layers, three packages + composition

| Layer | Package | Owns | Must not |
|---|---|---|---|
| Gateway | `packages/channels` | drivers (envelope conversion), router (block → wait-correlate → session-map), delivery, perimeter store *semantics* (sole writing consumer of the perimeter surfaces in ledger) | read session content; import brain/agent; embed a storage engine |
| Brain | `packages/openomni` | resident, agents, prompts/persona, subagent orchestration, native tools, work-items, engagement machine, evidence, conduct policy glue | touch an endpoint or platform id; open a socket outward |
| Loop | `packages/agent` | the pure run loop, compaction | know sessions, channels, or waits exist |
| Composition | `apps/server` | driver registration, gateway↔brain wiring, config/grants | host logic |

The package keeps the name `channels` (renaming to "gateway" is churn; the
role name lives in docs and AGENTS.md). Dependency whitelist: channels =
{protocol, ipc, policy, ledger} — policy because the router evaluates
perimeter rules through the shared engine (§3), ledger for its store
surfaces. The `drivers/` sub-band inside channels stays at {protocol, ipc}
(S8). Observation events publish through an injected `BusEvent.Sink` port —
channels does not import telemetry (the llm/agent precedent). openomni may
not import channels; channels may not import openomni — **both sides meet
only in protocol contracts, wired by apps/server through injected ports.**

## 2. Contracts (protocol-owned, the only seam)

### 2a. Inbound — `Gateway.Deliver` (gateway → brain)

```
{
  sessionId: string,            // opaque routing label to the gateway (S1)
  envelope: {
    messageId, traceId,         // trace minted at the driver's first frame (D11)
    surfaceKey,                 // e.g. telegram:bot:chat:123 — origin identity
    text, media?, threadId?, replyToId?,
  },
  actorContext: {
    actorId?,                   // absent = anonymous admitted via channel defaultTier
    trustTier,                  // perimeter verdict — brain consumes verbatim
    inboundTreatment,           // "full_access" | "evidence_only"
    origin: { surface, externalId },  // taint root for injection defense (soju origin-taint)
  },
  waitContext?: {               // present iff this resumed an open Wait
    waitId, allowedAction, engagementId?,
  },
}
```

Brain-side consumption rules (normative, closes the known gap):
- `inboundTreatment === "evidence_only"` → the turn is framed as **evidence**
  (observation block), never as a user-command turn. It may inform the
  resident; it may not directly drive tool use with conduct authority above
  the evidence tier.
- `origin` taints all content derived from it; taint survives into subagent
  prompts (external text is quoted material, not instruction).

Grant-write validation (perimeter): a channel grant whose `defaultTier`
materializes strangers may never carry `inboundTreatment: "full_access"` —
rejected at grant write, not at delivery time. Accepted residual: the
unconditional recency window (§5) means admitted external text enters run
context regardless of engagement match; the mitigation is taint framing plus
the evidence tier, not exclusion.

### 2a-1. Context resolution — physical vs semantic (normative)

The gateway resolves **physical context** only, by deterministic precedence:

1. **Wait correlation** (strongest): reply/thread/message ids match an open
   Wait **and the resolved sender is one of the Wait's
   `expectedResponders`** → that Wait's owner session, with `waitContext`
   attached. The responder gate is perimeter-side and runs BEFORE
   `waitContext` attachment (preserves the current
   `wait/matcher.ts` pinned-target invariant): a correlated message from a
   non-responder never carries `waitContext` — it degrades to an ordinary
   delivery on the container session (rule 3) so a third party replying into
   an awaited thread cannot hijack the wait.
2. **Thread inheritance**: a new thread container inherits the session (and
   engagement linkage, if any) of its origin message — the parent message id
   is platform fact, not judgment. The thread's own surfaceKey is then bound
   to that session in the surface-map.
3. **Container map**: otherwise the container's surfaceKey maps to its sticky
   session (DM = one durable session per counterpart container).

**Semantic context** (topic segmentation) is brain-side by definition: a
session is the transport unit; an engagement (§5) is the meaning unit. One DM
session may hold many engagements over time; the brain segments topic drift,
matches inbound content to open engagements, and uses actor identity
continuity (same actorId across containers, gateway-guaranteed) to bridge
cross-container context (e.g., marketplace comment thread → DM). The gateway
never infers topics; the brain never re-derives container identity.

### 2b. Outbound — `Gateway.Send` (brain → gateway)

The existing #215 send kernel IS this contract's implementation; it moves
whole. `SendInput → SendReceipt` unchanged: grant-first, one-endpoint
resolution, typed denials (`ungranted/target_missing/target_stale/
target_ambiguous/wait_duplicate`), record-before-act (durable Wait before the
delivery effect), platform-id re-key after delivery.

- `senderId` for as-me sends = the **resident persona actor** (an
  ActorRegistry identity owned by the Owner). Grants are Owner-written rows
  binding persona → external actor × operation × expiry. Default remains
  empty = all sends denied.
- The brain-side surface is one native tool: `message.send(target, body,
  operation, expectReply?)` registered in the brain's tool provider, calling
  the injected gateway port. `expectReply` expands to a waitSpec whose
  ownerRef is the calling engagement (§5) or session.
- **Reply-scoped grant** (case-discovered 2026-08-19): `SenderTargetGrant`
  requires a known `targetActorId`, which cannot be pre-written for unknown
  initiators (marketplace inquiries). Provenance stays Owner: the Owner
  writes a *reply-grant rule row* (channel-scoped, part of a standing
  delegation); the gateway then materializes grant **instances** from it
  mechanically when it admits a first-contact actor on the covered channel.
  Instances are scoped by **perimeter facts only** — initiator actorId +
  originating thread/surfaceKey + expiry — never by engagement id (§5
  guarantees authority is independent of engagement matching). Each rule
  carries a **cap on live instances** so an attacker cannot farm standing
  outbound grants by mass first contact. Replying to initiators stays
  grant-gated and ledgered; cold outreach to never-contacted actors still
  requires an explicit Owner grant.

### 2b-1. Wait control — `Gateway.WaitControl` (brain → gateway)

The brain owns *when* a wait should stop mattering (engagement transitions:
abort, term-crossing, satisfied-early); the gateway owns the wait rows. The
third contract closes that loop without violating S2:
`waitControl(waitId, action: "cancel" | "expire_now", reason)` → typed
receipt. Writes stay gateway-side; the brain never touches the surface
directly. Extension/narrowing beyond cancel/expire is out of scope until a
consumer exists.

### 2c. Egress semantics (#219) — gateway router policy

Social budget, notify|converse class split, and escalation counting (봉수:
beacon count = escalation stage) are **router policy on the outbound path**,
evaluated after grant, before delivery. clawhip stays a reference, not a
dependency. Persona rendering (#458 voice) is brain-side (the brain writes in
persona; the gateway never rewrites content — rendering ≠ routing).

## 3. Trust model — two planes, one engine

- **Perimeter trust** (gateway): who may reach us / whom we may reach.
  Channel grants, defaultTier materialization, blacklist, sender-target
  grants, wait correlation, allowedActions gating, egress social budget.
- **Conduct trust** (brain): what the agent may do once running. Tool policy,
  completion admission, evidence verification, engagement approval gates.
- `packages/policy` remains the single shared **evaluation engine**; each
  plane owns its own rules. Perimeter verdicts flow to the brain only via
  `actorContext` — the brain never re-derives them; the gateway never holds
  conduct authority. Policy locations: 3 ad-hoc → 2 named planes.

## 4. State ownership — one DB, one writer package, two domains
   (SSOT directive, Owner 2026-08-19)

- **Single source of truth**: exactly one database, owned by
  `@openomni/ledger` (the #502 rename of session's storage). **No package
  other than ledger touches the storage engine** — every read/write goes
  through ledger's typed store surfaces. Row schemas are defined in
  `protocol` (the existing Wait/Actor/ChannelGrant pattern generalizes).
- **Two domains inside the one DB**, isolated by store surface, not by file:
  - *Perimeter surfaces* (actors, endpoints, blacklist, channel grants,
    send grants, waits, surface↔session map, frozen pending-*): the gateway
    is their **sole writing consumer**.
  - *Brain surfaces* (sessions, transcripts, work-items, engagements, worker
    runs/grants, artifacts, evidence): the brain is theirs.
- **Cross-domain transactions and invariants are forbidden** even though the
  file is shared — sharing the engine is an operational choice (one backup
  target #226, one hash chain / decision-class append authority #510), not a
  license to couple domains. The bridge stays ids carried in §2 contracts
  (`sessionId`, `waitId`, `engagementId`, `messageId`, `traceId`).
- Record-before-act discipline is centralized in ledger; routing decisions
  and send receipts stay `user_audit` bus events with `factsUsed`.

## 5. Engagement machine — the delegation layer (brain-side, new)

The durable object for one delegation ("buy X from this seller"), closing the
"auto planning layer absent" thesis gap. Owned by the brain, stored with
work-items; the gateway sees only `engagementId` on waitSpecs it records.

```
planning → awaiting_external(waitIds) → deliberating
        → awaiting_user_approval → acting → done | aborted | expired
```

The machine owns **authority and resumption, never dialogue content**:
- the delegation terms (spend ceiling, auto-approve criteria, deadline) —
  crossing a term forces `awaiting_user_approval`;
- the set of open waits and what each may resume (whose reply is a valid
  input in the current state — everyone else degrades to evidence). This is
  the **second** filter: the perimeter expected-responder gate (§2a-1) has
  already run before `waitContext` ever reaches the brain;
- timeout/expiry behavior per state;
- the rehydration point after crash (state + open waits + terms rebuild the
  resident's working context; the LLM re-reasons the content).

**Run context is engagement-scoped.** The session transcript is the durable
record of one counterpart container — it is never fed to the LLM wholesale.
Each run hydrates from the matched engagement (state, terms, open waits,
relevant transcript slices) **plus an unconditional recency window** (the
last N turns of the container, regardless of engagement match) — real chat is
anaphora-dense ("ㅇㅇ", "그거?", bare acknowledgements) and unreadable without
immediate turns. Topic separation happens at hydration, not at routing —
sessions are never split by topic.

**Segmentation errors are quality-soft, never security-hard.** Engagement
matching shapes hydration only; routing, authority, and egress grants do not
depend on it. A mismatched engagement degrades one reply's quality — it can
never misdirect a message or escalate authority.

**Speak policy is a delegation term.** In conversational containers the
default is silent observation (evidence accumulation). A standing delegation
must state its speak triggers (direct question, deadline detection, explicit
summon, review request); tiki-taka participation without stated triggers is
a misconfiguration, not a feature.

Judgment (is the price fair, how to negotiate) stays in the loop/LLM.
Loop-internal quality machinery (judge/critic, compaction) stays in
`packages/agent`; ledger-gating verification (evidence, completion admission)
stays brain-side outside the loop — the harness never self-grades.

## 6. Migration inventory (measured at main 5a0610b7; re-verify at cut)

Move `openomni → channels`: the **routing plane of `ingress/`**
(resolve-route, routing-resolution, authority middleware, actor-resolver,
event-projector), `messaging/`, `wait/` service (correlation/matcher/
lifecycle/requested-action/upcast), perimeter half of `dispatch/actor.ts`
(the trustTier passthrough; `assigned_worker` derivation from WorkItem
attempt facts stays brain-side). The **session plane of `ingress/` stays
brain-side** — `session-bridge.ts` (reads session content and builds LLM
messages: moving it would be the S1 violation), `session-resolver.ts`,
`audit-envelope.ts`, and the execution half of `engine.ts`/`handlers.ts`.
The exact per-file map is a stage-2 deliverable, re-measured at cut time.

Perimeter stores do NOT move to channels (§4 SSOT): `actor/`, `blacklist/`,
`channel-grant/`, `wait/` store, `surface-key/`, `pending-ask/`,
`pending-interaction/` stay hosted in `@openomni/ledger` (#502). What changes:
their row schemas move to `protocol`, their surfaces are marked perimeter-
domain, and the gateway becomes their sole writing consumer — openomni loses
direct access to them.

Move `apps/server → channels`: `channel/*` drivers (#551 scope unchanged).

Stays in openomni: `resident/`, `agents/`, `execution-runtime/`,
`work-item/` (+ engagement machine), `evidence/`, `projection/`, `effect/`,
`ledger/`, conduct policy glue.

Stays in session: `session/`, `work-item/`, `worker-run/`, `worker-grant/`,
`artifact/`, `effect/`, message/part/transcript adapters, `ledger-core/`,
`bus-persistence/`, `app-connector/`.

## 7. Slop guards (normative)

- **S1 sessionId opacity** — the gateway selects sessions but treats
  sessionId as an opaque label; it owns the surface↔session map, never
  session content. Violation = the gateway becoming a second brain.
- **S2 one engine, one writer package, domain isolation by surface** — only
  ledger touches storage; perimeter surfaces are gateway-written only, brain
  surfaces brain-written only; cross-domain transactions/invariants are
  forbidden; correlation by contract-carried ids only.
- **S3 resident runtime stays brain-side** — activation/serialization is
  brain lifecycle; the gateway stops at "deliver to session S".
- **S4 actorContext split** — perimeter fields arrive via contract;
  run-derived fields stay brain-side.
- **S5 #504 independence** — the double tool pipeline is a brain-internal
  defect; this reorg neither absorbs nor is blocked by it.
- **S6 treatment must be consumed** — §2a framing rules are part of the
  contract, not advisory; a brain that ignores `inboundTreatment` fails
  review.
- **S7 no premature daemon** — gateway↔brain is an in-process injected port;
  daemonizing channels is a separate later decision. ipc stays only for what
  drivers need.
- **S8 driver banding** — inside channels, `drivers/` may not import
  `router/` or store surfaces. check-deps today enforces package-level
  whitelists only; the intra-package banding check is **new machinery, a
  stage-1 deliverable** added to `script/check-deps.ts`. Adding a platform =
  one driver file + one server registration line, zero security review of
  the router.
- **S9 gateway never rewrites content** — persona/voice rendering is
  brain-side; the gateway delivers bytes it was given (routing ≠ rendering).

## 8. Superseded rulings (Owner receipt)

1. naru = "권한 무지 IO층" (2026-08-03) → the gateway owns perimeter
   judgment; the dumb-IO property survives as S8 banding inside channels.
2. #499 clause "no policy/kernel import in Channel-facing types" →
   driver-facing types stay import-free; the gateway router may import the
   policy engine. No brain import either way.
3. #551 "pure move" scope → becomes stage 1 unchanged; gateway promotion is
   a new stacked issue (stage 2).
4. `docs/architecture.md` "Inbound routing (`resolveRoute`) is a kernel gate
   concern and stays in the kernel" and the mailroom's "zero authority"
   framing → superseded: the resolveRoute pipeline moves into the channels
   gateway, which owns perimeter authority; the mailroom's zero-authority
   property survives only for the `drivers/` sub-band (S8). Normative text
   amended in this PR.
5. `docs/kernel-contract.md` "ingress submits, **dispatch decides**; the
   ingress-resolved session is only a default candidate that dispatch may
   override" → superseded for delivery: the gateway's routing decision
   (wait/thread/container precedence, §2a-1) is authoritative for which
   session receives the message, and PendingInteraction elevation transfers
   to gateway `waitContext` attachment. Dispatch keeps deciding brain-side
   work placement (worker spawn/target), never delivery re-routing.
   Normative text amended in this PR.

Still valid: core-package rejection (J5) — this is a role expansion of an
already-planned package, not a new core.

## 9. Staging & issue map

- **Stage 0 — contracts.** protocol: §2 shapes + §3 trust vocabulary. New
  issue. No behavior change; both sides keep working against old wiring.
- **Stage 1 — drivers move.** #551 exactly as scoped (blocked by #499, whose
  Channel-contract clause is rewritten per §8.2 — the rewrite lands in #499
  itself).
- **Stage 2 — perimeter moves.** router (ingress) + messaging + wait service
  → channels; perimeter store surfaces carved as gateway-domain in ledger
  (schemas → protocol, gateway = sole writer); openomni sheds ~4
  directories. New issue, blocked by stages 0–1 (+ #502 rename ordering).
- **Stage 3 — outbound live.** `message.send` brain tool (as-me trigger),
  #219 egress semantics in the router, #216/#217 workItem/engagement-owned
  wait delivery. Closes the two product-thesis gaps.
- **Stage 4 — engagement machine.** §5 schema + store + resident wiring +
  rehydration. New issue; depends on stage 3 waits.

Reconciliation edits required on: #499 (clause rewrite), #551 (stage-1
framing), #219 (lands in gateway router), #216/#217 (gateway delivery path,
engagement ownerRef). Not yet executed — Owner confirmation before GitHub
edits.

## 10. Non-goals

- No new core package; no renaming `channels`.
- No daemon split, no HTTP surface between gateway and brain (yet).
- No FSM for dialogue content — negotiation judgment stays in the LLM.
- #504/#498 (tool pipeline ownership, policy vocabulary) proceed
  independently.
- Skill-market/connector scope unchanged (competitive-landscape rulings).
