# Machines and Delegation — the OS's Body and Workforce

Owner-directed target design (2026-08-23). This document supersedes the
package-layout portions of the archived clean-room blueprint (git history,
`docs/clean-room-blueprint.md`): the Owner ruling of 2026-08-23 replaces the
legacy brain and host with the sole-app target and includes machine placement.
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

### 2.1 The machine filesystem (read-only)

Attached machines appear as ONE flat namespace,
`/machines/<machineId>/<export>/<path inside it>`, carrying a read-only slice:
`read`, `list`, `stat`, and no mutation verb anywhere in the vocabulary.

- **One capability gates the whole surface.** `Machine.WellKnownCapability.fsRead`
  (`fs.read`) grants read|list|stat together. A per-op split would let an Owner
  grant `list` while believing they withheld `read`, when a listing already
  leaks the names it enumerates.
- **Exports are the unit of reach, and they fold like capabilities.**
  `Enrollment.allowedExports?` (what the Owner published) ∩ `Offer.exports?`
  (what the daemon serves) = `Machine.effectiveExports(...)`. Both sides are
  additive-optional and BOTH default to empty, so a pre-VFS peer on either end
  grants zero reach. `Machine.ExportName` owns the flat lowercase grammar so
  the Owner's spelling and the daemon's offer cannot drift.
- **The offer carries names only.** The daemon-local directory behind an export
  never crosses the wire; the host cannot address — or leak — a filesystem
  layout it has no business knowing.
- **Enforcement is layered on purpose** (the same shape as the `kernel.py`
  gate). The HOST checks attachment, `fs.read`, and the effective export set
  before the wire. The DAEMON re-checks its own offer across the trust
  boundary and OWNS path confinement.
- **Confinement is a descriptor-anchored no-follow walk, not a pathname
  check.** Root acquisition walks the configured root from a descriptor for
  `/`, opening each component without following it, and records the canonical
  root string from that walk. Each request then walks components RELATIVE TO
  THAT ROOT DESCRIPTOR. The kernel is never asked to follow a request symlink:
  an in-root link is expanded lexically and re-walked under the root fd; a link
  resolving outside refuses. Thus every root-acquisition and request component
  is opened by the decision that pins it, rather than checked by one pathname
  resolution and used by another. **Exactly one owner holds each descriptor**
  the walk acquires: the owning state is cleared before the close, so a failed
  root reopen closes each acquired descriptor once, never a reused fd number
  belonging to an unrelated open, and the reopen failure itself propagates
  instead of a secondary close error.
- **Outside-root refusals are uniform, deliberately.** ANY resolution landing
  outside the export root refuses as `path_escapes_export`, regardless of
  whether the outside target exists. Classifying an escaping link before its
  target's existence is consulted is what keeps the refusal from working as an
  existence oracle: a dangling link out and a live link out must be
  indistinguishable, or the coarse reason set has been defeated by its own
  error path.
- `Machine.FsRequest` paths are RELATIVE to the export root (`""` is the root).
  The schema refuses a leading `/`, any `..` segment, and an embedded NUL as a
  cheap first gate — not as the confinement boundary.
- `Machine.FsResult` refuses with a typed reason
  (`export_not_available`, `path_escapes_export`, `not_found`, `wrong_kind`,
  `io_error`), never a transport error: the attachment survives and the caller
  learns WHICH boundary held. `FS_READ_MAX_BYTES` / `FS_LIST_MAX_ENTRIES` are
  named in the protocol and enforced by the daemon; a bitten ceiling reports
  `truncated` rather than silently presenting a prefix as the whole thing.
  Final-target inspection uses `O_NONBLOCK`, so a FIFO reports kind `other`
  instead of parking the daemon inside `open`. Listing classifies each entry by
  a no-follow open: a directory or regular file is classified from its
  descriptor, an entry that is neither and is not a symlink (socket, device)
  reports kind `other` rather than failing the listing. `read` refuses a
  non-regular target — `wrong_kind` when it could be opened and classified,
  `io_error` when it could not be opened at all.
- **The typed-refusal contract covers requests the host was ENTITLED to make.**
  A daemon asked for `fs.read` when it never offered `fs.read` is not looking at
  a refusable request — it is looking at a host violating the attachment it
  negotiated. That arm is a transport-level protocol error
  (`MachineDaemonProtocolError`, reason `capability_not_offered`), not an
  `FsResult` refusal, and it is correct that it is: `FsResult` reasons are
  answers the ASKER is meant to read and act on, and there is no honest thing
  for a compromised host to learn from "you may not do what you already agreed
  you could not do". The distinction is the trust boundary itself — refusals
  speak to callers inside the contract, protocol errors to peers who broke it.
  An export NAME absent from the daemon's own `Offer.exports` stays inside the
  contract: the capability was negotiated, only the name was not, so the daemon
  answers with the typed `export_not_available` refusal that already exists for
  exactly that boundary.

The app surface is three host-placed tools — `fs_read`, `fs_list`, `fs_stat` —
over a router that parses the namespace path
(`apps/openomni/src/machines/vfs.ts`). Host placement is deliberate twice over:
the BRAIN forwards the request, and a machine-placed tool would be folded out
of a cell's catalog — precisely where reading a machine's files pays. The
tools declare no `requires`: placement resolves requirements against one
target's effective set, and a host-placed tool resolves against the host,
which holds no machine capabilities; the grant is per-MACHINE and the machine
is named inside the path, which placement cannot see. The host's `fsOp`
therefore owns that gate.

**The two doors do NOT see the same namespace, and that asymmetry is the
point.** The flat namespace is the OWNER's view: the model door addresses every
attached machine, because the Resident acts on the Owner's authority and that
authority spans them all. A CELL is not the Owner — it is code the Owner
dispatched to ONE machine, and code that can spell a path can spell any path.
So the executing `machineId` (the one `run_code` dispatched to) is bound into
the cell's catalog at the composition root, and a cell-originated `fs_*` call
naming any OTHER machine refuses as `cross_machine_denied` before the host is
reached — an app-level refusal, because no daemon and no host was asked: the
question was not the cell's to ask. Without that binding, a compromised daemon
on A reads B's effective exports through any A cell in flight, and B's own
gates correctly permit it, because the missing check was never B's to make.

## 3. Delegation contracts (`protocol/src/delegation/`)

- `Delegation.WorkerAddress` — `core` (internal loop; scope `inline` =
  same-process child, `independent` = isolated process) or `actor`
  (an already-registered external actor). The address says WHO, never HOW;
  transport selection does not define session identity.
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
  prepared, and the tree ids settlement arrives under. The delegation handle
  is not a polling surface; native worker state is read from its durable child
  session snapshot, while transport settlement remains on the delegation record.
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
  message `delegation <id> settled: <status>: <summary>` that commits a prompt
  to the Resident session inbox and runs through its handle. The settle CAS
  makes the wake exactly-once.
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
  passed deadline is a typed `AdmissionRefusal`. A native worker is also
  materialized as a normal role=`worker` session whose `parentId` is the
  origin session; it owns a separate lease, revision, and configuration
  generation. The worker-origin restriction stands: a Worker may open only a
  same-domain inline child (therefore ask only), `maxInlineDepth` 2.
- **Grants stay separate.** `may_contact` (the #215 send kernel's
  sender-target grants) is not `may_commission` (admission). The channel
  driver rides the send kernel for every actor contact; admission decides
  whether the delegation may exist at all. Neither grant implies the other.

### Session identity boundary

Resident and native worker execution share `@openomni/agent`'s session handle.
The delegation id is reused as the durable worker session id; no
`delegation-<id>` alias, WorkItem row, or Attempt row is created. The worker
adapter supplies role-specific tools and system text, while lease acquisition,
inbox drain, turn envelopes, crash recovery, and hibernation stay in the
common session machine. Parent/child terminal mail is intentionally not
specified here: the cross-session `sendMessage` contract belongs to I06; the
existing delegation settlement wake remains until that slice removes the
parallel lifecycle.

### Vocabulary fences

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
     under a required deadline, behind the effective-capability gate. The
     daemon keeps one interpreter PER TENANT (`CellRequest.tenant`, the
     asking session): a Python process offers no in-process isolation, so
     the process boundary is what keeps one session's state — and anything
     a cell leaves running — out of another session's cells.
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
   settlement fold, owner-session wakes, and a tested restart matrix. Native
   worker execution enters the shared fenced session handle as a parent-linked
   role=`worker` row; cross-session mail and removal of the delegation lifecycle
   remain assigned to I06.
8. Memory, last, referencing existing implementations.
