# Agent core rewrite — execution SOT

Source of truth for [#606](https://github.com/INONONO66/openomni/issues/606). The issue holds the outcome statement; this file holds the plan, the decisions, the falsifiable boundary rules, and live PR status. When they disagree, this file wins and the issue gets corrected.

## Outcome

`@openomni/agent` becomes a turn state machine whose only extension mechanism is the policy point, with a working compaction pipeline and constant-cost policy dispatch. Observation moves out of the ledger package into `@openomni/telemetry`, so `agent` and `llm` carry no dependency on durable storage.

The target is a base harness that survives comparison with [pi](https://github.com/badlogic/pi-mono), [senpi](https://github.com/code-yeongyu/senpi), and [pss-runtime](https://github.com/minpeter/pss-runtime) on its own terms — not by matching their feature surface, but by owning the layer none of them has.

## Why this shape

The three peer runtimes disagree on one axis and agree on another.

They **agree** that the provider/model layer is its own package below the loop: `pi-ai`, senpi's `ai`, pss's `llm/`, our `@openomni/llm`. We already match.

They **disagree** on whether tools, session persistence, system prompts, and compaction belong inside the agent package. `pi-agent-core` says yes — its loop is 23 lines of `.d.ts` and the bulk is `harness/{tools,session,skills,system-prompt,compaction}`. pss says no: no tools at all, an injected executor, `thread/` owning conversation state, `fsm/` owning the loop as an explicit state machine. senpi started as pi and is migrating toward pss — it has grown `protocol`, `server`, `client`, and `storage/sqlite-node` as separate packages.

**We are already on the pss side of that split and should stay there.** For us the harness content is product and lives in `apps/server` and the ledger.

What none of them has is a **policy point kernel**. pi offers three untyped hooks (`beforeToolCall`, `afterToolCall`, `shouldStopAfterTurn`). senpi ships permissions as *an extension*. pss has nothing. We have 18 registered points with contract validation, declared effect capabilities, per-point fail-closed/fail-open, and deny-wins composition.

**So the core's reason to exist is "loop + policy seam", not "loop + batteries."** Every decision below follows from that.

## Package ownership

Each rule below is falsifiable. A reviewer should be able to point at a line and say it violates one.

| package | owns | must not own | boundary test |
|---|---|---|---|
| `@openomni/protocol` | vocabulary: schemas, event descriptors, `PolicyPoint.Registry`, `PolicyEffect`, `BusEvent.Sink` | any behavior | importing it does nothing — no side effects, no globals, no I/O |
| `@openomni/telemetry` *(new)* | the single observation channel: `Bus`, trace-owning scoped emitter, span pairing, sink combinators. `Visibility` stays a protocol vocabulary term; telemetry applies it, it does not own it | what to record (protocol), where to store (ledger), decisions (policy) | **replacing it with no-ops leaves agent behavior bit-identical** |
| `@openomni/policy` | the decision kernel: `dispatchPoint`, contract validation, registration/scope/priority, undeclared-effect rejection, composition | policy *content*, when points fire, what reaches the ledger | the engine returns decisions and never applies an effect itself |
| `@openomni/llm` | one model round trip: providers, catalog, auth, request assembly, stream→message fold, tool-call protocol, token accounting | the conversation loop, tool *execution*, policy, history ownership | when `run()` returns, llm's work is over — "next turn" does not exist inside it |
| `@openomni/agent` | the turn state machine: run/turn lifecycle, the order and timing of the 12 injection points, effect application, retry control flow, history, counters, spans | tool implementations, MCP, system prompt text, session persistence, compaction *strategy*, default policy content | **zero domain string literals in core files** — no prompt text, tool names, policy names, or magic strings like `"stalled"` |

Consequence worth stating plainly: once the import conversion lands, `llm` becomes protocol-only and `agent` carries no dependency on durable storage — and `script/check-deps.ts` can then drop `@openomni/session` from both allowlists, so the boundary is enforced rather than conventional. Relocating `Bus` is what makes that possible; it does not by itself achieve it. Eight of the nine `Bus` imports in `packages/agent/src` still resolve through `@openomni/session`, and both `llm` files do — that conversion is Phase 1b.

## Decisions

| # | decision | rationale |
|---|---|---|
| D1 | Split `Bus` into `@openomni/telemetry` **before** [#502](https://github.com/INONONO66/openomni/issues/502) renames `session` → `ledger` | #502's scope keeps `bus/audit` as part of the "approved public ledger observation surface". Landing it first makes a `queueMicrotask` channel — whose own writer documents it as *"never a decision or authorization fact"* — the public API of a package named `ledger`. There is already one casualty of that ambiguity: `AuditLog.append()` publishes to the lossy Bus, not to any ledger. |
| D2 | The core takes injected ports (`sink`, `policy`, `llm`); no module-level globals | `BusEvent.Sink` already exists in protocol for exactly this and every ring-2 driver bypasses it. Injection is also what lets openomni bind a sink that promotes deny/abort to durable facts without the core knowing. |
| D3 | One output channel (`Sink`). Delete the `AgentEvent` generator and `ChatAgent.stream` | `stream()` has no production consumer; `run()` drains the generator to pick one `complete` event. The generator's `turnToolCalls`/`turnToolResults` buffers exist only to re-broadcast what the Sink already forwarded live. |
| D4 | FSM as a **guard**, not a driver — run and turn only | pss proves the shape costs ~108 LOC. The transition table doubles as the injection-point map, terminal states have no outgoing edges (making "started with no terminal" unrepresentable), and the state tag is serializable, so resume can be layered on later without touching the core. Explicitly not applied to tool execution or policy composition. |
| D5 | No `builtin/` tier. Mechanism folds into the core; opinions register through the public policy API | `defaultRegistry()` was a privileged second-class extension path only we could use. Budget *limits*, tool timeout, and loop-breaking are loop invariants (config-driven, in core). Budget nagging, idle-nudge, and permission rulesets are opinions (openomni registers them like any consumer). The core ships **zero policies** — it ships the points. |
| D6 | Compaction lives in `agent/src/compaction/` as pure modules; strategy opinions come in as config | It is not optional: a loop that cannot survive its own context window is broken, not unopinionated. But the *boundary invariant* — a kept window must start at a user message or the provider rejects it — is mechanism, true regardless of strategy, and belongs in core where every `run.replace_messages` application passes through it. |
| D7 | Summarization uses the run's model | senpi does the same. A cheaper summarizer degrades every downstream turn. |
| D8 | Speculative compaction overlaps the in-flight model call; **application stays at one deterministic seam** | Computing during the model's network wait is free. Applying at an arbitrary moment is not: it would make two identical runs produce different histories and break resume-by-replay. Compute in background, apply at `run.completion.pre`, record the applied result as the effect. |
| D9 | Idle warm-up between runs is **openomni's**, not the core's | senpi's `agent_end` warm-up exploits human thinking time. Our workers are headless — there is no idle *inside* a run. Idle exists between runs, which requires a session outliving the run, which is `Wait`/work-item territory. openomni can layer it on the exported pure modules. |
| D10 | Approval-and-resume is out of scope; `tool.require_approval` stays fail-closed as a denial | Real approval means the run suspends and resumes, which needs durable `Wait` ([#215](https://github.com/INONONO66/openomni/issues/215)). The FSM reserves a state for it. |
| D11 | Opaque trace ids convert **at the origin**, never in the emitter. No normalizing adapter exists, and a test pins its absence | `requireTraceScope` takes W3C 32-hex; 114 sites across 43 files still pass a dashed `crypto.randomUUID()` as `traceId`. Those are per-line ids wearing a trace's name — each one correlates to exactly one row. A normalizer would make them *look* correlated while leaving every caller minting its own vocabulary, so the shortcut is refused: Phase 1b converts each site to inherit a scope, or to mint via `newTraceId()` where it is a genuine origin. Until then `scope()` is on no production path. |

## The 12 injection points

The order the loop dispatches them. This table is the contract a policy author reads.

| # | point | site | effects available |
|---|---|---|---|
| P1 | `run.lifecycle.pre` | run start | block, `prompt.inject_message`, `prompt.append_context` |
| P2 | `run.turn.pre` | each turn | block, `run.retry_after`, prompt injection |
| P3 | `prompt.context.pre` | system prompt assembly | `prompt.replace`, `prompt.append_context` |
| P4 | `tool.catalog.pre` | tool selection | `tool.filter`, block |
| P5 | `connection.llm.pre` | before the model call | block, prompt injection |
| P6 | `tool.{native,mcp}.pre` | per tool call, **fail-closed** | deny, `tool.skip_invocation`, `tool.rewrite_input`, `tool.require_approval`, `runtime.set_timeout` |
| P7 | `tool.{native,mcp}.post` | per tool result, fail-open | `tool.rewrite_output`, `run.abort` |
| P8 | `connection.llm.post` | after the model call | `run.replace_messages` |
| P9 | `run.turn.post` | turn settlement | `run.continue_with_prompt`, `run.abort` |
| P10 | `run.completion.pre` | compaction seam | `run.replace_messages` |
| P11 | `run.lifecycle.post` | run end | transform |
| P12 | `run.error.error` | error path | `run.abort`, `run.retry_after` |

Effect vocabulary is 20 types; the agent applies 11. **Every declared type must either gain an application site or be deleted** — `runtime.set_timeout` gets the former (tool timeout), the rest are audited in Phase 4.

Six points the agent dispatches have no production registration, along with two dispatched elsewhere. Ruling tracked in [#609](https://github.com/INONONO66/openomni/issues/609); it is not a blocker for this work.

## Phases

Status legend: ⬜ not started · 🟨 in review · ✅ merged

### Phase 0 — groundwork

| PR | title | status |
|---|---|---|
| [#607](https://github.com/INONONO66/openomni/pull/607) | benchmark dispatch cost against history length | ✅ |
| [#608](https://github.com/INONONO66/openomni/pull/608) | skip context materialization at unguarded points | ✅ |

### Phase 1 — telemetry

| PR | title | status |
|---|---|---|
| [#612](https://github.com/INONONO66/openomni/pull/612) | create `@openomni/telemetry`, move `Bus`, add scope/span/sink; `session` re-exports for compatibility | 🟨 |
| — | `agent` and `llm` take an injected `Sink`; both drop `@openomni/session` | ⬜ |
| [#612](https://github.com/INONONO66/openomni/pull/612) | move `TraceContext` off `packages/session` — it owned a second, contradictory trace convention | 🟨 |
| — | convert the 114 opaque-`traceId` emit sites (D11): inherit a scope, or mint at a genuine origin | ⬜ |
| — | `openomni`/`server` import-path cleanup; remove the compatibility re-export | ⬜ |

### Phase 2 — core

| PR | title | status |
|---|---|---|
| [#610](https://github.com/INONONO66/openomni/pull/610) | delete the unimplemented second event channel | ✅ |
| — | single output channel: remove the `AgentEvent` generator and `ChatAgent.stream` | ⬜ |
| — | file layout + FSM; slop comments, duplicate helpers, the last `as unknown as`, `agentBaseForState` | ⬜ |
| — | drop the policy snapshot's `eventEmitter` carve-out — unreachable since #610, and `point-context-immutability.test.ts` asserts behavior with no production producer | ⬜ |
| — | dissolve `builtin/` per D5 | ⬜ |
| — | retry no longer double-counts the turn budget | ⬜ |

### Phase 3 — compaction

| PR | title | status |
|---|---|---|
| — | remove the dead pipeline: `InMemoryCompactor`, `builtin:compaction`, `handleCompact`, the `Run.Outcome.compact` variant, middleware wiring | ⬜ |
| — | `compaction/`: measure, adaptive policy with yield feedback, guard | ⬜ |
| — | deterministic no-LLM reduction, cut planning, incremental summarization | ⬜ |
| — | speculative overlap and bounded overflow retry | ⬜ |

### Phase 4 — lock

| PR | title | status |
|---|---|---|
| — | boundary rules in `lint-guards.ts`; baselines; structure docs; `packages/agent/AGENTS.md` rewrite | ⬜ |

Then [#502](https://github.com/INONONO66/openomni/issues/502) runs against a `session` package that holds only durable facts.

## What Phase 4 locks

Each becomes a `script/lint-guards.ts` rule, so the boundary survives the next contributor:

1. Core files (`run.ts`, `turn.ts`, `tools.ts`, `effects.ts`, `state.ts`) contain no domain string literals.
2. `packages/agent/src/pure/` may not import the telemetry package.
3. Core may not import `builtin/`.
4. No `crypto.randomUUID()` in a `traceId` position.
5. The set of policy points with zero production registration equals an explicit allowlist — a point silently losing its last registration fails CI.

## Measurement

`script/bench-policy-dispatch.ts`, committed artifact `script/bench-policy-dispatch.result.json`. Median of five interleaved rounds, 2000 iterations, `run.turn.pre`, engine binding a no-op `auditEmit` (the conservative agent-loop configuration).

Baseline before Phase 0, 512-message history, zero registered policies:

| context shape | ns/dispatch | growth 8→512 |
|---|---|---|
| correlated | 2,090,990 | 45.6× |
| minimal | 2,095,558 | 51.9× |

The loop dispatches ~12 points per turn and the history grows every turn, so a dispatch cost that tracks history makes a run pay O(turns² · messages).

**Rules of engagement**: any PR in this plan that changes dispatch or loop cost regenerates the artifact and states the delta. Growth factor is quoted as "constant" or with a stated ± — on a ~1.6 µs measurement, two decimal places overstate precision by an order of magnitude.

## Discipline

Beyond AGENTS.md § EXECUTION DISCIPLINE, which applies in full:

- **Every behavior change is pinned red-first.** A test added alongside a fix is verified to fail without the fix. Two defects in Phase 0 were caught this way and one was missed because the test used an accessor that returned rather than one that threw.
- **A deletion carries its zero-consumer proof in the PR body**, regenerated against the current tree rather than quoted from an issue.
- **A required field is required in the type, not only at runtime.** Three rounds of review each found a caller that satisfied a required schema by omission, because the guard was a runtime throw behind an optional parameter. `DispatchSubmitOptions.traceId` is required by type; the throw remains only for untyped callers (`Reflect.apply`, JSON-shaped IPC params).
- **Type-checking blind spots hide exactly this class of defect.** `apps/server`, `packages/agent`, `packages/llm`, `packages/openomni`, `packages/protocol`, and `packages/session` all set `include: ["src"]`, so their tests are never type-checked. A required `traceId` broke 25 `new McpToolProvider()` call sites and a stray argument sat in a `Promise` constructor, both invisible to `check-types`. Bringing those tests under a `tsconfig.test.json` surfaces ~60 further errors and is tracked separately — it is not free, and it is not this PR. Not all of that debt is pre-existing: this PR's own API changes added errors in `agent`, `llm`, `openomni`, and `session` test code that only a test-inclusive config revealed, and they were fixed by running one. A gate that cannot see a file cannot ratchet it.
- **Adversarial review is a separate session** that re-runs the suites itself and tries to refute the PR body. Phase 0's reviewer returned BLOCK on a real defect the author's green run did not surface.
