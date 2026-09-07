# SLOP: I09 deletion and closure receipts (#948)

Verified on 2026-09-06 against source HEAD `c4fb774869fb060859bbdc2f58ce37ee3a3072c9`, tree `0d6318c742a1ca0eeaa5ddf30003108ba8a53487`; a fresh `git fetch origin main` resolved to the same commit. This docs-only patch preserves that production tree. Final documentation commit/tree and PR URL are recorded in the local `REPORT.md` and PR body.

## Receipt location and scope

This is the tracked successor for the #948 rows formerly recorded in `.omo/reports/operation-architecture-20260902/SLOP.md`. PRs #981/#982 removed tracked agent artifacts; no `.omo/` file is recreated. Historical ledger/design text remains in git history, not an active contract. This file synchronizes the I09 rows and #811 disposition only; it does not mark unrelated historical SLOP rows closed.

The Owner-approved #945/#948 amendment overrides stale campaign labels and E4 parking. Deletion evidence, remaining quality acceptance, and the parked #950 successor are separate. This is not a zero-failure/final-convergence receipt and does not close #945 or the full #948 acceptance.

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
| A4, A16 | Conversation/lease/engagement stores/schemas and converse/lease tools | ALREADY-ABSENT; session fencing, gateway send, grants, egress budgets and session-owned Wait retained | #943, PR #961, `23ad4f6b` |

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

- `packages/ledger/src/storage/u967-projection.ts:9`: offline historical projection schema accepts the retired owner spelling to validate archival eligibility. `initializeSqliteDatabase` / archive verification -> `inspect967Projections` -> `HistoricalProjection` checks old rows; the public `Wait.OwnerKind` permits only `session`.
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
