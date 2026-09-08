# Implementation Status

Single source of truth for current wiring, not a declaration that every target in [Core Model](core-model.md), [Kernel Contract](kernel-contract.md), [Architecture](architecture.md), or [Machines and Delegation](machines-and-delegation.md) has shipped. [Epic #930](https://github.com/INONONO66/openomni/issues/930) supersedes #459 for kernel delivery; #966 and #968-#973 are the subsequent lifecycle campaign.

**#969 cutover (2026-09-07):** waiting and authenticated consent are original-action state. Source-owned outbound obligations feed the receiving kernel and inbox. Migration 0038 removes the independent stores with guarded archival retention. Final HEAD, gate outputs and acceptance receipts are recorded in the PR and local report.

**#971 cutover (2026-09-08):** alarm occurrence identity, deadline and notification budget are decided by the ledger from the committed row and its persisted spec; the evaluator reports a transport `sourceKey` and redelivery commits nothing. No schema change, no migration, no new table.

**#970 cutover (2026-09-08):** interrupted executor operations settle from classified durable evidence, never by rerunning a body. Attempt ordinal, cap, retry reason, usage, visible-output boundary and a non-secret credential handle are pinned on attempt actions. `restore_model_selection` and `restore_context_projection` are recorded, policy-evaluated actions that append; no schema change, no migration.

**#973 conformance (2026-09-08):** the unified lifecycle is proven on the real tree, not declared. `runLifecycleTrace` (`packages/agent/test/session-lifecycle-conformance.test.ts`) runs the six section 6.7 registrations of the [lifecycle contract](session-lifecycle-contract.md) over the real store, controller, executor waves, request port, outbound path and alarm rows, asserting append-only history, causal parents, terminal uniqueness, single input consumption, one observation per commit and effect-free replay from the reopened SQLite image. No production writer moved and no fixture was deleted; the #945 all-dimension quality receipt stays with #945.

**Source baseline:** #946 stage 2 includes main `678d357e` (#993/#949 stage 1), #991 codemode, #988's protocol contract and #990's desktop gateway selection. Historical #948 receipts below retain their `c4fb7748` source pin. [SLOP](SLOP.md) records deletion ownership; the PR body records the final gate commands and exit codes. Closed issue labels are not implementation evidence.

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
| Provisioning | Durable persons, channel instances, and encrypted secrets; declared instances supersede environment channel configuration. The vault key and channel supervisor are composed at boot. The one-shot environment import command is deleted. | `packages/ledger/src/provisioning/`, `apps/openomni/src/provisioning/` |
| Runtime administration | The `provision` op union uses the live supervisor for channel/secret changes and status. Person mutations suspend their original invocation for authenticated approval when `approvalRequirement` demands one (editing the existing owner Person, or raising a tier above collaborator); other declarations and non-sole-owner `person_remove` apply directly. Contact promotion/endpoint merge still use the separate `approval` tool; their proposed catalog consolidation has not shipped. | `apps/openomni/src/tools/mutation/provision.ts`, `apps/openomni/src/tools/authority/approval.ts`, `apps/openomni/src/provisioning/supervisor.ts` |
| Resident and native workers | Shared durable session handles and one app runner. Native and real process child-to-parent delivery pass targeted tests; the old app delegation subtree and tools are removed. | `apps/openomni/src/resident.ts`, `apps/openomni/src/process-entry.ts`, `apps/openomni/src/composition/process-session.ts` |
| Session durability | Fenced single-flight execution, durable inbox/alarms, parent-linked rows, action history, generation snapshots, boot recovery, idle release, authoritative reads, revision-gap observation, bounded revision history pages (`history()`) and redacted causal inspection (`inspect()`) derived from committed actions (#972). Legacy public CRUD/message/TTL ownership is removed, not aliased. | `packages/agent/src/session-handle.ts`, `packages/agent/src/session-controller.ts`, `packages/agent/src/session-lifecycle/inspect.ts`, `packages/ledger/src/session/kernel.ts`, `packages/ledger/src/storage/sqlite-l0-adapter.ts` |
| Action executor and policy | Session-pinned compiled policy rows govern prompt/turn/model/tool/message pre/post decisions; message post is obligation-only. The executor owns model/tool intents and linked terminals; prompt/turn records remain session-owned. Old callback registries are deleted (#965). | `packages/agent/src/executor.ts`, `packages/policy/src/row-compiler.ts`, `apps/openomni/src/policy-seed.ts` |
| LLM | Canonical model/auth resolution, provider classification, retry-after/backoff, and corrected additive token accounting. The processor performs one attempt; session execution owns retry and re-admission. The unused public fact tap is removed (#976); ephemeral transcript folding and message/tool callbacks remain. | `packages/llm/src/`, `packages/agent/src/executor-attempts.ts` |
| Compaction | App-configured summarization and agent-owned speculative/synchronous compaction, with durable projection/range/hash/revert evidence and reconstruction from canonical actions. The summarizer is wired, not dormant. | `apps/openomni/src/compaction/`, `packages/agent/src/compaction/`, `packages/agent/src/session-lifecycle/history.ts` |
| Observation | Scoped agent bus/component observations are projections, not durable authority. Ledger facts commit before observation. The old telemetry package and bus-persistence writer are absent. | `packages/agent/src/observation/`, `apps/openomni/src/observation/` |
| Machine body and raw endpoints | Stable list/get handles expose binary-safe confined fs read/write/list/stat, stateless exec(cmd,cwd), and runCode. Enrollment/offer intersection is fail-closed. Exactly two authorization boundaries: captured kernel tool.pre and daemon capability/export enforcement. The descriptor-pinned no-follow confinement driver remains; machines owns no interpreter. Old app filesystem/list-machines tools remain absent. | `packages/machines/`, `packages/protocol/src/machine/`, `packages/ipc/` |
| Code mode | Public factory supplies machine object handles and cell.run. The injected daemon runner owns lazy per-tenant Python processes, parallel/llm helpers and callback routing. The brain facade never spawns Python. Cancellation and close propagate across the attachment and await process cleanup. App VFS, cell registry and old machine methods are deleted; the single `eval` tool delegates to codemode. Cell-only `completion(prompt)` takes one prompt with a 32-call per-catalog budget; batching is the cell's `parallel()`. The scp-style plain-tool door is supplied by #949. | `packages/codemode/`, `apps/openomni/src/composition/codemode.ts`, `apps/openomni/src/tools/execution/` |
| Tool catalog and prompts | The catalog is sealed (#949): eleven model-door tools `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, `eval`, `monitor`, `send_message`, `provision` plus the cell-only `completion`; snake_case names, one `op` discriminator under `operation` for eval/monitor/provision, flat `tools/<name>.ts`. There is no `approval` tool: `provision.contact_promote`/`contact_merge` carry `require_approval` policy rows resolved through the kernel request path. `lint:tools` and the catalog test pin the exact set and refuse retired names. The prompt builder accepts model tuning only; deleted-domain injection/instructions are absent. Dispatcher-only model truncation caps at 32,000 UTF-16 code units on a Unicode code-point boundary, with exact dropped/original UTF-8 byte counts; cell values stay full. | `apps/openomni/src/tools/core/catalog.ts`, `apps/openomni/src/prompt/`, `packages/agent/src/tool-dispatcher.ts` |
| CLI and composition | Start/onboard/daemon/doctor/logs and npm staging belong to the app. The minimal `openomni machine attach <config.json>` composes the retained machine daemon wire; Resident `openomni daemon` remains unchanged. Reversible composition owns both boot rollback and reverse-order shutdown. | `apps/openomni/src/cli/`, `apps/openomni/script/build-npm-package.ts`, `apps/openomni/src/composition/composer.ts` |

#949 stage 1 removes the target-selection workspace and capability-based catalog fold; call-time admission belongs to executor `tool.pre`. Model fallback selection belongs to `packages/llm`. Together with #991's codemode workspace, the generated topology describes twelve workspaces. The standalone waiting/approval folds and stores are removed by #969. #949 stage 2 seals the catalog, folds approval into `provision`, and drops the catalog's conditional Proxy port scaffolding: every tool is constructed statically and refuses at execution when its port is absent.

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

| Gate/row | Current evidence | Not established |
| --- | --- | --- |
| Export ratchet / A9 | `script/check-dead-exports.ts`, empty `script/conformance/knip-baseline.json`, package-entry export scan and synthetic Knip discrimination test are wired into CI. | Benchmark/test/barrel/adapter-only references are not yet comprehensively excluded as #945 requires. |
| Event pairing | `script/conformance/protocol-event-pairing.test.ts` checks declared start/terminal vocabulary. | This is not a declaration-to-production-publisher census. |
| Ledger producers | `script/ledger-producer-manifest.ts` and its drift test enumerate current append/SQL writers. | This is not an all-store production read/write consumer census. |
| E3 | No new fixture code or prose snapshots in this docs patch. | Reproducible separate production/test clone-zero receipts remain #945 work. |
| E4 | Required by the Owner-approved #945 amendment; **not parked**. | Explicit/implicit TypeScript any type0 and unknown type0, with no boundary exemption. |
| E5 | Script tests and script coverage ratchet lane exist. | Campaign-wide coverage100%, complexity and mutation guarantees, including the gates themselves. |
| E7 | Runtime prompt has no deleted injection or tool instruction; structural assembly assertions already exist. | `apps/openomni/test/prompt.test.ts` still pins code-mode prose. E7 is not closed by a documentation-only PR; a negative signature/sentinel mutation gate is not claimed shipped. |

#945 remains open. Its acceptance also requires cyclomatic<22, cognitive<22, Halstead difficulty<80, CRAP<25, surviving mutants0, frozen analyzer versions/inventory/settings/coverage dimensions/operators, and full scheduled/final-convergence mutation execution. A passing ratchet or lint command does not establish any of those absent receipts. Local verification results, including pre-existing failures, are recorded in [SLOP.md](SLOP.md); no zero-failure campaign receipt is claimed.

## Parked and otherwise unimplemented

- [#950](https://github.com/INONONO66/openomni/issues/950) remains `icebox`, outside #930, superseding closed [#811](https://github.com/INONONO66/openomni/issues/811). It owns machine-offer isolation capability/fail-closed execution and the gateway egress secret gate. Kernel trust-boundary placement does not decide sandbox profiles or scanner semantics. Re-triage follows #938/#939 and #946; all three are open at verification. No sandbox/scanner implementation is included here.
- #949 is complete except for the `eval` ops `peek`/`stop` (the cell runtime has no background cell to peek at or stop yet; the op union is sealed at `run`) and the codemode machine-handle method names, which still mirror the raw endpoint (`read/write/list/stat/shell/run`) rather than the tool names. Continuous alarm scheduling stays #947; #969 acceptance uses the behavioral and deletion receipts above, not only its census; machine handles and codemode are described above.
- Connector definitions and installation schemas are not an installed connector execution host. The dormant installation store is deleted.
- Governor/Jester/Voice, Stakes and effective-authority target consumers, dynamic reactive composition, and any later memory/search redesign are not promoted to shipped by retained design prose.
