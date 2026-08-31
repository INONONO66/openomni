# Conversation and Message IO — Target Contract (Proposal)

Status: **proposed target contract — nothing in this document is shipped.**
Shipped-state truth remains [implementation-status.md](implementation-status.md).
This document extends [Gateway Design](gateway-design.md) and
[Machines and Delegation](machines-and-delegation.md); it does not replace
their vocabulary. Owner sign-off is required before any phase lands (baseline
growth law).

## 1. Problem

The perimeter today admits messages and lets the Resident answer them, and the
Resident can open one-shot contact (ask/notify) toward pre-registered actors.
Three structural gaps block real communication work:

1. **No WITH-WHOM-NOW axis.** Authority has MAY-I (SenderTargetGrant) and
   HOW-OFTEN (SocialBudget), but no durable notion of "a conversation with this
   actor is in progress". Consequences, verified in code:
   - A Wait resolves on `first_reply` with `followUpWindow: 0`; a counterparty's
     second consecutive message falls to surface-default routing — context
     fragmentation, or a block when the sender is unknown and the channel has
     no default tier.
   - Unsolicited mid-conversation inbound has no route back to the session that
     owns the exchange.
2. **Workers cannot speak.** `admission.ts` refuses every worker→actor
   delegation. Negotiation, support triage, or in-thread PR discussion cannot
   be handed to a worker even under tight bounds.
3. **Contacts are boot-frozen.** Only `config.actors` entries can be addressed.
   A marketplace counterparty or a new collaborator cannot become reachable at
   runtime.

Cross-cutting: outbound text is not normalized per surface (tracked
separately — renderer/chunking work precedes this proposal).

## 2. Design principles (references, distilled)

- **Capability = mounted component** (DeepSeek harness / Cordis): every unit of
  messaging authority is mounted with declared dependencies and unmounted
  cleanly. Composition happens by configuration and by runtime acts, not by
  editing kernel code.
- **Temporal composability** (arXiv:2608.25512, revertible effects): every
  authority mount carries an inverse **held by the runtime**, not by the
  component that asked for it. Expiry, settlement, unmount, and revocation all
  execute the same inverse. No orphan authority can exist by construction.
- **Spatial composability** (ibid., reactive coeffects): authority declares
  what it depends on; revoking a dependency reactively revokes every
  dependent. The app composer's reverse-order release already implements this
  shape for channel components (listener + delivery route + trusted_channel
  grant); this proposal extends the same law to contacts, conversations, and
  leases.
- **Renderer/sink separation** (clawhip): formatting is a pure stage between
  the send kernel and the transport sink.
- **Conversation-as-binding** (hermes-agent): multi-turn continuity comes from
  binding a counterparty to a session, not from per-message correlation.
  hermes gets this for free by making every chat a session; we get it by
  making the binding an explicit, bounded, recorded object.

Existing laws that this proposal must not weaken: single send kernel, one
enforcement layer per invariant, record-before-act, zero-by-default cold
budgets, fail-closed durable writes, evidence-only demotion.

## 3. The authority algebra

Five primitives. Each is a ledger fact with a declared dependency and a
runtime-held inverse. Mount order is the dependency order; revocation is
always the exact reverse.

```
Channel  <-  Contact  <-  Grant  <-  { Budget, Conversation }  <-  Lease
```

| Primitive | Axis | Depends on | Inverse (runtime-held) |
| --- | --- | --- | --- |
| Channel mount | REACHABLE-VIA | composition | unmount revokes listener, route, channel grant (shipped today) |
| Contact | WHO | Channel | unregister removes endpoints; dependents revoke reactively |
| Grant | MAY-I | Contact | expiry / revocation removes send capability |
| Budget | HOW-OFTEN | Grant | expiry re-applies zero-default |
| Conversation | WITH-WHOM-NOW | Contact + Grant | close/expiry removes correlation rule and conversational send right |
| Lease | ON-WHOSE-BEHALF | Conversation + delegation | settlement/cancel/deadline kills the lease with the delegation |

### 3.1 Contact

```
Contact {
  actorId, kind: "human" | "agent" | "system",
  standing: "registered" | "provisional",
  trustTier,                       // existing Actor.TrustTier
  endpoints: [{ channel, externalId }],
}
```

- `registered` contacts come from Owner config or an explicit promotion act.
- `provisional` contacts are minted automatically when a trusted channel
  delivers a message from an unknown sender: tier = the channel's default
  tier, treatment = `evidence_only`, no grants. Minting is a recorded fact,
  not an authority: a provisional contact can be *talked about*, not *talked
  to*, until promotion.
- **Promotion is an approval-lane act** (§6): Resident requests, Owner
  approves (or pre-delegated policy auto-approves within declared bounds).
- Identity is per-endpoint. Merging endpoints across channels into one
  contact is an explicit act, never inferred (anti-spoofing, §8.4).

### 3.2 Grant (existing, parameterized)

`SenderTargetGrant` gains a `holder` dimension: `resident` (today's only
value) or `lease:<leaseId>`. Grant evaluation stays in the send kernel;
nothing else changes. A grant never outlives its Contact.

### 3.3 Budget (existing, plus sub-allocation)

The `SocialBudget` fold is untouched. New: a budget may be **carved** — a
child allocation whose caps debit the parent atomically (`sum(children) <=
parent`, enforced at carve time, fail-closed). Carving exists so a Lease can
hold real, bounded spend rather than a reference to the Resident's budget.

### 3.4 Conversation

```
Conversation {
  conversationId,
  contact: actorId,                 // one counterparty; groups: §7.3
  endpointId,                       // channel binding — pinned at open
  ownerRef: { kind: "session", id },// the session that owns the exchange
  policy: {
    expiresAt,                      // hard bound, admission-clamped
    maxOutbound, maxInbound,        // hard caps, both directions
    quietHours: "defer",            // conversational sends queue, never deny
    onInboundCapBreach: "demote",   // -> evidence_only delivery, wake owner
  },
  state: "open" | "closed",
  openedBy,                         // delegationId or resident act
}
```

Mount effects (both recorded before act):

1. **Inbound correlation rule** — every message from `endpointId` routes to
   `ownerRef` as a conversation turn (full authority for the owner's next
   run), placed in the router fold order *after* blacklist, *before* wait
   correlation. First-reply Waits inside a conversation still settle
   delegations; the conversation catches what the Wait no longer needs.
2. **Conversational send right** — outbound from the owner (or a lease
   holder) to `contact` bypasses the cold-outreach gate, debits
   `maxOutbound` instead. DNC is still absolute: a DNC'd contact refuses
   conversational sends too (§8.8).

Inverse: close/expiry removes both effects. Subsequent inbound from the
contact falls back to today's surface-default routing. Closing is idempotent
and is itself a recorded settlement (`closed_by: owner | expiry | cap_breach |
dependency_revoked`).

Opening paths:
- `delegate(channel, ask)` **auto-opens** a Conversation whose expiry equals
  the Wait deadline (replaces `followUpWindow: 0` semantics with a real
  container). The cold send that opens it passes grant + social budget as
  today.
- An explicit `converse_open` Resident tool for exchanges that start inbound
  (e.g. adopting a support thread).
- An inbound-initiated exchange the Resident chooses to continue: replying
  through a reply-scoped grant may promote the container to a Conversation.

### 3.5 Lease

```
Lease {
  leaseId,
  conversationId,                   // scope — exactly one conversation
  holder: delegationId,             // the worker attempt holding it
  budget: carvedAllocation,         // §3.3, non-transferable
  expiresAt = min(conversation.expiresAt, delegation.deadline),
}
```

- Admission change (the only relaxation): worker→actor delegation is admitted
  **iff** a live lease names that worker's delegation chain and the target
  actor. Everything else about worker admission stays refused.
- **Non-transferable**: a lease never flows to inline children. A child
  worker returns text; the lease holder sends. (One speaking identity per
  conversation side; §8.5.)
- Outbound sent under a lease is stamped `onBehalfOf: residentId, via:
  leaseId` in the egress record. External identity remains the Resident's
  (`senderId: "resident"`), because the counterparty is dealing with the
  Owner's agent, not with an anonymous subprocess.
- Inverse rides the delegation lifecycle: settle/cancel/deadline kills the
  lease in the same fold that closes the attempt. A revoked conversation
  reactively kills its leases (spatial law) — the worker's next send is
  refused at admission, mid-flight sends are not clawed back (egress is
  already recorded).

## 4. Message IO pipeline (final form)

### 4.1 Inbound fold order

```
driver normalize (rich parts: text, attachments[], threadRef, replyToId)
  -> blacklist
  -> conversation correlation        (NEW — owns "in progress" traffic)
  -> wait correlation                (unchanged — settles delegations)
  -> channel admission (trusted/broadcast/blocked, treatment)
  -> actor identity (+ provisional mint on unknown@trusted)  (NEW mint)
  -> session routing (surface default | conversation ownerRef)
  -> deliver
```

Every stage stays a pure fold with recorded decision facts, exactly like
`resolve-route.ts` today. The conversation stage adds facts
(`conversation:<id>`, `conversation.cap:<n>/<max>`) to the decision record.

### 4.2 Outbound classes

One send kernel, three admission classes:

| Class | Gate | Debits |
| --- | --- | --- |
| Reactive reply (ingress return value) | none new (session-scoped) | nothing |
| Conversational send (owner or lease) | conversation open + cap | `maxOutbound` (+ lease budget) |
| Cold outreach (opens conversation) | grant -> social budget (+ approval lane §6) | window/class caps as today |

### 4.3 Rendering (precedes this proposal; restated as contract)

`send kernel -> render(surface, markdown) -> chunk(format-aware) -> sink`.
Renderers are pure functions in the driver band: Telegram MarkdownV2 with
plain-text fallback on parse rejection, Discord table→bullet rewriting, Slack
mrkdwn (+ opt-in Block Kit with mandatory text fallback), GitHub GFM
passthrough, WS raw. Chunking never splits inside a code fence without
closing and reopening it. Delivery failure never loses a message to a
rendering nicety — plain text is the universal floor.

## 5. Coverage matrix

| Case | Composition (no new mechanisms per case) |
| --- | --- |
| Owner chat on any surface | shipped path, + renderers |
| Reminder / alert to Owner | notify class (shipped) + renderers |
| Marketplace negotiation (중고나라, eBay) | provisional Contact -> promotion -> ask auto-opens Conversation -> multi-turn via correlation -> caps/expiry bound the exchange |
| Delegated negotiation | same + Lease to a worker; Resident sets caps, worker haggles, settlement closes lease |
| Scheduling with a third party | ask Conversation, low caps, calendar tool on the owner side |
| Customer support triage | inbound on broadcast channel (evidence_only) -> Resident adopts thread via converse_open -> leases to triage workers |
| Standup / status broadcast | notify to a group target (§7.3) |
| Escalation chain (CI failed twice) | clawhip-shaped route policy: notify; unanswered conversation expiry wakes owner; Resident escalates to next contact |
| GitHub PR/issue thread work | github surface already keys channelId per issue — a thread adopts naturally as a Conversation; lease = review worker replying in-thread; public repos stay evidence_only inbound (§8.11) |
| Cross-agent (A2A) traffic | Contact kind "agent"; conversations and leases compose unchanged — a peer agent is just a counterparty with a tier |
| Email / Slack / new surfaces | new drivers mount as channel components; every primitive above composes onto them with zero kernel change (spatial composability is the point) |

## 6. Approval lane

Some acts are `automatic` under Owner-declared policy, otherwise
`approval-required` (clawhip's lane split, made durable):

- Contact promotion (provisional -> registered)
- Cold outreach to a contact with no declared budget
- Lease issuance above declared caps
- Endpoint merging across channels

An approval request is itself a Conversation with the Owner (notify + wait),
so the mechanism is self-hosting — no separate approval subsystem. Unanswered
approval = refusal (fail-closed).

## 7. Explicit non-goals and deferred shapes

1. **No autonomous contact discovery.** The system never cold-messages an
   address that no human/inbound act introduced.
2. **No lease transitivity.** Ever. Re-evaluate only with a real case.
3. **Group conversations** (multiple expectedResponders, per-actor + total
   caps) are designed to fit `contact: actorId[]` but ship after 1:1 — every
   adversarial property must be re-checked per §8 before they land.
4. **Voice/media parts** ride the rich-part normalization but rendering
   contracts for them are out of scope here.

## 8. Adversarial review

Each attack, the holding invariant, and the residual.

1. **Prompt-injected worker exfiltration** — a counterparty convinces a
   leased worker to message a third party. Held: lease pins exactly one
   conversation/actor; admission refuses any other target. Residual: worker
   returns poisoned *text* for the Resident to act on — mitigated by existing
   evidence demotion (worker output is unverified Evidence, never
   auto-executed).
2. **Spam-in through an open conversation** — counterparty floods the owner
   session. Held: `maxInbound`; breach demotes further inbound to
   evidence_only and wakes the owner once (`onInboundCapBreach: "demote"`).
   The flood becomes cheap facts, not turns.
3. **Budget laundering** — open one conversation, then send forever. Held:
   `maxOutbound` + `expiresAt` are admission-clamped hard bounds; opening
   still debits the cold budget; caps are Owner policy, zero-default.
4. **Contact spoofing** — attacker registers the counterparty's name on
   another channel. Held: identity is endpointId-scoped; conversations pin
   the endpoint at open; cross-channel merge requires an approval-lane act.
5. **Lease escalation via children** — leased worker delegates sending to a
   child to widen authority. Held: non-transferability is an admission fold
   (child origin lacks the lease); the child can only hand text back.
6. **Revocation race** — sends in flight while the channel unmounts or the
   lease dies. Held: authority is evaluated per send at admission against
   live state (the kernel already re-reads the delivery-route map per
   delivery); the runtime-held inverse guarantees no dangling grant survives
   its dependency. Mid-flight egress that already passed admission lands and
   is recorded — recorded history is not clawed back.
7. **Runaway negotiation loop** — settle/wake ping-pong burns budget/tokens.
   Held: conversation caps bound total rounds; drive-loop continuation caps
   bound each worker attempt; wake turns are full-authority but each new send
   passes admission again.
8. **DNC / quiet-hours pressure** — "the deal closes tonight, message them at
   3am". Held: DNC refuses even conversational sends (absolute). Quiet hours
   *defer* conversational sends (queue until the window opens) rather than
   deny — deferral is recorded, and the counterparty's timezone experience is
   Owner policy, not model judgment.
9. **Cross-conversation leakage** — same contact, two conversations, two
   workers. Held: leases scope to conversationId; worker interpreters are
   already tenant-isolated per session; the contact sees one identity
   (resident) either way.
10. **Replay / duplicate debits** — retried deliveries double-count caps.
    Held: debits key on messageId (idempotent), mirroring the existing
    idempotencyKey seam on deliver.
11. **Public-thread injection (GitHub)** — anyone can comment on a public PR.
    Held: public surfaces keep `evidence_only` inbound treatment even inside
    an adopted conversation; a lease on a public thread grants posting only.
    The conversation raises correlation, never trust.
12. **Provisional-contact griefing** — attacker floods unknown senders to
    mint contacts. Held: provisional mint grants nothing (no grant, no
    budget, evidence-only); mint volume is bounded per channel window and
    mints are sweepable facts, not capabilities.
13. **Approval fatigue** — attacker induces a storm of approval requests to
    get one rubber-stamped. Held: approval requests are conversations with
    the Owner and are themselves budgeted (notify-class caps); refusal is the
    timeout default.

## 9. Phasing

| Phase | Contents | Gate |
| --- | --- | --- |
| P0 | Per-surface renderers + format-aware chunking (agreed prior work) | golden tests per surface |
| P1 | Conversation: protocol schema, ledger store, router correlation fold, delegate(ask) auto-open, converse_open/close tools | conformance: fold purity, cap/expiry admission clamps, close idempotency |
| P2 | Lease: budget carving, admission relaxation (worker→actor iff lease), egress stamping | adversarial tests §8.1/.5/.6 as executable cases |
| P3 | Provisional contacts + approval lane + promotion acts | §8.4/.12/.13 executable |
| P4 | Slack driver, group targets, email driver, A2A contact kind | per-surface re-run of §8 |

Each phase is independently shippable and independently revertible — the
phases themselves obey the temporal-composability law they implement.
