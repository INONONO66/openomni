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

### 2.1 Raw machine and code-mode consumers

`MachineHost.list()` returns attached enrollment fields, tags (empty when
omitted), the effective capability set, and os/arch from the daemon's platform
report. Detached machines are absent. `get(id)` returns a stable handle, even
before attachment; calling an unattached handle throws `MachineRefusalError`
with `machine_not_attached`. Handles follow reattachment by identity, not by
whichever connection was most recently used.

The handle exposes `fs.read/write/list/stat`, `exec(cmd,cwd)` and
`runCode(cell,signal?)`. Filesystem inputs are real absolute POSIX paths, never
a virtual root or URL. The longest matching offered root translates to the
existing export-relative `machine.fs_op` wire. Equal normalized roots refuse
`ambiguous_export`; the host does not select a broader root to evade a narrower
root's refusal. Offers carry named absolute roots; daemon configuration must
match those roots. Missing enrollment export grants fail closed.

There are exactly two authorization boundaries: the kernel executor's
`tool.pre` for app-originated effects, and the daemon's negotiated capability,
offer and export checks. Host path translation and same-connection cell
provenance are protocol mechanics, not additional policy checks. The app has
no VFS capability gate or cross-machine prohibition. Both consumer doors use
the same raw endpoint; the plain-tool locus door belongs to #949.

- `fs.read` gates read/list/stat. `fs.write` gates write. The daemon checks
  both its own offer and the enrollment/offer negotiation on every request.
- The descriptor-pinned `openat(O_NOFOLLOW)` confinement walk is retained.
  Symlinks are expanded under the pinned root; escaping and dangling external
  links uniformly refuse `path_escapes_export`. Root descriptor ownership and
  FIFO/socket nonblocking handling are unchanged.
- Writes create or overwrite a regular file, mode 0600 for new files. They
  open without truncating, verify the pinned descriptor's kind, then truncate
  and write. Writes are not atomic or transactional; an I/O refusal may leave
  a partial effect. Parent directories are not created. The 262144-byte
  socket cap refuses an oversized write before opening its target.
- Read returns `{op,data:Uint8Array,bytesRead,size,truncated}`; write returns
  `{op,bytesWritten}`. List and stat return their raw protocol structures.
  JSON wire bytes are lossless base64, never lossy UTF-8 or model previews.
  Reads retain the 262144-byte window cap and lists the 1000-entry cap, both
  with explicit truncation facts.
- `shell.exec` grants machine shell authority. For each call, the daemon
  re-resolves the effective export root pathname and validates the requested
  cwd before spawning `/bin/sh` by pathname. Exec does not share the fs
  branch's pinned-root invariant: replacing the export-root pathname before a
  request changes the directory exec actually starts in (fs requests keep
  reading the root pinned at attach), and a symlink swap between validation
  and spawn is a bounded, accepted TOCTOU for now (follow-up #938 in
  `docs/SLOP.md`).
  This is path validation, not an OS shell sandbox: a shell running as the
  daemon OS user remains arbitrary within that user's normal OS authority
  (including absolute paths and `cd` elsewhere). The Owner grants `exec`
  knowingly. Every execution requires an absolute cwd; no cwd persists between
  calls. Results
  retain raw stdout/stderr bytes, nullable exitCode/signal, and truncation.
  The combined output socket cap is 262144 bytes; reaching it kills the
  process group. A 30000ms deadline and attachment close also kill the group.
- Filesystem refusals are typed throws at the consumer surface and typed
  wire values. Exec and code retain typed terminal/refusal values. Invalid
  schemas and transport loss throw typed schema/IPC errors.

### 2.2 Code-mode ownership and lifecycle

`createCodemode({machines,llm,tools})` is a reusable facade over a structural
machines port. It supplies `cell.run(code,tenant,{timeoutMs,signal})` and
`listMachines/getMachine/findMachine({tag})`. Tag lookup requires exactly one
match: zero or multiple matches are typed errors, never arbitrary selection.
Handles expose `read/write/list/stat/shell/run`, forwarding raw structures and
bytes. The same names are installed under the Python `codemode` global;
Python reads and shell outputs contain bytes, and writes accept bytes.

Only a daemon's injected `createCodemode().runner` starts Python, lazily on
its first request. Codemode owns the interpreter map, per-tenant persistence,
parallel helper, llm helper, callId routing and cell bindings. Different tenants
never share an interpreter. Nested handle `run` uses a nested tenant to avoid
queuing behind its calling interpreter. The brain facade never spawns Python.
The app captures its executor and tool catalog at cell entry; `run_code` is
metadata/render plus one `cell.run` call. Machine-handle calls pass through the
captured executor's `tool.pre`, without manufacturing model tool definitions.

A call is accepted only from the connection with that live cell in flight.
Forged, late and detached callbacks cannot inherit another cell's authority.
`machine.cancel_code` propagates AbortSignal cancellation. Timeout/cancel kills
that interpreter, discards its state and lets its successor start fresh.
Attachment loss closes the injected runner; `daemon.close()` and `closed`
await process cleanup. Facade close cancels and awaits its live requests.

`openomni machine attach <config.json>` is the minimal production composition
of the retained daemon wire. It prints its structured attach result, exits 1
on refusal, and awaits close on host loss or SIGINT/SIGTERM. It is distinct
from `openomni daemon`, which still manages the Resident service. Example:

```json
{
  "socketPath": "/tmp/openomni-machines.sock",
  "offer": {
    "machineId": "laptop",
    "offeredCapabilities": ["fs.read", "fs.write", "shell.exec", "kernel.py"],
    "exports": [{ "name": "work", "path": "/home/owner/work" }],
    "daemonVersion": "1",
    "platform": "linux-arm64",
    "offeredAt": 1
  }
}
```

## 3. Session messaging contracts

The model and cell catalog exposes one `sendMessage({to, type, content, replyTo?, deadline?})` tool. Targets are an existing session, a new parent-linked session, or an existing actor. Message types are `message | interrupt | resume`; a committed message becomes a prompt in the recipient inbox. The returned `{messageId, target}` is a handle, not a synchronous join.

Every request enters `gateway.ingest(sender, envelope)`. External drivers provide authenticated sender coordinates and raw `Gateway.IngressFacts`; session tools supply their executor-bound session identity. Compiled message pre-policy selects external table A or session table B. Worker actor sends and worker allocation are denied by the default rows. The gateway reads perimeter facts and uses the injected L1 inbox writer; it does not query session state.

L1 supplies source fences, target relationship/depth/fanout facts, and the child's initial configuration. Child configuration and first inbox commit are atomic. Native and process sessions use the same session runner. A process transports a session id and model configuration over shared durable storage; its output carries committed inbox doorbells, not acceptance or completion settlements.

Child terminal mail preserves final text, terminal kind and original reply binding. Its atomicity, source answer/deadline CAS and exactly-once identity belong to the session/action store. Deadline requests use durable alarm rows, never per-message application timers. The retained Wait fold still owns external reply correlation; it is not a second worker lifecycle.

A machine remains WHERE execution happens, not a messaging target. Actor delivery uses the existing grant, egress-budget, endpoint and idempotency kernel, returning `accepted | rejected | unknown` only for an executed actor effect. Session commits succeed or throw. Current verification and remaining integration gaps are listed in [Implementation Status](implementation-status.md).

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

## 5. Ownership boundaries

The historical rollout sequence is retained in git history. Messaging now uses session inboxes and the shared executor, including from code-mode cells. Native and process child sessions use the same terminal-to-parent contract. Actor sends retain the channel grant/egress/Wait correlation kernel.

#947 owns continuous live due-alarm dispatch and monitoring. #969 owns unification of the retained generic Wait and approval lifecycles. Neither introduces a second messaging or execution authority in this cutover.
