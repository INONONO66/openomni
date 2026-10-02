# Implementation Status

## #1245 injected configuration, clock and entropy (epic #1260 P3 after #1244, ⏳ pending merge)

On `epic1260/1245-inject-clock-entropy` (2026-10-01, base `a4478b0e`). Ambient
time, entropy and environment reads are replaced by injection; seven
permissive defaults become explicit typed outcomes.

- **Three environment owners.** `process.env` is read only by
  `apps/openomni/src/config.ts` (vault key resolved once into
  `OpenOmniConfig.kek` via `resolveKek(env, home)` and injected into declared
  provisioning), `apps/openomni/src/cli/env-file.ts` (`processEnvironment()`
  for cli/main and watch-sources spawn env), and
  `packages/llm/src/model/loader.ts` (`resolveAuthFilePath(env)`, called
  once when `LlmLive` is constructed; the Layer closes over the path and
  `Auth.all/get/set/resolve` and raw `run`/`Provider.resolveModel` take
  `authFilePath` explicitly, so `auth/storage.ts` has no env read and no
  resolver call). The desktop reads env only
  through `bootstrap(process)` → `resolveDesktopConfig(env)` in the new
  `apps/desktop/src/main/config.ts` (`gateway-endpoint.ts` deleted); the
  config is pinned once at module load.
- **Effect Clock and agent Entropy.** The custom agent Clock service is
  deleted from `packages/agent/src/services.ts`; Effect code uses the
  built-in `Clock` (`Clock.currentTimeMillis`, TestClock-replaceable).
  `packages/agent/src/core/entropy.ts` owns the temporary `Entropy` service
  (`EntropySource { id(): string; random(): number }`, `Entropy.layer`);
  the executor derives plain `clock`/`entropy`/`random` functions from both
  services and threads them through execution. #1247 places Entropy finally.
- **Promise-side injection.** channels, llm, ledger, ipc, codemode and the
  desktop renderer take required plain function options — `now: () =>
  number`, `id: () => string`, `random: () => number` — with inline types and
  no fallback defaults (`?? Date.now` deleted everywhere). Representative
  owners: `ChannelProvider.create(credentials, config, publish, { now, id,
  random })`, `GatewayRouterPorts.now/id`, llm `RunInput.now/id` and
  `Retry.decide(..., { now, random })`, `openCatalogStore`/`openSessionStore`
  `{ now }`, ipc `PeerRequestTable` required `idSource`, `createCodemode({
  id })`, renderer `createPlatform({ clock, ids })` bound once in `main.tsx`
  (`RendererPlatform { now(): number; id(): string }`; minting before
  `bindStorePlatform` throws `RendererInvariantError`). Composition roots
  supply sources: `apps/openomni/src/composition/platform.ts`
  `platformEntropy()` holds the tree's only `node:crypto` randomUUID import,
  and protocol `traceIdFromUuid` alone formats trace IDs.
- **Seven defaults replaced.** (1) Unknown-provenance external mail runs
  with `evidence_only` authority plus a typed `InboundAuthorityViolation`
  fact (`session.inbound_authority.violation`), never `act`; (2) a missing
  failure reason becomes typed `reason: "unclassified"`; (3) a missing llm
  sink snapshot is `Effect.die(AgentInvariantViolation)`, not an empty
  assistant; (4) the tool wave bills injected-clock elapsed time instead of
  0ms; (5) absent runner output returns typed `RunnerOutputMissing`, not a
  policy `invalid_output` refusal; (6) `drain()` refusal is a typed
  `SessionDrainOutcome` and the append receipt carries required
  `admission: "stop" | "refused" | "turn"`; (7) a websocket frame without
  `eventId` returns `{ admitted: false, reason: "missing_key" }` — the
  perimeter never mints a deduplication key. Anonymous-session admission in
  `external-message.ts` is kept; only its minter is injected.
- **Verification.** `rg -n 'Date\.now\('`, `rg -n 'Math\.random\('` and
  `rg -n 'crypto\.randomUUID\('` over `packages/*/src apps/*/src` print zero
  lines (122, 2 and 42 sites removed); `rg -l 'process\.env'` over the same
  scope prints exactly the three owner files. Tests advance time with
  `TestClock.adjust` or fixed `now`/`id`/`random` stubs — no sleeps, no
  `Date.now`/`Math.random` spies. Mutation campaign and full CI are not
  claimed complete.
- **Receipts:** `.omo/evidence/ulw/01a0f656-c9f6-795d-9bfb-786c6699559b/1245/`
  holds the issue body, lane briefs and the eight lane reports with
  per-lane searches and test counts.

## #1244 package-owned typed failures (epic #1260 P2, ⏳ pending merge)

On `epic1260/1244-typed-failures` (2026-10-01, base `fb709568`). The shared
`ForeignFailure` tag is gone; every runtime package owns its failure
identity, and no production module throws a bare `Error`.

- **Seven package-owned failures.** `AgentFailure`, `LedgerFailure`,
  `LlmFailure`, `IpcFailure`, `MachinesFailure`, `CodemodeFailure` and
  `ChannelsFailure` (each a `Data.TaggedError` with `operation`/`cause`)
  replace `ForeignFailure`; `Failure.of` synthesizes `AgentFailure`. The
  ledger/llm/ipc/codemode ones are temporary until #1246 folds those packages.
- **Refusals are values, failures are typed, invariants are defects.**
  Policy refusals are plain result data returned to the caller
  (`SessionPolicyRefusal`). Expected Effect failures are the typed
  `Data.TaggedError` classes in each package union (the package `*Failure`s,
  `ContextRestoreError`, `CompactionExecutionError`, ...). Broken invariants
  are defects — thrown Errors or `Effect.die` (`AgentInvariantViolation`,
  `LedgerInvariant`). Two synchronous surfaces throw caller-handleable
  refusals instead of failing an Effect: `requireCommit` throws
  `SessionCommitError` and the actor registry throws `ActorRegistryRefused`.
  Pure tool bodies and protocol/ui/desktop throw
  named error classes (`CliError`, `AppInvariantError`,
  `ConfigurationError`, `TranscriptRecordingDefect`, ...).
  `rg 'throw new Error\\(' packages/*/src apps/*/src` is zero.
- **Deleted, not replaced.** `AlarmRefused`, `InboxCommitRefused` and the
  never-built `inbox`/`alarms` capability values; the five
  `executor-context` guards fold into `requireExecutor()`;
  `SessionCommitError` and `ReplyGrantProjectionError` move into their
  packages' errors modules; `DataPaymentRequired` (no producer puts a status
  under `.data`).
- **llm keeps the SDK error.** `APIError` is a thin tagged identity over the
  AI SDK's own `APICallError` (`cause`); provider facts (status, headers,
  body, retryability) are read from the SDK error and never copied, detection
  is `APICallError.isInstance`, and `LlmRunFailure.cause` carries the SDK
  error for classification. `ai` becomes a devDependency of agent and app so
  fixtures construct real `APICallError`s.
- **Logging without runners.** ipc/ledger/agent `console.*` calls are gone.
  ledger returns publish failures to an injected `ObservationFailurePort`;
  the agent observation bus reports a subscriber or sink failure through an
  injected reporter, else as an `observation.delivery_failed` fact on the
  same sink (a throwing reporter yields both failures in that fact; a failing
  failure report is dropped). Effect code logs through `Effect.log*`, asserted
  with a captured `Logger` through each package's one test-runner owner. No
  new runner site: `effect-runner-sites.json` stays `[]`.
- **Receipts:** `.omo/evidence/ulw/01a0f656-c9f6-795d-9bfb-786c6699559b/1244/` holds
  `gate-1244.log` (static gates + 15 CI lanes), `verify-1244.txt` (the
  issue's four searches), `patch-coverage-1244.txt`, `dod-1244.txt`,
  `checks-1244.txt`, the lane briefs/reports and review rounds.

## #1243 shared JSON/failure/interrupt helpers (epic #1260 P1, ⏳ pending merge)

On `epic1260/1243-shared-helpers` (2026-10-01, base `5641cff8`). Three
behaviours that were repeated across packages now have one owner each;
every consumer keeps its drop/warn/default and abort-once semantics.

- **One JSON wire parser.** `parseJson(schema, text)` in
  `packages/protocol/src/json.ts` returns the schema-typed value or
  `undefined` for text that is not JSON, a value that fails the schema, or a
  validation that throws. Consumers: discord gateway frames, slack socket
  envelopes (each now emits one warn string per dropped frame), ipc
  `LineDecoder` malformed reporting, llm retry payloads, the desktop renderer
  transport frame and saved window bounds (`?? WINDOW_DEFAULT`).
- **One Cause-to-failure fold.** `packages/agent/src/failure.ts` exports
  `fromCause(cause, synthesize)` (typed error if the Cause carries one, else
  `synthesize(Cause.pretty(cause))`) and the agent profile `of(cause,
  operation)` that synthesizes `AgentFailure` (#1244; `ForeignFailure` until then). Consumers: executor tool and
  completion outcomes, `session-turn` results, and app boot (`Failure.fromCause`
  with the app-owned `AppLifecycleFailure`). The remaining
  `Cause.findErrorOption` sites are Option extractions, not synthesis.
- **One abort listener owner.** `listenForAbort(signal, listener)` in
  `packages/protocol/src/platform.ts` is the only `addEventListener("abort")`
  in `packages/*/src` and `apps/*/src`; an already aborted signal fires at once
  and registers nothing. Effect bridges are `onAbort`/`interruptOn` in
  `packages/agent/src/core/interrupt-on.ts` and the one-expression `onAbort`
  connector in `packages/machines/src/interrupt-on.ts` (agent and machines
  cannot import each other; protocol is their common dependency). Consumers:
  executor body fibers, `tool-body`, `session-turn`, retry timers, approval
  waits, invocation close, machines exec/host cancellation, codemode kernel
  cancellation and cell launch, the CLI follow signal, and the desktop
  transport. `packages/machines/src/abort.ts` and the desktop renderer copy are
  deleted.
- **Waiters and fan-out.** The `Set<() => void>` listener sets in
  `executor-raw.ts` and `compaction/speculate.ts` are `Deferred`s (per raw
  slot; per preparation generation). `concurrency: "unbounded"` is gone:
  `BOUNDED_CONCURRENCY = 16` (`packages/agent/src/core/concurrency.ts`) for
  session close, tool waves and approval stages, `CLOSE_CONCURRENCY = 16` for
  codemode kernel close, and `2` for the two-element app shutdown join.
- **Kept, with reason.** The four `Promise.withResolvers` sites
  (`executor-raw.ts` retain settlement, `process-replies.ts` first/answer,
  `watch-sources.ts` eof) hand promises to promise-world callbacks; a
  `Deferred` there would need a `runPromise` runner site, which the
  `effect-runner-sites.json` `[]` law forbids. They are promise handles, not
  waiters, and stay.
- **Deviation from the issue text.** #1243 proposed three local
  `interrupt-on.ts` copies; two identical copies measured as one jscpd
  production clone (main is at 0), so `listenForAbort` lives in protocol and
  only the Effect wrappers are local.
- **Gates on the branch:** build, check-types, lint (including
  `noExcessiveCognitiveComplexity`; the desktop `sendMessages` optional-signal
  guard is the named `stopOnAbort` function), lint:tools, topology, deps,
  effect boundaries, written any/unknown 0, dead exports, import cycles,
  tsconfig inheritance, jscpd production clones 0, and
  `bun run ci test --lane <key>` over the 15 CI lanes (4828 pass / 0 fail across 15 CI lanes (gate r5, 2026-10-01)); patch coverage
  `all changed executable lines covered` (`script/check-patch-coverage.ts --base origin/main`, lane lcov union).
- **Receipts (HEAD `ec247818`):** `.omo/evidence/ulw/01a0f656-c9f6-795d-9bfb-786c6699559b/1243/`
  holds `gate-1243.log` (lane totals), `patch-coverage-1243.txt`, `dod-1243.txt`
  (ultracite on the 32 changed sources, written any/unknown 0, jscpd 0 clones for the
  three touched packages and `quality:clones:production` 0 clones over 473 sources,
  dead-export ratchet 0 new), `verify-1243.txt` (the issue's rg searches), `checks-1243.txt`
  (CI 30 pass / 0 fail), `review-1243-r1.md` + dispositions, and
  `gate-1243-watch-sources-flake.md` (a pre-existing `watch-sources` flake met by
  the local gate on untouched code; its own subgoal, not this PR).
- **Desktop checks:** the two renderer/main behaviours touched here are covered by
  automated counterparts, `gateway-transport.test.ts` "ignores malformed frames and
  retains unsolicited reply correlation" and `window-bounds.test.ts` "Given malformed
  or undersized JSON, When parsed, Then the default" (desktopApp lane 443 pass / 0
  fail). A native Electron run was not performed.

## W5.3 #1113 closure receipt (2026-09-29, ⏳ pending merge)

W5.3 on `kernel/1113-w5-closure-20260929` (draft PR #1240, HEAD `03f70089` plus this docs commit,
base `8390912c`) closes the W5 absolute-quality lanes. Lane receipts live
under `.omo/reports/kernel-campaign-w53/`.

- **Effect runner owners (A1):** `script/conformance/effect-runner-sites.json`
  is `[]` (48 → 0). `script/check-effect-boundaries.ts` names exactly one
  test-runner owner per package (`RUNNER_OWNERS`: the openomni, agent,
  channels, ipc, ledger, llm, and machines test helpers) plus the two named
  bench entrypoints (`packages/agent/bench/turns.ts`,
  `packages/ledger/bench/index.ts`); the production edges remain
  `apps/openomni/src/cli/main.ts` and `apps/openomni/src/gateway.ts`. No
  production `src/` file changed for A1.
- **Written any/unknown 0 (A2/A2b/A3):** repository-wide written
  `any`/`unknown` type keywords went 68 → 0 (A2 protocol 16 → 0, A2b the last
  4 protocol sites, A3/A3b the script/app/package sites). The new AST gate
  `script/check-written-types.ts` (`check-written-types` package command,
  wired into CI next to `check-effect-boundaries`) has no baseline and
  excludes only `*.test.ts(x)`; it exits 0 with
  `OK: written any/unknown types: 0`. A2 also deleted 53 dead protocol export
  identities (`app-connector/`, `Mcp.Events`, `McpConfig`, `Deadline`, and the
  Tool/Transcript/Policy/Machine/Ingress aliases with zero production
  consumers).
- **One app-owned read model (A4/A4b):** the single read surface is the
  `session_read` handler in `apps/openomni/src/gateway.ts`; channels only
  parses and transports the frame. Every read wire DTO is Zod plain data in
  `packages/protocol/src/gateway/session-read.ts` (`SessionRead.Request` /
  `Cursor` / `Page` / `Gap` / `Receipt`); the `session_snapshot`,
  `session_page`, and `session_gap` frames are additive. Usage provenance is
  `reported | estimated | unknown`, forked at the provider accounting site
  (`packages/llm/src/processor/stream-events.ts`) and written once by the
  durable attempt-result writer. Inspection is bounded
  (`packages/agent/src/session-lifecycle/inspect.ts`: limit 1-256, shared
  descendant budget, indexed catalog child pages, zero `kernel.listRows`
  loops). Desktop owns one query per durable session ID; tabs, drafts and
  selection stay local, and `DEFAULT_PROJECT_ID` plus the renderer
  `phase: "idle"` seeds are grep-zero.
- **A5 mutation baseline fix:** the #1049 baseline-compiler rejection is fixed
  by root-file candidate ownership (each compiler project diagnoses only its
  `getRootFileNames()`); the execution-copy tracked-deletion mirror is scoped
  to git roots (non-git fixture roots no longer fail); `quality-audit` gained
  TypeScript function metrics — cyclomatic (<22), Halstead difficulty (<80),
  CRAP (<25) — implemented in `script/quality-typescript-metrics.ts` and
  pinned in `script/conformance/quality-contract.json`.
- **W4 #1112 disposition (A6):** inert `RunInput.maxSteps` and orphaned
  `Retry.sleep` are deleted; the named executor files have zero duplicate
  abort/race owners; `tool-body.ts` keeps its one invocation-scoped
  cancellation bridge; channel HTTP retry and reconnect stay transport
  behavior. Full audit: `.omo/reports/kernel-campaign-w53/W4-1112-receipt.md`
  (H10 closed).
- **Review r1 findings 1-7 landed** (`review-r1.md`; fixes in `F1.md`,
  `F2.md`, and commits `cb4bf00e`/`f4542212`): (1) session-level terminal
  pages no longer settle other turns' pending chats; (2) an empty same-epoch
  same-head continuation keeps the cached page; (3) the descendant budget is
  independent of the mandatory root visit; (4) paged turn ancestry resolves
  through indexed `actionById` reads; (5) script entry points use top-level
  try/catch instead of inferred-`any` `Promise.catch`; (6) `phaseSince`
  derives from the phase-establishing transition; (7) the resume regression
  asserts exactly one delivery again. Each fix has a fails-before /
  passes-after regression.
- **Review r2 finding 1 (F1-r2):** the accepted receipt is restored to its
  frozen base shape `{type:"receipt",status:"accepted"}`; the durable binding
  moved to the additive `session_bound` frame (`SessionRead.Bound`), sent
  immediately after the receipt on the same socket; desktop binds from
  `session_bound` and ignores receipts.
- **Review r2 findings 2–7 (F2-r2..F6-r2):** (2, 6) the mutation baseline
  and candidate compilers share one root-file diagnostic ownership rule
  (`projectRootPaths`/`ownsDiagnostic` in `script/quality-mutation-input.ts`)
  and the generator's covered set is canonical root ownership, so
  transitive-only inventoried files enter the fallback deterministically;
  (3) the scheduled audit decodes the persisted version-1 summary footer
  (`previousTotalsSchema`) and skips regression rows for dimensions the
  footer never measured instead of comparing against invented zeros; (4)
  overlapping desktop `readSession` calls keep every waiter — same cursor
  coalesces onto the in-flight read, a differing cursor is rejected with the
  typed `SessionReadSupersessionError`, and close/error/session-scoped error
  frames reject all waiters;
  (5) paged turn ancestry resolves through descending 256-action history
  windows (zero point reads; a one-action page over a 300-link chain costs at
  most three window reads, attribution exact); (7) `readSessionCursor`
  captures every phase fact before the fence/revision check, so an
  interleaved commit surfaces as a typed `session_gap` instead of an old page
  with a newer turn's `phaseSince`; F6 sizes the durable-reconstruction
  child-exit deadline (60 s, exact exit signal) for cold hosted runners. Each
  fix carries a mutant-killed regression.

Wave-B gate line (`B-verify.md`, run locally at branch HEAD): build 0,
check-types 0, lint 0, lint:tools 0, lint:docs 0, check-topology 0,
check-deps 0, check-import-cycles 0, check-dead-exports 0,
verify-tsconfig-inheritance 0, check-effect-boundaries 0,
check-written-types 0; root `bun test --timeout 15000 --coverage`:
**4671 pass / 0 fail** after the r2 fix lanes (4635 before them); script
lanes serially 253/81/336 pass, 0 fail.

Honest audit deltas (`quality-audit --dry-run`; the W5.3 column had no local
LCOV lanes, so `complete: false`; the sweep column ran all 15 lanes locally
with LCOV, `complete: true`, `missingLanes: []`):

| Kind | `8390912c` baseline | W5.3 HEAD | quality-debt sweep (2026-09-29) |
| --- | ---: | ---: | ---: |
| coverage (uncovered lines with LCOV; missing-file records before) | 3116 | 485 | 1777 uncovered lines / 162 files |
| complexity | 17 | 14 | 0 |
| cyclomatic (new, <22) | — | 1 | 0 |
| halstead (new, <80) | — | 0 | 0 |
| crap (new, <25; needs LCOV) | — | 761 (no coverage input) | 0 |
| clones | 280 | 280 | 0 |
| types (transitive inferred sites, not written keywords) | 2779 | 2123 | 479 |

The sweep's residual coverage is enumerated in `docs/SLOP.md` §J (CLI
`main()`/violation-print paths in `script/`, race-guard tails in `agent`); the
479 type sites are Zod boundary parses and inferred generics, not written
keywords (`check-written-types` stays 0).

Not claimed: CI green, patch coverage, or mutation completion. B-verify
measured 71 patch-uncovered changed lines across 12 files locally; wave C
lanes C1/C2/C3 close them, and the authoritative gate is the CI
patch-coverage job on PR #1240. The full mutation campaign remains the
scheduled `quality-mutation.yml` run.

## W5.2 session entity receipt (#1197, 2026-09-28)

W5.2 merged as `8390912c` (PR #1239, 2026-09-29) on
`kernel/1197-session-entity-20260928`; it
ships one `Session` entity per `sessionId` on the `effect/cluster`
`SingleRunner` exposed by Effect `4.0.0-rc.118`. Each activation opens one
fresh-schema SQLite file under the configured sessions directory and shares a
catalog SQLite file for cross-session facts and cluster coordination. There is
no legacy migration path: the former `catalog.db` and other old database files
are neither read, migrated, nor deleted.

The entity owns mailbox FIFO followed by `decideSessionAdmission`, rotates the
session fence once per activation, drains the complete admitted backlog, and
uses `DeliverAt` messages for retry, request-deadline, and monitor timing. The
entity port now exposes `settle`; interruption detaches a running turn at the
entity boundary, and shutdown awaits quiescence before closing stores.
`localInboxCommit` borrows the active entity authority only while that entity
is running, preserving live-turn fence ownership while unrelated callers still
fail closed.

Historical deletion receipt: the former lease/alarm/inbox/migration planes are
deleted to the plan §5(a) grep-zero contract. Deleted symbols are `LEASE_TTL_MS`,
`HEARTBEAT_INTERVAL_MS`, `renewLease`, `acquireLease`, `sweepSessions`,
`wakeSession`, `createAlarms`, `Storage.get`, and `Storage.initialize`.
Deleted source surfaces include `packages/ledger/migration/`,
`packages/ledger/src/storage/migration-runner.ts`, the `u967-*`, `u969-*`,
`historical-projections`, and `historical-request-format` migration readers,
`packages/agent/src/executor-retry-alarm.ts`, and
`apps/openomni/src/composition/alarm-worker.ts`. The obsolete script gates
`check-ledger-schema-drift`, `verify-ledger-rename`,
`generate-ledger-archive-manifest`, `ledger-archive-snapshot`, and
`ledger-producer-manifest` are also deleted.

The crash matrix remains exactly 27 faults on the entity plane. Parent-measured
gates at this branch state are: `apps/openomni` 529/0, packages 1443/0,
channels 576/0, script 717/0, `check-types` exit 0, dead exports 0 known/0 new,
`check-effect-boundaries` exit 0 with its runner-site allowlist reduced 54 → 48,
and the §5(a) deletion grep at zero.

This receipt does **not** claim full CI, the pending L4.2 patch-coverage 100%
gate, or a mutation campaign. The 16 pre-existing protocol `unknown` sites
remain carried to #1113. Known findings are explicit: cluster entity reaper
resolution is at least five seconds; `ConfigProvider.fromEnv()` snapshots the
environment at module load; and protocol still retains the `Inbox.Commit` and
`Alarm.Watch*` wire schemas even though their consumer moved into the entity.

## Historical receipts retained below

The remaining sections preserve the evidence and scope claimed by earlier
campaign increments. Their source names are historical context, not live W5.2
ownership.

W5.0 (#1195) Effect pin `3.22.2` → `4.0.0-rc.118` (exact, published 2026-09-28) on `kernel/1195-effect-v4-pin-20260928` (PR #1198, ⏳ pending merge): zero behavior change — mechanical v4 renames across nine workspaces, `FiberRef` → `Context.Reference`, `Effect.withFiberRuntime` → `Effect.withFiber`, `Cause` reason filters, `Effect.all` failure semantics of `shutdownSessions` preserved under v4 `mode: "result"`, `effect/testing` `TestClock`; protocol/ui/desktop/tool bodies stay Effect-free (`check-effect-boundaries` 233 allowlisted ratchet sites, allowlist 224 entries, both unchanged from main); no `effect/unstable` cluster or workflow import. Receipts under `.omo/reports/kernel-campaign-w50/`. W3 (#1111) merged as `75d28562` (PR #1193, 2026-09-26): single ledger policy-generation writer (compiler `append: () => false` deleted), executor dispatch table with captured toolsGeneration, ToolCatalog Layer built once per generation with tools/** effect-free and sealed 12-tool catalog (read, write, edit, ls, find, grep, bash, eval, monitor, send_message, provision, completion), and typed evidence-only authority (`SessionRunnerInput.authority` from inbox `origin.inboundTreatment`) with OBSERVATION prose prefix deleted. W0.5 (#1184) source wiring inspected on `kernel/1184-consumed-layers-20260924`, 2026-09-24. This stamp covers the Layer/bundle slice below, not a re-verification of historical receipts or a merge/CI claim.

| Slice | Status | Scope |
| --- | --- | --- |
| Consumed Effect Layer floor (#1184), 2026-09-24 | wired in worktree; full acceptance not asserted | Effect factories consume Tags; AppLive composes package Layers and an app-owned generation map; validated bundle definitions and named policy contributions build in captured generation scopes. Sources and remaining boundaries follow below. |

`packages/agent/src/executor.ts` resolves Clock, Entropy, ObservationSink and
SessionLayer; `packages/agent/src/tool-dispatcher.ts` resolves ToolCatalog.
`packages/agent/src/core/execution/run.ts` and
`apps/openomni/src/composition/completion.ts` resolve Llm and ObservationSink.
App boot and gateway thread the ledger plane explicitly
(`apps/openomni/src/index.ts`, `apps/openomni/src/gateway.ts`);
`createAppLedger` (`apps/openomni/src/composition/cluster-runtime.ts`) owns
storage acquisition/release.

`apps/openomni/src/runtime.ts` builds AppLive with a final Layer.mergeAll.
`apps/openomni/src/composition/generation-layers.ts` constructs the selected
catalog, scoped local observations, named registry and compiled policy; its
session-keyed managers use `packages/agent/src/session-generations.ts` for
capture/configure and retirement. Boot initializes immutable role definitions
before recovery. Installed bundle names are passed to new sessions, and bundle
rows enter existing policy seeding (`apps/openomni/src/index.ts`,
`apps/openomni/src/policy-seed.ts`). Existing configure operations carry recorded
membership unchanged (`packages/agent/src/session-configuration.ts`).

`packages/agent/src/bundle.ts` validates definitions and ordered composition,
including named policy services. The executor records original arguments when
pre-transforms apply (`packages/agent/src/executor.ts`,
`packages/agent/src/executor-record.ts`). These are source-inspection claims,
not receipts for every runtime, crash, performance or patch-coverage gate.
B6 remains open: configure authority and approval-binding callbacks survive
([SLOP](SLOP.md#w05-consumed-layer-floor-1184)); W0.5 does not claim their W1
migration, a bundle membership API, full W3 G1, or concrete production bundles.

Policy/ledger ownership was updated on `kernel/s1-authority-cut-2`, 2026-09-18: G002 (#930) deletes the unused composition schema and moves app action reads to narrow SQL-backed ports.

**G003 durable spine (`kernel/s1-durable-spine`, 2026-09-18, #930):** the volatile `waitRetry` seam is deleted; a provider retry commits an `alarm.arm` action carrying a `retry.scheduled` spec (kind `at`, id `<intent>:retry:<attempt>`) before any wait, and the live waiter or boot alarm worker consumes it exactly once through the fenced cancel CAS (now admitting one-shot alarms) and wakes the session without an inbox prompt (`packages/agent/src/executor-retry-alarm.ts`, `apps/openomni/src/composition/alarm-worker.ts`). A boundary-flagged execution (compaction) commits summary + successor projection + accounting as one ledger transaction before result commit or publication; crash recovery settles the open intent executed-from-boundary without resummarizing (`packages/agent/src/executor.ts`, `executor-recovery.ts`, `compaction/execute-cut.ts`). Commit-time writer fencing is recorded as taxonomy: a stale fence gets the typed `{ok:false, reason:"stale"}` rejection atomically with no partial row, proven fence-only under the same owner name (`packages/ledger/test/session/commit-fencing.test.ts`). Crash-matrix rows `retry_backoff_wait` -> `rearmed`, `compaction_summary_before_result_commit` -> `resumed_without_reexecution`, `owner_reclaimed_before_stale_transcript_flush` -> `rejected`.

Single source of truth for current wiring, not a declaration that every target in [Core Model](core-model.md), [Kernel Contract](kernel-contract.md), [Architecture](architecture.md), or [Machines and Delegation](machines-and-delegation.md) has shipped. [Epic #930](https://github.com/INONONO66/openomni/issues/930) supersedes #459 for kernel delivery; #966 and #968-#973 are the subsequent lifecycle campaign.

[Kernel reference pins](kernel-references.md) are owned by `docs/kernel-references.md`.

**#945 absolute census (2026-09-19, main `f5ea0e32`):** the Quality ratchet is green as a no-growth gate; the admitted baseline still holds 60,509 rows (99,601 multiplicity) across coverage, type, CRAP, clone, export, publisher, complexity and store gates. #945's literal-zero definition of done is not met; the per-gate table and the full-mutation campaign outcome are in [SLOP](SLOP.md#945-absolute-census-receipt-2026-09-19-main-f5ea0e32).

**#969 cutover (2026-09-07):** waiting and authenticated consent are original-action state. Source-owned outbound obligations feed the receiving kernel and inbox. Migration 0038 removes the independent stores with guarded archival retention. Final HEAD, gate outputs and acceptance receipts are recorded in the PR and local report.

**#971 cutover (2026-09-08):** alarm occurrence identity, deadline and notification budget are decided by the ledger from the committed row and its persisted spec; the evaluator reports a transport `sourceKey` and redelivery commits nothing. No schema change, no migration, no new table.

**#970 cutover (2026-09-08):** interrupted executor operations settle from classified durable evidence, never by rerunning a body. Attempt ordinal, cap, retry reason, usage, visible-output boundary and a non-secret credential handle are pinned on attempt actions. `restore_model_selection` and `restore_context_projection` are recorded, policy-evaluated actions that append; no schema change, no migration.

**#973 conformance (2026-09-08):** the unified lifecycle is proven on the real tree, not declared. `runLifecycleTrace` (`packages/agent/test/session-lifecycle-conformance.test.ts`) runs the six section 6.7 registrations of the [lifecycle contract](session-lifecycle-contract.md) over the real store, controller, executor waves, request port, outbound path and alarm rows, asserting append-only history, causal parents, terminal uniqueness, single input consumption, one observation per commit and effect-free replay from the reopened SQLite image. No production writer moved and no fixture was deleted; the #945 all-dimension quality receipt stays with #945.

**#1030 policy dead-code removal (2026-09-09):** the general effect-composition implementation and its 29 conformance tests are removed without replacement. Searches of updated `origin/main` (`47bc4299`) found no external production or test consumer of any of its 31 exports; the PR body records every command, result and census/prose/substring false positive. The retained engine evaluates compiled rows and permissions; it does not implement general deny/pending/allow composition, safe-deny effect ceilings, conflict merging, deduplication or retry-ceiling merging. Captured row budget limits and channel ceilings are unchanged. Protocol `Policy.EffectiveDecision` was deleted in G002 (#930), including its schema/type, parser/module-surface entries and snapshot. Shared `PolicyEffect` and `PolicyDecision` contracts still have separate consumers and are not deleted (the obligation contract followed in #1246).

**Source baseline:** #946 stage 2 includes main `678d357e` (#993/#949 stage 1), #991 codemode, #988's protocol contract and #990's desktop gateway selection. Historical #948 receipts below retain their `c4fb7748` source pin. [SLOP](SLOP.md) records deletion ownership; the PR body records the final gate commands and exit codes. Closed issue labels are not implementation evidence.

**W1 (#1108) durable reconstruction (merged `851a71fc`, 2026-09-24):** checkpoint folding commits `fold.checkpoint` at the 256-action threshold and at compaction/restoration boundaries (`packages/ledger/src/storage/l0-action-builders.ts`, `packages/agent/src/session-lifecycle/history.ts`). Bounded hydration validates the checkpoint seed before a capped range load; corrupt seeds refuse with `FoldCheckpointIntegrityError` — zero full-tree fallback, zero runner entry (`packages/ledger/src/session/kernel.ts`). The whole-tree kernel `tree` export is removed; production `.tree(` consumers grep to zero across agent/openomni/ledger src, and the fold oracle remains test-only at `@openomni/ledger/testing` (`packages/ledger/test/helpers/session-tree.ts`). `authorizeConfigure` is a required pinned pre-policy authority on the session runtime (`packages/agent/src/session-contract.ts:129`); the optional-callback `?? Effect.succeed(true)` fail-open in `packages/agent/src/session-configuration.ts` is deleted (grep zero). Retry scheduling persists the unchanged `retry.scheduled` alarm payload (kind/attempt/reason/notBefore — `packages/protocol/src/ledger/l0.ts` `Alarm.RetrySchedule`) before any wait; restart sleeps only the residual `notBefore - now` with the recorded row byte-identical and no new jitter drawn (`packages/agent/src/executor-retry-alarm.ts`). NOT in W1: durable alarm-level deadline/route/jitter/provenance/remainingBudget fields (protocol change required) and a durable route cooldown store (no owner exists); residual/jitter/provenance are proven only at the derived level (`notBefore` embeds the drawn jitter; provenance/budget live in attempt-intent metadata). Crash-matrix v2 reconstruction rows (`script/conformance/crash-matrix.json`): `fold_checkpoint_committed_before_wake`, `context_restore_checkpoint_committed_before_publish` and `same_id_result_after_checkpoint_before_wake` → `resumed_without_reexecution`; `fold_checkpoint_tampered_before_load` and `captured_generation_missing_after_restart` → `rejected` (typed refusal, no fallback or generation substitution); `open_tool_checkpoint_before_terminal` → `lost` (identity preserved, `outcome_unknown`, no re-entry); `recovery_dispatch_identity_committed_before_rpc` → `resumed_without_reexecution` (not the `rearmed` target: no separately durable recovery-dispatch identity).

**W2 (#1110) one message plane (merged `d5b48a1b`, PR #1190, 2026-09-25):** the Resident no longer replies on its own initiative. The post-turn block that dispatched `send_message` to the last external-origin actor is deleted from `apps/openomni/src/resident.ts` (grep zero for `send_message` in that file); external replies happen only through an explicit `send_message` tool call, and a child's terminal still reaches the parent inbox as the kernel obligation. One alarm writer: the request-deadline `INSERT` in `sqlite-l0-write.ts` is gone; `requestDeadline` (`packages/ledger/src/storage/l0-action-builders.ts:24`) builds the row and the transaction-local `insertAlarm` (`packages/ledger/src/storage/sqlite-l0-write.ts:122`) is the single `INSERT INTO alarm` site, called by explicit `armAlarm` (`sqlite-l0-alarms.ts:87`) and by request/reply state projection in the same commit. The app alarm worker mints no occurrence ids and renders no timeout verdict; a watch timeout is delivered as a clock observation (`timer:<fireAt + timeout_ms>`) and the ledger alone decides expiry (`apps/openomni/src/composition/alarm-worker.ts`). Channel provisioning is declared-only: `channelsFromEnv`, `config.channels` and the `source: "env"` selection are deleted; `loadConfig`/`doctor` refuse nonblank legacy tokens with `ConfigurationError` `legacy_channel_credentials` naming `provision`/`channel_add` (`apps/openomni/src/config.ts:253`); the supervisor reports `source(): "declared"` only (`apps/openomni/src/provisioning/supervisor.ts:76`). Physical delivery reports facts: adapters return `sent | not_sent | unknown` (`packages/channels/src/support/deliver.ts:8`), `DeliveryReconciliation` holds custody per idempotency key and releases it only on a proven `not_sent` (connection never established, typed `DeliveryNotSent`, or platform rejection); the kernel `accepted | rejected | unknown` receipt is a translation at that one boundary (`kernelDeliveryReceipt`), and the expiring outbound `DedupeWindow` is deleted. GitHub reports unopened webhooks as a typed `unsupported_event` refusal observation (`packages/channels/src/provider/github/surface.ts:23-35`) while keeping HTTP 200; PR events are still not ingested. Matcher bearer/identity-less branches and the resolver's `legacyActorFields` copier are deleted (SLOP H14). Agent ports: outbound recovery reconciles against the receiver's durable receipt before any redispatch (`packages/agent/src/session-outbound.ts:112`) and `SessionRequestPort.cancel` shares the original-action CAS (`packages/agent/src/session-requests.ts:127`). The IPC client drops frames once disconnected or closed (`packages/ipc/src/client.ts`). Crash-matrix rows (`script/conformance/crash-matrix.json`): `platform_send_committed_before_local_ack_reconciled_sent` → `resumed_without_reexecution`; new `alarm_fire_committed_before_hibernated_doorbell` → `rearmed`; `platform_attempt_marker_before_send_reconciled_not_sent` and `outbound_flood_deadline_before_timer_rearm` stay `rearmed` and `platform_send_ambiguous_without_reconciliation` stays `replayed` because the ledger outbound projection admits only `pending | delivered` (no durable attempt, `outcome_unknown` or `notBefore` state); that protocol change is NOT in W2.

## #947 stage-1 branch receipt (2026-09-06)

The stage-1 branch extends the existing alarm owner with fenced evaluation,
atomic fired/prompt delivery, persistent PTY and path sources, durable dedupe,
policy-budget pause/rearm, and boot discovery. The additive `monitor` tool uses
`op:create|rearm|cancel`. The app band outlives session hibernation; its committed
inbox doorbell re-enters the existing session controller, not a second loop.
The focused 30-test run passes, including a real PTY, SQLite reopen and a
one-model-call waiting terminal followed by a hibernated-session wake.

The Owner-approved input now nests an op-discriminated `operation`, with create
payload under `source` and required `alarmId` on controls. `lint:tools` passes
without an exemption or lowered floor. Path sources reconcile stat identity in
the same app scan as native notifications: unchanged observations write zero,
and a missed native event no longer strands a durable create. The path test
subscribes before mutation and drives reconciliation without yielding to the
native callback, proving atomic delivery independently of callback timing.
Evaluator entry captures the app async context, preventing tool-wave abort
inheritance. A real WebSocket/PTY/FIFO regression verifies that a tool-created
source wakes a hibernated app session after its original tool wave has ended.

Rebased production checkpoint `6a912340` passes the complete gate chain:
3377 tests across 359 files, zero failures, and all 11 coverage lanes plus the
unchanged coverage ratchet. The real app WebSocket/path exercise reaches a
hibernated-session wake at revision 59 with two model calls. Removing the app
async-context binding makes the PTY/FIFO regression fail with AbortError.

[Decisions and operational limits](alarm-monitor-stage-1.md) include the
at-most-once restart gap. Stage 2 after #946 still owes only the
message-deadline consumer -> `at` alarm migration, its answer/deadline CAS and
restart tests, and B4 deletion proof. #969-#972 receipts are consumed by their
own sections below; #973's executable evidence is in the conformance section.

### PR #994 R1 correction receipt

The R1 implementation merges main `678d357e` (#993): all six fs/bash tools,
monitor and existing tools remain in the catalog; placement stays deleted.
Callback deadline precedence now applies before ordinary match/exit admission.
Command cleanup kills its process group, including HUP-ignoring grandchildren,
and stale cleanup is fenced from a rearmed source. Migration validates the
complete shared WatchSpec before committing 0035. Synchronous inbox/action
assertions kill the path-reconciliation mutant before native callbacks can run.
A compiler-backed boundary test reports zero inferred unsafe values and rejects
its deliberately planted JSON/catch mutant; runtime payloads are schema-checked.
The earlier 3377-test receipt above remains historical, not a claim that R1
was already addressed at that checkpoint.

Production checkpoint `21675e12` passes the merged full suite: 3435 tests,
zero failures, 11167 assertions across 365 files. All ten current coverage lanes
and the unchanged ratchet pass (app 97.08%, ledger 99.34%). The full build/type/
dependency/cycle/lint/export chain, including tool-lint self-test, exits 0.
The reviewer's added-line compiler probe emits no unsafe values. The real-app
WebSocket/path wake still commits one fired pair and reaches revision 59.

## Deployed shape

| Component | Current wiring | Source |
| --- | --- | --- |
| Kernel app | Boot/shutdown, Resident, channels, gateway, provisioning, machines, messaging, cells, and compaction. No built-in curated memory or replacement port. | `apps/openomni/src/index.ts` |
| Desktop console | Electron shell and app-owned AI SDK chat state; the renderer selects the configured gateway or the explicit preview transport. Gateway admission receipts and later message frames are distinct. Presentation is shared with the UI showcase. | `apps/desktop/`, `packages/ui/` |
| Channel drivers | Discord, GitHub, Slack, Telegram providers and a separate WebSocket bootstrap surface. Providers own credential/settings validation and outbound rendering; the app composes them. | `packages/channels/src/provider/`, `packages/channels/src/websocket.ts`, `apps/openomni/src/channels.ts` |
| Perimeter gateway | Blacklist, physical request correlation, channel ceiling, actor identity, surface sessions, durable route decisions, and grant/egress/idempotency-controlled sends survive. Removed dialogue stores confer no routing rights. WebSocket credentials use the canonical auth subprotocol; query-only authentication is rejected (#974). | `packages/channels/src/router/`, `packages/channels/src/authn/websocket.ts`, `apps/openomni/src/gateway.ts` |
| Provisioning | Durable persons, channel instances, and encrypted secrets; declared instances are the only channel provisioning owner, and nonblank legacy channel env credentials are refused at config load with `legacy_channel_credentials` (W2 #1110). The vault key and channel supervisor are composed at boot. The one-shot environment import command is deleted. | `packages/ledger/src/provisioning/`, `apps/openomni/src/provisioning/` |
| Runtime administration | The `provision` op union uses the live supervisor for channel/secret changes and status. Person mutations suspend their original invocation for authenticated approval when `approvalRequirement` demands one (editing the existing owner Person, or raising a tier above collaborator); other declarations and non-sole-owner `person_remove` apply directly. `contact_promote` and `contact_merge` suspend under the `require_approval` policy row until the Owner's answer re-admits the original invocation; the separate `approval` tool was deleted in `239b4273` (2026-09-08). | `apps/openomni/src/tools/provision.ts`, `apps/openomni/src/provisioning/supervisor.ts` |
| Resident and native workers | Shared durable session handles and one app runner. The Resident sends no automatic reply after a turn; external replies are explicit `send_message` calls (W2 #1110). Native and real process child-to-parent delivery pass targeted tests; the old app delegation subtree and tools are removed. | `apps/openomni/src/resident.ts`, `apps/openomni/src/process-entry.ts`, `apps/openomni/src/composition/process-session.ts` |
| Session durability | Fenced single-flight execution, durable inbox/alarms, parent-linked rows, action history, generation snapshots, boot recovery, idle release, authoritative reads, revision-gap observation, bounded revision history pages (`history()`) and redacted causal inspection (`inspect()`) derived from committed actions (#972). Legacy public CRUD/message/TTL ownership is removed, not aliased. | `packages/agent/src/session-handle.ts`, `packages/agent/src/session-controller.ts`, `packages/agent/src/session-lifecycle/inspect.ts`, `packages/ledger/src/session/kernel.ts`, `packages/ledger/src/storage/sqlite-l0-adapter.ts` |
| Action executor and policy | Session-pinned compiled policy rows govern prompt/turn/model/tool/message pre/post decisions; message post is obligation-only. The executor owns model/tool intents and linked terminals; prompt/turn records remain session-owned. Old policy callback registries are deleted (#965); configure-authority and approval-binding seams remain tracked by B6/H6. Unconsumed general effect composition is deleted without replacement (#1030). | `packages/agent/src/executor.ts`, `packages/policy/src/row-compiler.ts`, `apps/openomni/src/policy-seed.ts` |
| LLM | Canonical model/auth resolution, provider classification, retry-after/backoff, and corrected additive token accounting. The processor performs one attempt; session execution owns retry and re-admission. The unused public fact tap is removed (#976); ephemeral transcript folding and message/tool callbacks remain. | `packages/llm/src/`, `packages/agent/src/executor-attempts.ts` |
| Compaction | App-configured summarization and agent-owned speculative/synchronous compaction, with durable projection/range/hash/revert evidence and reconstruction from canonical actions. The summarizer is wired, not dormant. | `apps/openomni/src/compaction/`, `packages/agent/src/compaction/`, `packages/agent/src/session-lifecycle/history.ts` |
| Observation | Scoped agent bus/component observations are projections, not durable authority. Ledger facts commit before observation. The old telemetry package and bus-persistence writer are absent. | `packages/agent/src/observation/`, `apps/openomni/src/observation/` |
| Machine body and raw endpoints | Stable list/get handles expose binary-safe confined fs read/write/list/stat, stateless exec(cmd,cwd), and runCode. Enrollment/offer intersection is fail-closed. Exactly two authorization boundaries: captured kernel tool.pre and daemon capability/export enforcement. The descriptor-pinned no-follow confinement driver remains; machines owns no interpreter. Old app filesystem/list-machines tools remain absent. | `packages/machines/`, `packages/protocol/src/machine/`, `packages/ipc/` |
| Code mode | Public factory supplies machine object handles named after the tools (`read/write/ls/bash/eval`) and `cell.run/peek/stop`. The injected daemon runner owns lazy per-tenant Python processes, parallel/completion helpers and callback routing. The brain facade never spawns Python. Cancellation and close propagate across the attachment and await process cleanup. App VFS, cell registry and old machine methods are deleted; the single `eval` tool delegates to codemode: `run` waits `timeout` seconds then answers `running` with a `cell_id`, `peek` reads the streamed partial output (`machine.peek_code`), `stop` interrupts and settles the cell as `cancelled` with its output, never re-running it; a ten-minute ceiling bounds background cells. Cell-only `completion({prompt, model?, system?, schema?})` has a 32-call per-catalog budget; a `schema` answer is validated host-side and returned as canonical JSON; batching is the cell's `parallel()`. | `packages/codemode/`, `apps/openomni/src/composition/codemode.ts`, `apps/openomni/src/tools/eval.ts`, `apps/openomni/src/tools/completion.ts` |
| Tool catalog and prompts | The catalog is sealed (#949): eleven model-door tools `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, `eval`, `monitor`, `send_message`, `provision` plus the cell-only `completion`; snake_case names, one `op` discriminator under `operation` for eval/monitor/provision, flat `tools/<name>.ts` (`_` written `-` in file names; `lint:tools` `[tool-file-name]` pins the correspondence). There is no `approval` tool: `provision.contact_promote`/`contact_merge` carry `require_approval` policy rows resolved through the kernel request path. `lint:tools` and the catalog test pin the exact set and refuse retired names. The prompt builder accepts model tuning only; deleted-domain injection/instructions are absent. Dispatcher-only model truncation caps at 32,000 UTF-16 code units on a Unicode code-point boundary, with exact dropped/original UTF-8 byte counts; cell values stay full. | `apps/openomni/src/tools/core/catalog.ts`, `apps/openomni/src/prompt/`, `packages/agent/src/tool-dispatcher.ts` |
| CLI and composition | Start/onboard/daemon/doctor/logs and npm staging belong to the app. The minimal `openomni machine attach <config.json>` composes the retained machine daemon wire; Resident `openomni daemon` remains unchanged. Reversible composition owns both boot rollback and reverse-order shutdown. | `apps/openomni/src/cli/`, `apps/openomni/script/build-npm-package.ts`, `apps/openomni/src/composition/composer.ts` |

#949 stage 1 removes the target-selection workspace and capability-based catalog fold; call-time admission belongs to executor `tool.pre`. Model fallback selection belongs to `packages/llm`. Together with #991's codemode workspace, the generated topology describes twelve workspaces. The standalone waiting/approval folds and stores are removed by #969. #949 stage 2 seals the catalog, folds approval into `provision`, and drops the catalog's conditional Proxy port scaffolding: every tool is constructed statically and refuses at execution when its port is absent. #949 stage 3 adds `eval` `peek`/`stop` over a background cell registry with streamed partial output, `completion` options `{model, system, schema}`, and renames the codemode handle methods to the tool names.

## G002 ledger authority cut (#930)

On `kernel/s1-authority-cut-2` (2026-09-18), session `action` is the single ordered action history. Each append stores `prev_hash` and `action_hash`; `storage/l0-hash.ts` owns hash framing over the stored bytes and metadata. Migration 0039 validates contiguous per-session ordinals before backfilling links. `SessionHandleStore.verifyChain(sessionId)` returns an intact head/length or the first broken ordinal with expected/actual hashes; it verifies equality, not policy.

The separate `ledger-core` event/head store is deleted. `decision_fact` holds first-writer-wins keyed facts with a row hash: record returns either the newly recorded fact or the existing fact, and routing/admission callers replay that stored result. Migration 0040 preserves recognized historical stream heads as decision facts and refuses unrecognized stream classes before dropping the retired live tables.

App monitor, boot runner selection, message decision identities, platform-message lookup and outbound receipt recovery use `actionById`, `latestGenerationFor`, `policyDecisionRuleIds`, `messageActionByPlatformId` and `outboundReceipt`. SQL selects exact keys/kinds; schema decoding and the existing configuration fold remain ledger-owned. App source no longer loads `tree()`; agent history/fold consumers retain it. No new policy judgment or writer is introduced.

## #946 messaging cutover

The app exposes one `send_message` tool and one two-argument gateway ingest. Driver facts carry no authority. A/B message rows, tier and actor-grant preflight, transactional root/child inbox writes, source-owned outbound obligations and idempotent receiving inbox mail, durable reply-grant recovery and actor receipt distinctions are wired. Native, process, WebSocket and code-mode integration tests exercise the actual composition roots.

#969 replaces the former message-specific answer/deadline writer with the canonical request transition and an alarm projection. The request retains the original action binding and deadline; answer, timeout, refusal, and cancellation compete for one terminal action. Source terminal commits an outbound obligation; receiving acknowledgement is idempotent, and `LedgerSession.Commit.receive` is restricted to the committing session. **#947 supplies the shared live alarm worker; request deadlines use its `at` rows and the canonical request transition.** The earlier #946 deadline and native-delivery receipts do not, by themselves, verify these replacement paths.

The legacy tool trio, separate worker-run stores/process ACK lifecycle, channel return-value writeback, trigger rules and GitHub normalizer are deleted. Migration 0035 refuses nonempty retired tables rather than discarding their data; 0036 adds the bounded durable reply-grant projection. Historical migrations remain immutable. The coverage baseline is unchanged.

## #969 request waiting and delivery

The protocol exports SessionTransition under the existing session/action vocabulary. Gateway requestId/requestSpec/requestContext identify the original action; channels retains physical chain precedence, pins, responder matching, grants, egress budgets, idempotency and accepted/rejected/unknown receipts, while injected kernel ports decide request transitions. Typed Owner answers use the same authenticated gateway ingest, with no credential written to history. The model-facing protected-mutation tool no longer exposes request/decide operations or an approval-id bypass. Protected domain preconditions are checked again inside the actual mutation transaction.

Migration 0038 extends action/policy kinds with request/reply/outbound. It retains terminal legacy rows indefinitely in immutable archive_969_wait and archive_969_approval tables before removing the live tables. The preflight refuses unresolved, malformed, incoherent, or still-follow-up-visible rows before mutation; it cannot reconstruct an original invocation from old records. Historical migrations are unchanged. Unresolved legacy message alarms and native child inputs/turns also refuse; no captured invocation is guessed. Native message/part retention and the explicitly confirmed #967 archive procedure remain separate. Scoped pragma statements are finalized before rebuilding tables, including on Bun 1.3.6.

The executable census is `bun run script/request-authority-census.ts`; its test is `script/conformance/request-authority-census.test.ts`. It scans production, fixtures, and public schema with git grep, including untracked local files. Only enumerated archival SQL operations and one historical hash-chain event are excepted; no test tree or API-bearing file is excluded. Reintroduced store/interface, SQL writer, serialized correlation, and untracked fixture mutants must be rejected. This is a lexical/AST deletion guard, not proof against dynamically assembled SQL or renamed replacement engines. Behavioral tests exercise real Owner WebSocket consent after SIGKILL and two restarts, exact-invocation at-most-once execution, domain and principal refusal, answer/timeout/cancel CAS, real Telegram correlation, native/process replies and receiving-consumer failure discrimination. A copied-tree mutant that drops receiving intake fails the real app end-to-end test.

The producer manifest no longer permits independent waiting/approval streams or the deleted commit coordinator. The dependency manifest permits agent only for channels tests; production channels imports remain protocol/policy/ledger. Reviewed snapshots contain SessionTransition and the restricted protected-mutation catalog. The PR records the #969 gate results and unchanged coverage floors. This does not close the broader #945/#948 campaign.

## #970 durable recovery and typed restoration

`packages/agent/src/executor-recovery.ts` owns the recovery product. Every intent records its `recovery` classification (`local_transactional`, `endpoint_idempotent`, `read_back_reconcilable`, `ambiguous_no_replay`; kernel-local compaction/message intents default to local-transactional, everything else to ambiguous-no-replay). A post-body exception at `post_policy`, `reverter` or `result_commit` reads the original terminal slot first, settles `failed` from the body's known evidence and treats a thrown reverter as no proof of rollback; a refused recovery commit propagates and the intent stays recovery-pending. `DurableExecutor.recover()` settles crash-open intents: an ordinary open tool records one `outcome_unknown` with no body, a lost provider attempt makes the logical llm outcome unknown rather than silently retrying, an llm whose attempts all settled fails from that evidence, and local projections fail from the ledger read-back. Request-bearing waves stay with the captured tool dispatcher, which now runs executor recovery before its captured waves and never runs a tool.

The provider retry owner is unchanged (`createAttemptRunner` in `packages/agent/src/executor-attempts.ts`); each attempt intent pins `attempt`, `maxAttempts` and `retryReason`, and the settled result carries the llm `AttemptEvidence` (usage, `visibleOutput`, finish reason, `Auth.reference` credential handle: type plus a 16-hex digest, never the key). Provider retry, crash-open resume and goal continuation remain distinct budgets with their own durable parents and IDs.

`restore_model_selection` (`packages/agent/src/model-selection.ts`, `packages/agent/src/core/execution/run.ts`) runs at the turn boundary when the earlier turn's last chat attempt ended on a configured fallback: an executed action releases the primary, a refused one keeps the fallback pinned for the turn with the policy decision as the only record. `restore_context_projection` (`packages/agent/src/compaction/restore.ts`, `SessionHandle.restoreContext`, `createSessionAdmission.restoreContextProjection`) rebuilds the projection from the compaction's own recipe under the held lease and appends it as a compensation with the compaction as parent; unknown or unexecuted compactions are refused before anything is recorded, and the original compaction facts are untouched. The contract's proposed relocation of admission/turn code into `session-lifecycle/*.ts` did not happen; the owners stay in place. Tests: `packages/agent/test/executor-recovery.test.ts`, `core/model-restore.test.ts`, `model-selection.test.ts`, `session-context-restore.test.ts`, `session-chat-runner.test.ts`, `core/execution/llm-attempts.test.ts`, `packages/llm/test/run-outcome.test.ts`, `packages/llm/test/auth/storage.test.ts`.

## #971 monitor occurrences and evaluator recovery

The #947 alarm band is hardened against the transition contract without a second monitor, table or engine. `Alarm.Fire` (`packages/protocol/src/ledger/l0.ts`) carries the evaluator's transport `sourceKey`; the caller-minted `actionId`/`inboxId` and caller-supplied `limit` are gone. `alarmOccurrence` (`packages/ledger/src/storage/l0-action-builders.ts`) is the single admission judgment shared by the SQLite adapter and the in-memory test double: stale epoch/fence, pre-due time, consecutive equal poll batch, persisted `timeout_ms` deadline and persisted `notificationLimit` are decided there from the committed row. The occurrence action id is `Alarm.occurrenceId(alarmId, epoch, sourceKey)` and the prompt inbox id is derived alongside it, so redelivery of one committed occurrence appends nothing and leaves the session revision unchanged. Recurring matches stay armed; exit/timeout/one-shot complete; the N+1th match under a budget of N commits exactly one `alarm.paused` prompt and fences the evaluator; cancel and rearm fence before the band closes the source.

Recovery modes are unchanged in kind and now visible in identity: takeover (`acquire`) advances the fence and preserves epoch, notification count and dedupe digest, so a restarted idempotent poll that prints the same batch is suppressed and the next distinct batch delivers; explicit `rearm` advances the epoch and resets both. A non-persistent (timed) watch found running at band restart settles with a `restart` summary; live PTY output in the gap is never replayed; cursor-capable backends were not added. `createAlarmWorker` (`apps/openomni/src/composition/alarm-worker.ts`) keeps only OS handles, the per-source line counter and the recovery flag; the path source hands its stat identity to the ledger as the occurrence key and keeps its snapshot only to classify create/modify.

Tests: `apps/openomni/test/monitor-occurrence.test.ts` (distinct occurrences and zero-duplicate redelivery, takeover-vs-rearm dedupe, N+1 contenders, ledger-decided deadline, real PTY occurrence key), `packages/ledger/test/storage/alarm.test.ts` and `alarm-control.test.ts` (SQLite/memory parity, budget from the persisted spec), and the existing `alarm-boot-durability`, `alarm-worker-boundaries`, `monitor-budget`, `monitor-deadline`, `monitor-tool-boundaries`, `monitor-process-group` and `monitor-app` suites for evaluator restart, session hibernation and deterministic source shutdown. The contract's ALD/ALA/ALX relocation targets and `AlarmTransition` schema were not built; `session-lifecycle-contract.md` records the landed owners.

## #973 lifecycle conformance

`packages/agent/test/session-lifecycle-conformance.test.ts` is the section 6 HARNESS of the [lifecycle contract](session-lifecycle-contract.md). Each step of a trace runs against the real `SessionHandleStore`, session controller, `createExecutor.runBatch`, `createSessionRequests`, outbound dispatch and alarm rows, then snapshots the complete durable product of every traced session and checks: history only grows and keeps its prefix; every parent action precedes its child in the same session; at most one terminal per turn and per result slot; each inbox row is consumed at most once; exactly one `ledger.action.committed` observation per committed action. After the last step the file-backed SQLite image is reopened and the fold must equal the last prefix while dispatched bodies, tool observations and commits stay `[]`.

Measured against the landed #969-#972 tree: integrated wave revisions are 9/30/30/30/26 (ordinary, approved, refused, timeout, interrupt); the durable deadline fires once and a duplicate timer or late approve commits nothing; every losing contender on a closed request is recorded once per distinct input id as `duplicate`, `late_unknown` or `rejected` and never changes the winner (a seen reply id replayed by another principal is one `duplicate` in the pure authority, a record-free `rejected` at the store); a misrouted answer is refused before any record (destination revision, action count and `seenReplyIds` asserted unchanged; the request-id routing check is pinned in `session-request.test.ts`); the winning reply is delivered as pending inbox input keyed by its input id (inbox ids are store-wide); resume keeps the interrupted turn's messages and mints a new turn/result under the latest generation while crash-open recovery keeps the pinned turn, result and generation; a boot sweep resumes every open turn in the store; a child's reply survives a lost destination wake and a lost source ack with exactly one parent inbox row and one parent consumption; alarm takeover preserves epoch/count/digest and rearm resets them.

Not established here: the #945 receipt at final HEAD (any/unknown zero, clone zero, coverage 100%, complexity/Halstead/CRAP bounds, surviving mutants zero). The conformance file itself has no `any`, no `unknown`, and every unit below cyclomatic/cognitive 22 by the pinned analyzer; the campaign-wide receipt remains #945's.

## I09 deletion receipt synchronization

The A-row domain deletions below pass their exact production grep at the verified source. No production deletion is attributed to #948. [SLOP.md](SLOP.md) also records two archival-only semantic matches and three still-exported #944 G-CH9 callback types; those expanded acceptance gaps are not labeled zero. Exact identifiers and commands stay outside the active-contract grep surface.

| Rows | Disposition | Merged evidence |
| --- | --- | --- |
| A1, A2, A5 | Dormant transcript persistence, unused surface claim, and runtime integration client removed. The live ephemeral transcript fold survives. | #944 / PR #963, `b44cd76e` |
| A9 | Historical test-only export list was already zero; no invented deletion. The #948 source-pin empty-baseline Knip run reported twelve workspaces, zero issues. This is not proof of #945's stricter production-consumer census. | #944 / PR #963; current gate receipt in SLOP.md |
| A13 | Old task-ticket/completion domain, tools, schemas, and stores deleted. Later owner-schema correction consumed through #967. Generic provider-attempt history is unrelated and remains. | #940 / PR #960, `6c5d65d6`; PR #977, `eec7f7fc` |
| A14 | Built-in curated stores, mutation tool, config, and prompt injection removed without replacement. Local user files are not migrated by this docs update. | #941 / PR #958, `d35cdd39` |
| A15 | Blob store/schema/adapter/tools and spill removed; distinct model/cell output handling survives. | #942 / PR #959, `7edfe5d2` |
| A4, A16 | Dialogue-window, send-permission, and engagement domain stores/schemas/tools removed. Ordinary gateway send remains; #969 moves waiting to original-action request state. | #943 / PR #961, `23ad4f6b` |

Historical migrations remain immutable. The migration runner applies both 0030 deletion migrations, 0032's guarded dormant-table drops, 0033's session-handle lift, 0034's archive disposition, 0035's guarded retired-table deletion, 0036's reply-grant projection, and 0037's watch-alarm state. Source-level grep-zero does not mean that every historical identifier or every retained archival byte is gone.

## #937 and #967: merged corrections versus remaining retention

PR #985 (`c4fb7748`) completes session-loop convergence after #980: three inbox drains surround each model step/tool wave, then compaction and captured stop policy run. Approval covers the whole wave; positional results, sequential barriers, and live raw-effect lease retention remain. Visible text/tool output forbids provider replay. Missing/changed captured executable catalogs fail closed; crash-open recovery keeps captured IDs/generations, while terminal resume starts new ones. The #946 cutover replaces the earlier worker transport with session inbox messages.

The #967 corrections are merged: subprotocol-only authentication (#974), legacy session authority deletion (#975), unused fact-tap removal (#976), and native archive/retired-owner disposition (#977/#978). GitHub currently marks #967 closed. This document does not infer physical data deletion from that label: `message` and `part` remain in the source schema; #969 retains terminal waiting/approval records only in immutable archival tables; canonical history is written as actions.

The archive CLI creates a native SQLite image plus a v2 all-table receipt at explicit paths. Verification restores a temporary copy rather than opening the operator archive writable. `--dispose-967 --approve-manifest-sha256` revalidates the archive/receipt/source before guarded migration `0034_u967_archive_disposition`, in the migration transaction. Eligible retired Wait projections and archived bus rows are removed only with approval; the empty bus table is dropped. Ordinary boot does not archive implicitly. Message/part retention is not a DROP receipt and remains a final-convergence consideration for #945/#948, even though #937 is now merged.

## Census and final quality: current versus required

**#1116 lean PR gate (2026-09-20):** the per-PR Quality ratchet stack (census
legs, exact statement evidence, coverage ratchets, metrics/clone legs, their
receipts and the `quality-baseline-lcov-bound`/`coverage-baseline` fragments)
is deleted. PR admission is build, types, lint (including cognitive-complexity
max 21), dependency rules, tests, and the diff-scoped patch-coverage gate
(`script/check-patch-coverage.ts`); deep audits run in the scheduled
`quality-mutation.yml` workflow only. The #945 absolute-distance receipt in
[SLOP](SLOP.md#945-absolute-census-receipt-2026-09-19-main-f5ea0e32) remains
the record of quality debt at its measurement HEAD; a green lean gate makes no
claim about it.

| Gate/row | Current evidence | Not established |
| --- | --- | --- |
| Export ratchet / A9 | `script/check-dead-exports.ts`, empty `script/conformance/knip-baseline.json`, package-entry export scan and synthetic Knip discrimination test are wired into CI. | Benchmark/test/barrel/adapter-only references are not yet comprehensively excluded as #945 requires. |
| Event pairing | `script/conformance/protocol-event-pairing.test.ts` checks declared start/terminal vocabulary. | This is not a declaration-to-production-publisher census. |
| Ledger producers | `script/ledger-producer-manifest.ts` and its drift test enumerate current append/SQL writers. | This is not an all-store production read/write consumer census. |
| E3 | No new fixture code or prose snapshots in this docs patch. | Reproducible separate production/test clone-zero receipts remain #945 work. |
| E4 | Required by the Owner-approved #945 amendment; **not parked**. | Explicit/implicit TypeScript any type0 and unknown type0, with no boundary exemption. |
| E5 | Script tests and the per-PR patch-coverage gate exist (#1116 deleted the script coverage ratchet lane). | Campaign-wide coverage100%, complexity and mutation guarantees, including the gates themselves. |
| E7 | Runtime prompt has no deleted injection or tool instruction; structural assembly assertions already exist. | `apps/openomni/test/prompt.test.ts` still pins code-mode prose. E7 is not closed by a documentation-only PR; a negative signature/sentinel mutation gate is not claimed shipped. |

#945 remains open. Its acceptance also requires cyclomatic<22, cognitive<22, Halstead difficulty<80, CRAP<25, surviving mutants0, frozen analyzer versions/inventory/settings/coverage dimensions/operators, and full scheduled/final-convergence mutation execution. A passing ratchet or lint command does not establish any of those absent receipts. Local verification results, including pre-existing failures, are recorded in [SLOP.md](SLOP.md); no zero-failure campaign receipt is claimed.

## Parked and otherwise unimplemented

- [#950](https://github.com/INONONO66/openomni/issues/950) remains `icebox`, outside #930, superseding closed [#811](https://github.com/INONONO66/openomni/issues/811). It owns machine-offer isolation capability/fail-closed execution and the gateway egress secret gate. Kernel trust-boundary placement does not decide sandbox profiles or scanner semantics. Re-triage follows #938/#939 and #946; all three are open at verification. No sandbox/scanner implementation is included here.
- #949 stays open after stage 3, which landed `eval.op = run | peek | stop` over a background cell registry, `completion` options, and tool-named codemode handle methods for the five operations the machine wire carries (`read/write/ls/bash/eval`). Not landed: the `edit`, `find` and `grep` handle methods from the Owner amendment. Those tools are compositions the app tool layer builds over `read/write/list/stat` (`apps/openomni/src/tools/{edit,find,grep}.ts` on `core/filesystem.ts`); `@openomni/codemode` sits below that layer and the wire has no such op, so offering them in the cell without duplicating the tools means hoisting that composition into a package both can import. Until then the handle set is the five above and a cell reaches the other three through `tool.edit/find/grep()` proxies. Continuous alarm scheduling stays #947; #969 acceptance uses the behavioral and deletion receipts above, not only its census; machine handles and codemode are described above.
- Connector definitions and installation schemas are not an installed connector execution host. The dormant installation store is deleted.
- Governor/Jester/Voice, Stakes and effective-authority target consumers, dynamic reactive composition, and any later memory/search redesign are not promoted to shipped by retained design prose.
