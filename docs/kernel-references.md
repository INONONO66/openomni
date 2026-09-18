# Kernel Reference Pins

This document owns the tracked source pins for the kernel campaign. It grounds the
2026-09-17 owner decisions in `final-kernel-design-20260917.md` section 12.

## Pins

| Source | Repository | SHA | Role |
| --- | --- | --- | --- |
| Codex | `openai/codex` | `ee6814bf` | Append-only rollout, SQLite durability, retry, projection, and abort ordering reference. |
| OpenCode v2 | `anomalyco/opencode` | `7c5a4d01` | SQLite-owner layout and retry scheduling reference. |
| OmO | `code-yeongyu/oh-my-openagent` | `1d22bc26` | Durable task records, fallback chain, delivery fencing, and lost-terminal reference. |

## Decision references

All citations below name a file and line range at the pinned SHA. The receipt at
`.omo/reports/kernel-s0/docs-pin-receipt.txt` records the path checks.

| Decision | Decision value adopted | Reference source | Pin citation | What we absorb |
| --- | --- | --- | --- | --- |
| Persistence layout | Catalog plus 1,024 shard databases and blob storage; no per-session database. | Codex; OpenCode v2; OmO | Codex `codex-rs/rollout/src/recorder.rs:77-89`; OpenCode v2 `packages/core/src/database/database.ts:34-47`; OmO `packages/senpi-task/src/store/record-write.ts:31-54` | Keep one durable owner store per shard, with append-oriented session evidence and atomic record replacement at the file boundary. |
| WAL and synchronous policy | Shards use WAL plus `synchronous=NORMAL`; the catalog uses `FULL`. | Codex; OpenCode v2 | Codex `codex-rs/state/src/sqlite.rs:298-305`; OpenCode v2 `packages/core/src/database/database.ts:37-45` | Use the production WAL/NORMAL precedent only for recoverable session shards; isolate stricter catalog facts. |
| Retry, backoff, and retry-after provenance | Commit `retry.scheduled` with `notBefore`, bounded budget, and `retry-after` or estimated provenance; wait is not durable state. | Codex; OpenCode v2 | Codex `codex-rs/core/src/responses_retry.rs:92-113`; OpenCode v2 `packages/core/src/session/runner/retry.ts:63-81,130-148` | Take bounded exponential retry and provider-requested delay handling, but persist the schedule and its provenance in `packages/llm` instead of relying on an in-process sleep. |
| Fallback and model-switch recording | Append `route.changed` and child attempts; route changes never reset the logical budget. | Codex; OmO | Codex `codex-rs/core/src/responses_retry.rs:92-106`; OmO `packages/senpi-task/src/model-chain.ts:23-42,57-76` | Record each transport or model transition durably and retain one global turn budget across the fallback chain. |
| Deduplication and lost terminal | Blob content hashes are deduplication keys; owner death reaches `lost`, distinct from cancellation and unknown outcome. | OmO | OmO `packages/senpi-task/src/state/types.ts:3-13`; OmO `packages/senpi-task/src/state/transitions.ts:18-40`; OmO `packages/senpi-task/src/lifecycle/reconcile.ts:113-145` | Keep explicit loss/reconciliation semantics and use a content-hash identity for duplicate tool results. |
| Hash-chain absence | Add `prev_hash` and `row_hash` to OpenOmni actions; this is an OpenOmni audit addition, not a borrowed mechanism. | Codex; OpenCode v2; OmO | Codex `codex-rs/rollout/src/recorder.rs:77-89`; OpenCode v2 `packages/core/src/event/sql.ts:4-25`; OmO `packages/senpi-task/src/state/types.ts:3-13` | None of these pinned record shapes supplies a session record hash chain, so preserve the section 12 chain decision as an explicit local requirement. |

## Absorb list

- Codex projection anomaly counter: use a projection-versus-fold mismatch counter for
  `visible_transcript`. Citation: Codex
  `codex-rs/thread-store/src/local/thread_history_materialization.rs:19-32` at
  `ee6814bf`.
- Codex flush-before-terminal-on-abort: preserve the durable flush before publishing
  an abort terminal. Citation: Codex `codex-rs/core/src/tasks/mod.rs:930-940` at
  `ee6814bf`.
- OpenCode retry-after provenance parsing: carry provider retry-after input and its
  bounded delay classification into `packages/llm`, then record whether the delay was
  provider-requested or estimated. Citation: OpenCode v2
  `packages/core/src/session/runner/retry.ts:63-81,130-148` at `7c5a4d01`.
- OmO `yield_sha256` dedup plus `lost` terminal: adopt content-hash deduplication and
  an explicit `lost` terminal. The `lost` half is verified at OmO
  `packages/senpi-task/src/state/types.ts:3-13` and
  `packages/senpi-task/src/state/transitions.ts:18-40` at `1d22bc26`.
  The research report's `packages/senpi-task/src/workpool/reconcile.ts` citation for
  `yield_sha256` is absent at this pin and is intentionally not cited here; implement
  the dedup key only under the independent section 12 decision and replace this note
  when a pinned OmO source is available.

## Drift and verification

The local Codex, OpenCode, and OmO clones used during research drifted from these
pins. Every path cited in this document was verified to exist through the GitHub
contents API at its pinned SHA. The prior research citation
`packages/opencode/src/session/retry.ts` at OpenCode `7c5a4d01` and the prior OmO
citation `packages/senpi-task/src/workpool/reconcile.ts` at `1d22bc26` returned 404;
they are not cited as evidence above. See the receipt for the full 200/404 record.
