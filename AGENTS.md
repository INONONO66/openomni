# PROJECT KNOWLEDGE BASE


## OVERVIEW

OpenOmni — multi-agent task orchestration framework for LLM-powered autonomous agents. TypeScript monorepo (Bun + Turborepo) with 5 packages and 1 CLI app.

## STRUCTURE

```
openomni/
├── apps/cli/            # CLI entry point (yargs + @clack/prompts)
├── packages/
│   ├── protocol/        # Shared Zod schemas: Message, Tool, Run, Sink, Events, Agent, Artifact, Guardrail, Messenger, EventLog
│   ├── session/         # Session CRUD, Bus pub/sub, Storage adapter, Compaction, EventLog, Artifact
│   ├── llm/             # LLM abstraction: providers, OAuth, streaming, retry
│   ├── agent/           # ChatAgent core + multi-agent runtime
│   │   ├── src/core/           # ChatAgent, budget, retry, tool-guard, delegation, telemetry
│   │   │   └── execution/      # StreamEngine, ToolExecutor, compaction, parallel-tools
│   │   └── src/runtime/        # Multi-agent infrastructure
│   │       ├── messenger/      # AgentMessenger, BusTransport, InstanceRegistry
│   │       ├── registry/       # AgentRegistry
│   │       ├── tools/          # SubagentTool
│   │       └── mcp/            # McpClient, type conversion
│   └── openomni/        # Orchestration: Plan/Team mode, DAG, legacy agent code
├── turbo.json           # Build pipeline config
└── package.json         # Workspace root (bun@1.3.6)
```

## DEPENDENCY GRAPH

```
protocol  ←  session  ←  llm  ←  agent (pure ReAct)  ←  openomni (orchestration + legacy)  ←  cli
    └──────────────────────┘              ↑
    └─────────────────────────────────────┘
    └──────────────────────┘         ↑
    └────────────────────────────────┘
```

`protocol` is the leaf — zero internal deps. `session` depends on `protocol`. `llm` depends on `protocol` + `session`. `agent` (pure ChatAgent) depends on `protocol` + `llm`. `openomni` depends on all four. `cli` depends on all five.

## WHERE TO LOOK

| Task                         | Location                                              | Notes                                                                                                                   |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Add Zod schema / shared type | `packages/protocol/src/{domain}/index.ts`             | 13 domains: error, tool, message, run, sink, bus, event, notification, agent, artifact, guardrail, messenger, event-log |
| Add/modify events            | `packages/protocol/src/event/index.ts`                | BusEvent.define() pattern                                                                                               |
| Agent profile schema         | `packages/protocol/src/agent/index.ts`                | AgentProfile Zod schema                                                                                                 |
| Artifact schemas             | `packages/protocol/src/artifact/index.ts`             | Artifact.Meta, Artifact.Part schemas                                                                                    |
| Guardrail schemas            | `packages/protocol/src/guardrail/index.ts`            | ToolPermission, Guardrail, DelegationPolicy                                                                             |
| Messenger schemas            | `packages/protocol/src/messenger/index.ts`            | MessageEnvelope, AllowPattern, PersistencePolicy                                                                        |
| Execution event log schema   | `packages/protocol/src/event-log/index.ts`            | ExecutionEvent discriminated union                                                                                      |
| Session CRUD                 | `packages/session/src/session/`                       | Namespace-based API                                                                                                     |
| Storage backend              | `packages/session/src/storage/`                       | Implement `StorageAdapter` interface                                                                                    |
| Session event log            | `packages/session/src/event-log/`                     | EventLog.append/replay/listIncomplete/markComplete                                                                      |
| Session artifacts            | `packages/session/src/artifact/`                      | Artifact.store/get/list/versions                                                                                        |
| Add LLM provider             | `packages/llm/src/fetch/` + `packages/llm/src/oauth/` | One file per provider                                                                                                   |
| Provider SDK wiring          | `packages/llm/src/provider/provider.ts`               | `getSDK()` function                                                                                                     |
| Model catalog                | `packages/llm/src/model/`                             | Fetches from models.dev                                                                                                 |
| ChatAgent core               | `packages/agent/src/core/`                            | ChatAgent, budget, retry, tool-guard, delegation, telemetry                                                             |
| Agent execution engine       | `packages/agent/src/core/execution/`                  | StreamEngine, ToolExecutor, compaction, parallel-tools                                                                  |
| Agent messenger              | `packages/agent/src/runtime/messenger/`               | AgentMessenger, BusTransport, InstanceRegistry                                                                          |
| Agent registry               | `packages/agent/src/runtime/registry/`                | AgentRegistry for multi-agent lookup                                                                                    |
| Subagent tool                | `packages/agent/src/runtime/tools/`                   | SubagentTool for agent delegation                                                                                       |
| MCP client                   | `packages/agent/src/runtime/mcp/`                     | McpClient, type conversion                                                                                              |
| Plan Mode (PlanAgent)        | `packages/openomni/src/plan/`                         | PlanAgent.generate(goal, config) → PlanResult; LLM-based, no exec                                                       |
| Spec validator               | `packages/openomni/src/plan/spec-validator.ts`        | SpecValidator for plan validation                                                                                       |
| Team Mode (TeamOrchestrator) | `packages/openomni/src/team/`                         | TeamOrchestrator.execute(plan, config) → TeamResult; deterministic                                                      |
| Approval gate                | `packages/openomni/src/team/approval-gate.ts`         | ApprovalGate for human-in-the-loop approval                                                                             |
| Evaluation gate              | `packages/openomni/src/team/evaluation-gate.ts`       | EvaluationGate for step result quality checks                                                                           |
| DAG utilities                | `packages/openomni/src/dag/`                          | Pure functions: build, validateAcyclic, getReady, complete                                                              |
| Plan/Team schemas            | `packages/protocol/src/plan/` + `src/team/`           | Plan, PlanStep, PlanResult; Team.StepState, StallReason, 10 events                                                      |
| Agent profile/graph          | `packages/openomni/src/legacy/agent/`                 | Graph validation, routing, messaging                                                                                    |
| Task lifecycle               | `packages/openomni/src/legacy/task/`                  | State machine, manager, checkpoint, recovery                                                                            |
| Orchestration loop           | `packages/openomni/src/legacy/`                       | Envelope → Router → Dispatcher → Supervisor                                                                             |
| Triggers (cron/fs/webhook)   | `packages/openomni/src/legacy/trigger/`               | EventQueue + schedulers                                                                                                 |
| CLI commands                 | `apps/cli/src/cmd/`                                   | One file per command group                                                                                              |

## CONVENTIONS

See [Golden Principles](docs/golden-principles.md) for all coding invariants (enforced by `script/check-deps.ts` in CI).

Key patterns: Namespace exports (`Session.create()`), Zod-first types (`z.object` + `z.infer`), ESM only, discriminated unions, BusEvent.define() for events.

## ANTI-PATTERNS (THIS PROJECT)

- **CLI imports internals**: `apps/cli` imports deep paths like `@openomni/llm/src/auth/storage` and `@openomni/agent/src/task/manager` instead of package index. Known tech debt — do NOT extend this pattern.
- **Backward compat shims**: `Session.storage` and `Session.messages` exist for test compatibility. Use `Session.create/get/addMessage` API for new code.
- **`as any` in protocol**: `NamedError.create()` uses `(this as any).cause = options.cause`. This is the ONE exception; do not add more.

## COMMANDS

```bash
# Install
bun install

# Build all packages
bun run build          # or: turbo run build

# Test individual package
bun test               # in package dir
turbo run test         # all packages

# Type check
bun run check-types    # or: turbo run check-types

# Format
bun run format         # prettier

# Run CLI
bun run --cwd apps/cli dev           # dev mode
openomni auth login                  # after build + link
openomni agent --mode direct         # test agent
openomni agent --mode orchestrated   # full pipeline
```

## NOTES

- README.md describes project architecture, dependency graph, and getting started.
- `packages/protocol` publishes built `dist/` artifacts (`main: ./dist/index.js`). Other packages point `main` at source (`./src/index.ts`) for Bun's native TS support.
- No ESLint config present (referenced in scripts but not configured).
- CI pipeline: `.github/workflows/ci.yml` — build, check-types, tests for all packages.
- `dist/` dirs are gitignored but some exist locally — they are build artifacts, not source.
- `@ai-sdk/anthropic` and `@ai-sdk/openai` are the two bundled providers. New providers via `@ai-sdk/openai-compatible` fallback.
- `packages/agent` contains ChatAgent core (`src/core/`) with budget, retry, tool-guard, delegation, telemetry, and execution engine (StreamEngine, ToolExecutor, compaction, parallel-tools). Also contains multi-agent runtime (`src/runtime/`) with messenger, registry, subagent tool, and MCP client.
- `packages/openomni` contains orchestration (Plan/Team mode, DAG) and legacy code. Use `@openomni/openomni` for RunWorker, TaskManager, IngressEngine, etc.
- **Plan Mode** (`PlanAgent`) and **Team Mode** (`TeamOrchestrator`) are now implemented in `packages/openomni/src/plan/` and `packages/openomni/src/team/`. Plan Mode generates a structured `Plan` via LLM; Team Mode executes it with a deterministic dispatch loop (LLM used only in ReviewLoop).
- Plan/Team protocol types live in `packages/protocol/src/plan/` and `packages/protocol/src/team/` — 4 Plan schemas + 4 Team types + 10 BusEvents.
