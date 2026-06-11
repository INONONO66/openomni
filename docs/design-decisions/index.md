# Architecture Decision Records

Design decisions that shaped OpenOmni. Each record captures **why** a decision was made, not just what. For the overarching design principles, see [Design Philosophy](../design-philosophy.md).

## How the project evolved

**Foundation (001–003)** — Established the code-level conventions: namespaces over classes, Zod-first type contracts, and a strict layered dependency graph. These are the mechanical invariants that every package still follows.

**Agent architecture (004)** — Separated the stateless ChatAgent loop from session-backed orchestration. This split defined the boundary between `agent` (execution) and `openomni` (orchestration) that persists today.

**Product model (005)** — Introduced the workforce model: a single user-facing Resident delegates to specialized Workers through controlled inbound authority. This decision shaped ingress, session hierarchy, and delegation design. (Uses older "Main Persona / Sub Persona" terminology; see [Core Model](../core-model.md) for current terms.)

**Runtime capabilities (006–008)** — Built out multi-agent execution. ADR-006 shipped SubagentRuntime and BackgroundManager (team orchestration pieces were dropped). ADR-007 proposed the Policy Kernel v2 governance VM. ADR-008 replaced the fixed worker pool with a lightweight in-process Resident and on-demand worker processes — its core (OnDemandWorkerManager, ResidentRuntime) has shipped.

**External actors (009)** — Extends the workforce model to external humans and AI agents. Defines the 3-axis actor taxonomy, dual allow-list access control (channel + actor), durable PendingInteraction registry for async response correlation, explicit session ownership, and `executorKind`-based WorkerRun dispatch. Includes five end-to-end scenarios and the canonical seven-category vocabulary map. Builds on ADR-005's controlled inbound authority principle.

**Agent OS model (010)** — Names the organizing architecture the runtime has been converging on: a kernel/userland split (structural guarantees vs prompt conventions), PendingInteraction as the blocking-wait primitive for all external latency (humans, external AI, CI), CLI coding agents as installed applications (`local_cli_agent`, connector philosophy: observe the boundary, don't manage the inside), three execution lanes (built-in / dispatch action / worker) with the effect-radius rule for tools vs dispatch, the task ledger (WorkItem) with completion reports and the evidence gate ("no evidence = not done"), the Governor as an incident-driven postmortem engine (RCA, fingerprints, tighten-autonomous/loosen-approval, ratchet-through-the-same-pipeline), a pluggable memory engine port (Hermes pattern: built-in curation + external engines), a durable boot contract, and a social-budget axis for human outreach. Implementation truth lives in [Implementation Status](../implementation-status.md).

## Records

| ADR | Decision | Status |
|-----|----------|--------|
| [001](./001-namespace-pattern.md) | Namespace pattern over class instances | Accepted |
| [002](./002-zod-first-types.md) | Zod-first type definitions | Accepted |
| [003](./003-layered-package-architecture.md) | Strict layered dependency direction | Accepted |
| [004](./004-stateless-chat-agent.md) | Stateless ChatAgent separated from orchestration | Accepted |
| [005](./005-persona-workforce-runtime.md) | Workforce model: single Resident, controlled delegation | Accepted |
| [006](./006-persistent-subagent-team-orchestration.md) | Persistent subagent sessions (partial ship) | Superseded |
| [007](./007-policy-kernel-v2.md) | Policy Kernel v2 governance VM | Proposed (reframed by 010 as future loadable-policy mechanism) |
| [008](./008-lightweight-main-persona-on-demand-workers.md) | Lightweight Resident + on-demand workers | Accepted |
| [009](./009-external-actor-authority-model.md) | External actor authority & communication model | Accepted |
| [010](./010-agent-os-kernel-model.md) | Agent OS kernel model | Proposed |

## Adding a New ADR

1. Create `docs/design-decisions/NNN-short-name.md`
2. Follow the Context → Decision → Rationale → Consequences format
3. Add entry to this index
4. Status: `Proposed` → `Accepted` | `Superseded by NNN` | `Deprecated`
