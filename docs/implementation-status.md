# Implementation Status

Single source of truth for current wiring, not a declaration that every target in [Core Model](core-model.md), [Kernel Contract](kernel-contract.md), [Architecture](architecture.md), or [Machines and Delegation](machines-and-delegation.md) has shipped. [Epic #930](https://github.com/INONONO66/openomni/issues/930) supersedes #459 for kernel delivery; #966 and #968-#973 are the subsequent lifecycle campaign.

**Verified source:** `c4fb774869fb060859bbdc2f58ce37ee3a3072c9`, tree `0d6318c742a1ca0eeaa5ddf30003108ba8a53487`, 2026-09-06. This includes #965, the #967 correction PRs, and #985's session-loop convergence. The #948 patch changes documentation only. [SLOP and deletion receipts](SLOP.md) contain exact grep commands, merged commits, gate results, and outstanding acceptance; closed issue labels are not implementation evidence.

Machine/codemode wiring is updated by #938/#939 in PR #991, rebased onto `5b3ff997` including #987's deletion receipts and #988's protocol-only messaging contracts. The source pin above identifies the retained #948 historical receipt, not the new machine implementation.

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
native callback, proving atomic delivery independently of callback timing. [Decisions and operational limits](alarm-monitor-stage-1.md)
include the at-most-once restart gap. Stage 2 after #946 still owes only the
message-deadline consumer -> `at` alarm migration, its answer/deadline CAS and
restart tests, and B4 deletion proof. #969-#973 receipts remain unconsumed.

## Deployed shape

| Component | Current wiring | Source |
| --- | --- | --- |
| Kernel app | Boot/shutdown, Resident, channels, gateway, provisioning, machines, delegation, cells, and compaction. No built-in curated memory or replacement port. | `apps/openomni/src/index.ts` |
| Desktop console | Electron shell and app-owned AI SDK chat state; the default renderer uses mock transport, not live machine execution. Presentation is shared with the UI showcase; a gateway transport implementation also exists. | `apps/desktop/`, `packages/ui/` |
| Channel drivers | Discord, GitHub, Slack, Telegram providers and a separate WebSocket bootstrap surface. Providers own credential/settings validation and outbound rendering; the app composes them. | `packages/channels/src/provider/`, `packages/channels/src/websocket.ts`, `apps/openomni/src/channels.ts` |
| Perimeter gateway | Blacklist, Wait correlation, channel ceiling, actor identity, surface sessions, durable route decisions, and grant/egress/idempotency-controlled sends survive. Removed dialogue stores confer no routing rights. WebSocket credentials use the canonical auth subprotocol; query-only authentication is rejected (#974). | `packages/channels/src/router/`, `packages/channels/src/authn/websocket.ts`, `apps/openomni/src/gateway.ts` |
| Provisioning | Durable persons, channel instances, and encrypted secrets; declared instances supersede environment channel configuration. The vault key and channel supervisor are composed at boot. The one-shot environment import command is deleted. | `packages/ledger/src/provisioning/`, `apps/openomni/src/provisioning/` |
| Runtime administration | The `provision` op union uses the live supervisor for channel/secret changes and status. Person mutations consume a matching approval only when `approvalRequirement` demands one (editing the existing owner Person, or raising a tier above collaborator); other declarations and non-sole-owner `person_remove` apply directly. Contact promotion/endpoint merge still use the separate `approval` tool; their proposed catalog consolidation has not shipped. | `apps/openomni/src/tools/mutation/provision.ts`, `apps/openomni/src/tools/authority/approval.ts`, `apps/openomni/src/provisioning/supervisor.ts` |
| Resident and native workers | Shared durable session handles and the same stateless runAgent loop. Inline/process workers have no separate drive loop. Existing delegation transport, admission, settlement, deadlines, and recovery remain live. | `apps/openomni/src/resident.ts`, `apps/openomni/src/composition/worker-session.ts`, `apps/openomni/src/delegation/` |
| Session durability | Fenced single-flight execution, durable inbox/alarms, parent-linked rows, action history, generation snapshots, boot recovery, idle release, authoritative reads, and revision-gap observation. Legacy public CRUD/message/TTL ownership is removed, not aliased. | `packages/agent/src/session-handle.ts`, `packages/agent/src/session-controller.ts`, `packages/ledger/src/session/kernel.ts`, `packages/ledger/src/storage/sqlite-l0-adapter.ts` |
| Action executor and policy | Session-pinned compiled policy rows govern prompt/turn/model/tool pre/post decisions. The executor owns model/tool intents and linked terminals; prompt/turn records remain session-owned. Old callback registries are deleted (#965). | `packages/agent/src/executor.ts`, `packages/policy/src/row-compiler.ts`, `apps/openomni/src/policy-seed.ts` |
| LLM | Canonical model/auth resolution, provider classification, retry-after/backoff, and corrected additive token accounting. The processor performs one attempt; session execution owns retry and re-admission. The unused public fact tap is removed (#976); ephemeral transcript folding and message/tool callbacks remain. | `packages/llm/src/`, `packages/agent/src/executor-attempts.ts` |
| Compaction | App-configured summarization and agent-owned speculative/synchronous compaction, with durable projection/range/hash/revert evidence and reconstruction from canonical actions. The summarizer is wired, not dormant. | `apps/openomni/src/compaction/`, `packages/agent/src/compaction/`, `packages/agent/src/session-history.ts` |
| Observation | Scoped agent bus/component observations are projections, not durable authority. Ledger facts commit before observation. The old telemetry package and bus-persistence writer are absent. | `packages/agent/src/observation/`, `apps/openomni/src/observation/` |
| Machine body and raw endpoints | Stable list/get handles expose binary-safe confined fs read/write/list/stat, stateless exec(cmd,cwd), and runCode. Enrollment/offer intersection is fail-closed. Exactly two authorization boundaries: captured kernel tool.pre and daemon capability/export enforcement. The descriptor-pinned no-follow confinement driver remains; machines owns no interpreter. Old app filesystem/list-machines tools remain absent. | `packages/machines/`, `packages/protocol/src/machine/`, `packages/ipc/` |
| Code mode | Public factory supplies machine object handles and cell.run. The injected daemon runner owns lazy per-tenant Python processes, parallel/llm helpers and callback routing. The brain facade never spawns Python. Cancellation and close propagate across the attachment and await process cleanup. App VFS, cell registry and old machine methods are deleted; the single run_code tool delegates to codemode. Cell-only llm retains batched prompts and its 32-prompt per-catalog budget. The scp-style plain-tool door remains #949. | `packages/codemode/`, `apps/openomni/src/composition/codemode.ts`, `apps/openomni/src/tools/execution/` |
| Tool catalog and prompts | The current catalog has delegation, approval, provisioning, cell execution and cell LLM definitions. The prompt builder accepts model tuning only; deleted-domain injection/instructions are absent. Model output truncation retains its marker and original size; cell values stay full. | `apps/openomni/src/tools/core/catalog.ts`, `apps/openomni/src/prompt/`, `packages/agent/src/tool-dispatcher.ts` |
| CLI and composition | Start/onboard/daemon/doctor/logs and npm staging belong to the app. The minimal `openomni machine attach <config.json>` composes the retained machine daemon wire; Resident `openomni daemon` remains unchanged. Reversible composition owns both boot rollback and reverse-order shutdown. | `apps/openomni/src/cli/`, `apps/openomni/script/build-npm-package.ts`, `apps/openomni/src/composition/composer.ts` |

`packages/placement` still exists and participates in tool placement. PR #991 adds `packages/codemode`; generated `AGENTS.md` topology now describes thirteen workspaces. Delegation and the current approval tool are retained consumers, not deleted-domain residue. The original twelve-workspace census remains historical evidence at the #948 source pin.

## I09 deletion receipt synchronization

The A-row domain deletions below pass their exact production grep at the verified source. No production deletion is attributed to #948. [SLOP.md](SLOP.md) also records two archival-only semantic matches and three still-exported #944 G-CH9 callback types; those expanded acceptance gaps are not labeled zero. Exact identifiers and commands stay outside the active-contract grep surface.

| Rows | Disposition | Merged evidence |
| --- | --- | --- |
| A1, A2, A5 | Dormant transcript persistence, unused surface claim, and runtime integration client removed. The live ephemeral transcript fold survives. | #944 / PR #963, `b44cd76e` |
| A9 | Historical test-only export list was already zero; no invented deletion. The #948 source-pin empty-baseline Knip run reported twelve workspaces, zero issues. This is not proof of #945's stricter production-consumer census. | #944 / PR #963; current gate receipt in SLOP.md |
| A13 | Old task-ticket/completion domain, tools, schemas, and stores deleted. Later owner-schema correction consumed through #967. Generic provider-attempt history is unrelated and remains. | #940 / PR #960, `6c5d65d6`; PR #977, `eec7f7fc` |
| A14 | Built-in curated stores, mutation tool, config, and prompt injection removed without replacement. Local user files are not migrated by this docs update. | #941 / PR #958, `d35cdd39` |
| A15 | Blob store/schema/adapter/tools and spill removed; distinct model/cell output handling survives. | #942 / PR #959, `7edfe5d2` |
| A4, A16 | Dialogue-window, send-permission, and engagement domain stores/schemas/tools removed. Ordinary gateway send and session-owned Wait remain; the future unified messaging door is not claimed wired. | #943 / PR #961, `23ad4f6b` |

Historical migrations remain immutable. The migration runner applies both 0030 deletion migrations, 0032's guarded dormant-table drops, 0033's session-handle lift, and 0034's archive disposition. Source-level grep-zero does not mean that every historical identifier or every retained archival byte is gone.

## #937 and #967: merged corrections versus remaining retention

PR #985 (`c4fb7748`) completes session-loop convergence after #980: three inbox drains surround each model step/tool wave, then compaction and captured stop policy run. Approval covers the whole wave; positional results, sequential barriers, and live raw-effect lease retention remain. Visible text/tool output forbids provider replay. Missing/changed captured executable catalogs fail closed; crash-open recovery keeps captured IDs/generations, while terminal resume starts new ones. Worker recovery observes delegation cancellation rather than reviving cancelled work.

The #967 corrections are merged: subprotocol-only authentication (#974), legacy session authority deletion (#975), unused fact-tap removal (#976), and native archive/retired-owner disposition (#977/#978). GitHub currently marks #967 closed. This document does not infer physical data deletion from that label: `message`, `part`, session-owned Wait and frozen worker rows remain in the source schema; canonical history is written as actions.

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
- I05/I06's final catalog, unified messaging runtime, machine-locus plain-tool door, and deletion of remaining live delegation/placement consumers are not predeclared shipped. #988 adds protocol-only sendMessage/gateway ingest contracts, not runtime cutover; I08's machine handles and codemode package are described above.
- Connector definitions and installation schemas are not an installed connector execution host. The dormant installation store is deleted.
- Governor/Jester/Voice, Stakes and effective-authority target consumers, dynamic reactive composition, and any later memory/search redesign are not promoted to shipped by retained design prose.
