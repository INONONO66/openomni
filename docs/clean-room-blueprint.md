# Clean-room rebuild blueprint (transition plan)

Status: Owner-approved direction, 2026-08-08. This documents the TARGET structure
and the migration order. Roadmap authority stays with #459 and its leaves; this
blueprint is the structural vehicle those leaves are delivered through. Current
wiring truth remains `docs/implementation-status.md`.

## The three-layer rule

Every piece of code answers exactly one question:

| Layer | Question | Package | Owns |
| --- | --- | --- | --- |
| Definition | what is it? | `protocol` | zod schemas + pure folds (state machines with time/randomness as inputs) per domain. No storage, no effects. Precedent: `work-item/completion-admission.ts`. |
| Record | what happened? | `ledger` (session renamed, #502) | Drizzle tables + stores. No authority decisions. Raw SQL only in the CAS `append/`. |
| Effect | what do we do? | `kernel` (openomni renamed, #505) | Effectful services: assemble state, call protocol folds, record to ledger, execute. |

Support tiers: `policy` (pure decision engine), `llm`, `agent` (loop), `ipc` (#496),
`coordinator` (local-process Execution.Driver), driver band `naru`/`chasa`/`masil`/
`dokkaebi` ({protocol, ipc} deps only), `gantaek` (deferred until a second execution
target kind exists). `apps/server` is the composition root (bootstrap-only
ledger, see #503) plus userland (`agents/`, `worker/` — recorded #504 exception).
`@openomni/core` is REJECTED: every candidate util already has a natural owner.

## Target domain lists

- **protocol (exactly 13)**: actor, command, wait, work-item, policy, ledger,
  channel, app-connector, ingress, execution, transcript, tool, ipc. Plus root
  `named-error.ts` (single cross-boundary error base — amendment to #497's
  `error -> llm` exit; only APIError/retry classification moves to llm).
  Each domain: `index.ts` entry + `schema.ts`/`fold.ts`/`events.ts`.
- **ledger**: db + append (raw CAS + chain) + observe + per-record-family domains
  (session, transcript, actor, grant, blacklist, wait, work-item(+attempts),
  surface-key, artifact, app-connector, schedule) + `archive/` (frozen legacy rows,
  ATTACH read-only, upcast-on-read — never destructive).
- **kernel**: ingress(routing), command(dispatch renamed), wait, messaging,
  work-item(admission service; fold lives in protocol), evidence, stakes
  (current `openomni/src/ledger/` renamed — name collision fix), schedule, policy,
  access/injection (fold into neighbors unless a second consumer is proven).
- **server**: bootstrap/ (only ledger importer), http/, config/, agents/ (userland
  profiles incl. resident runtime), worker/ (execution host: entry, runner, tool
  pipeline, child-agent, workspace, context), connector/, manual/ (QA drivers).

## Owner rulings (locked 2026-08-08)

J1 NamedError stays in protocol root. J2 ResidentRuntime (runner included) moves to
server userland. J3 kernel folder is `command/`. J4/J6 access & injection: fold
unless second consumer proven at implementation time. J5 no `core` package.
J7 worker execution lives at `apps/server/src/worker/` (recorded #504 exception;
promote to a package only when a second execution host exists). J8 loop/LLM event
descriptors -> `execution/events.ts`, MCP -> `tool/events.ts`, pure telemetry
defined package-locally. J9 consent-validation stays beside the ledger store.
J10 band skeletons: naru immediately (real code moves), chasa/masil/dokkaebi at
their leaf start. J11 coordinator keeps its name; public surface narrows to
Execution.Driver. J12 `owner-map-driver.ts` (rename from runtime-owner-driver).

Storage decisions: Drizzle ORM pinned to stable (drizzle-orm 0.45.2 / drizzle-kit
0.31.10; 1.0-rc line has a sqlite dialect bug), bun:sqlite sync driver, schema.ts
as the DDL source of truth, drizzle-kit as generator only (apply via the existing
BEGIN IMMEDIATE runner). Decision-class writes (CAS, changes===1 receipts, hash
chain, archive readers) stay raw prepared statements. Sync transaction callbacks
only; writes use behavior "immediate"; durability split per-connection
(FULL writer / NORMAL telemetry). Durable writes fail closed — no optional
sub-adapter ever guards a production write.

## Execution order (each stage = one roadmap leaf = one PR)

0. This blueprint + AGENTS.md conventions (committed on the #215 branch).
1. **#215 Wait unification** — first clean-room domain: `protocol/src/wait/`
   (schema + fold), `wait` table (interim migration 0012 on the existing pipeline;
   non-optional adapter, fail-closed), kernel wait service with ONE correlation
   lookup + ONE sender-matcher core, cutover of the four waiting representations
   (~15 files / ~1,900 LOC converge), legacy rows upcast-on-read, existing-agent
   message driver (restart-quorum / duplicate-ambiguous scenarios).
2. **#510 clean ledger** — new `ledger.db` baseline via Drizzle, `append/` CAS,
   domain stores ported, legacy DB ATTACH read-only; move session's 22
   authority-decision files' logic into kernel.
3. **P3 acceleration** — #496 ipc extraction, #497–#500 protocol 30->13 and
   vocabulary convergence, #502/#505 renames, naru extraction (fixes the two
   Discord gateway bugs by re-merging the split), #503/#504 server boundary.

Known defects fixed en route: Discord heartbeat-ack never called + RESUME
token:undefined (naru re-merge), empty `SurfaceKey.clear()` called by
`IngressEngine.reset()` (FIXED — #522: fake API deleted, `Storage.reset()`
is the enforcement layer), double tool pipeline (agent wraps kernel executor —
duplicate events + double policy pass; agent half loses emission/policy),
`storage.ts` warn-and-auto-init `:memory:` (plus the test pinning it),
~3,400 LOC of test harnesses exported from src barrels (move to test/),
`agent/src/bun-test.d.ts` leaking into dist.

Full file-level disposition (484 files: KEEP 65% / REWRITE 13% / MERGE 22% /
DELETE 0.6%) was produced by the 2026-08-08 audit; re-verify per-file claims at
head when each stage executes (reconcile-first law).
