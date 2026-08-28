# Machines and Delegation — the OS's Body and Workforce

Owner-directed target design (2026-08-23). This document supersedes the
package-layout portions of [clean-room-blueprint.md](clean-room-blueprint.md)
where they conflict: the Owner ruling of 2026-08-23 replaces the legacy brain
and host with the sole-app target and includes machine placement.
Everything here is a target contract; [implementation-status.md](implementation-status.md)
alone says what is wired.

## 1. The two axes

OpenOmni is an agent OS. Its reach grows along two axes:

- **Axis A — body (machines).** Devices attach by running a daemon that dials
  home. What the OS may do on a device is `effective = enrollment ∩ offer`.
- **Axis B — workforce (delegation).** Work is commissioned through ONE
  address vocabulary covering internal loops and external actors uniformly.

The protocol contracts for both belong together because they meet in the tool catalog: a tool declares *where* it runs and *which capabilities* the executing side must hold.

## 2. Machine contracts (`protocol/src/machine/`)

- `Machine.Enrollment` — Owner-side admission record: the capability allowlist
  for one machine. Never empty (an enrolled machine with nothing allowed is a
  contradiction).
- `Machine.Offer` — daemon-side attach report: what the machine can do right
  now. May be empty; the daemon re-offers when modules come up.
- `Machine.effectiveCapabilities(enrollment, offer)` — pure clockless fold:
  intersection, sorted; mismatched machine ids refuse (`machine_mismatch`).
  Neither side can grant itself a capability the other never named.
- `Machine.CapabilityId` — dot-namespaced lowercase grammar (`fs.read`,
  `shell.exec`, `kernel.py`, `screen.read`, `input.write`). Open vocabulary,
  owned grammar: enrollment writer, daemon offer, and tool `requires` all
  parse the same shape.
- Events: `machine.attached` (carries the effective set in force),
  `machine.detached`.

The daemon itself is the driver-band `packages/machines` package
({protocol, ipc} deps only, reverse-connection over the ipc transport);
enrollment storage is a ledger record; attach admission is kernel judgment.

## 3. Delegation contracts (`protocol/src/delegation/`)

- `Delegation.WorkerAddress` — `core` (internal loop; scope `inline` =
  same-context child, `independent` = isolated session/process) or `actor`
  (an already-registered external actor). The address says WHO, never HOW.
- `Delegation.Operation`: `notify` (fire-and-forget message; no Wait, no
  reply expected; terminal `sent` at transport acceptance; actor addresses
  only), `ask` (a question; the reply settles it; core inline|independent or
  actor), or `assign` (commissioned work held to acceptance criteria; core
  independent or actor, never inline: an inline child is a volatile in-turn
  helper, too weak to hold a contract to). `assign` requires acceptance
  criteria; `ask` and `notify` forbid them.
- `Delegation.Request`: address + operation + payload + **required deadline**
  (epoch ms; no unbounded delegation exists, same law as `Wait.expiresAt`).
- `Delegation.Origin`: who is asking (`role`, `depth`, `sessionId`) plus the
  lineage the durable lifecycle needs: `parentDelegationId` and
  `rootDelegationId`, stamped by the admission fold, never self-reported.
- `Delegation.Handle`: what the requester holds after DURABLE admission,
  before the work runs: the resolved `Transport` (`inline` | `process` |
  `channel`), the effective deadline (admission clamps the requested deadline
  to the parent's when a parent exists), the channel `waitId` when one was
  prepared, and the tree ids settlement arrives under. Progress is observed
  through Wait/WorkItem, never polled through the handle.
- `Delegation.Settled`: seven terminals: `completed`, `failed`, `cancelled`,
  `delivery_failed`, `no_response`, `interrupted`, `sent`.
  `delivery_failed` (never reached the worker) and `no_response` (delivered,
  silence past deadline; `at >= deadline` is a schema invariant) are distinct:
  unknown-outcome is never read as did-not-happen. `interrupted` is set only
  by the boot sweep: the host restarted while volatile (inline/process) work
  was open. `sent` is transport acceptance of a notify, terminal for notify
  only (pinned on `Delegation.Record`, where operation meets settlement).
  `completed` means the worker/actor REPORTED completion (or replied);
  acceptance-criteria enforcement remains deliberately outside this terminal.
- `Delegation.Record`: the durable row (record-before-act): the Handle
  fields plus origin, instruction summary, and the `open|settled` lifecycle.
  Written at admission before any work runs; settled exactly once by the
  kernel's open→settled compare-and-swap.
- Events: `delegation.admitted` (the durable record committed),
  `delegation.delivered` (transport ack), `delegation.settled`. The v1
  `delegation.requested` event was removed: its meaning changed from
  "admission decided" to "admission persisted", and a changed meaning is a
  new event type.

Admission (who may commission whom, address→transport resolution, deadline
clamp, fanout cap), the three transport drivers, and sole settlement
authority form the **DelegationKernel** in `apps/openomni`; the agent loop
reaches it only through tools in its catalog (`delegate`, `await_delegation`,
`cancel_delegation`).

### Async lifecycle contract

- **Record-before-act, single settlement fold.** `kernel.delegate()` runs:
  admit → driver `prepare` (the channel driver allocates its durable `waitId`
  here, so the persisted Handle already links the Wait) → write the
  `Delegation.Record` → emit `delegation.admitted` → dispatch. Only the
  kernel settles: a CAS `open→settled` in the store, then the
  `delegation.settled` event, then the wake. Drivers report outcomes; they
  never mutate delegation state. The store lives in
  `packages/ledger/src/delegation/` over `Storage.DelegationSubAdapter`
  (get / create / compareAndSwapStatus / listOpen / listOpenByRoot /
  findByWaitId), with memory and SQLite adapters.
- **Immediate Handle.** Process and channel ask|assign return the Handle as
  soon as the record commits; settlement arrives later. Inline stays volatile
  and awaited (the tool call blocks and returns the settlement directly, but
  the record is still written uniformly, so the boot sweep can mark an
  interrupted inline). Notify sends, settles `sent` at transport acceptance,
  and returns Handle plus settlement.
- **Owner-session wake.** When a non-inline delegation settles, the kernel
  synthesizes an internal delivery into the origin session: a system-authored
  message `delegation <id> settled: <status>: <summary>` that runs a Resident
  turn and is persisted to the transcript. The settle CAS makes the wake
  exactly-once.
- **Re-invocable await and cancel.** `await_delegation(delegationId)` returns
  the settlement if settled, else subscribes until settlement or the await's
  own timeout, never past the delegation deadline. `cancel_delegation` aborts
  the in-flight controller and CAS-settles `cancelled`; cancelling an
  already-settled delegation returns the existing settlement.
- **Deadline.** The kernel arms one timer per open record; firing settles
  `no_response` (at the deadline instant, never before). The channel driver's
  `waitSpec.expiresAt` IS the same effective deadline: one clock, no second
  spelling.
- **Restart matrix.** Boot sweep on startup: open records past their deadline
  settle `no_response`; open inline/process records settle `interrupted`
  (volatile transports, no reattach); open channel records with a future
  deadline re-arm the timer and keep correlating, because the Wait is durable
  and the record links it by `waitId` (a reply after restart reaches
  `settleFromReply` and settles `completed` plus wake). Notify settles `sent`
  at acceptance, so nothing notify stays open across a restart.
- **Lineage and limits.** Admission computes
  `effectiveDeadline = min(requested, parentDeadline)` when a parent exists,
  and enforces a fanout cap of open records per `rootDelegationId` (default
  8), counted from the durable store at admission. Both live in the admission
  fold only. Exceeding the cap, a missing parent, a lineage mismatch, or a
  passed deadline is a typed `AdmissionRefusal`. The worker-origin
  restriction stands: a Worker may open only a same-domain inline child
  (therefore ask only), `maxInlineDepth` 2.
- **Grants stay separate.** `may_contact` (the #215 send kernel's
  sender-target grants) is not `may_commission` (admission). The channel
  driver rides the send kernel for every actor contact; admission decides
  whether the delegation may exist at all. Neither grant implies the other.

### Vocabulary fences

- **Engagement ≠ Delegation.** `protocol/src/engagement/` is the *terms
  machine* of one delegation relationship (constraints, expiry edges).
  `Delegation.Request` is the commissioning act itself. An engagement may
  govern a delegation; neither absorbs the other.
- **Transport ≠ Lane.** `Delegation.Transport` names the wire a commissioned
  unit travels on (`inline`/`process`/`channel`); the core-model
  "Lane" noun names execution roles (Built-in/Action/Worker/Subagent). The
  two never alias.
- **A machine is a WHERE, never a WHO.** Delegation addresses workers and
  actors; a machine is a body execution lands on, and its addressing surface
  is the tool axis (`run_code` cells name a `machineId`, discovered through
  the `machines` catalog tool). The once-reserved `machine` transport arm was
  removed rather than left dormant (Owner decision, #786): a worker whose
  tools should land on a machine is an ordinary `process` worker whose
  catalog placement folds against that machine.
- **Wait is reused, not redefined.** Reply correlation, quorum, deadlines
  (`expiresAt`), and `delivery_recorded` already live in `protocol/src/wait/`.
  The `channel` transport opens a Wait; `Settled.no_response` is the delegation
  reading of that Wait's expiry.

## 4. Tool placement (`Tool.Placement`, `Tool.Spec`)

- `placement`: `machine` (runs on an attached machine's daemon), `host` (runs
  on the brain's own host), `free` (anywhere — pure/network tools).
  Additive-optional on `Tool.Spec`; the catalog resolver (stage 4 below) is
  the single owner of the absent-means-`free` read.
- `requires`: capabilities the executing side must hold
  (`Machine.CapabilityId` grammar). Placement resolution =
  `placement` × `requires` ⊆ effective set of a candidate target.
- The mutation axis is the EXISTING `safe` field (`safe === false` is what
  earlier drafts called `mutates`) — one spelling per convention.

The machine axis of `@openomni/placement` folds candidate machines against
`requires`; the model axis (#752) is unchanged.

## 5. Delivery order

1. **Contracts** (this document's schemas) — landed first.
2. `packages/machines` daemon + localhost attach (driver band).
3. `apps/openomni` slice 1: pure Resident chat loop (no memory, no delegation).
4. **Agent-loop placement axis + tool catalog `requires` resolution — landed.**
5. Code mode, in two slices because the substrate and the batching payoff are
   independently verifiable:
   - **5a — kernel substrate: landed.** A machine offering `kernel.py` runs
     code cells with interpreter state persisting across cells, each cell
     under a required deadline, behind the effective-capability gate.
   - **5b — the `tool.<name>()` bridge: landed.** A running cell calls back to
     the host's tool port over the same attachment (`machine.call_tool`), so
     one cell replaces N tool round trips. The host does not re-implement the
     placement gate: the composition root injects the same placement-gated
     executor the model-facing catalog uses, so a tool the fold refused cannot
     be reached by spelling its name in code. A tool call is served only on an
     attached connection and only for a cell the host itself dispatched and is
     still awaiting. The `eval` tool spec that offers code mode to the
     model belongs with the app that composes a catalog, and lands with it.
6. ~~`DelegationPort` extraction from the agent loop.~~ **Nothing to extract.**
   Re-checked against the tree at stage 6: `packages/agent/src` contains no
   spawn, subagent, or delegation code at all — the loop already reaches
   delegation the only way it reaches anything, as a tool in its catalog. The
   legacy semantics belonged to the removed product tree, which the final app
   replaces rather than extracts from. This step is struck rather than
   deleted so the correction stays visible.
7. DelegationKernel with the `inline` transport driver **(landed)**, then
   `process` **(landed)**, then the `channel` driver on Wait resumption
   **(landed)**. The `machine` driver was struck per the WHERE-never-WHO
   fence above (#786) — machine execution ships as tool placement, not as a
   delegation wire. The kernel lives in `apps/openomni/src/delegation/` because
   who may commission whom is product meaning; admission owns the depth rule
   and the address→transport resolution, and drivers own only the wire.

   Ordered ahead of the `eval` wiring in step 5 on purpose: code mode earns
   its keep by batching tool calls, and until the app had a real tool to
   batch, wiring `eval` would have shipped an engine with no consumer.

   The kernel's lifecycle is now async-first and durable (§3 "Async
   lifecycle"): record-before-act into the ledger delegation store, the
   Handle returned at admission for process/channel work, one kernel-owned
   settlement fold, owner-session wakes, and a tested restart matrix.
8. Memory, last, referencing existing implementations.
