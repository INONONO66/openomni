# Architecture Decision Records

Design decisions that shaped OpenOmni. Each record captures **why** a decision was made, not just what. For the overarching design principles, see [Design Philosophy](../design-philosophy.md).

## How the project evolved

**Foundation (001–003)** — Established the code-level conventions: namespaces over classes, Zod-first type contracts, and a strict layered dependency graph. These are the mechanical invariants that every package still follows.

**Agent architecture (004)** — Separated the stateless ChatAgent loop from session-backed orchestration. This split defined the boundary between `agent` (execution) and `openomni` (orchestration) that persists today.

**Product model (005)** — Introduced the workforce model: a single user-facing Resident delegates to specialized Workers through controlled inbound authority. This decision shaped ingress, session hierarchy, and delegation design. (Uses older "Main Persona / Sub Persona" terminology; see [Core Model](../core-model.md) for current terms.)

**Runtime capabilities (006–008)** — Built out multi-agent execution. ADR-006 shipped SubagentRuntime and BackgroundManager (team orchestration pieces were dropped). ADR-007 proposed the Policy Kernel v2 governance VM. ADR-008 proposed replacing the fixed worker pool with a lightweight in-process Resident and on-demand worker processes.

## Records

| ADR | Decision | Status |
|-----|----------|--------|
| [001](./001-namespace-pattern.md) | Namespace pattern over class instances | Accepted |
| [002](./002-zod-first-types.md) | Zod-first type definitions | Accepted |
| [003](./003-layered-package-architecture.md) | Strict layered dependency direction | Accepted |
| [004](./004-stateless-chat-agent.md) | Stateless ChatAgent separated from orchestration | Accepted |
| [005](./005-persona-workforce-runtime.md) | Workforce model: single Resident, controlled delegation | Accepted |
| [006](./006-persistent-subagent-team-orchestration.md) | Persistent subagent sessions (partial ship) | Superseded |
| [007](./007-policy-kernel-v2.md) | Policy Kernel v2 governance VM | Proposed |
| [008](./008-lightweight-main-persona-on-demand-workers.md) | Lightweight Resident + on-demand workers | Proposed |

## Adding a New ADR

1. Create `docs/design-decisions/NNN-short-name.md`
2. Follow the Context → Decision → Rationale → Consequences format
3. Add entry to this index
4. Status: `Proposed` → `Accepted` | `Superseded by NNN` | `Deprecated`
