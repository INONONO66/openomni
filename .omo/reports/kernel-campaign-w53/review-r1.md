# PR #1240 adversarial review, round 1

**Verdict: NO-GO**

**Counts: 0 blockers, 5 majors, 2 minors.**

Reviewed on 2026-09-29 in `/Users/ino/Develop/openomni-w53`.
The reviewed range is `8390912c5b08f97611295a9a2586135a52830adf...c3ae365385526d64f55bef5dd33ff63dd50f6d65`.
HEAD remained at that latter commit during verification. Uncommitted `script/`
changes and `docs/ci.md` are excluded. Root/package AGENTS instructions, the
plan, and A1/A2/A2b/A3/A4/A4b/A6/W4 receipts were read. The final A4 receipt
supersedes the incomplete A4b handoff; neither was substituted for verification.

## Findings

1. **Major - A session-level terminal page can discard another turn's answer.**
   `apps/desktop/src/renderer/chat/gateway-transport.ts:129-135`.

   `settleRead` closes every pending turn sharing a socket and durable session
   when a page says completed/failed/interrupted. It does not establish that
   the terminal belongs to that pending turn. It also runs independently of
   the cache's delayed-page rejection in `state/queries.ts:27-31`. Once removed
   from `pending`, the turn cannot receive the subsequent message frame:
   `settleChat` returns without emitting that message.

   **Observed:** A real Bun WebSocket server and the production
   `createGatewayChatTransport` delivered a normal first answer. After
   establishing a read subscription, the server delivered an accepted receipt,
   a page describing the previous completion, and the second answer message.
   The first stream contained `text-delta: "answer 1"`; the second stream
   contained only `[{"type":"finish"}]`. Both reproduction variants exited 0.
   The second answer was sent by the server but not emitted to the reader.
   An old completion is not evidence that a newly submitted turn finished;
   even a current terminal page can precede its separately delivered text.

   **Minimal fix:** Keep session-page updates separate from chat-stream
   completion. Do not close a pending chat from a session-level phase alone.
   If terminal pages must complete chats without a message, first provide
   actual per-submission/turn correlation and a completion protocol that cannot
   discard later text. Add a regression with an established subscription and
   two successive turns, including a terminal page before the answer frame.

2. **Major - An unchanged-head refresh erases authoritative last activity.**
   `apps/desktop/src/renderer/state/queries.ts:27-31,57-63`.

   An empty continuation at the cached head replaces the populated cached
   page. `sessionReadModel` then falls back to the local record's timestamp,
   not the previously observed authoritative timestamp. This makes a session
   appear older after an ordinary refetch, despite no change to its history.
   `attention/order.ts:64` uses that timestamp for attention ordering, and
   `shell/session-secondary.tsx:32-46` uses it for the displayed activity time.

   **Observed:** With a real WebSocket transport, `QueryClient`,
   `subscribeSessionReads`, and two `fetchQuery(sessionReadOptions(...))`
   calls, the first snapshot contained revision 1 at time 900. The second
   response was a valid empty continuation after revision 1, still at head 1.
   Output was:

   ```json
   {"before":900,"after":10,"firstRevision":1,"secondRevision":1,"secondActions":[]}
   ```

   **Minimal fix:** Preserve the existing page on an empty, same-epoch,
   same-head continuation, or retain authoritative activity metadata separately
   from the bounded action slice. Do not restore an unbounded history cache.
   Test a no-new-actions refresh, not only a lower-revision delayed page.

3. **Major - A permitted inspection limit of 1 cannot advance to children.**
   `packages/agent/src/session-lifecycle/inspect.ts:86-106`.

   `nodes` starts at `limit`, and visiting the root always decrements it.
   With limit 1, no child can be visited even when the root action cursor is
   already at its head. The response advertises `nextChildrenCursor: ""`;
   following that continuation repeats the identical empty child page forever.
   The caller cannot discover the child's ID in order to page it separately.

   **Observed:** Using real in-memory catalog/session stores, a materialized
   root and catalog-indexed child, and the public `inspectSession` function,
   both the initial and resumed call with
   `{depth:1,cursor:3,limit:1,childrenCursor:""}` returned:

   ```json
   {"headRevision":3,"transitions":[],"nextCursor":null,"nextChildrenCursor":"","children":[]}
   ```

   **Minimal fix:** Make the descendant visit budget independent of the
   mandatory root response, allowing at least one child to advance on an
   otherwise empty page. Keep the action budget bounded and make each
   advertised continuation either advance or terminate. Cover limits 1 and 2
   with empty root history and more than one child.

4. **Major - Action pagination loses causal turn attribution.**
   `packages/agent/src/session-lifecycle/inspect.ts:37-46,91,108`.

   The bounded read now passes only the current slice to `inspectActions`,
   but that fold reconstructs turn ancestry using a new empty `turns` map.
   A tool, attempt, or policy action whose turn/parent lies on a preceding
   page therefore loses its `turnId`. This is a regression from folding the
   complete history and makes inspection depend on the chosen page boundary.

   **Observed:** A real ledger contained a configuration at revision 1,
   `turn-1` at revision 2, and its tool intent `tool-1` at revision 3.
   A complete inspection returned `tool-1.turnId === "turn-1"`.
   Inspecting `{depth:0,cursor:2,limit:1}` returned the same action, parent,
   revision, and digest, but `turnId === null`.

   **Minimal fix:** Preserve the ancestry needed by the fold across
   continuations, or resolve it through a bounded/indexed ledger read before
   projecting the page. Do not restore the removed loop-to-head scan.
   Assert equality of causal attribution when the page boundary falls between
   a turn and its tool/attempt/policy descendants.

5. **Major - Two zero-census substitutions introduce inferred `any`.**
   `script/lint-tools.ts:794` and `script/check-dead-exports.ts:396`.

   Removing the explicit `unknown` annotation from a `Promise.catch`
   callback does not give it the safety of a language `catch` binding.
   `Promise.catch` contextually types its rejection parameter as `any`.
   Thus these edits make the keyword-only census green while weakening the
   previous compiler protection. The current `instanceof`/`String` handling
   is safe at runtime; the defect is the specifically forbidden loss of type
   safety in the zeroing change.

   **Observed:** A TypeScript compiler program over the actual two files
   reported the callback parameter as `any` at both cited lines. An in-memory
   compiler probe using these callback signatures rejected
   `error.reviewNonexistentMethod()` with the former annotation
   (`TS18046: 'error' is of type 'unknown'`) and accepted it with the new
   inferred signature. No source mutation was used for that probe.

   **Minimal fix:** Use top-level `try { await main(); } catch (error) { ... }`,
   as this PR already does in `script/check-deps.ts`, preserving an implicitly
   unknown catch binding without writing either forbidden keyword. Keep the
   existing narrowing and error reporting.

6. **Minor - A previous turn's terminal timestamp becomes the current phase time.**
   `apps/openomni/src/gateway.ts:199-207`.

   The phase comes from the current row when it is non-idle, but `phaseSince`
   unconditionally prefers the latest terminal action. On a subsequent turn,
   that terminal belongs to the previous turn. If there is no terminal, the
   fallback to the latest action also moves the timestamp on unrelated commits
   within the same phase. This does not represent when the current phase began.
   The desktop consumes it directly at `state/queries.ts:62`, including
   approval/input wait ages in `attention/reason.ts:32-36`.

   **Observed:** The real in-memory ledger reproduction sealed `turn-1` at
   time 30, then committed `turn-2` and state `running` at time 900.
   `readSessionCursor` returned `phase:"running", phaseSince:30`, with the
   new turn at time 900 present in its actions.

   **Minimal fix:** Derive the timestamp from the durable transition that
   establishes the emitted phase, rather than an unrelated terminal or latest
   activity. Cover a second turn and repeated actions within one waiting phase.

7. **Minor - The no-op identity regression test no longer asserts a delivery exists.**
   `packages/agent/test/session-handle.test.ts:2103-2105`.

   The old expectation `toEqual(["noop"])` established exactly one delivery.
   Its replacement compares two projections of the same output array and
   passes when both are empty. The other assertions also permit an
   implementation that does nothing on `resume()` and never admits the inbox
   item: no runs, unchanged interrupted state, and no pending inbox.

   **Observed:** Evaluating the changed assertion for an empty delivery list
   gives equality; the old expectation fails for that same list. There is no
   independent delivery cardinality or admitted-input assertion in this test.

   **Minimal fix:** Retain an exact one-delivery assertion and verify its
   `turnId` and `inboxId` against the admitted resume identity, rather than only
   comparing two values derived from the output.

## OWNER-STOP

## Verified clean

- **Effect boundary:** `check-effect-boundaries.ts` exited 0. The runner
  allowlist is `[]`; the newly named owners at
  `script/check-effect-boundaries.ts:14-24` are seven test helpers and two
  existing bench entry points, not production source. Production runner-name
  search found only the existing approved `cli/main.ts` and `gateway.ts`
  edges. Production source did not import the test/bench owners.
- **Wire/deletions:** No existing consumed wire field was found renamed,
  removed, or retyped. The read DTOs are additive. The common-schema snapshot
  additions for session generation/history/turns correspond to source already
  present on the base, not changes to those schemas in this diff. Deleted
  public protocol names and deleted-module imports were searched throughout
  the worktree; the only removed qualified-name hit was the prose test title
  `"Machine.ExportName grammar"`. Retained internal `isPlainValue` and
  `RouteStreamScope` uses are not consumers of the deleted public aliases.
  Protocol, channels, and desktop consumer type checks passed.
- **Read privacy/admission:** `gateway.ts:212-219` projects action identities,
  kinds, revisions, and times, not raw intent/effect payloads. Usage and tool
  wall time are projections. `apps/openomni/src/index.ts:676-677` checks the
  catalog before opening a kernel, so the missing-session read path does not
  materialize a session. Existing real-socket tests passed for missing-session
  refusal, epoch/future-cursor gaps, repair, and live high-water continuation.
- **Runtime nits/perimeter:** The no-op identity change reaches production
  delivery writers in admission, turn execution, and the entity handler.
  `session-record.ts:223` chooses the inbox ID for an unbound delivery.
  `cluster-runtime.ts:61-64` clamps the actual SingleRunner option to 5,000 ms.
  No `ConfigProvider.fromEnv` was found in agent production source.
  All seven named ledger factories exist and are called by
  `packages/channels/src/router/stores.ts:35-41`; this diff adds explanatory
  comments, not additional entries, to that already-existing perimeter list.
- **Accounting/tests:** The accounting fork leaves usable provider zero
  authoritative, marks missing-count substitution estimated, and keeps
  estimated provenance across steps. The committed-attempt and parallel-tool
  metrics tests passed. No newly added timing sleeps, skipped tests,
  `expect.any`, `biome-ignore`, or `@ts-expect-error` were found in the diff.
  Deletions of the dead protocol APIs, `Retry.sleep`, inert `maxSteps`
  forwarding, and retired local phase setters explain their removed tests;
  finding 7 identifies the separate weakened assertion on live behavior.

## Verification evidence and limits

All executable checks used Bun 1.4.1 through `mise exec bun@1.4.1 --`.

| Check | Observed result |
| --- | --- |
| `bun run script/check-effect-boundaries.ts` | Exit 0. |
| `bun run script/check-written-types.ts` | Exit 0; zero written keywords. Finding 5 explains the semantic hole. |
| `bun run script/check-deps.ts` | Exit 0; no violations, two stale-doc notices. |
| `bun test apps/openomni/test/session-cursor.test.ts apps/desktop/test/session-read-model.test.ts packages/agent/test/attempt-metrics.test.ts packages/agent/test/session-inspection.test.ts script/check-effect-boundaries.test.ts script/check-written-types.test.ts` | Exit 0; 117 pass, 0 fail. |
| `bun test --config=/dev/null packages/protocol/test/json-boundary.test.ts packages/protocol/test/error.test.ts packages/protocol/test/policy/input-schema-parity.test.ts packages/ipc/test/framing.test.ts packages/ipc/test/failure-classes.test.ts packages/channels/test/websocket.test.ts` | Exit 0; 75 pass, 0 fail; coverage disabled. |
| `bunx tsc --noEmit -p packages/protocol/tsconfig.json` | Exit 0. |
| `bunx tsc --noEmit -p packages/channels/tsconfig.json` | Exit 0. |
| `bunx tsc --noEmit -p apps/desktop/tsconfig.web.json --incremental false --composite false` | Exit 0. |
| LSP errors for gateway, desktop transport/queries, agent inspect/metrics | No diagnostics in all five files. |
| Real-socket terminal and unchanged-head cache probes | Reproduced findings 1 and 2; process exits 0 with the incorrect outputs quoted above. |
| Real in-memory ledger inspection/cursor probe | Reproduced findings 3, 4, and 6; process exit 0 with the incorrect outputs quoted above. |
| TypeScript checker/virtual-source probe | Confirmed inferred `any` and the loss of the former TS18046 refusal. |
| `git diff --check origin/main...c3ae3653` | Exit 2: Markdown trailing spaces at A2b receipt lines 3-6, A6 lines 3-4, and W4 receipt lines 3-4. No source whitespace failure was reported. |

The first focused test command unintentionally inherited root
`bunfig.toml:2-4`, which enables LCOV output, and therefore wrote generated root
coverage output. This exceeded the requested report-only write restriction;
it is disclosed rather than represented as a read-only run. No tracked source
or existing lane change was edited or reverted. Subsequent tests explicitly
used an empty configuration. Do not treat the review's root coverage output as
the concurrently running lane's coverage receipt.

Two setup attempts failed before running their intended checks: a shell-quoted
inline reproduction initially had an escape error, and
`bun --config /dev/null test ...` was not accepted in that argument position.
The corrected reproduction and `bun test --config=/dev/null ...` completed.
No whole suite, build, formatter, mutation campaign, native Electron session,
or external provider run was performed.

### Counter-cases and recommendation

The strongest terminal-race counter-case was an already-established read
subscription rather than an unsolicited page. It still lost the second answer.
The cache regression used equal epoch and equal head, so the existing
lower-epoch/lower-revision rejection cannot prevent it.

A potential subscription leak was reproduced only while deliberately holding
ManagedRuntime initialization open and closing the connection before decoding.
It did not reproduce with the runtime warmed as production boot does:
the sent-frame count stayed at 1 after a subsequent commit. Production boot
initializes services before exposing the server at
`apps/openomni/src/index.ts:630-683`. That cold-only case is not a finding.

Fix findings 1-7 before approval. Retain the bounded read architecture and the
unchanged existing wire contracts; do not resolve these failures by restoring
unbounded history scans or weakening the gates. Add regressions at the existing
read-model/inspection tests for the reproduced boundaries, then run the parent
integration gates after the excluded lane settles. These are proposed fixes,
not fixes implemented or verified by this read-only review.

**NO-GO - 0 blockers, 5 majors, 2 minors.**
