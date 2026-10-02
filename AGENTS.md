# PROJECT KNOWLEDGE BASE

#1249 (epic #1260) on `epic1260/1249-bus-pubsub` (2026-10-02, base `d34218c6`, ⏳ pending merge): observation bus on Effect PubSub/Stream — `packages/agent/src/session/bus.ts` exposes `makeObservationBus` (one unbounded PubSub per owning Scope; synchronous lossy nonblocking publication via `PubSub.publishUnsafe`; subscribers are Streams or FiberSet-forked callback drains interrupted at Scope closure, so overlapping generations unsubscribe independently) and `observationBusLayer` over the kernel `ObservationSink`; the app owns the root bus as a runtime-lifetime Layer (`apps/openomni/src/runtime.ts`) and one bus per generation Scope with a publish-gating finalizer (`apps/openomni/src/composition/generation-layers.ts`); a throwing callback subscriber logs a typed `ObservationSubscriberFailure` on its own fiber and never blocks publication; `createObservationBus`/`withIsolation`/the bus microtask hops/the AsyncLocalStorage isolation store are deleted (grep zero) and test bus fixtures are PubSub-backed through each package's named runner owner; receipt in `docs/implementation-status.md`. #1248 (epic #1260) on `epic1260/1248-channels-effect` (2026-10-02, base `0ebef4b0` rebased onto `9b4e4b8c`, merged as `d34218c6` (PR #1267)): channel timing on Effect — drivers compose Effect Schedule/Fiber/Deferred programs on an injected `EffectRunner` port (app binds `runAppEffect`); one jittered exponential-to-60s reconnect policy with a 10-attempt bound (`packages/channels/src/support/schedule.ts`), one interruptible retry streak per close in the socket shell (stop() interrupts mid-backoff; exhaustion is a typed dead shell), Telegram poll loop and Discord heartbeat as clock-driven Effect loops, fetch retry via `Effect.retry` with 429 retry-after, process reply wait via `Effect.timeoutOrElse`, uncertain sends publish an Owner-visible unknown notice and are never resent; `setTimeout`/`setInterval`/`new Promise`/`calculateBackoff` grep zero in channels src; TestClock-driven suites replace timing-luck tests. #1250 (epic #1260) on `epic1260/1250-ai-7` (2026-10-02, base `0ebef4b0`, merged as `9b4e4b8c` (PR #1265)): model and desktop unified on AI SDK 7 — `packages/agent` and `apps/openomni` pin `ai@7.0.93` with provider majors 4 (`@ai-sdk/anthropic@4.0.49`, `@ai-sdk/openai@4.0.60`), `isStepCount` replaces the v6 stop-condition name, the system prompt crosses as `instructions`, accounting reads nested `inputTokenDetails`/`outputTokenDetails`, one shared 7-signature ai test mock, `maxRetries: 0` kept and SDK retries/approval/runtime context/default gateway stay off; desktop pins untouched. #1246 (epic #1260 P4) on `epic1260/1246-packages-10-5` (2026-10-02, merged as `0ebef4b0` (PR #1264)): ten packages merged into five — ipc+codemode fold into `packages/machines/src/{ipc,codemode}/`, policy/ledger/llm fold into `packages/agent/src/{kernel/gate,store,model}/`, channel-facing stores move to `packages/channels/src/store/`; one root barrel per package, `AgentFailure`/`MachinesFailure` the surviving untyped-cause carriers, `script/topology.ts` + check-deps S8 bands gate the channels→agent perimeter; retired package names grep to zero; receipt in `docs/implementation-status.md` and `docs/SLOP.md` §K. #1245 (epic #1260 P3) on `epic1260/1245-inject-clock-entropy` (2026-10-01, base `a4478b0e`, merged as `c1d5ebd2` (PR #1263)): ambient time/entropy/environment reads replaced by injection — Effect `Clock` plus the agent `Entropy` service (`packages/agent/src/core/entropy.ts`; the custom agent Clock service is deleted) in Effect code, required inline `now`/`id`/`random` function options with no fallback defaults in Promise-side packages, `process.env` confined to `apps/openomni/src/config.ts`, `apps/openomni/src/cli/env-file.ts` and `packages/llm/src/model/loader.ts` (desktop env pinned once via `bootstrap(process)` → `resolveDesktopConfig`; renderer entropy/clock bound once via `createPlatform`), and seven permissive defaults replaced by typed outcomes (unknown-provenance mail runs `evidence_only` with a violation fact, keyless websocket frames are refused `missing_key`, refused drains surface a typed `admission`); receipt in `docs/implementation-status.md` and `docs/SLOP.md` §K. #1244 (epic #1260 P2) on `epic1260/1244-typed-failures` (2026-10-01, base `fb709568`, ⏳ pending merge): `ForeignFailure` replaced by seven package-owned `*Failure` classes, refusals fail typed and invariants `Effect.die`, bare `throw new Error` zero in production, thin `APIError{cause: APICallError}` in llm, ipc/ledger/agent console logging replaced by typed ports and `Effect.log*`; receipt in `docs/implementation-status.md` and `docs/SLOP.md` §K. #1243 (epic #1260 P1) on `epic1260/1243-shared-helpers` (2026-10-01, base `5641cff8`, ⏳ pending merge): one JSON wire parser `parseJson` and one abort-listener owner `listenForAbort` in `packages/protocol`, one Cause fold `Failure.of`/`fromCause` plus `onAbort`/`interruptOn` in `packages/agent`, a one-expression machines connector, listener sets replaced by `Deferred`, and every `concurrency: "unbounded"` bounded; receipt in `docs/implementation-status.md` and `docs/SLOP.md` §K. Quality-debt sweep on `quality/1237-sweep-20260929` (2026-09-29, base `f7e36984`, merged as `5641cff8`, PR #1241): every applicable finding of Quality Audit run 36416999469 (issues #1126..#1237) fixed in one PR; `docs/SLOP.md` §J is the receipt and the "Honest audit deltas" table in `docs/implementation-status.md` carries the measured totals. W5.3 (#1113) closure on `kernel/1113-w5-closure-20260929` (2026-09-29, draft PR #1240, ⏳ pending merge): effect-runner allowlist `[]` with one named test-runner owner per package, written `any`/`unknown` type keywords 0 gated by `script/check-written-types.ts`, one app-owned `session_read` read model (`packages/protocol/src/gateway/session-read.ts` DTOs, `apps/openomni/src/gateway.ts` surface) with bounded inspection, the additive `session_bound` frame (accepted receipts keep their frozen base shape) and `reported|estimated|unknown` usage provenance, the #1049 mutation-baseline compiler fix, and the W4 #1112 duplicate-owner disposition; receipts under `.omo/reports/kernel-campaign-w53/`. W5.2 (#1197) session entity merged as `8390912c` (PR #1239, 2026-09-29) on `kernel/1197-session-entity-20260928`: one `effect/cluster` `SingleRunner` entity per session, one fresh-schema SQLite file per session plus a catalog, activation-scoped fence rotation, entity mailbox admission, and `DeliverAt` timers; the former lease/alarm/inbox/migration planes are deleted to grep-zero. W5.0 (#1195) pinned Effect `4.0.0-rc.118` exactly on `kernel/1195-effect-v4-pin-20260928` (PR #1198): zero behavior change, boundary law and runner-site ratchet unchanged (233 sites / 224 allowlist entries), no cluster imports. W3 (#1111) merged as `75d28562` (PR #1193, 2026-09-26): single ledger policy-generation writer (compiler `append: () => false` deleted), executor dispatch table with captured toolsGeneration, ToolCatalog Layer built once per generation with tools/** effect-free and sealed 12-tool catalog, and typed evidence-only authority with OBSERVATION prose prefix deleted. W0.5 (#1184) Layer/bundle wiring was inspected on `kernel/1184-consumed-layers-20260924`, 2026-09-24. Keep this stamp current when editing (doc-state sync law).
#1247 (epic #1260 P5) on `epic1260/1247-agent-dirs` (2026-10-02, base `9b4e4b8c`, merged as `a5ee6c4d` (PR #1266)): `packages/agent` reorganized by responsibility into exactly seven source directories (`kernel/`, `session/`, `store/`, `model/`, `plugins/`, `inspect/`, `testing/`) plus `index.ts` exporting seven namespaces (`Kernel`, `Session`, `Bundle`, `Journal`, `Model`, `Inspect`, `Testing`) and the nine-name pinned S8 named-export perimeter for channels; Timer→Alarm and lease→fence on TS surfaces (durable `lease_owner`/`lease_fence` bytes unchanged), the old flat controller module and `core/settled.ts` deleted, the session registry and `requireCommit` test-only under `testing/`; check-deps bands ratchet intra-agent imports shrink-only. Owner-accepted deviations (PR #1266 comment): `kernel/` is 6,090 LOC and the band baseline is 36 violations/15 files; receipt in `docs/implementation-status.md`. #1250 (epic #1260) on `epic1260/1250-ai-7` (2026-10-02, base `0ebef4b0`, merged as `9b4e4b8c` (PR #1265)): model and desktop unified on AI SDK 7 — `packages/agent` and `apps/openomni` pin `ai@7.0.93` with provider majors 4 (`@ai-sdk/anthropic@4.0.49`, `@ai-sdk/openai@4.0.60`), `isStepCount` replaces the v6 stop-condition name, the system prompt crosses as `instructions`, accounting reads nested `inputTokenDetails`/`outputTokenDetails`, one shared 7-signature ai test mock, `maxRetries: 0` kept and SDK retries/approval/runtime context/default gateway stay off; desktop pins untouched. #1246 (epic #1260 P4) on `epic1260/1246-packages-10-5` (2026-10-02, merged as `0ebef4b0` (PR #1264)): ten packages merged into five — ipc+codemode fold into `packages/machines/src/{ipc,codemode}/`, policy/ledger/llm fold into `packages/agent/src/{kernel/gate,store,model}/`, channel-facing stores move to `packages/channels/src/store/`; one root barrel per package, `AgentFailure`/`MachinesFailure` the surviving untyped-cause carriers, `script/topology.ts` + check-deps S8 bands gate the channels→agent perimeter; retired package names grep to zero; receipt in `docs/implementation-status.md` and `docs/SLOP.md` §K. #1245 (epic #1260 P3) on `epic1260/1245-inject-clock-entropy` (2026-10-01, base `a4478b0e`, merged as `c1d5ebd2` (PR #1263)): ambient time/entropy/environment reads replaced by injection — Effect `Clock` plus the agent `Entropy` service (`packages/agent/src/core/entropy.ts`, since #1247 `packages/agent/src/kernel/ports.ts`; the custom agent Clock service is deleted) in Effect code, required inline `now`/`id`/`random` function options with no fallback defaults in Promise-side packages, `process.env` confined to `apps/openomni/src/config.ts`, `apps/openomni/src/cli/env-file.ts` and `packages/llm/src/model/loader.ts` (desktop env pinned once via `bootstrap(process)` → `resolveDesktopConfig`; renderer entropy/clock bound once via `createPlatform`), and seven permissive defaults replaced by typed outcomes (unknown-provenance mail runs `evidence_only` with a violation fact, keyless websocket frames are refused `missing_key`, refused drains surface a typed `admission`); receipt in `docs/implementation-status.md` and `docs/SLOP.md` §K. #1244 (epic #1260 P2) on `epic1260/1244-typed-failures` (2026-10-01, base `fb709568`, ⏳ pending merge): `ForeignFailure` replaced by seven package-owned `*Failure` classes, refusals fail typed and invariants `Effect.die`, bare `throw new Error` zero in production, thin `APIError{cause: APICallError}` in llm, ipc/ledger/agent console logging replaced by typed ports and `Effect.log*`; receipt in `docs/implementation-status.md` and `docs/SLOP.md` §K. #1243 (epic #1260 P1) on `epic1260/1243-shared-helpers` (2026-10-01, base `5641cff8`, ⏳ pending merge): one JSON wire parser `parseJson` and one abort-listener owner `listenForAbort` in `packages/protocol`, one Cause fold `Failure.of`/`fromCause` plus `onAbort`/`interruptOn` in `packages/agent`, a one-expression machines connector, listener sets replaced by `Deferred`, and every `concurrency: "unbounded"` bounded; receipt in `docs/implementation-status.md` and `docs/SLOP.md` §K. Quality-debt sweep on `quality/1237-sweep-20260929` (2026-09-29, base `f7e36984`, merged as `5641cff8`, PR #1241): every applicable finding of Quality Audit run 36416999469 (issues #1126..#1237) fixed in one PR; `docs/SLOP.md` §J is the receipt and the "Honest audit deltas" table in `docs/implementation-status.md` carries the measured totals. W5.3 (#1113) closure on `kernel/1113-w5-closure-20260929` (2026-09-29, draft PR #1240, ⏳ pending merge): effect-runner allowlist `[]` with one named test-runner owner per package, written `any`/`unknown` type keywords 0 gated by `script/check-written-types.ts`, one app-owned `session_read` read model (`packages/protocol/src/gateway/session-read.ts` DTOs, `apps/openomni/src/gateway.ts` surface) with bounded inspection, the additive `session_bound` frame (accepted receipts keep their frozen base shape) and `reported|estimated|unknown` usage provenance, the #1049 mutation-baseline compiler fix, and the W4 #1112 duplicate-owner disposition; receipts under `.omo/reports/kernel-campaign-w53/`. W5.2 (#1197) session entity merged as `8390912c` (PR #1239, 2026-09-29) on `kernel/1197-session-entity-20260928`: one `effect/cluster` `SingleRunner` entity per session, one fresh-schema SQLite file per session plus a catalog, activation-scoped fence rotation, entity mailbox admission, and `DeliverAt` timers; the former lease/alarm/inbox/migration planes are deleted to grep-zero. W5.0 (#1195) pinned Effect `4.0.0-rc.118` exactly on `kernel/1195-effect-v4-pin-20260928` (PR #1198): zero behavior change, boundary law and runner-site ratchet unchanged (233 sites / 224 allowlist entries), no cluster imports. W3 (#1111) merged as `75d28562` (PR #1193, 2026-09-26): single ledger policy-generation writer (compiler `append: () => false` deleted), executor dispatch table with captured toolsGeneration, ToolCatalog Layer built once per generation with tools/** effect-free and sealed 12-tool catalog, and typed evidence-only authority with OBSERVATION prose prefix deleted. W0.5 (#1184) Layer/bundle wiring was inspected on `kernel/1184-consumed-layers-20260924`, 2026-09-24. Keep this stamp current when editing (doc-state sync law).

W5.2 supersedes the historical archive-migration boot path: the new catalog and per-session files use fresh schemas, and old database files remain untouched rather than read, migrated, or deleted. Original-action request ownership from #969 remains, but mailbox consumption now occurs inside the entity. Integration, full CI, patch coverage, and mutation are not claimed complete; see `docs/implementation-status.md` and `docs/SLOP.md`. #945 absolute census recorded on `q945/closure-receipt-20260919` (2026-09-19, main `f5ea0e32`): ratchet green is no-growth only; 60,509 baseline rows remain, literal-zero DoD not met. Gateway transport wiring verified on `feat/desktop-gateway-transport` (2026-09-06): Electron main resolves the endpoint and exposes it to the renderer over one `contextBridge` call. `docs/kernel-references.md` owns kernel source pins. G002 (#930) retains narrow app reads over the action hash chain and decision facts. G003's durable `retry.scheduled` action and W1's residual-delay restart behavior remain, but W5.2 now delivers them through chain-guarded `DeliverAt` entity messages. W2's declared-only channel provisioning and `sent | not_sent | unknown` adapter facts remain; its former transaction-local timing row was removed with the old persistence plane.

Machine/codemode ownership updated on `kernel/949-tools-catalog` (2026-09-06), based on `f9c02a66`: raw WHERE handles, injected code runner, two-boundary authority, and production machine attach composition. Stage 1 added locus-aware path tools and bash and deleted the target-selection workspace; stage 2 (`239b4273`, 2026-09-08) sealed the twelve-tool catalog and removed the legacy entries, including the separate `approval` tool. Hygiene sweep on `chore/slop-hygiene-20260920` (2026-09-20, main `84704df2`): the quality baseline dropped 1,830 rows for 38 deleted files (60,509 -> 58,679); `docs/SLOP.md` §H records the sweep findings.

Desktop/ui ownership updated on `feat/desktop-tabs` (2026-09-07; `docs/desktop-shell.md`, receipts in `.omo/reports/desktop-tabs-20260907/impl-{A,B,C,D}.md`; native QA and full integration gates not claimed complete): one TanStack Store owns tab-local places/history and sessions/drafts; Electron Menu commands cross a value-only preload subscription, installed once per App mount. App owns Sessions list, explicit-open dedupe, search invocation/reveal, prompt-earned titles and window-lifetime Chat cache. Server state remains one TanStack Query gateway endpoint. No mock data or kernel imports. `packages/ui` exposes generic Console/ConsoleContent transcript presentation, exports only real desktop consumers, and stamps every UI address from `src/names.ts`.

Policy ownership updated on `kernel/s1-authority-cut-2` (2026-09-18): the unconsumed general effect-composition implementation and its 29 tests were removed in PR #1030, not replaced. Compiled-row and permission evaluation remain; `Policy.EffectiveDecision` was deleted in G002 (#930). See `docs/implementation-status.md`.

Desktop internals cleanup on `refactor/desktop-cleanup` (PR #1047): `state/selectors.ts` owns the session index and read-only derivations, `state/session-actions.ts` owns the session mutations, and `chat/session-content.tsx` binds SDK content while App keeps Chat ownership. Whole-store render/clock cadence, hook order, preference writes, preload validation, the desktop bridge, `SessionRow`, turn-cost mapping and UI contracts are unchanged. No development global is exposed. File inventory: `docs/desktop-shell.md`.

The W0.5 consumed-service contract is documented in `docs/kernel-contract.md` under “Extension points (4) and bundle contract”. Extension is through tool/system configuration, data-only policy rows with named services, observation subscriptions, and entity mailbox messages only; there is no arbitrary code-callback registration road. The composition root owns storage acquisition/release: `createAppLedger` (`apps/openomni/src/composition/cluster-runtime.ts`) opens the catalog and per-session stores, and app boot threads the entity plane explicitly (`apps/openomni/src/index.ts`).

## OVERVIEW

Benchmark admission updated on `fix/benchmark-paired-reference-20260914`: every event measures the latest accepted SHA and head on one runner in alternating serial order, with separate frozen dependencies and canonical 14-metric summaries. The sole 20% gate uses a fresh one-reference history (zero historical noise band); only passing main push/dispatch runs publish original head timings. Raw paired observations and hashed provenance remain artifacts. An Owner-applied `benchmark:accept-baseline` label lets the PR gate pass with `ACCEPTED` rows. After merge, the Owner runs `gh workflow run benchmark.yml --ref main -f accept_baseline=true` to publish the new accepted reference; scheduled runs never accept baseline resets.
See `docs/ci.md`; hosted execution and landing remain parent-owned.

Native coverage merge correction on `fix/quality-lcov-union-20260914`: executing
lanes contribute the union of observed DA lines rather than their intersection.
Saved PR #1068 receipts reproduce the lost-positive-evidence defect; regression
tests retain uncovered-line refusal and the corrected replay reports no growth.
Full-codebase zero debt and complete mutation are not established by that replay.

Native mutation throughput updated on `fix/mutation-reach-integration-20260914`:
TypeScript/JavaScript candidates share one campaign reach map and execute only
tests that reached their original sites. Unreached candidates retain `noCoverage`
without candidate test receipts; Python retains its existing probe. The 112-test
runner suite passed, but a complete mutation campaign is still outstanding.

Reach discovery corrected on `fix/mutation-reach-e2e-20260914`: green baseline
JUnit supplies the executed test files, retaining Bun's package ignore rules
without removing source or candidate inventory. Probe failures retain process
and JUnit evidence; failed reach copies are unregistered during cleanup.

Statement probes corrected on `fix/mutation-statement-probes-20260914`:
block-owned statements retain their lexical position, including `super()`
with TypeScript parameter properties. Entry markers precede overlapping
expression probes and still record calls whose base constructor throws.

Mutation compiler reuse on `perf/mutation-incremental-typecheck-20260914`:
`quality-mutation-input.ts` owns shared cold compiler/input operations;
`quality-mutation-compiler.ts` owns the persistent worker and one retained
incremental checker. Candidate proof is separate from process receipts. The
bounded project-batch implementation caps requests at eight, canonicalizes
physical execution roots, and preserves request/proof identity and fallback
ownership. The final regression run passed 129 tests across five files. A real
16-candidate non-campaign receipt completed two batches (241.7s then 120.8s),
matched cold diagnostics at indices 0, 8 and 15, and reported
`originalRestored:true`. Full campaign completion and six-hour feasibility are
not established.

OpenOmni is a single-Owner Agent OS: one Resident delegates through durable contracts and evidence, not self-report. The repository contains core packages, one deployable kernel app, and an Electron console (`apps/desktop`) with app-owned AI SDK chat state and shared UI presentation. Target contracts live in `docs/core-model.md`, `docs/kernel-contract.md`, and `docs/machines-and-delegation.md`; `docs/implementation-status.md` is authoritative for current wiring.

## STRUCTURE

```text
openomni/
├── apps/
│   ├── openomni/        # kernel app: Resident, gateway composition, machines, delegation
│   └── desktop/         # Electron console: shell/build pipeline plus app-owned AI SDK chat state
├── packages/
│   ├── protocol/        # Zod schemas and cross-package contracts
│   ├── policy/          # pure compiled-row and permission policy evaluation
│   ├── ledger/          # durable stores and journal persistence
│   ├── llm/             # provider I/O, transforms, retry, token/cost accounting
│   ├── agent/           # durable sessions, stateless runAgent loop, executor, compaction
│   ├── ipc/             # protocol-only bidirectional IPC transport
│   ├── machines/        # raw list/get/fs/exec/runCode WHERE endpoint
│   ├── codemode/        # code facade, machine handles, per-tenant interpreter runner
│   ├── channels/        # channel drivers and perimeter gateway router
│   └── ui/              # shared console presentation and design system
├── script/              # conformance and repository gates
├── turbo.json
└── package.json
```

## DEPENDENCY GRAPH

<!-- BEGIN GENERATED TOPOLOGY -->
<!-- Generated by script/generate-agents-deps.ts from script/topology.ts. Do not edit. -->

Read `X <- Y` as Y may depend on X.

```text
protocol <- agent, machines, channels, apps/openomni, apps/desktop
agent <- channels, apps/openomni
machines <- apps/openomni
channels <- apps/openomni
ui <- apps/desktop
```

| Workspace | May depend on |
| --- | --- |
| `protocol` | none |
| `agent` | protocol |
| `machines` | protocol |
| `channels` | protocol, agent |
| `apps/openomni` | protocol, channels, agent, machines |
| `ui` | none |
| `apps/desktop` | protocol, ui |
<!-- END GENERATED TOPOLOGY -->

`script/check-deps.ts` is the executable contract. Product meaning is composed in `apps/openomni`; core packages remain independently consumable primitives.

## PACKAGE OWNERSHIP

| Package | Owns | Must not own |
| --- | --- | --- |
| `packages/protocol` | Schemas, wire contracts, pure folds | I/O, storage, product decisions |
| `packages/agent` | Generic durable-session mechanics over its store facts, stateless loop, and compaction; the generic policy gate (`src/kernel/gate/`); handle-scoped catalog/session-file stores, action hash chain, decision facts, and activation fence CAS (`src/store/`); provider behavior and model accounting (`src/model/`); bus and scoped observation (`src/observation/`) | Product-specific session identity, routing, lifecycle policy, or authority decisions |
| `packages/machines` | Machine attachment, confined fs, exec and injected code wire; framing and bidirectional transport (`src/ipc/`); code facade, machine object handles, per-tenant interpreter and call routing (`src/codemode/`) | Enrollment policy, kernel policy, model rendering or product judgment |
| `packages/channels` | Drivers plus perimeter routing, physical request correlation, and admission; the channel-facing perimeter stores (`src/store/`) | Session content or product execution |
| `apps/openomni` | Product composition: Resident, gateway, delegation, code mode, boot/shutdown | Reimplementation of package primitives |
| `apps/desktop` | Electron shell: main/preload/renderer build pipeline, window security defaults, the gateway endpoint resolved from env in main and handed to the renderer over one `contextBridge` call; AI SDK chat state and the gateway transport; client state in one TanStack `Store` (`state/store.ts`: sessions, tabs with strictly local history, active id, retained closed snapshots, collapsed project groups, per-session drafts) read through `useStore` selectors, and server state through TanStack Query (`state/queries.ts` mints every key; the only query is the gateway endpoint — the wire has no session-list method yet); native Menu → value-only preload → one disposed App subscription; app-owned places/icons, kind-grouped Sessions list, prompt-title lifecycle, search invocation/reveal, attention ordering and App-lifetime Chat cache; no mock data of any kind. Desktop owns the unified SessionCard state, phase-to-glyph mapping, and pinned/demand/report/residue/watch/rest attention kinds. | Kernel logic; anything beyond protocol contracts; **transcript presentation — that is `packages/ui`'s** |
| `packages/ui` | The renderer's UI package: tokens (`src/styles.css`), primitives, window chrome, the transcript's presentation (timeline, the three voices, tool rows and their folding, the composer, the approval tray), and the stable `Console` frame with generic `ConsoleContent`/`transcript` composition; `src/index.ts` exports only what apps/desktop imports, and `src/names.ts` is the single owner of every `data-ui` address. StatusGlyph owns generic tone/shape presentation and reference palette status tokens, never session phases. | Application places, project/session resolution, kernel logic or state policy. Touched Console contracts use generic transcript records; the lower-level Timeline sessionId adapter remains a legacy boundary |

## WHERE TO LOOK

| Task | Location |
| --- | --- |
| Shared schema or event | `packages/protocol/src/` |
| Session/store behavior | `packages/agent/src/store/` |
| Policy mechanism | `packages/agent/src/kernel/gate/` |
| Model/provider behavior | `packages/agent/src/model/` |
| Session loop, executor, and compaction | `packages/agent/src/session/run.ts`, `packages/agent/src/kernel/turn.ts`, `packages/agent/src/kernel/gate/decide.ts`, `packages/agent/src/plugins/compaction/` |
| Channel driver or perimeter route | `packages/channels/src/` |
| Raw machine endpoints | `packages/machines/src/` |
| Code mode and injected interpreter | `packages/machines/src/codemode/` |
| Resident and app composition | `apps/openomni/src/resident.ts`, `apps/openomni/src/index.ts` |
| Production compaction strategy | `apps/openomni/src/compaction/`, `packages/agent/src/plugins/compaction/` |
| Gateway and channel registration | `apps/openomni/src/gateway.ts`, `apps/openomni/src/channels.ts` |
| Delegation lifecycle and transports | `apps/openomni/src/delegation/` |
| Product tools and provisioning | `apps/openomni/src/tools/`, `apps/openomni/src/tools/mutation/provision.ts` |
| Shipped-state truth | `docs/implementation-status.md` |
| Conformance/ratchets | `script/`, `script/conformance/` |

## CONVENTIONS

- ESM, strict TypeScript, Zod-first shared contracts, namespace-style public APIs.
- Effect-native runtime packages; protocol/ui/desktop/tool bodies never import effect (script/check-effect-boundaries.ts).
- One enforcement layer per invariant; durable writes fail closed. Machine effects enter captured kernel `tool.pre` and daemon negotiated/offered capability/export enforcement; no app VFS policy layer.
- No deep package imports. Driver-band code stays on published protocol/IPC contracts.
- Product vocabulary avoids new `runtime`, `task`, and `envelope` nouns in protocol surfaces.
- Tests must use exact state/event completion rather than timing sleeps; behavior-sensitive failure paths must assert typed errors or messages.
- Baseline shrinkage is autonomous; baseline growth requires Owner sign-off.
- Reconcile before deletion and update implementation docs in the same PR.

## COMMANDS

CI selection and verification wiring inspected at `c9c53af0` (PR #1117),
2026-09-20; scheduled Quality Audit added for #1116 PR B. See `docs/ci.md` for dependency-aware PR lanes, full runs, and
fail-closed completion checks. Use Bun 1.4.1 as pinned in `package.json`;
monitor source handling requires Bun >=1.4.0 for built-in PTY support.

```bash
bun install
bun run build
bun run check-types
bun run lint
bun run lint:tools
bun run script/check-topology.ts
bun run script/check-deps.ts
bun run script/check-import-cycles.ts
bun run script/check-dead-exports.ts
bun run script/verify-tsconfig-inheritance.ts
bun test --timeout 15000

# PR patch-coverage gate (#1116): changed executable lines must be covered by
# the lane lcov evidence. Locally, point --glob at fresh coverage output:
bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'

# Weekly/manual Quality Audit preview (no gh calls; missing LCOV is reported):
bun run script/quality-audit.ts --dry-run

# Separate scheduled mutation campaign (quality-mutation.yml, never per PR):
bun run script/check-quality-python.ts
gh workflow run quality-mutation.yml --ref main -f pilot_limit=0 -f shard_count=8

# Reproduce one CI test lane:
bun run ci test --lane agent
bun run ci test --lane scripts-contracts

# Sole deployable app
bun run --cwd apps/openomni dev

# Desktop console (Electron)
bun run --cwd apps/desktop dev
```

Dead-export shrinkage uses `bun run script/check-dead-exports.ts --update`.

The per-PR quality ratchet stack (census, exact statement evidence, coverage
ratchet, metrics legs) was deleted by #1116 in favor of the lean PR gate:
build, types, lint (including `noExcessiveCognitiveComplexity`), dependency
rules, tests, and the patch-coverage gate. Deep audits stay scheduled:
`quality-audit.yml` records absolute findings and capped quality-debt issues;
`quality-mutation.yml` runs `run-quality-mutations.ts`, which requires a
complete campaign receipt, including restoration and cleanup proof.

## NOTES

- `apps/openomni` is the kernel composition root. `apps/desktop` owns Electron and AI SDK chat state and imports `packages/ui`; its dependency band permits `protocol` and `ui`, not kernel implementation packages. It speaks to the daemon over the gateway's WebSocket rather than importing it: main resolves `OPENOMNI_WS_URL`, else `ws://127.0.0.1:<OPENOMNI_WS_PORT or 3000>/ws`, and `OPENOMNI_WS_TOKEN`, with the port default and the `/ws` path copied as literals from `apps/openomni/src/config.ts` and `apps/openomni/src/index.ts` and the source named at each — the dependency the console must not take is the reason the copy exists.
- `packages/channels` is the perimeter gateway; `apps/openomni` injects delivery and observation ports. Conversation windows, send leases, and engagement lifecycles were removed in issue #943; ordinary sends use grants, egress budgets, idempotency, and physical request correlation.
- `packages/agent` coordinates generic session handles through `SessionHandleStore` and owns the durable facts in `src/store/`, while product-specific session identity, routing, and lifecycle policy remain in `apps/openomni`.
- Shipped-state claims, including Stakes, effective authority, and connector consumers, belong only in `docs/implementation-status.md`; other docs define target contracts or historical context and defer to it.
- CI lives in `.github/workflows/ci.yml`; its Ultracite check is `bunx ultracite check --formatter-enabled=false .` (formatting disabled). Full formatting checks use `bunx ultracite check .`; the pinned baseline has existing formatter failures, recorded in `docs/SLOP.md`.
- #945 is a campaign ratchet, not a zero-quality closure claim. Named publisher/export/store measurements and type, complexity, clone, coverage, and scheduled mutation gates are separate from final zero at #973. E4 is required, not parked; #950 alone parks sandbox/egress hardening outside #930.
