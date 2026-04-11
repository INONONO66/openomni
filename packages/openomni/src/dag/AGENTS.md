# DAG Module

Pure dependency-graph utilities for Plan/Team mode step scheduling.
Zero external deps beyond `PlanStep` from protocol. Single file, four functions.

## API

- `DAG.build(steps)` — Constructs a `DAGStructure` from a `PlanStep[]`. Validates no duplicate IDs and all dependency references exist. O(V+E).
- `DAG.validateAcyclic(dag)` — Kahn's algorithm. Returns `{ valid: true }` or `{ valid: false, cycle: string[] }` with the offending cycle path.
- `DAG.getReady(dag, completed)` — Returns step IDs whose dependencies are all in `completed`. Used to find parallelizable work.
- `DAG.complete(dag, stepId, completed)` — Returns `{ newlyReady }` — steps unblocked by completing `stepId`. Note: callers own the `completed` set; this function is pure and does not mutate it.

## Internal

`findCycle()` — DFS cycle extractor, used only by `validateAcyclic` when Kahn's detects unvisited nodes.

## When NOT to use

DAG is structural — it knows step topology, not runtime state.
For execution tracking (retries, stalls, step results), use `RunLedger` in `src/team/`.

## Pattern

Single-file namespace module (Pattern A). `index.ts` IS the module — not a barrel.
