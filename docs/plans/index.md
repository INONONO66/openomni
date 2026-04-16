# Execution Plans — Status Index

> Plans live in `.sisyphus/plans/`. This index tracks their status.

Last updated: 2026-04-17

## Completed

| Plan                                     | PR                                                                  | Description                                                |
| ---------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `session-refactor.md`                    | [#17](../../.sisyphus/plans/session-refactor.md)                    | Session package convention compliance refactoring          |
| `refactor-protocol.md`                   | [#18](../../.sisyphus/plans/refactor-protocol.md)                   | Protocol package cleanup and domain-based reorganization   |
| `refactor-agent-modular-architecture.md` | [#19](../../.sisyphus/plans/refactor-agent-modular-architecture.md) | Agent package modular architecture (loop/ → 10 domains)    |
| `restructure-agent-domains.md`           | [#19](../../.sisyphus/plans/restructure-agent-domains.md)           | Decompose loop/ into domain folders (part of modular arch) |
| `flatten-sub-domains.md`                 | [#19](../../.sisyphus/plans/flatten-sub-domains.md)                 | Merge over-split sub-domains (part of modular arch)        |
| `session-persistence.md`                 | [#20](../../.sisyphus/plans/session-persistence.md)                 | Session history persistence with FileStorageAdapter        |
| `agent-package-split.md`                 | [#21](../../.sisyphus/plans/agent-package-split.md)                 | Split agent into pure ChatAgent + openomni orchestration   |
| `llm-cleanup.md`                         | [#16](../../.sisyphus/plans/llm-cleanup.md)                         | LLM package dead code removal and namespace consolidation  |
| `plan-team-mode.md`                      | [#29](../../.sisyphus/plans/plan-team-mode.md)                      | Plan Mode + Team Mode multi-agent execution pipeline       |
| `ingress-engine.md`                      | [#30](../../.sisyphus/plans/ingress-engine.md)                      | IngressEngine session management and mode routing          |
| `adapter-hardening.md`                   | [#28](../../.sisyphus/plans/adapter-hardening.md)                   | Adapter layer resilience (gateway, triggers, SurfaceKey)   |

## Superseded / Abandoned

| Plan                          | Reason                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `agent-layer-redesign.md`     | Superseded — split into `agent-package-split.md` (Phase 1) + plan-team-mode (Phase 2)      |
| `planner-identity-upgrade.md` | Abandoned — target file (`apps/cli/src/agent/planner.ts`) removed during CLI restructuring |
| `plan-team-mode.md` (Team)    | Superseded — Team mode removed; persistent subagent shipped as `SubagentRuntime` + `BackgroundManager` |

## Active

None — all plans completed or archived.
