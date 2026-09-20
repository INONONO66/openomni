# PROJECT KNOWLEDGE BASE

Verified against merged `c4fb774869fb060859bbdc2f58ce37ee3a3072c9` (PR #985), 2026-09-06. Resident and native workers share the session-owned loop; legacy session CRUD/TTL and the I09 deletion surfaces are absent. Native archive confirmation and guarded migration 0034 are wired; physical message/part retention remains. #969 ownership updated on `kernel/969-delegation-inbox`, 2026-09-07: original-action requests replace independent waiting/approval authority; guarded 0038 retains terminal legacy rows in immutable archives. Integration and final quality gates are not claimed complete. Deletion and outstanding quality receipts: `docs/SLOP.md`. Keep this stamp current when editing (doc-state sync law). #945 absolute census recorded on `q945/closure-receipt-20260919` (2026-09-19, main `f5ea0e32`): ratchet green is no-growth only; 60,509 baseline rows remain, literal-zero DoD not met (`docs/SLOP.md`). Gateway transport wiring verified on `feat/desktop-gateway-transport` (2026-09-06): the endpoint is resolved in Electron main from env and reaches the renderer over one `contextBridge` call. `docs/kernel-references.md` owns kernel source pins on `kernel/s0-evidence-gate` as of 2026-09-18. Policy/ledger ownership updated on `kernel/s1-authority-cut-2`, 2026-09-18: G002 (#930) deletes the unused composition schema and adds narrow app reads over the action hash chain and decision facts. G003 (`kernel/s1-durable-spine`, 2026-09-18, #930) makes provider retries durable `retry.scheduled` alarms consumed via the fenced cancel CAS, commits the compaction boundary atomically before publication, and records commit-time fence rejection as the `rejected` crash-matrix class.

Machine/codemode ownership updated on `kernel/949-tools-catalog` (2026-09-06), based on `f9c02a66`: raw WHERE handles, injected code runner, two-boundary authority, and production machine attach composition. Stage 1 added locus-aware path tools and bash and deleted the target-selection workspace; stage 2 (`239b4273`, 2026-09-08) sealed the twelve-tool catalog and removed the legacy entries, including the separate `approval` tool. Hygiene sweep on `chore/slop-hygiene-20260920` (2026-09-20, main `84704df2`): the quality baseline dropped 1,830 rows for 38 deleted files (60,509 -> 58,679); `docs/SLOP.md` §H records the sweep findings.

Desktop/ui ownership updated on `feat/desktop-tabs` (2026-09-07; `docs/desktop-shell.md`, receipts in `.omo/reports/desktop-tabs-20260907/impl-{A,B,C,D}.md`; native QA and full integration gates not claimed complete): one TanStack Store owns tab-local places/history and sessions/drafts; Electron Menu commands cross a value-only preload subscription, installed once per App mount. App owns Sessions list, explicit-open dedupe, search invocation/reveal, prompt-earned titles and window-lifetime Chat cache. Server state remains one TanStack Query gateway endpoint. No mock data or kernel imports. `packages/ui` exposes generic Console/ConsoleContent transcript presentation, exports only real desktop consumers, and stamps every UI address from `src/names.ts`.

Policy ownership updated on `kernel/s1-authority-cut-2` (2026-09-18): the unconsumed general effect-composition implementation and its 29 tests were removed in PR #1030, not replaced. Compiled-row and permission evaluation remain; `Policy.EffectiveDecision` was deleted in G002 (#930). See `docs/implementation-status.md`.

Desktop internals cleanup on `refactor/desktop-cleanup` (PR #1047): `state/selectors.ts` owns the session index and read-only derivations, `state/session-actions.ts` owns the session mutations, and `chat/session-content.tsx` binds SDK content while App keeps Chat ownership. Whole-store render/clock cadence, hook order, preference writes, preload validation, the desktop bridge, `SessionRow`, turn-cost mapping and UI contracts are unchanged. No development global is exposed. File inventory: `docs/desktop-shell.md`.

## OVERVIEW

Benchmark admission updated on `fix/benchmark-paired-reference-20260914`,
2026-09-14: every event measures the latest accepted SHA and head on one runner
in alternating serial order, with separate frozen dependencies and canonical
14-metric summaries. The sole 20% gate uses a fresh one-reference history (zero
historical noise band); only passing main push/dispatch runs publish original
head timings. Raw paired observations and hashed provenance remain artifacts.
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
protocol <- ipc, ledger, policy, llm, agent, machines, codemode, channels, apps/openomni, apps/desktop
ipc <- machines, apps/openomni
ledger <- agent, channels, apps/openomni
policy <- agent, channels, apps/openomni
llm <- agent, apps/openomni
agent <- channels, apps/openomni
machines <- codemode, apps/openomni
codemode <- apps/openomni
channels <- apps/openomni
ui <- apps/desktop
```

| Workspace | May depend on |
| --- | --- |
| `protocol` | none |
| `ipc` | protocol |
| `ledger` | protocol |
| `policy` | protocol |
| `llm` | protocol |
| `agent` | protocol, ledger, policy, llm; `src/` may depend on protocol, ledger, policy, llm |
| `machines` | protocol, ipc |
| `codemode` | protocol, machines |
| `channels` | protocol, policy, ledger, agent; `src/` may depend on protocol, policy, ledger |
| `apps/openomni` | protocol, channels, ipc, agent, llm, ledger, policy, machines, codemode |
| `ui` | none |
| `apps/desktop` | protocol, ui |
<!-- END GENERATED TOPOLOGY -->

`script/check-deps.ts` is the executable contract. Product meaning is composed in `apps/openomni`; core packages remain independently consumable primitives.

## PACKAGE OWNERSHIP

| Package | Owns | Must not own |
| --- | --- | --- |
| `packages/protocol` | Schemas, wire contracts, pure folds | I/O, storage, product decisions |
| `packages/policy` | Generic policy evaluation | Product-specific authority |
| `packages/agent/src/observation` | Bus and scoped observation | Durable or decision state |
| `packages/ledger` | Durable stores, action hash chain, decision facts | Routing and authority decisions |
| `packages/llm` | Provider behavior and model accounting | Product routing or tools |
| `packages/agent` | Generic durable-session mechanics over ledger facts, stateless loop, and compaction | Product-specific session identity, routing, or lifecycle policy |
| `packages/ipc` | Framing and bidirectional transport | Run semantics or authorization |
| `packages/machines` | Machine attachment, confined fs, exec and injected code wire | Interpreter internals, enrollment policy or product judgment |
| `packages/codemode` | Code facade, machine object handles, per-tenant interpreter and call routing | Kernel policy, ledger, model rendering |
| `packages/channels` | Drivers plus perimeter routing, physical request correlation, and admission | Session content or product execution |
| `apps/openomni` | Product composition: Resident, gateway, delegation, code mode, boot/shutdown | Reimplementation of package primitives |
| `apps/desktop` | Electron shell: main/preload/renderer build pipeline, window security defaults, the gateway endpoint resolved from env in main and handed to the renderer over one `contextBridge` call; AI SDK chat state and the gateway transport; client state in one TanStack `Store` (`state/store.ts`: sessions, tabs with strictly local history, active id, retained closed snapshots, collapsed project groups, per-session drafts) read through `useStore` selectors, and server state through TanStack Query (`state/queries.ts` mints every key; the only query is the gateway endpoint — the wire has no session-list method yet); native Menu → value-only preload → one disposed App subscription; app-owned places/icons, kind-grouped Sessions list, prompt-title lifecycle, search invocation/reveal, attention ordering and App-lifetime Chat cache; no mock data of any kind. Desktop owns the unified SessionCard state, phase-to-glyph mapping, and pinned/demand/report/residue/watch/rest attention kinds. | Kernel logic; anything beyond protocol contracts; **transcript presentation — that is `packages/ui`'s** |
| `packages/ui` | The renderer's UI package: tokens (`src/styles.css`), primitives, window chrome, the transcript's presentation (timeline, the three voices, tool rows and their folding, the composer, the approval tray), and the stable `Console` frame with generic `ConsoleContent`/`transcript` composition; `src/index.ts` exports only what apps/desktop imports, and `src/names.ts` is the single owner of every `data-ui` address. StatusGlyph owns generic tone/shape presentation and reference palette status tokens, never session phases. | Application places, project/session resolution, kernel logic or state policy. Touched Console contracts use generic transcript records; the lower-level Timeline sessionId adapter remains a legacy boundary |

## WHERE TO LOOK

| Task | Location |
| --- | --- |
| Shared schema or event | `packages/protocol/src/` |
| Session/store behavior | `packages/ledger/src/` |
| Policy mechanism | `packages/policy/src/` |
| Session loop, executor, and compaction | `packages/agent/src/session-chat-runner.ts`, `packages/agent/src/core/`, `packages/agent/src/executor.ts`, `packages/agent/src/compaction/` |
| Channel driver or perimeter route | `packages/channels/src/` |
| Raw machine endpoints | `packages/machines/src/` |
| Code mode and injected interpreter | `packages/codemode/src/` |
| Resident and app composition | `apps/openomni/src/resident.ts`, `apps/openomni/src/index.ts` |
| Production compaction strategy | `apps/openomni/src/compaction/`, `packages/agent/src/compaction/` |
| Gateway and channel registration | `apps/openomni/src/gateway.ts`, `apps/openomni/src/channels.ts` |
| Delegation lifecycle and transports | `apps/openomni/src/delegation/` |
| Product tools and provisioning | `apps/openomni/src/tools/`, `apps/openomni/src/tools/mutation/provision.ts` |
| Shipped-state truth | `docs/implementation-status.md` |
| Conformance/ratchets | `script/`, `script/conformance/` |

## CONVENTIONS

- ESM, strict TypeScript, Zod-first shared contracts, namespace-style public APIs.
- One enforcement layer per invariant; durable writes fail closed. Machine effects enter captured kernel `tool.pre` and daemon negotiated/offered capability/export enforcement; no app VFS policy layer.
- No deep package imports. Driver-band code stays on published protocol/IPC contracts.
- Product vocabulary avoids new `runtime`, `task`, and `envelope` nouns in protocol surfaces.
- Tests must use exact state/event completion rather than timing sleeps; behavior-sensitive failure paths must assert typed errors or messages.
- Baseline shrinkage is autonomous; baseline growth requires Owner sign-off.
- Reconcile before deletion and update implementation docs in the same PR.

## COMMANDS

CI selection and verification wiring inspected at `c4fb7748` (includes PR #983),
2026-09-06. See `docs/ci.md` for dependency-aware PR lanes, full runs, and
fail-closed completion checks. Use Bun 1.4.1 as pinned in `package.json`;
alarm monitoring requires Bun >=1.4.0 for built-in PTY support.

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
bun run script/verify-ledger-rename.ts
bun run script/check-ledger-schema-drift.ts
bun test --timeout 15000

# PR patch-coverage gate (#1116): changed executable lines must be covered by
# the lane lcov evidence. Locally, point --glob at fresh coverage output:
bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'

# Scheduled/manual deep audit entry points (quality-mutation.yml, never per PR):
bun run script/check-quality-python.ts
bun run script/quality-native-mutation.ts --base origin/main --baseline script/conformance/quality-baseline-mutation.json

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
`quality-mutation.yml` runs `run-quality-mutations.ts`, which requires a
complete campaign receipt, including restoration and cleanup proof.

## NOTES

- `apps/openomni` is the kernel composition root. `apps/desktop` owns Electron and AI SDK chat state and imports `packages/ui`; its dependency band permits `protocol` and `ui`, not kernel implementation packages. It speaks to the daemon over the gateway's WebSocket rather than importing it: main resolves `OPENOMNI_WS_URL`, else `ws://127.0.0.1:<OPENOMNI_WS_PORT or 3000>/ws`, and `OPENOMNI_WS_TOKEN`, with the port default and the `/ws` path copied as literals from `apps/openomni/src/config.ts` and `apps/openomni/src/index.ts` and the source named at each — the dependency the console must not take is the reason the copy exists.
- `packages/channels` is the perimeter gateway; `apps/openomni` injects delivery and observation ports. Conversation windows, send leases, and engagement lifecycles were removed in issue #943; ordinary sends use grants, egress budgets, idempotency, and physical request correlation.
- `packages/agent` coordinates generic session handles through `SessionHandleStore`; `packages/ledger` owns the durable facts, while product-specific session identity, routing, and lifecycle policy remain in `apps/openomni`.
- Shipped-state claims, including Stakes, effective authority, and connector consumers, belong only in `docs/implementation-status.md`; other docs define target contracts or historical context and defer to it.
- CI lives in `.github/workflows/ci.yml`; its Ultracite check is `bunx ultracite check --formatter-enabled=false .` (formatting disabled). Full formatting checks use `bunx ultracite check .`; the pinned baseline has existing formatter failures, recorded in `docs/SLOP.md`.
- #945 is a campaign ratchet, not a zero-quality closure claim. Named publisher/export/store measurements and type, complexity, clone, coverage, and scheduled mutation gates are separate from final zero at #973. E4 is required, not parked; #950 alone parks sandbox/egress hardening outside #930.
