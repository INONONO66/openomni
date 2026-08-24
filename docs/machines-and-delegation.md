# Machines and Delegation — the OS's Body and Workforce

Owner-directed target design (2026-08-23). This document supersedes the
package-layout portions of [clean-room-blueprint.md](clean-room-blueprint.md)
where they conflict: the Owner ruling of 2026-08-23 merges `packages/openomni`
and `apps/server` into ONE deployable app `apps/openomni`, and unfreezes
`placement` (the second execution-target kind — machines — now exists).
Everything here is a target contract; [implementation-status.md](implementation-status.md)
alone says what is wired.

## 1. The two axes

OpenOmni is an agent OS. Its reach grows along two axes:

- **Axis A — body (machines).** Devices attach by running a daemon that dials
  home. What the OS may do on a device is `effective = enrollment ∩ offer`.
- **Axis B — workforce (delegation).** Work is commissioned through ONE
  address vocabulary covering internal loops and external actors uniformly.

The protocol contracts for both landed together (`packages/protocol/src/machine/`,
`packages/protocol/src/delegation/`, `Tool.Placement`) because they meet in the
tool catalog: a tool declares *where* it runs and *which capabilities* the
executing side must hold.

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
- `Delegation.Mode` — `ask` (a question; the reply settles it) or `assign`
  (commissioned work held to acceptance criteria). Actor addresses accept
  `assign` only: the system cannot force an external actor to answer, it can
  only hold commissioned work to its contract.
- `Delegation.Request` — address + mode + payload + **required deadline**
  (epoch ms; no unbounded delegation exists — same law as `Wait.expiresAt`).
  `assign` requires acceptance criteria; `ask` forbids them.
- `Delegation.Handle` — what the requester holds after admission: the
  resolved `Transport` (`inline` | `process` | `channel`) plus the
  durable ids settlement arrives under. Progress is observed through
  Wait/WorkItem, never polled through the handle.
- `Delegation.Settled` — five terminals. `delivery_failed` (never reached the
  worker) and `no_response` (delivered, silence past deadline) are distinct:
  unknown-outcome is never read as did-not-happen.
- Events: `delegation.requested` (admission settled onto a transport),
  `delegation.settled`.

Admission (depth-1 rule, record-before-act), the four transport drivers, and
settlement authority form the **DelegationKernel** in `apps/openomni`; the
agent loop consumes it through an injected `DelegationPort` (same pattern as
`@openomni/placement`), removing spawn/subagent semantics from the loop.

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
   legacy semantics live in `packages/openomni`, which the clean-room app
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
8. Memory, last, referencing existing implementations.
