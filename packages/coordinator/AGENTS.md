# packages/coordinator

Multiprocess execution coordinator runtime. This package owns worker pool lifecycle, IPC transport, recovery, credentials/policy helpers, and the worker entrypoint used by server-side dispatch.

## STRUCTURE

```
src/
├── index.ts              # Package barrel
├── credentials/          # Worker credential filtering and injection
├── ipc/                  # Unix socket transport + framing + protocol errors
├── metrics/              # In-memory metrics registry and event-loop lag measurement
├── recovery/             # Interrupted worker run recovery
├── tool-permission/      # Non-interactive permission policy + audit log
└── worker-pool/          # Worker routing, supervision, and worker entrypoint
```

## DEPENDENCIES

Depends on `@openomni/protocol`, `@openomni/session`, `@openomni/agent`, and `@openomni/openomni` because the coordinator reconstructs real execution in worker processes.

## MODULES

| Module | Purpose |
|--------|---------|
| `credentials/store.ts` | Loads stored credentials and filters them by provider prefix |
| `credentials/injector.ts` | Injects provider-scoped credentials into workers |
| `ipc/*` | Request/response framing, client/server transport, and protocol errors |
| `metrics/*` | MetricsRegistry, collectMetrics, and event-loop lag measurement |
| `recovery/index.ts` | Marks interrupted worker runs failed after restart |
| `tool-permission/*` | Policy load + audit logging for non-interactive tool decisions |
| `worker-pool/pool.ts` | Public worker-pool factory |
| `worker-pool/supervisor.ts` | Worker lifecycle and restart management |
| `worker-pool/session-routing.ts` | Session-tree affinity routing |

## ANTI-PATTERNS

- Do NOT deep-import from `@openomni/*/src/*`; use package barrels only.
- Do NOT add empty catch blocks; coordinator needs explicit degradation behavior.
- Do NOT add generic catch-all files like `utils.ts` or `helpers.ts`.
- Do NOT put session-backed orchestration policy here; coordinator executes and recovers worker processes, while `@openomni/openomni` owns orchestration semantics.
