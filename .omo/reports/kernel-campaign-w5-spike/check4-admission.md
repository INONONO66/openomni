# Check 4 — cluster mailbox + pure decideSessionAdmission keeps the W1 admission contract

Date: 2026-09-28. Worktree `/Users/ino/Develop/openomni-w51` (branch `kernel/1196-cluster-spike-20260928`).
Spike files written: `spike/w5-cluster/src/admission-bridge.ts`, `spike/w5-cluster/test/check4-admission.test.ts`,
plus a resolution shim required to import agent sources from the spike:
`spike/w5-cluster/bunfig.toml` + `spike/w5-cluster/test/preload-module-map.ts` (see Finding F6).

Imports: `decideSessionAdmission` is NOT exported from the `@openomni/agent` index, so the spike
deep-imports `../../../packages/agent/src/session-admission` (and `session-request`, `session-record`)
relatively, as sanctioned for the spike.

## Commands run

```
cd /Users/ino/Develop/openomni-w51/spike/w5-cluster
/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check4-admission.test.ts --timeout 60000   # run 1: exit 0
/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check4-admission.test.ts --timeout 60000   # run 2: exit 0
/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check4-admission.test.ts --timeout 60000   # run 3: exit 0 (saved)
/opt/homebrew/bin/mise exec bun@1.4.1 -- bun test test/check1-boot.test.ts --timeout 60000        # regression: exit 0
```

Stdout excerpt (identical across runs; full logs: `check4-verify-run2.log`, `check4-verify-run3.log`):

```
 27 pass
 0 fail
 98 expect() calls
Ran 27 tests across 1 file. [472.00ms]
```

check1 regression (`check4-check1-regression.log`): `4 pass / 0 fail` — the bunfig shim does not change check 1.

## Table A — admission sequences: mailbox plane vs inbox-table plane

Every row asserts BOTH (a) the expected W1 decision and (b) parity: `decideFromMailbox(row, items, open?, terminal?)`
normalizes (kind + selected item/turn ids) equal to `decideSessionAdmission({row, pending: inboxRows(items), open?, terminal?})`
where `inboxRows` is built independently of the bridge. Kinds are the real Inbox kinds
(`prompt | interrupt | resume`; `interrupt` is the control/"signal" kind — there is no separate "signal").

| # | state | mailbox (FIFO) | open | terminal | decision | selected | parity |
|---|-------|----------------|------|----------|----------|----------|--------|
| A01 | idle | [] | – | – | stop | – | PASS |
| A02 | idle | [prompt] | – | – | start | – | PASS |
| A03 | idle | [interrupt, prompt] | – | – | consume | [interrupt] | PASS |
| A04 | idle | [prompt, prompt] | – | – | start (2nd stays queued) | – | PASS |
| A05 | idle | [resume] | – | – | consume | [resume] | PASS |
| A06 | idle | [resume, resume, prompt] | – | – | consume | control prefix [r1, r2] | PASS |
| A07 | running | [prompt] | own T | – | recover | turn T | PASS |
| A08 | running | [prompt] | – | – | refused | – | PASS |
| A09 | interrupted | [resume] | – | interrupted | resume | [resume] | PASS |
| A10 | interrupted | [resume] | – | result | consume | [resume] | PASS |
| A11 | interrupted | [prompt] | – | interrupted | stop | – | PASS |
| A12 | idle | [prompt@foreign-session] | – | – | refused | – | PASS |
| A13 | running | [] | foreign | – | refused | – | PASS |
| A14 | interrupted | [resume] | – | foreign | refused | – | PASS |
| A15 | idle | [prompt] | own T | – | refused | – | PASS |
| A16 | idle | 5 prefixes x 5 suffixes | – | – | FIFO invariance: suffix after first prompt never changes the decision (25 combos) | – | PASS |
| A17 | interrupted | [prompt, resume] | – | interrupted | resume (whole-mailbox scan; see F4) | [resume] | PASS |

## Table B — request commands as FIFO mailbox items (decideRequestTransition per item)

Each row folds `decideRequestTransition` per item in mailbox FIFO order (threading `decision.request`),
and independently folds the same items as inbox rows sorted by table ordinal (presented shuffled first);
both resolution sequences must match. Fixtures mirror `packages/agent/test/session-request.test.ts`
(approval request, deadline 100, owner principal, kernel lease fence 1).

| # | mailbox order | resolutions (mailbox) | resolutions (inbox order) | final state | verdict |
|---|---------------|-----------------------|---------------------------|-------------|---------|
| B1 | [resolve] | [resolved] | same | resolved | PASS |
| B2 | [resolve, cancel] | [resolved, duplicate] | same | resolved | PASS |
| B3 | [cancel, resolve] | [cancelled, duplicate] | same | cancelled | PASS |
| B4 | [cancel, timeout@150] | [cancelled, duplicate] | same | cancelled | PASS |
| B5 | [timeout@150, resolve@150] | [expired, late_unknown] | same | expired | PASS |
| B6 | [resolve, resolve'] | [resolved, duplicate] | same | resolved | PASS |
| B7 | [open, resolve] | [opened, resolved] | same | resolved | PASS |
| B8 | cancel-first, then resolve: resolution is never resolved/attached, `receive` is undefined, request stays cancelled | – | – | cancelled | PASS |

Note on B3/B8 vs the task wording: a cancel arriving first DOES make the later resolve refused-in-effect —
it is never applied, produces no inbox intake, and the request stays `cancelled` — but the resolution
token the contract emits is `"duplicate"` (terminal close already won), not the literal `"rejected"`.
`"rejected"` is reserved for authority/binding failures. Identical on both planes, so parity holds.

## Integration — single-writer FIFO proof (C1/C2)

Surface: real cluster runtime (`makeRuntime`: SingleRunner sql runner+message storage on a catalog sqlite,
BunCrypto, per-session sqlite ledger files under a mkdtemp dir). An instrumented copy of the Session
entity handler (`Check4Session`) records start/end `performance.now()` spans around
`ensureSessionRow` + `appendTurnAction` + 40 ms measured workload. Three prompts sent concurrently
(`Effect.all(..., { concurrency: 3 })`) to ONE entityId.

Observed spans, ordered by start (run 2; ms):

```
[{"ordinal":1,"start":248.140,"end":290.901},
 {"ordinal":2,"start":291.896,"end":333.327},
 {"ordinal":3,"start":333.721,"end":375.182}]
```

- ordinals in handler-start order are exactly 1, 2, 3 — PASS
- no overlap: each `start(n)` >= `end(n-1)` (291.896 >= 290.901; 333.721 >= 333.327) — PASS
- OUR hash chain in the per-session file is linear: ordinals [1,2,3], `prev_hash(n) == action_hash(n-1)` — PASS
- C2: the UNMODIFIED Session entity also returns ordinals {1,2,3} for 3 concurrent prompts — PASS

## PASS/FAIL summary

| sub-check | result |
|-----------|--------|
| Table A (15 sequence rows + FIFO invariance + whole-mailbox resume scan), mailbox == inbox parity | PASS (17/17) |
| Table B (7 order rows + cancel-first effect check), mailbox order == inbox order | PASS (8/8) |
| C1 single-writer FIFO on real cluster runtime (ordinals + non-overlapping spans + chain linkage) | PASS |
| C2 unmodified Session entity serializes concurrent prompts | PASS |
| VERIFY exits 0 twice in a row (three times total) | PASS |
| check1 regression under the new bunfig shim | PASS |

## Findings for W5.2

- F1 — Inbox columns with no cluster equivalent: `status`, `consumed_by`, `consumed_at`, and the table
  `ordinal`. The mailbox IS the order (FIFO position replaces `ordinal`), a message is delivered to
  exactly one writer and acknowledged once (replaces `status`/`consumed_by`/`consumed_at`). `kind`,
  `content`, and `origin` have no envelope equivalent either — they must ride INSIDE the Rpc payload
  (the bridge synthesizes `origin {kind:"cluster_message", envelopeId}`; W5.2 must carry the real
  origin payload in the message).
- F2 — How `consume` maps to cluster messages: `consume` = append the noop `inbox.deliver` actions to
  OUR chain (durable evidence that the items were drained without a turn), then acknowledge the
  envelopes (SqlMessageStorage marks `cluster_messages.processed = 1` when the entity replies).
  Ack order matters: chain append first, ack second — an ack before the append could lose the
  delivery evidence on crash. `start`/`resume` similarly ack only after the turn-intent commit.
- F3 — resume/interrupted as entity messages: model `resume` as its own Rpc (or a `kind` field on one
  Enqueue Rpc) so the handler can apply the admission table per drained batch. The `interrupted`
  session state and latest turn terminal stay derived from OUR chain (S/T views), never from cluster
  state; the mailbox only supplies the pending items.
- F4 — The interrupted-state decision is NOT head-of-queue-only: `decideSessionAdmission` finds a
  `resume` anywhere in the pending list (A17). A cluster entity that processes strictly one envelope
  at a time would diverge here; the W5.2 handler must drain/peek the whole backlog for the entity
  (MessageStorage exposes unprocessed messages per entity) before deciding, exactly like
  `pendingInbox(sessionId)` does today. Idle-state decisions ARE prefix-invariant past the first
  prompt (A16), so batching is safe there.
- F5 — Requests: mailbox FIFO + per-entity single writer removes the need for the inbox
  `status`/`consumed_by` columns for request commands. Ordering is the mailbox; single delivery is the
  ack. Idempotency/replay does NOT come from those columns today anyway — it comes from the durable
  input records in OUR action chain (`<requestId>:input:<inputId>` via `repeatedInput`), which stays.
  So request commands can become plain entity messages with zero inbox-table involvement; only the
  action-chain input/resolution records are required.
- F6 — Tooling: agent sources cannot be deep-imported from outside `packages/agent` in this worktree —
  Bun resolves `@openomni/*` via the importer's nearest tsconfig `paths`; agent's tsconfig has none and
  `packages/protocol/dist` is unbuilt, so `Cannot find module '@openomni/protocol'` fires from
  `session-admission.ts`. The spike works around it with `bunfig.toml` preloading a Bun virtual-module
  shim mapping `@openomni/{protocol,ledger,llm,policy,agent}` to their `src/index.ts` (same files the
  ledger tsconfig paths resolve to, so one module instance per package). W5.2 should export the pure
  decision modules (`decideSessionAdmission`, `decideRequestTransition`) from the agent package index
  or move them to a leaf package.
- F7 — Contract-token nuance worth pinning in W5.2 docs: cancel-before-resolve yields `"duplicate"`
  (terminal already decided), not `"rejected"`; late resolve after timeout yields `"late_unknown"`.
  Any cluster-side reply mapping must not collapse these tokens.
