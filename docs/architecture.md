# Architecture — The Kernel in Code

This document maps [Core Model](core-model.md) onto the codebase: the target structure, the measured gap, and the migration order. Grounded in the 2026-07 full-package audit (42-agent adversarially-verified sweep) plus direct code inspection.

## Communication: Three Verbs, One Exception

Target: all communication is `ingress.submit` (world enters) / `dispatch.submit` (boundary crossed) / `bus.publish` (recorded, observe-only), with the in-process subagent as the only non-gate path.

Measured reality — seven paths exist today:

| # | Path | Verdict |
|---|---|---|
| 1 | `DispatchRuntime.submit` — policies + lifecycle events on the bus | ✅ the real gate |
| 2 | coordinator `WorkerManager.dispatch` + `supervisor.deliverMessage` — a second delivery system that shares the gate's name | rename to `deliver`, demote to a driver *under* the worker dispatch handler |
| 3 | ~40 server files importing `session` directly; PendingAsk correlation performed by the server | back doors — route through ledger/dispatch APIs; correlation returns to the kernel |
| 4 | ingress re-implements worker spawn/cancel/deliver alongside dispatch | delete; delegate to dispatch |
| 5 | `createToolExecutor` double pipeline (agent + openomni nested) — audit events emitted twice | collapse to one pipeline, one audit emission |
| 6 | Bus is in-memory microtask fire-and-forget (errors swallowed), persistence bolted on separately | see Ledger below |
| 7 | dispatch fabricates an agent-loop policy context (`steps: []`) | see Policy below |

## Ledger: Bus Is the Write API

One append-only ledger. `publish` = append (+ durable persistence — a process-crash-volatile audit log is not a ledger); `subscribe` = tail; sessions, traces, and work items are views. `WorkerRun` is absorbed into `WorkItem.attempts`, ending the double bookkeeping.

Kernel requirement: **agent-greppable export** of transcripts and the ledger. The Governor's minimal implementation is a scheduled coding-agent session over the ledger store (per Meta-Harness, arXiv:2603.28052 — improvement loops need selective access to raw traces; summaries are the losing ablation). This constrains #213: rows are fine as the primary store, but a file-form export path ships with it.

## Policy: Complete the Existing Hook Layer

The hook layer already exists and is contract-grade: protocol registers 21 policy points (`session.inbound.pre`, `dispatch.action.pre`, `run.lifecycle/turn/completion/error.*`, `prompt.context.pre`, `connection.llm.pre/post`, `tool.catalog/native/mcp.*`, `delegation.subagent/background.*`, `session.writeback.pre`) each with allowed-effects whitelist, default fail policy (pre-boundary fail-closed, post fail-open), required context, input schema, and version. Nineteen effect types cover prompt/tool/run/delegation/writeback/audit interventions.

Work remaining:

1. **Four new points + ID-grammar extension** (`memory|egress|work|schedule` prefixes): `memory.recall.pre` (scope filter), `egress.render.pre` (voice contract), `work.complete.pre` (evidence gate), `schedule.fire.pre` (cron constraints). Note: the grammar's `credential` prefix has zero registered points — consistent with the dead credentials code below.
2. **Relocate the engine**: contracts live in protocol (correct); the engine lives in `@openomni/agent` (wrong) — move to `@openomni/policy` (ring 1) and enforce per-point input schemas, which structurally eliminates the fabricated context in path 7.
3. Enforce the rulebook in [Core Model § Policy](core-model.md#policy--the-cross-cutting-hook-layer) — notably registration-time effect validation and the meta-policy that gates policy changes themselves (Owner free / Governor tighten-only / others none).

Already true and worth protecting: `delegation.subagent.pre/post` exist — the gate's one exception is not a policy exception.

## Package Rings

```
ring 0  @openomni/protocol      schemas only ("structure over instruction", physically)
ring 1  @openomni/ledger        (rename of session) bus + session + work-item + trace + actor stores
        @openomni/policy        pure judgment + the relocated engine
ring 2  @openomni/llm           model access
        @openomni/coordinator   worker process driver — verb is deliver, never a gate
ring 3  @openomni/agent         the LLM execution loop
ring 4  @openomni/kernel        (rename + shrink of openomni) ingress + dispatch
ring 5  apps/server             channel adapters + composition root; zero direct ledger imports
```

Each ring depends only inward. `check-deps` gets real rules (the current openomni/server any-except-self rule is vacuous); a shared tsconfig base ends the 8-way drift. **Resident, Governor, Jester, and Voice are not packages** — they are actor profiles and components running on the kernel (userland), which is the code translation of "all four roles are just actors".

## Extraction / Merge / Delete Ledger

**Extract (wrong home → right home):** PolicyEngine agent → policy; Bus session → ledger core; PendingAsk correlation server → kernel.

**Merge (two implementations → one):** WorkerRun → WorkItem.attempts; ingress's worker spawn/cancel/deliver → dispatch handlers (coordinator becomes the `deliver` driver beneath them); tool-executor double pipeline → one kernel path with a single audit emission; server session back doors → ledger/dispatch APIs.

**Delete (audit-confirmed dead, ~5–6k LOC):** openomni `extension/` (entire), `profile/`, half of `skill/` manager (SkillLoader survives), orphaned policy resolver; server connector registry/discovery/definitions and `router.ts`; session storage drizzle tree + dep, Snapshot, backgroundTask adapter, WalMaintenance; coordinator `credentials/` and `tool-permission/`; the llm retry stack (unreachable in production, `maxRetries: 0`) and 6 of 7 error classes; agent writeback-policy, empty tools barrel, write-only AgentRegistry.

**Hygiene:** protocol barrel farm (31/68 index.ts) trimmed; 29 sub-30-LOC single-importer micro-files merged; the word "runtime" (currently 7 meanings) restricted to agent loop / worker process / kernel.

**Recurrence guard: abstraction is earned.** No extraction before a second consumer exists — the same evidence-based promotion pattern as Workers and data ingestion. Every dead module above was a pre-extracted abstraction.

## Code Conventions (absorbed from ADR-001–004)

- **Namespaces over classes.** Public API is `Namespace.method()`, never `new Class()`. `new` is internal-only; no inheritance hierarchies; state via module-level variables or injected `configure()` patterns. Sole exception: `NamedError.create()` (needed for `instanceof`).
- **Zod-first types.** Every cross-package contract is a Zod schema first, `z.infer<>` second, sharing one name. No standalone `interface` for shared contracts; validate at boundaries with `.parse()`; discriminated unions for state shapes. Runtime-only members extend via `&` intersection.
- **Strict inward dependencies.** Each ring depends only inward (see rings above); reverse imports are build failures; cross-package imports go through the root barrel only — no deep imports. The server must not import the agent loop directly; all agent work flows through the kernel. Enforced by `script/check-deps.ts` in CI.
- **Stateless ChatAgent.** The agent loop is a function-style primitive (messages + tools in, events out via `AsyncGenerator`); it owns no session lifecycle or durable state — sinks and transports are injected. Session-backed orchestration lives above it. Extension happens through the policy engine, not subclassing.
- **Native tools first.** First-party capabilities are in-process native tools; MCP is reserved for genuinely external boundaries. Wrapping our own code behind MCP adds a serialization hop and hides it from the policy pipeline.
- **Scheduling is deferred ingress.** A scheduled job is `ingress.submit` with a later timestamp — there is no separate queue subsystem or queue tool; cron fires back into the same single entry path.

## Known Bugs (audit-confirmed)

1. llm model-catalog weekly refresh writes to `src/provider/` while the runtime reads `src/model/` — the catalog never updates.
2. `run.ts adaptStream` is an ai-v4 shim duplicating v6 `text-start/end` — emits empty text parts.
3. Resident agent definition drifts across 2 paths (stale hardcoded model fallback).

## Migration Phases

| Phase | Content |
|---|---|
| **P0 clean** | delete the dead-code list, fix the 3 bugs; reconcile with `feat/foundation-restructure` |
| **P1 one channel** | enforce the three verbs: coordinator rename/demote, close server back doors, delete ingress double implementation, single tool-executor, cut dispatch's agent coupling |
| **P2 one ledger** | WorkerRun absorption, durable bus as the ledger write path, greppable export (the heart of #213) |
| **P3 rings** | package moves/renames, real check-deps rules, tsconfig base |
| **P4 roles** | Resident demoted to a judgment-only shell profile, Jester, Voice egress, Governor MVP (scheduled coding-agent session over the ledger) |
