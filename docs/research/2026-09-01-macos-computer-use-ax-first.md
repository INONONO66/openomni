<!-- Research report. Proposal, not wired behavior. See docs/implementation-status.md for what runs. -->

> **What this document is.** The conclusions and design proposal of a research
> session run on 2026-09-01 and revised on 2026-09-02. Every structure,
> contract, and acceptance target here is **proposed**; the only source of truth
> for what actually runs is [`implementation-status.md`](../implementation-status.md).
> Decisions are tracked in RFC issue
> [#887](https://github.com/INONONO66/openomni/issues/887). The raw research
> record (claim graph, observation manifest, probe artifacts) lives outside the
> repository in the research session folder; this file merges the user-facing
> report body with Appendix A (sources) and Appendix B (unresolved leads).

# Codex-quality remote macOS Computer Use: design research

Status: final synthesis.

Revision 2026-09-02: recorded the observation-routing decision (AX-first
adaptive), unified the result-state vocabulary with RFC #887, added Appendix A
(sources) and Appendix B (unresolved leads).

## Terminology

| Term | Meaning |
| --- | --- |
| AX | The macOS Accessibility tree: the `AXUIElement` hierarchy with roles, names, values, and actions |
| SCK | ScreenCaptureKit, the primary screen-capture API in the current SDK |
| TCC | Transparency, Consent, and Control, the macOS permission framework behind Screen Recording and Accessibility grants |
| overlay | AX geometry drawn on top of pixels |
| projection | The video path that shows a remote screen in a browser in real time |
| receipt | A record that a command was accepted or delivered. Not proof of success |
| postcondition | The state that must be observed after an action |
| proof, evidence | An immutable artifact showing that the postcondition was observed |
| epoch | A revision counter that advances when the attachment, process, tree, authority, or display topology changes |
| helper | A signed auxiliary process launched by the daemon |
| re-offer | The daemon re-announcing its current capability set (`Machine.Offer`) |
| journal, ledger | Append-only records |
| `outcome_unknown` | Terminal state for an effect whose application cannot be determined |
| non-model admission | Admission decided by policy or the Owner, never by the model |
| locator | A query that names the target at the level of intent |
| fingerprint | A digest of role, name, and value used to validate the current candidate |
| lease | Ownership with an expiry |
| corpus | The benchmark task set |
| transfer matrix | The table judging which iOS techniques transfer to macOS |

## 1. Conclusion

**Verified fact:** the public computer-use contract and samples can be reused
as an execution and verification harness, but they are not evidence that Codex
desktop uses the same implementation or prioritizes AX. What public facts let
us replicate is the observation, command, safety, and proof contract, not the
internal implementation. [S010][S012][S060][S064]

**Verified fact:** OpenAI's shipped iOS Simulator browser skill is a thin
orchestration layer that invokes `serve-sim`. The actual capture, JPEG/H.264
browser projection, WebSocket HID input, and AX snapshot/overlay live in the
pinned `serve-sim` source. The merged skill contains no semantic AX-targeting
guidance. [S046][S047][S048][S049]

**Design inference:** OpenOmni should make the remote Mac the execution
authority and provide `AX semantic observation + ScreenCaptureKit pixels and
proof + a constrained visual fallback` under one machine contract. Product
judgment lives in `apps/openomni`, remote native semantics in
`packages/machines`, transport in `packages/ipc`, and the wire baseline in
`packages/protocol`. The Mac is an **execution location**, not a worker.
[S030-S034][S063][S085]

**Design decision (2026-09-01, RFC #887):** the three channels are offered under
the same machine contract, but the observation route at execution time is
**AX-first adaptive routing**.

```text
default route:            AX only (bounded snapshot + semantic action)
when needed:              AX + pixels (snapshot incomplete, target ambiguous, or visual postcondition required)
last fallback:            pixels + vision (surfaces with no or poor AX)
high-risk ambiguity:      refuse, or require Owner confirmation
```

AX and pixels are not always called together on every step. Pixels are added
only when the AX snapshot is `partial | truncated | unstable`, when the target
does not resolve to exactly one candidate, or when a visual postcondition or
proof such as color or layout is required. This priority is not a fact derived
from Codex's public behavior. Public material confirms only that Codex desktop
uses screenshots together with accessibility data; which one it consults first
is not published. [S044][S045][S166][S168] An unofficial reverse-engineering
project claims AX indexing with a coordinate fallback, but it is not used as a
factual basis. [S169] AX-first is therefore an independent OpenOmni product
decision made for latency, target stability, and auditability, and it is
tuned by benchmarking AX-first, pixel-first, and simultaneous use on the same
corpus. The router's location and admission rule are in the architecture plan,
section 3.

Shipping `input.write` to a generally untrusted remote principal is
**blocked** until supported pre-dispatch OS containment is verified. Only an
observe-only profile and an explicitly risk-labelled trusted same-account
proof of concept are allowed. [S085][S151-S154]

## 2. What to borrow and what to discard

### Borrow

1. Explicit machine and simulator identifiers with scoped lifecycles.
   [S046][S047]
2. Separation of IOSurface-based native capture from browser projection.
   [S047]
3. Separation of input delivery from semantic postconditions. [S057][S131]
4. Proof discipline that demands real frames and postconditions rather than a
   live preview. [S046][S050-S052]
5. Combining an AX snapshot/overlay with the pixel channel. [S047]
6. Hot reload with a stable PID, epochs, and an observable change check.
   [S046-S048]

### Do not reuse as-is

1. `serve-sim@latest`: the plugin SHA alone does not pin the runtime.
   [S046][S047]
2. `/health`: it does not guarantee readiness. [S156]
3. WebSocket/HID delivery success: it does not guarantee action completion.
   [S057][S131][S155][S156]
4. Per-device state and arbitrary port reclamation: helper ownership is weak
   and unrelated listeners can be killed. [S155][S157]
5. Coordinate-only cropping: it does not prevent pixel leaks from overlapping
   windows. [S141][S142]
6. Generalizing the private iOS Simulator bridge to plain macOS AX or to real
   devices. [S026][S055-S059]

Detailed verdicts are in the transfer matrix below.

## 3. The fundamental iOS/macOS boundary

**Design inference:** iOS automation has no single "macOS AX counterpart."

```text
Public XCUI
  app-scoped test lifecycle and actions

Private Simulator bridge
  CoreSimulator/SimulatorKit layers, capture, HID acceleration

macOS host AX
  the Simulator.app or iPhone Mirroring host surface
```

XCUI snapshots, WDA UUIDs, idb tokens, app `accessibilityIdentifier`, and
macOS `AXUIElementRef` have different identities and lifecycles. They must not
be merged into one persistent live object tree. [S026][S055-S059]

iPhone Mirroring's success is fully explained by the
`com.apple.ScreenContinuity` host window and Mac input relay. It is not
evidence of access to closed iOS internals. [S028]

## 4. Target remote-machine-first structure

```text
Owner / Resident
  -> apps/openomni
       policy, confirmation, record-before-act, global journal
  -> packages/machines
       attachment / capability / native-operation facade
  -> packages/ipc
       typed control + bounded binary/artifact transport
  -> remote macOS daemon / signed helper
       AX, ScreenCaptureKit, input, TCC, local proof
  <- snapshots / previews / receipts / immutable proof / outcome_unknown
```

### Independent capabilities

- `accessibility.read`
- `screen.read`
- `input.write`
- `artifact.transfer`

When TCC state or helper readiness changes, the attachment's offer revision is
updated and capabilities are revoked or re-offered dynamically. Reconnection
creates a new attachment epoch and invalidates every earlier handle, command
lease, and upload lease.

### Success contract

```text
precondition
-> durable authorization
-> delivery receipt
-> native dispatch
-> observed postcondition
-> immutable proof
-> completed | not_applied | precondition_failed | refused | outcome_unknown
```

These five terminal states are used under the same names throughout this
report and RFC #887.

Ordered, reliable delivery still does not guarantee that an effect executes
exactly once. The same command ID with the same hash is a status query and a
deduplication target; the same ID with a different hash is rejected as a
conflict. A non-idempotent action whose result was lost after dispatch is never
replayed automatically. [S067-S069][S107][S110]

Detailed interfaces and package responsibilities are in the architecture plan.

## 5. AX, identity, actions, recovery

**Verified fact:** macOS AX is synchronous, capability-driven IPC. Observers
are invalidation hints, not a transaction log, and `CannotComplete` does not
prove that an action failed. [S030-S034][S065][S107]

**Design inference:**

- A per-PID serial executor with deadlines.
- Bounded snapshots: node, depth, attribute, byte, call, and time budgets.
- Partiality states `complete | partial | truncated | unstable`.
- Opaque native handles bound to process, tree, and topology epochs.
- The locator expresses intent; the fingerprint validates the current
  candidate.
- `subscribe -> buffer -> bounded snapshot -> reconcile`.
- No ambiguous re-binding for consequential actions.
- `unsupported`, `no_value`, `invalid_element`, `api_disabled`,
  `cannot_complete`, and `illegal_argument` stay distinct typed results.

Secure Event Input is a keyboard-monitoring protection, not a pixel or AX
redaction contract. Credential-like surfaces such as `AXSecureTextField` must
not be trusted to mask themselves: block capture, read, paste, replay, and
submit, then end with confirmation or human handoff. [S108-S111]

## 6. Capture, projection, geometry

**Verified fact:** ScreenCaptureKit is the primary macOS capture API within
the current SDK. [S092]

**Design inference, initial baseline:**

```text
ScreenCaptureKit per-display frames
-> VideoToolbox H.264
-> WebRTC video channel
-> browser <video>
```

The superiority of this path is unproven. H.264/HEVC/AV1, WebRTC/WebCodecs,
RFB, and MJPEG are compared on the same corpus. [S003][S006][S008][S024]
[S052][S088-S091][S129][S132][S134]

`sourceRect` and AX geometry are logical points; dirty and destination
surfaces are pixels. Per-display transforms and topology epochs are preserved.
Dirty rectangles are not a complete change log, so a lost reference frame or a
geometry, filter, permission, or reconnection change recovers with a full frame
or keyframe. [S092-S094][S118-S130]

The live preview, the bytes the model observed, the authoritative proof, and
the estimated overlay are different contracts. A frame is shown as "what the
model saw" only when its hash equals the actual model input bytes. [S063][S064]

## 7. Authority, broker, ledger

Same UID, a `0600` socket, a PID, or a string identifier alone never admits a
native caller. Kernel peer identity and code-signing identity are verified, and
every request binds a nonce, expiry, capability, exact operation hash, and
epoch. [S151-S154]

```text
verify peer and manifest
-> reject replay, expiry, and capability mismatch
-> durable effect.authorized record
-> native dispatch
-> postcondition and proof
-> durable completed | not_applied | outcome_unknown record
```

An unkeyed hash chain does not stop a ledger-write attacker from recomputing
the whole chain. Keyed checkpoints and an external append-only witness are
hardening gates. Policy and audit do not replace OS containment. [S151][S154]

## 8. Implementation phases

1. **P0 evidence freeze**: immutable corpus, evaluator, and environment
   manifests.
2. **P1 protocol**: Zod schemas for native operations, results, errors, and
   epochs.
3. **P2 transport**: control channel plus binary/artifact side channel.
4. **P3 native daemon**: capability watch, AX executor, SCK, input, re-offer.
5. **P4 admission and proof**: app and broker record-before-act,
   deduplication, proof finalization.
6. **P5 product tools**: observe, capture, act, and verify tools.
7. **P6 hardening**: signer, TCC, secure surfaces, geometry, crashes,
   containment, risk-tiered evidence policy tuning.
8. **P7 quality parity**: fixed baseline and paired comparison.

The observation router's AX-only admission rule ships first as a
deterministic rule in P5 and is tuned from benchmark results in P7.

Concrete exit gates are in the benchmark plan.

## 9. Resolving the core contradictions

- Claiming that Codex is AX-first is prohibited. OpenOmni's preference for
  semantic actions is an independent design inference.
- Pixels are evidence of the captured rendered state, not the absolute
  authority on freshness, hidden state, intent, occlusion, or semantic
  completion.
- A longer timeout may help a slow provider but never guarantees readiness.
- The presence of dirty metadata is not the same as its completeness.
- Reliable delivery is not the same as proof of effect.
- The finding that large raw frames need a binary channel is not extended to
  a universal statement about every frame.
- The fact that general text is not a single US-HID path is kept separate from
  the design inference about concrete input modes.

## 10. Unresolved and refuted annex

### Prohibited claims

- That the hybrid approach is already "the strongest."
- That pixels are universal ground truth.
- That increasing a timeout is always meaningless.
- That every Retina frame exceeds the IPC limit.
- That a complete text-input classification was proven from a few local
  artifacts.

### Promotion blockers

- Supported pre-dispatch macOS containment.
- Operational signer and peer-identity renewal, rotation, and revocation
  matrix.
- A clean TCC and version matrix.
- A cross-framework AX action corpus.
- A mixed-DPI, rotation, and Spaces geometry corpus.
- A secure-field AX and pixel exposure matrix.
- A full capture→encode→network→browser benchmark.
- Immutable external evaluators and macOS human trajectories.
- Keyed or external ledger witnesses.
- A comparable Codex baseline build, account, policy, and denominator.

These are acceptance inputs that block phase promotion, not further research
questions. The full list of unresolved leads and the convergence audit are in
Appendix B.

## 11. Research scale and confidence

- Opening nodes: 60.
- Expansion waves: 2.
- Final skeptic pass: 122/122 qualifying high-risk claims.
- Skeptic verdicts: 68 supported, 52 partial, 1 refuted, 1 unresolved.
- Conservative synthesis allowlist: `claim-graph.md#verified-claims` (32
  claims, all supported).
- Tracked leads: 219. 82 closed, 61 unresolved or partial, 74 moved to the
  unresolved annex, 2 refuted. Leads left without a disposition: 0.
- Wave-3 strict evidence audit: 2 of 13 nodes passed. Closure claims from the
  11 failing nodes were not promoted into the body. Details in Appendix B.
- No unrecorded execution measurements were used.

## 12. Canonical records and evidence

The research session folder (outside this repository) holds the canonical
record:

- Claim allowlist: `claim-graph.md`
- Source ledger: `sources-ledger.md` (reproduced as Appendix A)
- Observation manifest: `observation-manifest.md`
- Debate log: `debate-log.md`
- Expansion tracking: `expansion-log.md` (summarized in Appendix B)
- Final skeptic and global synthesizer outputs: internal session records, not
  publicly verifiable.

## 13. Open decisions

Tracked in RFC #887; this report does not settle them.

1. Whether the first semantic-action milestone includes only `press`,
   `setValue`, and `scroll`, or also typed text input.
2. Which risk tiers require visual proof.
3. Whether large frame and evidence transfer uses an IPC side channel, an
   object store, or both.
4. Which deterministic AX-quality rules ship before benchmark-based tuning.
5. What supported pre-dispatch OS containment is required before allowing
   `input.write` from a generally untrusted remote principal.

---

# Transfer matrix: from the iOS Simulator to remote macOS Computer Use

| Item | iOS evidence | macOS mapping | Verdict | Risk | Cites |
| --- | --- | --- | --- | --- | --- |
| Skill orchestration | The shipped skill orchestrates `serve-sim` invocation, lifecycle, and proof | `apps/openomni` owns product composition; `packages/machines` owns native semantics | adapt | medium | S046,S047 |
| IOSurface capture | SimulatorKit IOSurface capture | Plain Macs use ScreenCaptureKit; a private Simulator adapter is isolated on a separate path | adapt | high | S047,S092 |
| Browser preview | JPEG/H.264 browser projection | SCK→VT H.264→WebRTC as the initial baseline, separated from the proof path | adapt | high | S047,S063,S064 |
| HID back-channel | Tagged WebSocket HID with no success/error acknowledgement | Typed action receipt + observed postcondition + `outcome_unknown` state | reject | critical | S057,S131,S155,S156 |
| Service health | A health check does not prove readiness | First fresh frame + non-zero geometry + foreground and capability readiness | reject | high | S156 |
| AX dependency | `serve-sim` includes a bounded AX snapshot and overlay | Use the bounded AX adapter and pixel overlay pattern | adapt | high | S047 |
| Merged AX guidance | The merged shipped skill has no semantic AX-targeting guidance | OpenOmni's AX policy is designed independently and not claimed as shipped behavior | reject | medium | S046,S047,S048,S049 |
| Hot reload | Per-epoch dynamic library, stable PID, visible change proof | Borrow the epoch and observable-proof pattern for helper/adapter updates | adapt | medium | S046,S048 |
| Scoped lifecycle | Explicit UDID and scoped cleanup | Strengthen with machine, attachment, and helper epochs plus ownership leases | adapt | high | S046,S147,S157 |
| Proof procedure | Requires real frames and reload output instead of page load | Immutable action-bound proof + postcondition | reuse | high | S046,S063,S064 |
| Coordinate model | Separate guest-point, framebuffer, and host-point spaces | Logical-point coordinates with per-display pixel transforms and epochs | adapt | high | S058,S092,S094 |
| simctl boundary | Lifecycle, screenshot, and video features; no general input | Use only as a supported auxiliary tool, never as the native input backend | reuse | low | S057,S165 |
| XCUI snapshot | Dynamic query + private snapshot transport | An optional test oracle for owned apps, not a superset of production AX | adapt | high | S026,S056,S059 |
| idb private bridge | Private Simulator AX/HID acceleration | Isolate behind a supported contract as a pinned-Xcode adapter | adapt | critical | S057 |
| iPhone Mirroring | macOS ScreenContinuity host surface | Treat as a pixel-first, focus-sensitive host target; infer nothing about iOS internals | adapt | high | S028 |
| Text input | USB HID usage-code-centric path | Separate key, text, IME, paste, and secure-input modes by type | reject | high | S131 |
| State ownership | Per-device state without a strong owner identity | Code identity + attachment/helper epochs + leases | reject | critical | S157 |
| Port reclamation | May SIGKILL an arbitrary listener | Reclaim only after authenticating the owner; fail when unclear | reject | critical | S155,S157 |
| Floating dependency | The shipped skill uses `serve-sim@latest` | Pin the resolved version, integrity, and Xcode provenance | reject | high | S046,S047 |

## Verdict criteria

- `reuse`: borrow the semantics and safety contract nearly as-is.
- `adapt`: borrow the principle but change it for public macOS APIs, remote
  IPC, and the authority boundary.
- `reject`: unusable in the product contract at its current semantics or trust
  level.

## Key interpretation

What is worth borrowing is not the "iOS AX implementation" but **plane
separation, the split between projection and proof, explicit lifecycles, and
postcondition verification after an input receipt**.

The private iOS Simulator bridge is not the default production path on macOS.
Plain macOS uses ScreenCaptureKit and AXUIElement; Simulator acceleration is
isolated as an optional adapter with Xcode pinning and acceptance gates.

---

# Remote macOS Computer Use architecture plan

## 1. Architecture decision

Computer Use is designed remote-machine-first.

```text
packages/protocol        Zod wire baseline, fixed methods, discriminated results
packages/ipc             typed control, backpressure, binary/artifact side channel
packages/machines        attachment, capability lifecycle, native-operation facade
remote macOS daemon      TCC, AX, SCK, input, local dedup, postconditions, proof
apps/openomni            admission, Owner confirmation, record-before-act, journal
```

The Mac is an execution location, not a worker. Computer Use is not built as a
delegation transport. `run_cell` and reverse `call_tool` must not become
bypasses for native operations.

### Starting point in the repository

At the research pin (34945a74) OpenOmni already has:

- attached-machine capability negotiation and cell execution in
  `packages/machines`
- bidirectional transport in `packages/ipc`
- shared serializable contracts in `packages/protocol`
- product policy, Owner confirmation, tools, and lifecycle composition in
  `apps/openomni`

It does not yet have first-class contracts for bounded macOS AX snapshots,
stable UI element identity, ScreenCaptureKit observation, semantic native
actions, adaptive AX/pixel/vision routing, observed postconditions and
immutable proof, or reconciliation of effects whose outcome cannot be
determined. Everything below adds those contracts; it does not describe wired
behavior.

## 2. Native operation contract

```ts
type Capability =
  | "accessibility.read"
  | "screen.read"
  | "input.write"
  | "artifact.transfer"

type NativeOperationRequest = {
  protocolVersion: string
  operationId: string
  machineId: string
  sessionId: string
  attachmentEpoch: string
  authorityEpoch: string
  deadlineAt: string
  requiredCapabilities: Capability[]
  authorization?: AuthorizationEnvelope
  operation: NativeOperation
}

type NativeOperationResult<T> =
  | { status: "completed"; value: T; evidence: EvidenceRef[] }
  | { status: "not_applied"; error: NativeError }
  | { status: "precondition_failed"; reason: string }
  | { status: "refused"; reason: RefusalReason }
  | { status: "outcome_unknown"; reconciliation: ReconciliationRecord }
```

Only these five terminal states are used. `completed` means the postcondition
was observed; `not_applied` means non-application was confirmed;
`precondition_failed` means revalidation immediately before dispatch failed;
`refused` means the action was declined for policy, authority, or ambiguity;
`outcome_unknown` means application cannot be determined. The names match RFC
#887.

Native CF/AX objects never cross the transport boundary. Only snapshot values
and epoch-scoped opaque handles do.

## 3. Observation plane

There are three observation channels: AX, ScreenCaptureKit pixels, and vision.
At the level of public fact, no channel's superiority has been verified. On top
of that, OpenOmni adopts **AX-first adaptive routing** as a product decision
(RFC #887, 2026-09-01).

```text
default route:            AX only
when needed:              AX + pixels
last fallback:            pixels + vision
high-risk ambiguity:      refuse, or require Owner confirmation
```

### Observation router

Route selection is owned by `apps/openomni`. `packages/machines` exposes AX,
capture, and input capabilities as typed results but does not judge product
risk or fallback policy, and does not silently switch observation policy
inside. The chosen route and its reason are recorded in the product journal.

Initial AX-only admission rule:

```text
snapshot == complete
AND target.count == 1
AND target.action_supported
AND target.not_stale
AND visual_postcondition_not_required
```

A ScreenCaptureKit observation is added when any of the following holds:

- The AX snapshot is `partial`, `truncated`, or `unstable`.
- There is more than one candidate target.
- The target is on a canvas, video, game, or custom-rendered surface.
- Color, layout, animation, or rendered output is part of the postcondition.
- AX geometry must be checked against the rendered surface.
- The operation requires visual proof.

Vision-based coordinate targeting is used only on surfaces where AX and pixels
together still fail to identify the target. A consequential action with
several candidates is refused with `ambiguous_target` rather than guessing
coordinates. AX and pixels are not always called together on every step.

### Bounded AX snapshot

```ts
type AXSnapshotRequest = {
  root: ElementRef | "application"
  attributes: string[]
  maxNodes: number
  maxDepth: number
  maxBytes: number
  maxIPCCalls: number
  deadlineAt: string
}
```

The result state is `complete | partial | truncated | unstable`.

### Pixels and proof

- ScreenCaptureKit is the default capture.
- Per-display surfaces and topology epochs are maintained.
- Dirty regions are used only to optimize the preview.
- Proof is stored as immutable full artifacts.
- Window filters are identifier-based; coordinate-only privacy cropping is
  prohibited.

## 4. Stable element identity

```ts
type ElementRef = {
  processEpoch: string
  treeEpoch: string
  opaqueNativeKey: string
  locator: Locator
  fingerprint: Fingerprint
  observedRevision: string
}
```

Process relaunch, PID reuse, invalid elements, permission loss, provider
change, and topology change invalidate the corresponding epoch.

A consequential action must satisfy all of the following:

- The current locator resolves to exactly one element.
- The fingerprint and capability are revalidated.
- Ambiguous candidates are refused with `ambiguous_target`.
- Speculative coordinate re-binding is prohibited.

## 5. Cache invalidation and observers

```text
subscribe
-> buffer notifications
-> bounded authoritative snapshot
-> reconcile buffered invalidations
-> ready | unstable
```

Observer events are change hints. State is never reconstructed from event
patches alone.

## 6. Action execution

```text
exact operation manifest
-> non-model admission
-> durable authorized record
-> daemon admission and deduplication
-> precondition and target revalidation
-> native dispatch
-> postcondition
-> proof finalization
-> terminal result
```

Action results use only the five states from section 2:

- `completed`
- `not_applied`
- `precondition_failed`
- `refused`
- `outcome_unknown`

`CannotComplete`, a lost response, or a crash after dispatch became possible
preserves ambiguity. A non-idempotent action is never re-executed
unconditionally.

### Evidence policy

Not every operation requires a screenshot. Evidence is tiered by the risk of
the operation; the tier is chosen by `apps/openomni` and recorded with the
route.

| Operation | Required evidence |
| --- | --- |
| AX read | Snapshot plus revision/epoch |
| Low-risk AX action | Action receipt plus AX postcondition |
| Visual-state change | Before/after frame or bounded changed region |
| File save or transfer | Durable file/object hash |
| External or destructive effect | Owner admission, postcondition, immutable artifact, journal record |
| Unknown outcome | Reconciliation record and no-blind-replay state |

## 7. Browser projection and remote protocol

Initial baseline:

```text
remote SCK -> VideoToolbox H.264 -> WebRTC video -> browser
browser intent -> reliable control -> remote admission -> AX / raw input
```

This is a benchmark candidate, not a verified optimum.

Every message carries:

- session, attachment, authority, observation, and topology epochs
- message ID, command ID, sequence, and payload hash

On reconnection, outstanding command IDs and states are exchanged and the
preview delta stream is reset with a full frame.

## 8. Binary and artifact transport

Control JSON carries descriptors only. Large or streaming payloads use a
length-framed binary side channel or an object store.

```ts
type BinaryDescriptor = {
  artifactId: string
  attachmentEpoch: string
  mimeType: string
  byteLength: number
  sha256: string
  chunkSize: number
}
```

Partial artifacts are never exposed. Byte-count and hash verification and
durable finalization must happen before a `completed` result.

## 9. Authority boundary and threat model

Three release profiles:

1. Observe-only.
2. Explicitly trusted same account.
3. Untrusted remote environment, blocked until containment exists.

Broker requirements:

- Kernel peer identity and code identity.
- Nonce, expiry, capability, and exact operation hash.
- Never authenticate on PID or string identifiers alone.
- Record before act.
- Keyed or external audit witness for the hardening phase.
- Pre-dispatch OS containment.

## 10. OpenOmni integration seams

### `packages/protocol`

- Native operation, result, and error schemas.
- Capability re-offer schema.
- Artifact descriptor and proof manifest.

### `packages/ipc`

- Control channel.
- Binary side channel.
- Checksum, length, backpressure, and disconnection contracts.

### `packages/machines`

- `nativeOperation` facade.
- Per-PID AX executor.
- SCK service.
- Typed input service.
- Capability watch and re-offer.
- Artifact uploader.

### `apps/openomni`

- Observation-route selection and reason recording.
- Operation admission.
- Owner confirmation.
- Record before act.
- Tool catalog.
- Artifact persistence.
- Global terminal journal.

## 11. Implementation order

1. Freeze the acceptance manifest and vocabulary.
2. Protocol schemas.
3. IPC control and binary primitives.
4. Machine daemon adapter.
5. Signed helper and peer identity.
6. Capability lifecycle.
7. App artifact intake.
8. App admission and journal.
9. Tools and placement.
10. Deterministic proof-of-concept corpus.
11. Hardening fault corpus.
12. Parity benchmark.

## 12. Proof-of-concept exit criteria

**Product acceptance targets, not public facts.** RFC #887's "initial
acceptance criteria" list combines the PoC and hardening gates below.

- One signed remote Mac daemon.
- Four independent capabilities.
- Bounded AX snapshots.
- Semantic actions with a pointer fallback.
- Window proof artifacts.
- Capability revocation and re-offer.
- Durable pre-dispatch authorization records.
- 0 actions on a stale epoch.
- 0 actions whose route and reason are missing from the journal.
- 0 unauthorized mutations.

## 13. Hardening exit criteria

**Product acceptance targets, not public facts.**

- 0 duplicate side effects in 10,000 attempts.
- 0 blind replays.
- 0 missed capability revocations after a mutation gate.
- 100% reconciliation success across notification gaps.
- 0 automated actions on secure surfaces.
- 0 partial binary exposures.
- The signer, nonce, ledger, focus, and topology fault suite passes.

## 14. Quality-parity exit criteria

**Product acceptance targets, not public facts.**

- Fixed baseline build, account, policy, and denominator.
- Isolated typed evaluators.
- Paired confidence-interval gates.
- 100% precision on destructive actions.
- Trajectory, proof, and journal for every success.
- External or keyed ledger witness.

## 15. Promotion blockers

- Supported broad input containment.
- Signer rotation and revocation matrix.
- Clean TCC and version matrix.
- Cross-framework AX corpus.
- Mixed-DPI and Spaces geometry corpus.
- Secure-field exposure matrix.
- Full remote projection benchmark.
- Comparable Codex baseline.

---

# Benchmark plan for Codex-level macOS Computer Use

## 1. Evidence-handling principles

Every threshold below is a **product acceptance target, not a public fact**.

- Immutable task (corpus), evaluator, environment, and policy manifests.
- Exact typed scorers.
- Consistent denominators.
- Evaluators isolated outside the agent's desktop authority.
- Preserved trajectories, action receipts, proof hashes, and journals.
- Seeded paired execution order.
- No fixed sleeps; exact event and state subscriptions with timeouts.

## 2. Corpus

| Layer | Cases |
| --- | --- |
| Semantics | Buttons, menus, tables, text, dialogs, drag and drop, canvas |
| Frameworks | AppKit, SwiftUI, Electron, WebView, Qt/Java, custom rendering |
| Geometry | Retina, mixed DPI, negative origins, rotation, Spaces, Stage Manager |
| Lifecycle | Relaunch, PID reuse, observer loss, daemon reconnection, sleep |
| Permissions | AX/SCK denied, granted, revoked, responsible-process variants |
| Input | Physical keys, Unicode, IME, paste, pointer, focus |
| Safety | Credentials, auth dialogs, destructive confirmations, prompt injection |
| Recovery | Stale handles, duplicates, lost responses, crashes, checksum failures |
| Cross-app | Switching, file pickers, overlapping-window privacy |

## 3. Metrics

- Task success rate.
- Precision and recall on destructive actions.
- Count of unauthorized executions.
- Ratio of minimum human steps to agent steps.
- Per-action and end-to-end latency p50/p95/p99.
- Stale-target rate and recovery rate.
- `outcome_unknown` rate and classification accuracy.
- Permission recovery rate.
- Frame freshness and proof-finalization latency.
- Bytes per action, CPU, and peak RSS.
- Per-framework, per-display, and per-permission slice results.
- Duplicate suppression and reconnection recovery rate.
- Per-route (AX only, AX + pixels, pixels + vision) success, latency, and
  switch-reason distribution.

## 4. Proof-of-concept targets

Targets for the proof-of-concept phase.

**Product acceptance targets, not public facts.**

- Stale reconnection executions: 0/100.
- Route-selection reasons missing: 0.
- Mutations with mismatched capabilities: 0/100.
- Low-risk corpus success rate: >=95%.
- Unauthorized native effects: 0.
- Admitted artifact hash or length mismatches: 0/100.
- Ambiguous-target classification: 100%.
- Guessed actions on ambiguous consequential targets: 0.
- Missing visual evidence when visual proof is required: 0.
- p95 AX operation: <=250 ms.
- p95 admitted action: <=500 ms.
- p95 action-to-proof: <=2 s.

## 5. Hardening targets

**Product acceptance targets, not public facts.**

- Duplicate side effects: 0/10,000.
- Blind replays after ambiguity: 0.
- Typed error and reconciliation classification: 100%.
- Mutations after capability revocation: 0.
- Geometry round-trip error: <=2 logical points.
- Supported geometry corpus success: >=98%.
- Stale-state recovery rate: >=95%.
- Indeterminate results misclassified as determinate: <=0.5%.
- Partial artifact exposures: 0.
- Automated capture, input, or submit on credential-like surfaces: 0.
- Capture and encode CPU/RAM increase over the fixed baseline: <=20%.

## 6. Quality-parity targets

Run only against a fixed, comparable baseline.

**Product acceptance targets, not public facts.**

- >=5 repetitions for ordinary tasks, >=20 for non-deterministic tasks.
- Paired success-rate 95% CI lower bound: >= -3 percentage points.
- Destructive-action precision: 100%.
- Human-intervention ratio: <=1.5x baseline.
- Executions per successful task: <=1.25x baseline.
- Successful-task latency: <=1.25x baseline.
- Major slice success rate: >=95%.
- Re-run success-rate variance: <=3 percentage points.
- Successful evaluator spoofing: 0.
- An external witness checkpoint for every outcome-affecting terminal action.

## 7. Required faults

1. Crash before the authorization record is finalized.
2. Lost response after dispatch.
3. Stale attachment epoch.
4. Duplicate operation ID with a hash conflict.
5. Replay of a pre-re-offer revision.
6. PID reuse.
7. Observer loss or coalesced notifications.
8. TCC revocation mid-operation.
9. Partial binary or checksum mismatch.
10. Topology change during a pointer action.
11. Secure field or authentication dialog.
12. Focus steal.
13. Malformed evaluator output.
14. Evaluator or manifest tampering.
15. Signer mismatch and nonce replay.
16. Ledger rewrite and witness mismatch.

## 8. Capture and projection experiments

Compare full paths, not isolated hints.

```text
capture -> encode -> sender queue -> network -> jitter
-> decode -> display -> action -> postcondition -> proof
```

Candidates:

- SCK + VideoToolbox H.264 + WebRTC
- SCK + VT + WebCodecs
- RFB/noVNC
- MJPEG proof fallback

Observation routing is compared on the same corpus: AX-first, pixel-first,
and simultaneous policies run against the same tasks, measuring success,
latency, and switch reasons, and the AX-only admission rule is tuned from the
result.

## 9. Evaluator integrity

The pinned macOSWorld evaluator cannot be reused.

- Substring `"true"` success matching. [S147]
- An uninitialized mismatch path. [S148]
- Evaluators that run inside the agent-controlled guest.

Requirements:

- Exact enum/boolean schemas.
- Immutable evaluator hashes.
- A separate authority principal.
- Fail closed on malformed output, mismatch, or empty fallback.
- An adversarial "true"-string corpus.
- Published exclusion criteria and denominators.

## 10. Statistics

- Success proportions: Wilson intervals.
- Paired success-rate differences: paired bootstrap 95% CI.
- Latency: paired distributions with p50/p95/p99.
- Effect errors: exact counts with confidence intervals.
- No averaging across framework or permission slices without tail reporting.

## 11. Phase promotion

The proof-of-concept, hardening, and parity gates are blocking. Without real
remote-machine execution, proof artifacts, and isolated evaluator receipts, a
passing unit-test suite alone never promotes a phase.

---

# Appendix A. Sources

`[S000]` markers in the body refer to the numbers below; a range such as `[S030-S034]` means every number in between. The date is when the research session actually opened the source. Of 169 entries, 106 have a public URL. The remaining 63 are pinned sources recorded with only a commit SHA or paper number (32), local Xcode SDK headers (10), and local probe or system artifacts (21). Sources without a URL cannot be re-checked on the public web directly, so they are grouped separately. Adding URLs to the pinned sources is a cleanup item before implementation starts.

## A.1 Public sources

- **[S001]** Apple ScreenCaptureKit documentation · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/screencapturekit>
- **[S002]** Apple CGDisplayStream documentation · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/coregraphics/cgdisplaystream>
- **[S003]** Apple VideoToolbox documentation · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/videotoolbox>
- **[S004]** WebRTC source mirror · primary implementation · observed 2026-09-01  
  <https://github.com/webrtc-mirror/webrtc>
- **[S005]** WebRTC macOS capturer source · primary implementation · observed 2026-09-01  
  <https://webrtc.googlesource.com/src/+/refs/heads/main/modules/desktop_capture/mac/screen_capturer_mac.mm?format=TEXT>
- **[S006]** W3C WebCodecs · primary standard · observed 2026-09-01  
  <https://www.w3.org/TR/webcodecs/>
- **[S007]** W3C Media Source Extensions · primary standard · observed 2026-09-01  
  <https://www.w3.org/TR/media-source/>
- **[S008]** W3C WebRTC · primary standard · observed 2026-09-01  
  <https://www.w3.org/TR/webrtc/>
- **[S009]** Apple AXUIElement documentation · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/applicationservices/axuielement>
- **[S010]** OpenAI Responses API Computer Use guide · primary · observed 2026-09-01  
  <https://platform.openai.com/docs/guides/tools-computer-use>
- **[S011]** Codex approvals and security · primary · observed 2026-09-01  
  <https://developers.openai.com/codex/agent-approvals-security>
- **[S012]** Codex app browser · primary · observed 2026-09-01  
  <https://learn.chatgpt.com/codex/app/browser>
- **[S013]** Codex in ChatGPT help · primary · observed 2026-09-01  
  <https://help.openai.com/en/articles/11369540-codex-in-chatgpt>
- **[S014]** Introducing Codex · primary historical · observed 2026-09-01  
  <https://openai.com/index/introducing-codex/>
- **[S015]** Operator system card · primary adjacent product · observed 2026-09-01  
  <https://openai.com/index/operator-system-card/>
- **[S016]** Introducing ChatGPT agent · primary historical adjacent product · observed 2026-09-01  
  <https://openai.com/index/introducing-chatgpt-agent/>
- **[S017]** Apple macOS Accessibility guide · primary · observed 2026-09-01  
  <https://developer.apple.com/library/archive/documentation/Accessibility/Conceptual/AccessibilityMacOSX/>
- **[S018]** Chrome DevTools Accessibility domain · primary protocol · observed 2026-09-01  
  <https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/>
- **[S019]** Anthropic computer-use docs · primary adjacent implementation · observed 2026-09-01  
  <https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool>
- **[S020]** Anthropic computer-use demo · primary implementation · observed 2026-09-01  
  <https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo>
- **[S021]** browser-use · primary implementation · observed 2026-09-01  
  <https://github.com/browser-use/browser-use>
- **[S022]** Microsoft UFO · primary implementation · observed 2026-09-01  
  <https://github.com/microsoft/UFO>
- **[S023]** Hammerspoon docs · primary implementation docs · observed 2026-09-01  
  <https://www.hammerspoon.org/docs/>
- **[S024]** Apache Guacamole · primary implementation · observed 2026-09-01  
  <https://guacamole.apache.org/>
- **[S025]** FreeRDP · primary implementation · observed 2026-09-01  
  <https://github.com/FreeRDP/FreeRDP>
- **[S026]** Apple XCTest · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/xctest>
- **[S027]** Appium WebDriverAgent · primary implementation · observed 2026-09-01  
  <https://github.com/appium/WebDriverAgent>
- **[S028]** Apple iPhone Mirroring guide · primary · observed 2026-09-01  
  <https://support.apple.com/en-us/120421>
- **[S029]** OpenAI Codex issue 33663 · first-party issue observation · observed 2026-09-01  
  <https://github.com/openai/codex/issues/33663>
- **[S030]** Apple AXUIElement header/docs · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/applicationservices/axuielement_h>
- **[S031]** Apple AX multiple attribute values · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/applicationservices/axuielementcopymultipleattributevalues(_:_:_:_:)>
- **[S032]** Apple AX perform action · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/applicationservices/axuielementperformaction(_:_:)>
- **[S033]** Apple AXObserver · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/applicationservices/axobserver>
- **[S034]** Apple AXError · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/applicationservices/axerror>
- **[S035]** Apple AX trust API · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions>
- **[S036]** Apple App Sandbox configuration · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox/>
- **[S037]** AXSwift · primary implementation · observed 2026-09-01  
  <https://github.com/tmandry/AXSwift>
- **[S038]** ActivityWatch AXObserver leak report · measured issue evidence · observed 2026-09-01  
  <https://github.com/ActivityWatch/aw-watcher-window/issues/139>
- **[S039]** Windows UIA runtime ID · primary docs · observed 2026-09-01  
  <https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.getruntimeid>
- **[S040]** Chrome DevTools DOM · primary protocol · observed 2026-09-01  
  <https://chromedevtools.github.io/devtools-protocol/tot/DOM/>
- **[S041]** W3C WebDriver elements · primary standard · observed 2026-09-01  
  <https://w3c.github.io/webdriver/#elements>
- **[S042]** Playwright actionability · primary implementation docs · observed 2026-09-01  
  <https://playwright.dev/docs/actionability>
- **[S043]** WebDriverAgent element cache · primary source · observed 2026-09-01  
  <https://raw.githubusercontent.com/appium/WebDriverAgent/master/WebDriverAgentLib/Routing/FBElementCache.m>
- **[S044]** Codex computer-use docs · primary · observed 2026-09-01  
  <https://developers.openai.com/codex/computer-use.md>
- **[S045]** OpenAI Codex issue 36459 · first-party issue observation · observed 2026-09-01  
  <https://github.com/openai/codex/issues/36459>
- **[S046]** OpenAI ios-simulator-browser pinned skill · primary source · observed 2026-09-01  
  <https://github.com/openai/plugins/blob/1e285826e604f66f7208f7ac4dba0fe8341d1f57/plugins/build-ios-apps/skills/ios-simulator-browser/SKILL.md>
- **[S047]** serve-sim pinned source · primary implementation · observed 2026-09-01  
  <https://github.com/EvanBacon/serve-sim/tree/0ee6fbde40a6b5840d0c6e0379f544feb9fa246b>
- **[S048]** SnapshotPreviews pinned source · primary implementation · observed 2026-09-01  
  <https://github.com/EmergeTools/SnapshotPreviews-iOS/tree/d42446f0439217941a4e3a2ca58a643c1ac328c4>
- **[S049]** OpenAI plugins PR 233 AX-first proposal · first-party unmerged design evidence · observed 2026-09-01  
  <https://github.com/openai/plugins/pull/233>
- **[S050]** OpenAI plugins PR 308 merged implementation · first-party merged change · observed 2026-09-01  
  <https://github.com/openai/plugins/pull/308>
- **[S051]** serve-sim issue 136 input false success · issue evidence · observed 2026-09-01  
  <https://github.com/EvanBacon/serve-sim/issues/136>
- **[S052]** serve-sim issue 128 MJPEG false stall · issue evidence · observed 2026-09-01  
  <https://github.com/EvanBacon/serve-sim/issues/128>
- **[S053]** serve-sim issue 56 record/replay proposal · issue evidence · observed 2026-09-01  
  <https://github.com/EvanBacon/serve-sim/issues/56>
- **[S054]** serve-sim issue 102 orphan/high CPU · historical issue evidence · observed 2026-09-01  
  <https://github.com/EvanBacon/serve-sim/issues/102>
- **[S055]** UIKit accessibilityIdentifier · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/uikit/uiaccessibilityidentification/accessibilityidentifier>
- **[S056]** WebDriverAgent pinned source · primary implementation · observed 2026-09-01  
  <https://github.com/appium/WebDriverAgent/tree/b06271fc0d73241f7a577af98b3f95d8a7ee2f7b>
- **[S057]** facebook idb pinned source · primary implementation · observed 2026-09-01  
  <https://github.com/facebook/idb/tree/9ca15afdd417e5f36e3d6cc32239b580e343243d>
- **[S058]** Apple XCUICoordinate · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/xcuiautomation/xcuicoordinate>
- **[S059]** Appium XCUITest driver pinned source · primary implementation · observed 2026-09-01  
  <https://github.com/appium/appium-xcuitest-driver/tree/a14c4548b3505e628a9f05d7efc585e6ee938640>
- **[S060]** OpenAI Codex repository pin · primary source · observed 2026-09-01  
  <https://github.com/openai/codex/tree/633ab199cfd724aa78013c006b27a2b3d049fc3b>
- **[S061]** Codex Record and Replay · primary · observed 2026-09-01  
  <https://developers.openai.com/codex/extend/record-and-replay>
- **[S062]** serve-sim npm 0.1.46 manifest · primary package metadata · observed 2026-09-01  
  <https://registry.npmjs.org/serve-sim/0.1.46>
- **[S063]** Apple ScreenCaptureKit capture guide · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos>
- **[S064]** OpenAI CUA sample app pin · primary implementation · observed 2026-09-01  
  <https://github.com/openai/openai-cua-sample-app/tree/3751c8baa6376c0bbf6cceea2cdc0c0b42996e03>
- **[S065]** AXSwift pinned source · primary implementation · observed 2026-09-01  
  <https://github.com/tmandry/AXSwift/tree/e18a18453d135ad45809a384ee5139e05ea52def/Sources>
- **[S066]** Chrome DevTools DOM protocol pin · primary protocol source · observed 2026-09-01  
  <https://github.com/ChromeDevTools/devtools-protocol/blob/41535d3aa57d27fc86a4ddcceb5bef23f382d67d/pdl/domains/DOM.pdl>
- **[S067]** RFC 8831 WebRTC Data Channels · primary standard · observed 2026-09-01  
  <https://www.rfc-editor.org/rfc/rfc8831.html>
- **[S068]** RFC 8832 DCEP · primary standard · observed 2026-09-01  
  <https://www.rfc-editor.org/rfc/rfc8832.html>
- **[S069]** RFC 8445 ICE · primary standard · observed 2026-09-01  
  <https://www.rfc-editor.org/rfc/rfc8445.html>
- **[S070]** Appium mac2 driver pin · primary implementation · observed 2026-09-01  
  <https://github.com/appium/appium-mac2-driver/tree/793f0ec01f9db46ced44e8bcb10574c89857813e>
- **[S071]** Codex sandboxing docs · primary · observed 2026-09-01  
  <https://developers.openai.com/codex/sandboxing.md>
- **[S072]** Codex managed configuration · primary · observed 2026-09-01  
  <https://developers.openai.com/codex/enterprise/managed-configuration.md>
- **[S073]** Chromium AX text implementation pin · primary source · observed 2026-09-01  
  <https://chromium.googlesource.com/chromium/src/+/0847c2e4e984379e298459e69765aaeb7cbb4d43>
- **[S074]** WebKit source pin · primary source · observed 2026-09-01  
  <https://github.com/WebKit/WebKit/tree/c5cf5b7adef53ed9941565a6b1086dc601a8517a>
- **[S075]** Gecko source pin · primary source · observed 2026-09-01  
  <https://github.com/mozilla/gecko-dev/tree/5836a062726f715fda621338a17b51aff30d0a8c>
- **[S076]** WebRTC ScreenCaptureKit pin · primary source · observed 2026-09-01  
  <https://webrtc.googlesource.com/src/+/f42551fe4c84391810cb98e836dddcfa1d1d7da0/>
- **[S077]** Apple NSTextInputClient · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/appkit/nstextinputclient>
- **[S078]** Apple NSPasteboard · primary · observed 2026-09-01  
  <https://developer.apple.com/documentation/appkit/nspasteboard>
- **[S079]** Microsoft UI Automation docs pin · primary docs source · observed 2026-09-01  
  <https://github.com/MicrosoftDocs/win32/tree/ae532eec351953d128dd9e65f78d9edacb56f4b5>
- **[S080]** AT-SPI2 source pin · primary source · observed 2026-09-01  
  <https://github.com/GNOME/at-spi2-core/tree/1ef5342c846d592046ad8d9b706dca95b9689f9f>
- **[S083]** OWASP LLM01 prompt injection · security guidance · observed 2026-09-01  
  <https://genai.owasp.org/llmrisk/llm01-prompt-injection/>
- **[S084]** MCP specification 2025-06-18 · primary specification · observed 2026-09-01  
  <https://modelcontextprotocol.io/specification/2025-06-18>
- **[S088]** W3C WebCodecs · primary standard · observed 2026-09-01  
  <https://www.w3.org/TR/webcodecs/>
- **[S091]** Chrome WebCodecs best practices · primary implementation guidance · observed 2026-09-01  
  <https://developer.chrome.com/docs/web-platform/best-practices/webcodecs>
- **[S111]** Apple TN2150 Secure Event Input · primary archived guidance · observed 2026-09-01  
  <https://developer.apple.com/library/archive/technotes/tn2150/_index.html>
- **[S112]** Apple Screen Recording permission guide · primary · observed 2026-09-01  
  <https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac>
- **[S113]** Apple FileVault Platform Security · primary · observed 2026-09-01  
  <https://support.apple.com/guide/security/volume-encryption-with-filevault-sec4c6dc1b6e/web>
- **[S114]** Codex rust-v0.152.0 release · primary · observed 2026-09-01  
  <https://github.com/openai/codex/releases/tag/rust-v0.152.0>
- **[S115]** Codex rust-v0.152.0 config source · primary source · observed 2026-09-01  
  <https://raw.githubusercontent.com/openai/codex/rust-v0.152.0/docs/config.md>
- **[S117]** Screen2AX paper · primary research · observed 2026-09-01  
  <https://arxiv.org/html/2507.16704>
- **[S147]** macOSWorld evaluator pin e2ca8334 · primary source · observed 2026-09-01  
  <https://raw.githubusercontent.com/showlab/macosworld/e2ca8334b3765537e5c1c428ce57990248a1bb5f/utils/evaluator.py>
- **[S148]** macOSWorld run_task pin e2ca8334 · primary source · observed 2026-09-01  
  <https://raw.githubusercontent.com/showlab/macosworld/e2ca8334b3765537e5c1c428ce57990248a1bb5f/utils/run_task.py>
- **[S149]** macOSWorld paper · primary research · observed 2026-09-01  
  <https://arxiv.org/abs/2506.04135>
- **[S150]** OSWorld-Human paper · primary research · observed 2026-09-01  
  <https://arxiv.org/abs/2506.16042>
- **[S158]** Chromium accessibility overview · mutable primary docs · observed 2026-09-01  
  <https://chromium.googlesource.com/chromium/src/+/main/docs/accessibility/overview.md>
- **[S159]** Electron accessibility docs · primary docs · observed 2026-09-01  
  <https://www.electronjs.org/docs/latest/tutorial/accessibility>
- **[S160]** OpenJFX accessibility API docs · primary docs · observed 2026-09-01  
  <https://openjfx.io/javadoc/21/javafx.graphics/javafx/scene/AccessibleRole.html>
- **[S161]** Unity accessibility docs · primary docs · observed 2026-09-01  
  <https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-accessibility.html>
- **[S162]** Unreal accessibility docs · primary docs · observed 2026-09-01  
  <https://dev.epicgames.com/documentation/en-us/unreal-engine/accessibility-in-unreal-engine>
- **[S163]** Qt accessibility docs · primary docs · observed 2026-09-01  
  <https://doc.qt.io/qt-6/accessible.html>
- **[S164]** SwiftUI accessibility docs · primary docs · observed 2026-09-01  
  <https://developer.apple.com/documentation/swiftui/accessibility>
- **[S165]** Apple simctl documentation · primary docs · observed 2026-09-01  
  <https://developer.apple.com/documentation/xcode/simctl>
- **[S166]** OpenAI official video "Computer use in Codex" · primary official video; description chapter "Screenshots plus accessibility data" · observed 2026-09-01 (follow-up web check)  
  <https://www.youtube.com/watch?v=D_FCYsshMI4>
- **[S167]** OpenAI "Codex for (almost) everything" · primary official announcement · observed 2026-09-01 (follow-up web check)  
  <https://openai.com/index/codex-for-almost-everything/>
- **[S168]** ChatGPT/Codex Computer Use setup docs · primary official docs; distinguishes Screen Recording and Accessibility permissions · observed 2026-09-01 (follow-up web check)  
  <https://learn.chatgpt.com/docs/computer-use>
- **[S169]** paralym/codex-computer-use-cli · unofficial independent reverse-engineering claim (SkyComputerUseClient, AX indexing, AXPress/AXOpen, CGEvent fallback); low credibility, not used as factual basis · observed 2026-09-01, repository existence re-checked 2026-09-02  
  <https://github.com/paralym/codex-computer-use-cli>

## A.2 Pinned sources without a recorded URL

Only a repository commit SHA, an arXiv number, or a document name was recorded. The target is identifiable but there is no link.

- **[S081]** Peekaboo pin 8d5e638 · implementation evidence cited in DAG node · primary implementation · observed 2026-09-01
- **[S082]** Cua pin 605ce1a · implementation evidence cited in DAG node · primary implementation · observed 2026-09-01
- **[S085]** OpenOmni pin 34945a74 · repository evidence cited in DAG node · primary source · observed 2026-09-01
- **[S086]** Osaurus pin 1bbd959 · adjacent implementation evidence · observed 2026-09-01
- **[S087]** Open Computer Use pin 503a5e5 · adjacent implementation evidence · observed 2026-09-01
- **[S089]** Chromium WebCodecs pin 3f22bdf · primary implementation source · observed 2026-09-01
- **[S090]** WebKit WebCodecs dequeue fix 9676c2c · primary implementation source · observed 2026-09-01
- **[S093]** OBS pin 6c6adac · ScreenCaptureKit implementation evidence · observed 2026-09-01
- **[S094]** cua pin 605ce1a · hybrid semantic/visual implementation evidence · observed 2026-09-01
- **[S095]** Screen2AX paper · benchmark evidence cited by DAG node · observed 2026-09-01
- **[S096]** Chromium accessibility source/design · primary implementation evidence cited by DAG node · observed 2026-09-01
- **[S097]** Electron accessibility docs/issues · primary implementation evidence cited by DAG node · observed 2026-09-01
- **[S098]** Qt and OpenJDK accessibility source/issues · primary implementation evidence cited by DAG node · observed 2026-09-01
- **[S099]** AccessKit and Godot accessibility source · primary implementation evidence cited by DAG node · observed 2026-09-01
- **[S100]** OSWorld paper and repository pin 091f5ef1 · primary benchmark · observed 2026-09-01
- **[S101]** OSWorld-Verified · primary benchmark update · observed 2026-09-01
- **[S102]** OSWorld 2.0 arXiv:2606.29537v2 · primary benchmark · observed 2026-09-01
- **[S103]** OSWorld-Human arXiv:2506.16042v2 · primary benchmark analysis · observed 2026-09-01
- **[S104]** macOSWorld arXiv:2506.04135 · primary benchmark · observed 2026-09-01
- **[S105]** MacArena arXiv:2606.06560 · primary benchmark · observed 2026-09-01
- **[S119]** OpenAI public Computer Use API/model/release guides · primary · observed 2026-09-01
- **[S121]** WebKit source pin 1e92f67e · primary implementation · observed 2026-09-01
- **[S122]** ActivityWatch source pin 05c0d924 · primary implementation · observed 2026-09-01
- **[S123]** Microsoft win32metadata pin 98f1681 · primary source · observed 2026-09-01
- **[S124]** pymobiledevice3 pin ec4ac06a · primary implementation · observed 2026-09-01
- **[S125]** go-ios pin ced7e53d · primary implementation · observed 2026-09-01
- **[S126]** Apple IOSurface/CVPixelBuffer/Metal/XPC documentation · primary · observed 2026-09-01
- **[S128]** Appium Mac2 pinned implementation sources · primary implementation · observed 2026-09-01
- **[S131]** idb/CoreSimulator HID pinned sources · primary implementation · observed 2026-09-01
- **[S132]** W3C WebCodecs and pinned Chromium/WebKit/Mozilla implementations · primary standard/source · observed 2026-09-01
- **[S133]** CDP and Playwright documentation · primary implementation docs · observed 2026-09-01
- **[S134]** RFC 6143 RFB and Microsoft RDP specifications · primary standards · observed 2026-09-01

## A.3 Local Xcode SDK headers

Evidence read directly from the Xcode SDK headers installed on the session's Mac. Reproducible by installing the same Xcode version.

- **[S092]** Xcode 26.6 ScreenCaptureKit and CGWindow headers · local primary SDK evidence · observed 2026-09-01
- **[S106]** Xcode 26.5 AXError.h lines 28-76 · local primary SDK · observed 2026-09-01
- **[S107]** Xcode 26.5 AXUIElement.h lines 25-75, 133-185, 315-402 · local primary SDK · observed 2026-09-01
- **[S108]** Xcode 26.5 CarbonEventsCore.h lines 2971-3064 · local primary SDK · observed 2026-09-01
- **[S109]** Xcode 26.5 NSSecureTextField.h lines 14-19 · local primary SDK · observed 2026-09-01
- **[S110]** Xcode 26.5 AXRoleConstants.h lines 400-410 · local primary SDK · observed 2026-09-01
- **[S118]** Xcode 26.5 SCStream.h · local primary SDK · observed 2026-09-01
- **[S127]** Apple XCUIAutomation/XCTest SDK headers and manuals · primary SDK/docs · observed 2026-09-01
- **[S129]** Apple ScreenCaptureKit/VideoToolbox/CoreMedia SDK headers · primary SDK · observed 2026-09-01
- **[S130]** Apple NSScreen/NSWorkspace/NSCursor/CoreGraphics SDK headers · primary SDK · observed 2026-09-01

## A.4 Local probe and system artifacts (not publicly verifiable)

Sources and logs of the Swift, C, and TypeScript probes the session ran without a remote Mac, plus local system bundles. They live under `probe-artifacts/` in the research session folder. Conclusions that cite them must be reproducible by re-running the probe, and they are treated as single-source exceptions until a public document replaces them.

- **[S116]** Local iPhone Mirroring Info.plist · /System/Applications/iPhone Mirroring.app/Contents/Info.plist · local Apple artifact · observed 2026-09-01
- **[S120]** Installed Codex Computer Use plugin/service artifacts · local signed artifact evidence reported by G02/G03 · observed 2026-09-01
- **[S135]** G15 focus-guard logs · probe-artifacts/g15/g_on.log and g_off.log · local measured artifact · observed 2026-09-01
- **[S136]** G15 input/pasteboard logs · probe-artifacts/g15/ · local artifact, partially audited · observed 2026-09-01
- **[S137]** G20 SCK probe sources · probe-artifacts/g20/*.swift · local source artifact · observed 2026-09-01
- **[S138]** G20 display/window logs · probe-artifacts/g20/run_display.log and run_nsapp.log · local measured artifact · observed 2026-09-01
- **[S139]** G20 denial logs · probe-artifacts/g20/consent_run1.log and launchd_run.log · local measured artifact · observed 2026-09-01
- **[S140]** G20 SCK crash report · probe-artifacts/g20/sck_consent_probe-2026-09-01-141042.ips · local crash artifact · observed 2026-09-01
- **[S141]** G23 regional-capture harness · probe-artifacts/g23/harness.swift · local source artifact · observed 2026-09-01
- **[S142]** G23 regional-capture results · probe-artifacts/g23/run5.log · local measured artifact · observed 2026-09-01
- **[S143]** G26 Simulator AX sources/logs · probe-artifacts/g26/ · local source/measured artifacts · observed 2026-09-01
- **[S144]** G27 serve-sim package metadata · probe-artifacts/g27/meta.json and att.json · local package/provenance artifacts · observed 2026-09-01
- **[S145]** G27 addon/process probes · probe-artifacts/g27/ · local source/runtime artifacts · observed 2026-09-01
- **[S146]** iPhone Mirroring Apple support and local bundle · S028,S116 · primary/local Apple evidence · observed 2026-09-01
- **[S151]** G35 broker and ledger logs · probe-artifacts/g35/broker.log and ledger.jsonl · local measured artifacts · observed 2026-09-01
- **[S152]** G35 UDS peer-token log · probe-artifacts/g35/uds.out · local measured artifact · observed 2026-09-01
- **[S153]** G35 TCC context logs · probe-artifacts/g35/authprobe.shell.txt and authprobe.launchd.txt · local measured artifacts · observed 2026-09-01
- **[S154]** G35 broker/auth/UDS probe sources · probe-artifacts/g35/ · local source artifacts · observed 2026-09-01
- **[S155]** G28 serve-sim probes/logs · probe-artifacts/g28/ · local source/measured artifacts · observed 2026-09-01
- **[S156]** serve-sim pinned device-session source · probe-artifacts/g28/device-session.ts · primary source · observed 2026-09-01
- **[S157]** serve-sim pinned lifecycle/port source · probe-artifacts/g28/index.ts and ports.ts · primary source · observed 2026-09-01

---

# Appendix B. Unresolved leads and convergence audit

"0 leads left without a disposition" in body section 11 means every lead was classified as closed, unresolved, or annexed. It does not mean every question was answered. This appendix exposes the questions that remain open. Per-lead history is in `expansion-log.md` in the research session folder.

## B.1 Lead dispositions

| Disposition | Count | Meaning |
| --- | --- | --- |
| Closed | 82 | Closed by a pinned source or an executed artifact. Includes 7 provisional closures and 1 duplicate |
| Unresolved or partial | 61 | Investigated in wave 2 but evidence was insufficient or measurements could not be verified |
| Unresolved annex | 74 | Opened by wave 3 but not closed because the strict evidence audit failed |
| Refuted | 2 | Evidence supports the opposite conclusion: L011 (browser-only control hypothesis) and L119 (manual reference-frame control proposal) |
| Total | 219 | |

Of the 13 wave-3 nodes, only two (W3-09, W3-10) passed the strict evidence audit. The other 11 produced useful architecture prose but lacked exact pinned anchors, labelled inference as fact, or claimed closure on runtime artifacts that did not exist. None of those closure claims were promoted into the body. W3-10 closed L196 (Simulator cross-framework fidelity boundary) and L197 (automation-setting source contract).

## B.2 Debate verdicts

| Round | Claim | Verdict | Reflected in the body |
| --- | --- | --- | --- |
| D001 | iPhone/Simulator success reveals closed iOS accessibility internals | Unresolved; inference rejected | Section 3: replaced by the host-window explanation |
| D002 | Codex is accessibility-first | Partial | Sections 1 and 9: described only as a "screenshots + accessibility data" hybrid; priority claims prohibited |
| D003 | iPhone success implies access to closed iOS internals | Refuted | Section 3: inference prohibited |

## B.3 Leads moved to the unresolved annex

These leads are acceptance inputs for the implementation phases. Each must be closed with executed artifacts at the PoC, hardening, or quality-parity gate rather than by further desk research.

### Codex policy and account matrix

| Lead | Content |
| --- | --- |
| L147 | exact untrusted-policy migration source |
| L148 | Codex account/plan/region matrix |

### iPhone Mirroring runtime and design evidence

| Lead | Content |
| --- | --- |
| L149 | iPhone Mirroring runtime AX matrix |
| L150 | controlled ScreenContinuity reproduction and lifecycle |
| L188 | artifact-backed Mirroring AX factorial |
| L189 | macOS 27 GM Mirroring matrix |
| L190 | iOS SCK consent lifecycle |
| L191 | Mirroring supervision |
| L192 | authoritative Mirroring design statement |

### Observation-channel safety, Screen2AX, DOM mapping

| Lead | Content |
| --- | --- |
| L151 | independent Screen2AX reproduction |
| L152 | observation-channel action-safety thresholds |
| L153 | WebKit DOM-to-screenshot mapping |

### ScreenCaptureKit capture, geometry, recovery

| Lead | Content |
| --- | --- |
| L154 | signed SCK conformance fixture |
| L155 | cross-version/filter dirty-rect matrix |
| L156 | injected-loss SCK recovery |
| L157 | queue-depth runtime defaults |
| L180 | mixed-scale AX text geometry |
| L186 | SCK sleep/disconnect/virtual display |
| L193 | NSWindow sharing matrix |
| L194 | SCScreenshotManager parity |
| L195 | encoded redaction integrity |

### Authority, TCC, containment, identity

| Lead | Content |
| --- | --- |
| L160 | authorization-plugin adversarial tests |
| L161 | TCC version/state matrix |
| L162 | post-TCC prompt-injection containment |
| L163 | disposable-user permission factorial |
| L177 | Apple screen-sharing isolation |
| L179 | hypervisor display isolation |
| L185 | disposable-host TCC identity/reset |
| L209 | signed audit checkpoints and external witness |
| L210 | native peer-token/SecCode machines shim |
| L211 | platform/LWCR identity matrix |
| L212 | supported fail-closed macOS containment |
| L213 | launchd broker TCC update survival |
| L214 | prompt-injection/pixel-DLP/observer-stall harness |

### Input, IME, secure fields, focus

| Lead | Content |
| --- | --- |
| L144 | secure-field AX value redaction |
| L145 | protected-prompt Screen Recording redaction |
| L146 | supported loginwindow/FileVault/Keychain automation |
| L181 | Japanese/Chinese IME corpus |
| L182 | cross-framework secure controls |
| L183 | modal/auth focus-steal corpus |
| L184 | pasteboard always-deny |

### Proof, protocol, recovery contracts

| Lead | Content |
| --- | --- |
| L158 | pinned live safety-order test |
| L159 | action-bound proof-frame specification |
| L171 | canonical proof encoding and transcript authentication |
| L172 | action-specific crash reconciliation |
| L173 | boot-epoch HID proof ACK |

### iOS Simulator, WDA, idb tool boundaries

| Lead | Content |
| --- | --- |
| L164 | signed live-AX matrix |
| L165 | WDA issue 507 root cause |
| L166 | Apple offline-provisioning evidence |
| L167 | non-XCTest DVT boundaries |
| L168 | tvOS PIN pairing |
| L169 | device-farm usbmux multiplexing |
| L198 | native-helper orphan rate |
| L199 | executed AX/WDA/idb comparison |
| L200 | XCTest delta channel |
| L201 | multi-device contention |
| L202 | serve-sim teardown/signing |
| L203 | Xcode 27/XCTest drift execution |
| L215 | upstream helper ownership defects |
| L216 | first-frame/foreground readiness contract |
| L217 | freshness-rate/AX liveness model |
| L218 | 24-hour serve-sim soak |
| L219 | ownership-safe port reclamation |

### Projection, codecs, transport

| Lead | Content |
| --- | --- |
| L170 | browser/native WebRTC stress matrix |
| L174 | three-browser codec priming |
| L175 | Chromium timestamp history |
| L176 | native AX/SCK projection benchmark |
| L178 | WebDriver BiDi comparison |

### Benchmarks, evaluators, trajectories

| Lead | Content |
| --- | --- |
| L187 | human picker trace |
| L204 | immutable VM/guest manifests |
| L205 | exact evaluator parsing and fail-closed fixes |
| L206 | macOS human trajectories |
| L207 | benchmark classification delta |
| L208 | isolated safety-task rerun |

## B.4 Leads left unresolved or partial after wave 2

Wave 2 investigated these but could not close them. Most need executed measurements; unverified measurements were excluded from the body.

| Lead | Disposition | Content |
| --- | --- | --- |
| L001 | unresolved | benchmark SCK/CGDisplayStream/WebRTC at 30/60/120 Hz |
| L003 | unresolved | prototype IOSurface/CVPixelBuffer zero-copy transport |
| L004 | unresolved | stress DataChannel control lifecycle and network loss |
| L005 | unresolved | validate AX overlay transforms on mixed display/Spaces states |
| L006 | unresolved | verify keyframe/full-refresh recovery for damage transport |
| L012 | unresolved | cross-framework AX behavior corpus |
| L013 | unresolved | secure and protected surface observation/action tests |
| L014 | unresolved | align AX notifications and frame timestamps |
| L015 | unresolved | compare CDP projection and Playwright locators |
| L017 | unresolved | adversarial RDP/VNC clipboard and display isolation |
| L020 | unresolved | cross-framework AX capability matrix |
| L021 | unresolved | Spaces/full-screen completeness |
| L022 | unresolved | AX event ordering/loss/queue experiment |
| L033 | unresolved | 2x2 Screen Recording × Accessibility experiment |
| L034 | unresolved | Accessibility Inspector dump for iPhone Mirroring |
| L035 | unresolved | authoritative maintainer/design note search |
| L037 | partial/unresolved | postcondition-verify every HID action and reproduce issue 136 |
| L045 | unresolved | guest/host coordinate calibration matrix |
| L046 | partial | Xcode-version XCTest/CoreSimulator SPI drift |
| L048 | partial | WDA/idb projection fidelity and latency corpus |
| L059 | unresolved | remote-control enrollment/revocation/authorization |
| L063 | unresolved | SCK→VideoToolbox→WebRTC benchmark |
| L065 | unresolved | Simulator capture/encode benchmark |
| L067 | unresolved | simctl recording timing |
| L068 | unresolved | screenshot/AX/HID coordinate transforms |
| L069 | partial/unresolved | keyboard/IME/pointer/multitouch corpus |
| L070 | unresolved | cross-framework AX latency/staleness benchmark |
| L073 | unresolved | AX observer delivery/teardown fault suite |
| L075 | unresolved | parameterized text mixed-scale tests |
| L076 | unresolved | rotated/mixed-scale geometry normalization |
| L077 | unresolved | Stage Manager/Spaces/mirrored-display behavior |
| L081 | unresolved | ScreenCaptureKit TCC revocation recovery |
| L083 | unresolved | XCUI coverage and recovery corpus |
| L086 | unresolved | final macOS 27 iPhone Mirroring behavior |
| L087 | unresolved | fixed-release Codex security/audit matrix |
| L088 | unresolved | cross-editor AX text and secure-field harness |
| L089 | unresolved | bounded AX performance benchmark |
| L090 | unresolved | multi-day AX observer/cache soak |
| L098 | unresolved | Simulator HID/XCTest coordinates and completion |
| L099 | partial/unresolved | DTUHID capability thresholds |
| L100 | unresolved | deterministic SCK damage/geometry tests |
| L102 | unresolved | mixed-DPI round-trip tests |
| L104 | partial | Unicode/IME/secure/pasteboard corpus |
| L110 | unresolved | screenshot/raw-AX/bounded-AX/XCTest benchmark |
| L113 | unresolved | containment and adversarial safety tests |
| L114 | unresolved | authoritative Codex/SkyComputerUseService evidence |
| L116 | unresolved | Chromium timestamp regression timeline |
| L118 | unresolved | WebCodecs/VideoToolbox priming and buffering |
| L121 | unresolved | SCK dirty-rect cross-version/filter matrix |
| L122 | unresolved | SCK headless/sleep/virtual-display behavior |
| L125 | unresolved | AX secure-field and Secure Input behavior |
| L128 | partial | SCK scoped-consent prototype |
| L129 | unresolved | current Chromium AXEnhancedUserInterface |
| L130 | unresolved | Chrome/Electron cold-AX benchmark |
| L131 | unresolved | current JavaFX AX behavior |
| L132 | unresolved | Unity/Unreal AX behavior |
| L133 | unresolved | Qt QML versus Widgets corpus |
| L135 | unresolved | rerun VideoToolbox real-time lane |
| L137 | partial | resolve macOSWorld shipped architecture |
| L138 | unresolved | test OSWorld evaluator spoofing allegation |
| L140 | partial | minimal-human macOS trajectories |
