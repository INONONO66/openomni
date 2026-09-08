# SLOP: I09 deletion and closure receipts (#948)

#969 cutover, 2026-09-07: request waiting, authenticated consent and outbound delivery now use canonical actions. The new receipt below covers the replacement; historical receipts retain their original source pins. Final HEAD and gate outputs are in the PR and local report.

#971 cutover, 2026-09-08: alarm occurrence identity, deadline and budget admission moved into the ledger's single judgment; evaluators report transport keys only. Receipt below.

#970 cutover, 2026-09-08: interrupted operations settle from classified evidence; attempt evidence, `restore_model_selection` and `restore_context_projection` are recorded actions. No store, table or schema is added or removed; the receipt at the end records what stayed in place.

#972 cutover, 2026-09-08: history and diagnostics are read projections over committed actions. `SessionHandle.history()` pages the append-only tree by revision; `SessionHandle.inspect()` derives redacted causal transitions, policy decisions, requests and compactions. No table, migration, writer or store is added; the receipt at the end names the one moved fold and the census.

Verified on 2026-09-06 against source HEAD `c4fb774869fb060859bbdc2f58ce37ee3a3072c9`, tree `0d6318c742a1ca0eeaa5ddf30003108ba8a53487`; a fresh `git fetch origin main` resolved to the same commit. This docs-only patch preserves that production tree. Final documentation commit/tree and PR URL are recorded in the local `REPORT.md` and PR body.

## Receipt location and scope

This is the tracked successor for the #948 rows formerly recorded in `.omo/reports/operation-architecture-20260902/SLOP.md`. PRs #981/#982 removed tracked agent artifacts; no `.omo/` file is recreated. Historical ledger/design text remains in git history, not an active contract. This file synchronizes the I09 rows and #811 disposition only; it does not mark unrelated historical SLOP rows closed.

The Owner-approved #945/#948 amendment overrides stale campaign labels and E4 parking. Deletion evidence, remaining quality acceptance, and the parked #950 successor are separate. This is not a zero-failure/final-convergence receipt and does not close #945 or the full #948 acceptance.

## #947 stage-1 alarm contribution (unmerged)

| Row | Receipt |
| --- | --- |
| B4 | Not closed here. Delegation source is untouched; #946 owns deletion and stage 2 wires its deadline consumer to the existing `at` alarm owner. |
| E8 | Additive `monitor` registration and strict create/rearm/cancel schema implemented; no claim about unrelated vocabulary. |
| Alarm quality | Focused 30 tests pass, including real PTY exit/dedupe, exact timeout, budget pause/rearm, path create/modify/cancel, atomic rollback, SQLite reopen, and hibernation/live-wait. |
| Path readiness correction | The same path source reconciles stat identity on the app scan; unchanged scans append nothing. The test subscribes before mutation and drives reconciliation before native callbacks can run. The previous create timeout is retained in local history, not hidden by sleeps or retries. |
| Full verification | On rebased production checkpoint `6a912340`: build, workspace/script types, dependency/cycle checks, lint, tool lint, formatter-disabled Ultracite and dead-export gates exit 0. `bun test --timeout 15000` passes 3377 tests across 359 files in one run, zero failures. |
| Coverage | All 11 coverage-producing lanes pass, then the unchanged ratchet passes: app 96.83%, agent 97.73%, ledger 99.34%; no floors lowered. |
| Real surface and mutation | WebSocket -> monitor -> real path/create -> atomic inbox -> hibernated session wake passes (two model calls, revision 59). PTY/FIFO app regression passes; removing app async-context binding fails with the expired tool-wave AbortError. |
| Tool schema | Owner-approved nested `operation` discriminates create/rearm/cancel; create nests `source`, controls require `alarmId`. `bun run lint:tools` passes under the existing field cap, with no exemption or floor reduction. |
| Lifecycle campaign | No #969-#973 transition/deletion/test receipt is consumed by stage 1. |

R1 correction evidence (after main `678d357e` merge): production checkpoint
`21675e12` passes all gates, including tool-lint self-test; 3435 tests pass in
one full-suite run, zero failures. Ten current coverage lanes and the unchanged
ratchet pass (app 97.08%, ledger 99.34%, agent 97.73%). The removed placement
lane is main's deletion, not a floor change introduced by this PR.

| Finding | Failing-first proof -> correction |
| --- | --- |
| R1 callback timeout | Three PTY line/exit/native-path tests fail before the callback deadline check; all pass with timeout precedence. No scan is triggered by those tests. |
| R2 descendants | Five real child-of-child HUP-ignoring process probes fail before group cleanup. Cancel/timeout/pause/exit/shutdown/rearm now close exact death-witness sockets and leave no live probed process. |
| R3 migration guard | Seventeen invalid historical specs formerly upgraded; each now refuses with the alarm id and byte-identical old database. Complete command/path upgrades still pass. |
| R4 reconciliation oracle | Removing source observation now fails on the synchronous inbox count before any yield; restored implementation passes. |
| R5 inferred types | Compiler test fails on untyped JSON results/catch bindings; corrected boundary files report zero. Its planted mutant still fails discrimination. No cast, suppression, exemption or baseline growth was added. |

Decisions and operator contracts: [alarm-monitor-stage-1.md](alarm-monitor-stage-1.md).

## A rows: already-absent production domains

| Rows | Target | Classification at source HEAD | Merged deletion |
| --- | --- | --- | --- |
| A1 | `TranscriptStore`, session transcript persistence and adapter | ALREADY-ABSENT; no replacement store. Live ephemeral transcript fold retained. | #944, PR #963, `b44cd76e` |
| A2 | `claimSurface` interface/implementation | ALREADY-ABSENT | #944, PR #963, `b44cd76e` |
| A5 | `McpClient`, `runtime/mcp`, runtime SDK dependency | ALREADY-ABSENT runtime/client; retained protocol vocabulary alone is not a client. | #944, PR #963, `b44cd76e` |
| A9 | Historical sixteen test-only exports | Historical no-op, not sixteen new deletions. Empty Knip baseline and current zero-issue ratchet verified; stricter production-only census remains #945. | #944, PR #963, `b44cd76e` |
| A13 | `WorkItem`/task Attempt domain, completion, stores, schemas and tools | ALREADY-ABSENT under the exact #940 grep. Semantic archival survivors below are not hidden. Provider attempt children remain live. | #940, PR #960, `6c5d65d6`; #967 correction PR #977, `eec7f7fc` |
| A14 | Curated memory, tool/config/snapshot injection | ALREADY-ABSENT, no replacement engine/port | #941, PR #958, `d35cdd39` |
| A15 | Artifact store/schema/adapter/tools and model spill | ALREADY-ABSENT; model truncation and full cell results retained | #942, PR #959, `7edfe5d2` |
| A4, A16 | Conversation/lease/engagement stores/schemas and converse/lease tools | ALREADY-ABSENT; session fencing, gateway send, grants, egress budgets and waiting retained at that historical source; replaced by original-action requests in #969 | #943, PR #961, `23ad4f6b` |

### Exact issue greps

Run from repository root. Each command below produced **zero hits, empty stdout, ripgrep exit 1** (no matches, not a tool error). The issue's exclusions are retained verbatim. No test exclusions were added to make these five original acceptance commands pass. Re-run on the final docs HEAD before opening the PR.

```bash
# #940 / A13
rg -n '(WorkItem|work_items|complete_work|work_item)' apps packages script -g '*.ts' -g '*.sql' -g '!*.test.ts' -g '!dist/**' -g '!packages/ledger/migration/**'

# #941 / A14
rg -n '(openCuratedMemory|CuratedMemory|MemoryRefusal|MEMORY_STORES|MEMORY_TOOL_NAME|createMemoryTool|memoryPath|memorySnapshot)' apps/openomni/src packages script -g '*.ts' -g '!*.test.ts' -g '!dist/**'

# #942 / A15
rg -n '(write_artifact|read_artifact|ArtifactsPort|ARTIFACTS_TOOL_NAME|createArtifactsTool|storeTextArtifact|sqlite-artifact-adapter|Artifact\.(store|get)|ArtifactSchema|export namespace Artifact|export \{ Artifact \})' apps packages script -g '*.ts' -g '!*.test.ts' -g '!dist/**'

# #943 / A4, A16
rg -n '(converse_open|converse_close|lease_open|createConverseTool|ConversePort|LeasePort|ConversationStore|LeaseStore|EngagementStore|ConversationSubAdapter|LeaseSubAdapter|EngagementSubAdapter|export namespace (Conversation|Lease|Engagement))' apps packages script -g '*.ts' -g '!*.test.ts' -g '!dist/**' -g '!packages/ledger/migration/**'

# #944 / A1, A2, A5
rg -n '(TranscriptStore|claimSurface|McpClient|runtime/mcp)' apps packages script -g '*.ts' -g '!*.test.ts' -g '!dist/**'

# #948 active contracts and runtime prompts
rg -n '(WorkItem|complete_work|work_items|converse_open|converse_close|lease_open|write_artifact|read_artifact|memorySnapshot|MCP client)' AGENTS.md docs/implementation-status.md docs/kernel-contract.md apps/openomni/src/prompt -g '*.md' -g '*.ts'

# #948 shipped schema/tool snapshots and prompt source (no exclusions)
rg -n '(WorkItem|complete_work|work_items|converse_open|converse_close|lease_open|write_artifact|read_artifact|memorySnapshot|MCP client)' script/conformance/tool-schema-snapshot.json script/conformance/schema-snapshot.json apps/openomni/src/prompt

# Deleted physical source inventory: zero paths
rg --files apps/openomni/src packages/agent/src packages/ledger/src packages/protocol/src | rg '(/(work-item|artifact|conversation|lease|engagement|memory|runtime/mcp)/|session/transcript\.ts$|sqlite-(work-item|artifact|conversation|lease|engagement|app-connector-installation|transcript-fact)-adapter\.ts$|delegation/work-item-linkage\.ts$|tools/mutation/(work-items|memory|artifacts|converse)\.ts$|provisioning/init\.ts$)'
```

### #944 expanded G-row receipt

These rows came from #944's issue comment. Partial completion is reported rather than inferred from its CLOSED label.

| Rows | Scoped check/evidence | Result |
| --- | --- | --- |
| G-P01/P02/P03/P04/P05/P08 | `rg -n '(StreamRegistry\|RouteDecided\|extractText\|ExecutionUsage\|ModelStatus\|GovernorIncident)'` using alternation as in the command below, scoped to former owners | Zero hits; aliases/helpers/events removed |
| G-L1 | Installation store/adapter symbol and deleted-path checks below | Zero hits |
| G-L4 | `cron_job` excluded from runtime reset list; only immutable migration names remain in the migration runner | Fresh schema contains no cron/installation/transcript tables; migration 0032 owns guarded removal |
| G-CH1 | Four obsolete dispatch failure-code spellings, checked with other app/ledger symbols below | Zero hits |
| G-CH4 | `rg -n '"bridge"' packages/channels/src/provider/contract.ts` | Zero hits |
| G-CH7 | Read all four provider `surface.ts` handler use sites | Handler required at start; delivery uses the captured handler directly, no second missing-handler fallback. Discord/Slack retain start guards; GitHub/Telegram use `requireHandler`. |
| G-CH8 | `rg -n 'export.*(IngestMode\|ProviderCapabilities\|ProviderRuntime\|PublishPort\|Adapter\|normalize)'` with alternation, scoped to `packages/channels/src/index.ts` | Zero hits; root now exports the live provider registry/router surface. `ProviderRuntime` inside its defining module is not a stale root export. |
| G-CH9 | Callback/option declarations in four surfaces plus gateway/socket/poller | Surface-only options are private, but **three callback interfaces remain exported**: `GatewayCallbacks` (`discord/gateway.ts:22`), `SocketCallbacks` (`slack/socket.ts:15`), `PollerCallbacks` (`telegram/poller.ts:8`). Production references are their own constructor annotations only. Un-export acceptance is incomplete; not changed in this docs-only delivery. |
| G-H1 | `rg -n 'FiberSnapshot\|snapshot\(\|pending'` with alternation in `apps/openomni/src/composition/composer.ts` | Zero hits; executable `ctx.effect` teardown registration survives, not the removed diagnostic snapshot. |
| G-H5 | Deleted-path census includes `apps/openomni/src/provisioning/init.ts` | Zero paths; app/CLI no longer expose the one-shot import. |

Executable scoped commands (all zero hits/exit 1):

```bash
rg -n '(StreamRegistry|RouteDecided|extractText|ExecutionUsage|ModelStatus|GovernorIncident)' packages/protocol/src/ledger packages/protocol/src/ingress packages/protocol/src/token packages/protocol/src/model packages/protocol/src/event/operational.ts packages/llm/src/model -g '*.ts'
rg -n '(AppConnectorInstallationStore|sqlite-app-connector-installation-adapter|FiberSnapshot|initializeProvisioning|dispatch_runtime_missing|dispatch_route_invalid|dispatch_failed|dispatch_output_unsupported)' apps/openomni/src packages/ledger/src packages/channels/src -g '*.ts' -g '!*.test.ts'
rg -n 'export.*(IngestMode|ProviderCapabilities|ProviderRuntime|PublishPort|Adapter|normalize)' packages/channels/src/index.ts
rg -n '"bridge"' packages/channels/src/provider/contract.ts
rg -n 'FiberSnapshot|snapshot\(|pending' apps/openomni/src/composition/composer.ts
```

G-CH9 nonzero receipt: `rg -n 'GatewayCallbacks|SocketCallbacks|PollerCallbacks' packages apps -g '*.ts' -g '!*.test.ts' -g '!**/test/**' -g '!**/dist/**'` returns six lines (three declarations, three same-file constructor uses). This is a real remaining un-export, not a new product consumer.

## #967 semantic and data-retention receipt

The case-variant census is intentionally broader than #940:

```bash
rg -n -i '(work[_-]?item|complete_work|work_items)' apps packages script -g '*.ts' -g '!*.test.ts' -g '!**/test/**' -g '!**/fixtures/**' -g '!**/dist/**'
```

It returns **two production-source hits**, not zero:

- `packages/ledger/src/storage/u967-projection.ts:9`: offline historical projection schema accepts the retired owner spelling to validate archival eligibility. `initializeSqliteDatabase` / archive verification -> `inspect967Projections` -> `HistoricalProjection` checks old rows; that historical public owner schema was subsequently removed by #969; frozen formats now live in `storage/historical-request-format.ts`.
- `script/generate-ledger-archive-manifest.ts:151`: approved archive disposition deletes eligible retired-owner rows with revision and owner predicates. CLI -> locked receipt verification -> guarded migration preparation -> this delete. No live owner creation or fallback reader is reintroduced.

The semantic census must keep these archival-only uses visible. They are not relabeled grep-zero, and no schema/history is destroyed to satisfy a lexical check. A direct schema probe rejects `workItem` and accepts `session`. Generic model attempt children are distinct and remain live.

`rg -n '\bonFact\b|Session\.(create|list|get|remove|delete|sweep|addMessage)|sweepExpiredSessions|sessionTtl' apps packages script -g '*.ts' -g '!*.test.ts' -g '!**/test/**' -g '!**/dist/**'` is zero. The word-boundary avoids false hits in unrelated desktop `SessionFacts` types. WebSocket source has no query-token reader; canonical subprotocol authentication is the only token path (#974).

A direct fresh `initializeSqliteDatabase` probe found none of `work_item`, `artifact`, `conversation`, `lease`, `engagement`, `transcript_fact`, `cron_job`, `app_connector_installation`, `bus_event`. `message`, `part`, and `wait` remain. The full test run also executed fresh/upgraded archive, guarded refusal, and boot preservation scenarios; its unrelated failures below prevent a whole-suite green claim. Historical migration files are unchanged.

## E rows and #948 acceptance limits

| Row/acceptance | Status at this source |
| --- | --- |
| E3 | OPEN #945: production/test clone findings are measured separately by the pinned detector and ratcheted; clone-zero remains final convergence. |
| E4 | REQUIRED #945, **not parked**: the TypeScript census distinguishes written type tokens from transitive inferred type findings at owned reference sites. Existing findings have a measured shrink-only baseline; new/modified source findings must be zero. |
| E5 | #945 ratchets cover source type, publisher/export/store, complexity, clones and native coverage evidence. Baselines may only shrink; findings in added files or modified source ranges fail. Full mutation is scheduled/manual and cannot turn an incomplete run into a baseline. Final all-dimension zero belongs to #973. |
| E7 | OPEN: prompt builder has no memory parameter and presets have no deleted tool instruction, but `apps/openomni/test/prompt.test.ts:27-29` still pins prose/code-mode phrases. Structural assembly assertions coexist with those pins. No tests were added or modified in this docs-only PR. |
| Synchronous completion signal | Locally invoked the real builder for Resident/Worker, split the returned machine-consumed prompt into blocks, asserted zero removed sentinels: Resident 3 blocks, Worker 2. No sleep/poll. Catalog contained `approval`, `await_delegation`, `cancel_delegation`, `delegate`, `llm`, `provision`, `run_code`; zero removed tool names. |
| Prompt/signature mutation | Existing tests do not supply the full requested negative signature/sentinel mutation contract; no claim that restoring an unused parameter must fail them. This acceptance remains open rather than adding a prose test or claiming an unrun mutant. |
| Generated-doc mutation | Temporarily added `apps/openomni` to generated `ui` consumers. `bun run lint:docs` exited 1 with `AGENTS.md dependency topology is stale`. Regenerated via `script/generate-agents-deps.ts`; restored check exited 0. Generated block is unchanged from the correct source topology. |

The narrower existing gates are the empty-baseline Knip ratchet, protocol start/terminal pairing, and enumerated ledger-producer drift. They are not #945's complete publisher/export/store census. Expanded #945 requirements additionally include coverage100%, production/test clones0, cyclomatic<22, cognitive<22, Halstead difficulty<80, CRAP<25 and surviving mutants0 with frozen tools, inventories, settings and mutation operators. Full mutation remains scheduled/final-convergence work, not silently waived.

## Local verification

Darwin arm64; Bun `1.4.1` (`4661e494f`), TypeScript `5.9.2`, Knip `6.31.0`, Ultracite `7.8.3`, Biome `2.4.16`. Frozen-lockfile installation completed. No production/test/lockfile edits.

| Command | Exit / result |
| --- | --- |
| `bun run build` | 0; Turbo reported 6 successful tasks, cache restored |
| `bunx turbo run check-types` | 0; 16 successful tasks |
| `bunx tsc -p script/tsconfig.json` | 0 after workspace build |
| `bun run script/check-deps.ts` | 0; pre-existing stale-doc notices for IPC/placement AGENTS |
| `bun run script/check-import-cycles.ts` | 0; 372 modules, zero value-import cycles |
| `bun run script/check-topology.ts` | 0; twelve workspaces |
| `bun run script/check-dead-exports.ts` | 0; twelve workspaces, zero known/new issues; baseline unchanged |
| `bun run lint` | 0; guard/side-effect/docs and formatter-disabled Ultracite checks |
| `bun run lint:tools` | 0 after workspace build; schema/tool snapshots current |
| `bun run lint:docs` | 0 on restored generated block |
| `bunx ultracite check --formatter-enabled=false .` | 0 (also executed by lint) |
| `bunx ultracite check .` | **1; 182 existing formatter errors**, 902 files scanned; no fixes applied |
| `bun test --timeout 15000` | **1; 3326 pass, 2 fail, 1 error**, 3328 tests / 347 files, one run |
| Markdown LSP diagnostics | Unavailable: no `.md` language server configured; generated-doc gate and `git diff --check` used instead |

Initial `lint:tools` and script tsc attempts before build could not resolve package `dist` exports. The required workspace build supplied those artifacts; post-build commands passed. This was prerequisite setup, not a source fix or suppressed error.

Full-suite failure output (unchanged code; not retried to obtain green):

```text
(fail) discord gateway state machine (#520) > identifies with the real token and survives many heartbeat intervals when acked
error: WebSocket closed before ready: 1002
reason: Expected 101 status code
  packages/channels/src/provider/discord/gateway.ts:138

(fail) 967 WAL rollback crash and resumability > a contender triggered by the exact in-transaction lock signal cannot write
error: timed out waiting for gateway signal
  packages/channels/test/discord-gateway.test.ts:60

# Unhandled error between tests
error: timed out waiting for gateway signal
  packages/channels/test/discord-gateway.test.ts:60
```

The second failure's stack is the earlier gateway fixture's pending signal, not evidence that the archive lock admitted a contender. The same output records the contender's `SQLITE_BUSY`. An expected failing cleanup-oracle subprocess also prints a failure but is not one of the final two suite failures. Related prompt, boot catalog, deleted-surface Knip discrimination, event-pairing, ledger producer drift, and model/cell truncation assertions passed within this run. Existing failures remain visible; no test was skipped/deleted and no baseline grew.

## F. #811 park disposition

GitHub changes executed and re-read with `gh` on 2026-09-06:

- #811 remains CLOSED; its body now leads with supersession by #950 and links #948. Historical scope is explicitly historical.
- #950 remains OPEN with `icebox`, `architecture`, `improvement`; its body explicitly places it outside #930 and cross-links #811/#948. No duplicate successor was filed.
- Scope stays exactly #950's machine-offer isolation capability/fail-closed execution and gateway egress secret gate, including its existing profile/blocklist/scanner acceptance. No implementation or profile/scanner design is absorbed into I08.
- Re-triage remains closure of #938/#939 (I08) and #946 (I06); all three are OPEN at verification. This is a parking receipt, not a hardening delivery claim.

## #949 stage 1 receipt (2026-09-06)

Based on `f9c02a66` including the real machine consumer surface from #991.
This receipt does not seal the final catalog or duplicate #946/#947 work.

| Row | Stage-one disposition | Evidence |
| --- | --- | --- |
| B15, G-AG3 | CLOSED: target-selection workspace, topology/dependency/Knip/CI/coverage rows and executor eligibility wrapper deleted. Model selection moved to llm; tool.pre remains call-time authority. | `script/tool-target-deletion.test.ts`; model fallback and tool-admission tests |
| G-H7 | CLOSED: credential decryption and bounce-key rotation share one store read per credential per reconciliation. | provisioning test observes one actual SecretStore.get call |
| G-H9 | CLOSED: orphan model-resolution comment removed from llm tool module. | source diff; no prose test |
| E8 / A15 truncation sub-condition | CLOSED after R1 review correction: central 32,000-code-unit model cap includes literal truncated and exact dropped/original UTF-8 byte counts, retaining a valid Unicode boundary; cell output remains full and no spill port is required. | `packages/agent/test/tool-dispatcher.test.ts` ASCII/multibyte exact receipts; local/real-daemon large-file and Unicode tests |
| G-H8 | OPEN stage 2: schema census still constructs legacy approval/delegation factories using the catalog Proxy. Removing those dependencies would overlap protected #946 files. | `apps/openomni/src/tools/core/catalog.ts` |
| A11, A12, B12, B17, B18, E6, E8 catalog seal | Not closed by stage 1. New path tools consume the existing package-owned dispatcher; final naming/layout and exact catalog belong to stage 2. | #949 stage boundary |

`apps/openomni/test/locus-routing.test.ts` exercises five filesystem verbs and
bash both locally and through a real attached Unix-socket daemon, binary reads,
unique-match edit refusals, large raw cell values, recursive literal search and
daemon capability refusal. Completion is promise settlement, with no sleep or
polling. The explicit stage-one naming is retained rather than implementing the
later naming amendment in parallel with the messaging worker.

## #949 stage 2 receipt (2026-09-07)

Stage 2 seals the catalog on the KERNEL §3.5 names. Greps below are against the
merge HEAD of the stage-2 PR, production `.ts` only (tests, `dist/` excluded).

| Row | Stage-two disposition | Evidence |
| --- | --- | --- |
| B17 | CLOSED: the `approval` tool ({request,decide,contact_promote,endpoint_merge}) and its hourly pending cap are deleted. `contact_promote`/`contact_merge` are `provision` ops whose Owner consent is a `require_approval` policy row (`PROVISION_POLICY_ROWS`) resolved by the #969 request path; the policy `Match` gained an inner `operation` field to scope a row to one op. No model-callable `decide` exists. | `apps/openomni/src/tools/provision.ts`, `apps/openomni/src/tools/core/contact-mutations.ts`, `apps/openomni/test/provision-consent.test.ts` (forged `request`/`decide`/`approvalId` ops are `invalid_input`; consent flows through the kernel request and re-admits the exact captured invocation) |
| B18 | CLOSED: flat `apps/openomni/src/tools/<tool_name>.ts` plus `locus.ts` and `core/`; no `tools/{query,mutation,authority,execution}` or target-axis directories. `category` remains a `defineTool` field only. | `ls apps/openomni/src/tools` |
| E8 / E9 | CLOSED: model door == `{read,write,edit,ls,find,grep,bash,eval,monitor,send_message,provision}`, cell-only `completion`; snake_case; one discriminator `op` under `operation` for eval/monitor/provision; `contact` is the single model noun (`Actor` stays protocol-internal); `command` not `cmd`; `completion({prompt, model?, system?, schema?})` with `parallel()` for batching. Stage 3 residue closed: codemode machine-handle methods are the tool names (`read/write/ls/bash/eval`; the old `list/stat/shell/run` names are grep-zero), `eval.op = run | peek | stop` over a per-tenant background cell registry (peek returns the streamed partial output of a running cell; stop settles it as `cancelled` and never re-runs it), and the tool file name is the tool name in kebab-case (`send-message.ts`, pinned by the `[tool-file-name]` lint). | `apps/openomni/src/tools/core/catalog.ts`, `catalog.test.ts` (literal pin, op sets, completion fields, retired-name refusal), `script/lint-tools.ts` (snake_case + file-name ratchets), `script/conformance/tool-schema-snapshot.json` (12 specs), `packages/codemode/test/consumer.test.ts` (peek/stop behavior), `apps/openomni/test/code-mode-e2e.test.ts` (eval run/peek/stop and completion options through the model door) |
| G-H8 | CLOSED: the nested Proxy fake port is gone; `createTools` constructs every tool regardless of wired ports and a tool whose port is absent refuses at execution (`ToolRefused`). | `apps/openomni/src/tools/core/catalog.ts` |
| A11, A12, B12, E6 | Reconfirmed zero: no `fs_read/fs_list/fs_stat/machines`, `delegate*`, `work_items`, `converse`, `memory`, `artifacts`, `run_code`, `llm`/`llm_batched`, `list`/`search`, or `sendMessage` tool definitions in production. | `rg -n 'name: "(fs_read\|fs_list\|fs_stat\|machines\|delegate\|await_delegation\|cancel_delegation\|work_items\|converse\|memory\|artifacts\|approval\|run_code\|llm\|llm_batched\|list\|search\|sendMessage)"' apps packages -g '*.ts' -g '!*.test.ts' -g '!dist/**'` → 0 |

## #938 follow-up

- **R3-3 (parked):** add a platform-specific `fchdir`/descriptor-backed cwd
  helper for exec so shell startup can inherit the pinned export directory.
  Current contract deliberately accepts the bounded pathname check/spawn TOCTOU.

## #946 stage-2 cutover receipts (historical; #969 supersedes lifecycle ownership)

Rebased onto `f9c02a66` (#991). This PR closes the implementation rows below; final gate receipts are in its PR body. Historical sections above are not rewritten as current gate evidence.

| Rows | Closed by this cutover |
| --- | --- |
| A3, C4 | Retired continuation/settlement authority removed; child terminal mail crosses compiled message policy and the atomic session writer. |
| A10 | Legacy delegation/await/cancel tools and their catalog entries removed; sendMessage returns a handle without joining. |
| A17 | Separate delegation/worker-run adapters and exports removed; guarded migration 0035 drops only empty retired tables. |
| B3, B10 | One two-argument ingest and injected inbox commit; facts-only drivers, no return-value writeback or trigger-rule admission. |
| B4 | Message deadlines persist as alarm rows with answer/timeout CAS; startup owner tested before/at deadline and across restart. Live scheduling remains #947. |
| B7 | Ledger stores channel-grant facts; channels alone resolves treatment. |
| C5, C8 | No retired task eligibility or worker-run correlation; authenticated session/action/message identities are used. |
| D3 | Indexed durable live reply-grant projection replaces full route-history boot replay. |

Retained ownership, not a hidden alternate path:

- #947 still owns continuous live due-dispatch and monitoring. The former message-specific startup expiry path is replaced in #969; its historical receipt does not prove the new path.


Source and test runtime-symbol census (each prints zero matches and exits 1):

```bash
rg -n 'DelegationKernel|Delegation\.|delegation\.settled|/delegation/|DELEGATE_TOOL_NAME|await_delegation|cancel_delegation|delegation_await|delegation_cancel|create(Await|Cancel)DelegationTool' apps/openomni/{src,test} packages/{agent,channels,ledger,protocol}/{src,test} -g '*.ts'
rg -n 'deliverWake|settleFromReply|awaitDelegation|processWorkerRun|registerDelegationProcessEntry|registerDelegationChannelDriver|nextTimerDelay|respondUnderTyping|GitHubNormalizer|TriggerRule|WorkerRunStateStore|workerRunId|worker_run_state' apps/openomni/{src,test} packages/{agent,channels,ledger,protocol}/{src,test} -g '*.ts'
```

The immutable migration manifest still names historical migration 0023. The guarded SQL migrations and offline archive checks intentionally retain historical table names; they are not live adapters or producers. No coverage floor is lowered.

## #969 action waiting, delivery and retained history

| Scope | Cutover disposition | Acceptance surface |
| --- | --- | --- |
| Waiting/approval authority | Independent protocol folds, stores, adapters, tables and writers removed; one original-action CAS | Kernel request race tests; real Owner socket/SIGKILL/restart test |
| Protected mutations | Captured input/effect/catalog/domain binding; global pending-count CAS; at-most-once application claim | Wrong principal/hash/domain tests; body-entry domain race |
| Child delivery | Terminal plus source obligation commit together; receiving inbox is idempotent and source acknowledgement requires its receipt | Native/process app tests; lost-ack restart; dropped-receiving-consumer mutant |
| Physical channels | Grant/budget/idempotency and drivers retained; receipt identity never upgrades unknown/rejected to accepted | Real Telegram harness; quorum/all/chain and receipt tests |
| Historical data | Forward migration refuses unresolved state and retains terminal rows in immutable archives | Fresh/0035 upgrades, archival equality, rollback and Bun 1.3.6 tests |


`script/request-authority-census.ts` scans production, fixtures, and public schemas, including local untracked files, using Linux-compatible git grep. It rejects retired public APIs, live-table SQL, old correlation fields/events, and legacy module paths. Exact archival SQL allowances do not exempt an entire file: adding a store/sub-adapter to an archival fixture or a write to the read-only preflight still fails. One exact historical event remains in the hash-chain adoption fixture. Source comments and immutable migration comments are not executable authority. Dynamic SQL/name construction and semantically renamed engines remain outside this lexical/AST guard.

The old producer entries and allowed perimeter store import are removed. Protocol/tool snapshots are generated from the current public barrel and catalog: SessionTransition maps to existing Session/Action vocabulary, and protected mutation no longer accepts model-minted approval decisions. The channels manifest allows agent for real-kernel tests only, not production source.

Migration 0038 retains terminal legacy row bytes in immutable archive_969_wait/archive_969_approval tables; it does not erase action history or rewrite historical migrations. Unresolved or invalid old rows refuse before mutation. The #967 archive command remains explicitly confirmed and pinned separately. Unresolved old message alarms and native child execution also refuse. The replacement is covered by request/outbound race, restart and actual receiving-executor tests; final command receipts remain attached to the PR. Message/part retention, continuous scheduling (#947), and the broader #945/#948 quality campaign remain outside this cutover.

## #971 monitor occurrences and evaluator recovery

| Scope | Cutover disposition | Acceptance surface |
| --- | --- | --- |
| Identity split | Alarm id = control identity/inbox origin; persisted `fence` = evaluator authority; occurrence = `Alarm.occurrenceId(alarmId, epoch, sourceKey)` as the `alarm.fired`/`alarm.paused` action id. No redundant occurrence table or id column. | `monitor-occurrence.test.ts` two matches -> two action ids; same key redelivered -> undefined, revision unchanged |
| Admission owner | `alarmOccurrence` in `packages/ledger/src/storage/l0-action-builders.ts` is the only judgment (fence, due, dedupe, deadline, budget), shared by SQLite and the memory double; `Alarm.Fire` lost `actionId`, `inboxId`, `limit` | `alarm.test.ts` parity, `alarm-control.test.ts` budget-of-one pause, `monitor-occurrence.test.ts` late match settles as timeout |
| Takeover vs rearm | `acquire` keeps epoch/count/digest; `rearm` resets them; both advance the fence before physical cleanup | `monitor-occurrence.test.ts` poll A -> takeover -> A suppressed, B delivers, old fence zero, rearm re-admits A; `alarm-boot-durability.test.ts` real PTY restart gap |
| Budget | N notifications then one `alarm.paused` prompt on N+1; N+2 and every stale contender commit zero; cancel of paused refuses later fires | `monitor-occurrence.test.ts`, `monitor-budget.test.ts` |
| Recovery limits | Live streams restart from now; timed watches settle `restart`; cursor backends not added; band retains OS handles only | `alarm-worker-boundaries.test.ts`, `monitor-process-group.test.ts`, `monitor-app.test.ts` hibernation wake |
| Deletion | Worker-side `expired` computation, caller-minted random action/inbox ids and caller-supplied `limit` removed with their schema fields in the same PR; `schema-snapshot.json` regenerated for `Alarm.Fire` | `git grep -n -e "randomUUID" -e "limit:" -e "expired" apps/openomni/src/composition/alarm-worker.ts` -> zero |

## #970 durable recovery and typed restoration

| Scope | Cutover disposition | Acceptance surface |
| --- | --- | --- |
| Recovery authority | One owner: `packages/agent/src/executor-recovery.ts`; classification pinned on intents; post-body exceptions and crash-open intents settle failed/outcome_unknown from evidence, refused commits stay pending | `packages/agent/test/executor-recovery.test.ts` per site and per kind; turn dispatcher recovery runs no tool |
| Retry owners | Provider retry stays with `createAttemptRunner`; no second retry loop introduced; channel socket backoff (transport) and summarizer shrink loop (wraps recorded llm) audited as non-owners | `core/execution/llm-attempts.test.ts` pins ordinal/cap/reason and settled evidence |
| Attempt evidence | Usage, visible-output boundary, finish reason and `Auth.reference` (type + 16-hex digest) recorded; the credential itself is never written | `packages/llm/test/run-outcome.test.ts`, `packages/llm/test/auth/storage.test.ts` |
| Model restoration | Turn-boundary `restore_model_selection` from the durable last attempt; refusal keeps the fallback pinned | `core/model-restore.test.ts`, `model-selection.test.ts`, two-turn `session-chat-runner.test.ts` |
| Context restoration | `restore_context_projection` appends under the compaction parent with the lease held; original compaction facts intact; unknown/unexecuted compaction refused before recording | `session-context-restore.test.ts` |
| Deletion | Nothing deleted: no duplicate retry owner or process-local recovery authority remained at post-#969 main beyond the implicit chain reset in `run.ts`, which the recorded restoration replaces | `git diff --stat origin/main..HEAD`: 25 files, no migration, no schema |

The contract's `move` rows for `session-admission.ts`/`session-turn.ts` into `session-lifecycle/*.ts` were not executed; those symbols keep their current owners and the contract records the landed locations. Gate outputs and the final HEAD are in the PR body.

## #972 action-based history and diagnostic projections

| Scope | Cutover disposition | Acceptance surface |
| --- | --- | --- |
| Authoritative history read | `SessionHandleStore.historyPage` reads the session row revision and `actions.range(sessionId, afterRevision, limit)` in one transaction; `nextRevision` continues an incomplete page and is null at the head. `watch()` gaps are hints: the caller re-reads from `gap.from`; no event is synthesized | `packages/ledger/test/session/kernel.test.ts` dropped-notification resync; `packages/ledger/test/storage/adapter-contracts.test.ts` range contract on both adapters |
| Canonical context fold | `foldSessionHistory` in `packages/agent/src/session-lifecycle/history.ts` (moved from `session-history.ts`, which is deleted). Model context carries delivered prompts, assistant snapshots, positional tool settlements and compaction projections only | `packages/agent/test/session-history.test.ts` (kept at its contract path), `session-context-restore.test.ts` |
| Diagnostic projection | `inspectActions`/`inspectSession` in `packages/agent/src/session-lifecycle/inspect.ts` derive one `SessionHistory.Transition` per action with `cause` (`action`/`inbox`/`alarm`/`root`), turn/call/request identity, outcome and a canonical digest; `outcome_unknown` is its own outcome; a pre denial is the refused call's only terminal record (`blocked_pre` on the decision). Payloads are never copied, so credentials in tool input do not appear | `packages/agent/test/session-inspection.test.ts`: child session, retried model call, tool refusal, approval, `outcome_unknown` effect, monitor wake and compaction; every cause resolves to a committed action, inbox row or alarm |
| Policy inspection | `inspectPolicy(decisions, {generation, ruleId, verdict})` over the recorded `policy.decision` actions; reason and inputHash are the recorded ones | same suite, `deny`/`require_approval` rows by rule and verdict |
| Cross-session traversal | `inspect({depth})` follows only `parentId` (commissioned children). Outbound destinations appear as `peerSessionId` and are not read | same suite: parent -> child, depth 0 yields none |
| Compaction evidence | Existing `compaction` result (`summary`, `firstKeptEntryId`, `discarded{first,last,count,sha256}`, revert recipe) is surfaced as `SessionHistory.Compaction` with `restoredBy`; original facts untouched | same suite; `session-context-restore.test.ts` |
| Pure replay | Inspection and paging run no body and append nothing; a rebuilt page sequence equals the tree, and its fold equals the canonical fold | same suite: body counter and tree equality before/after |
| Transcript / fact taps | `Transcript.fold` stays: it is the ephemeral provider-stream assembler in `packages/llm/src/processor`. `onFact` remains grep-zero (see #944 grep above). OTel/log ids are derived from turn/session identity in `executor-record.ts`; no durable trace grammar | `rg -n '\bonFact\b' apps packages -g '*.ts'` = 0 |
| Deletion | `packages/agent/src/session-history.ts` removed with its five importers rewired in the same commit; no schema, table or migration touched (`message`/`part` bytes refused per contract) | `rg -n "session-history\"|\bsessionHistory\b" apps packages -g '*.ts'` = 0 (the unrelated ledger benchmark seeder of the same name became `seedTurnHistory`) |

`LedgerAction.Kind` is unchanged: no new action kind was needed, so no forward CHECK migration ships. The #971 occurrence kinds will project through the generic `record` phase when they land.
