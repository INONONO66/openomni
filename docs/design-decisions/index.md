# Architecture Decision Records (ADR)

> Design decisions that shaped this project. Each record captures **why** a decision was made, not just what.
>
> For the overarching design principles, see [Design Philosophy](../design-philosophy.md).

## Format

Each ADR follows: Context → Decision → Rationale → Consequences.

## Records

| ADR                                          | Decision                                         | Status     |
| -------------------------------------------- | ------------------------------------------------ | ---------- |
| [001](./001-namespace-pattern.md)            | Namespace pattern over class instances           | Accepted   |
| [002](./002-zod-first-types.md)              | Zod-first type definitions                       | Accepted   |
| [003](./003-layered-package-architecture.md) | Strict layered package dependency direction      | Accepted   |
| [004](./004-stateless-chat-agent.md)         | Stateless ChatAgent separated from orchestration | Accepted   |
| [005](./005-persona-workforce-runtime.md)    | Persona workforce runtime direction              | Accepted   |
| [006](./006-persistent-subagent-team-orchestration.md) | Persistent subagent sessions (partial ship) | Superseded |

## Adding a New ADR

1. Create `docs/design-decisions/NNN-short-name.md`
2. Follow the Context → Decision → Rationale → Consequences format
3. Add entry to this index
4. Status: `Proposed` → `Accepted` | `Superseded by NNN` | `Deprecated`
