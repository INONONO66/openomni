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

Consequence, now realised: `llm` depends on protocol and telemetry only, and `agent` carries no dependency on durable storage. `script/check-deps.ts` no longer lists `@openomni/session` in either allowlist and neither manifest declares it, so the boundary is enforced rather than conventional — reopening either edge fails the gate. Relocating `Bus` made it possible; converting the nine imports is what achieved it.

## Decisions

| # | decision | rationale |
|---|---|---|
| D1 | Split `Bus` into `@openomni/telemetry` **before** [#502](https://github.com/INONONO66/openomni/issues/502) renames `session` → `ledger` | #502's scope keeps `bus/audit` as part of the "approved public ledger observation surface". Landing it first makes a `queueMicrotask` channel — whose own writer documents it as *"never a decision or authorization fact"* — the public API of a package named `ledger`. There is already one casualty of that ambiguity: `AuditLog.append()` publishes to the lossy Bus, not to any ledger. |
| D2 | The core takes injected ports (`sink`, `policy`, `llm`); no module-level globals | `BusEvent.Sink` already exists in protocol for exactly this and every ring-2 driver bypasses it. Injection is also what lets openomni bind a sink that promotes deny/abort to durable facts without the core knowing. |
| D3 | One output channel (`Sink`). Delete the `AgentEvent` generator and `ChatAgent.stream` | `stream()` has no production consumer; `run()` drains the generator to pick one `complete` event. The generator's `turnToolCalls`/`turnToolResults` buffers exist only to re-broadcast what the Sink already forwarded live. |
| D4 | FSM as a **guard**, not a driver — run and turn only | pss proves the shape costs ~108 LOC. The transition table doubles as the injection-point map, terminal states have no outgoing edges (making "started with no terminal" unrepresentable), and the state tag is serializable, so resume can be layered on later without touching the core. Explicitly not applied to tool execution or policy composition. **Amended after #633 (closed).** The run half of this is already delivered, by construction rather than by assertion: #631 routed every returning exit through one `finish`, and #632 gave the runner both terminals, so a run cannot leave without recording one. A machine layered on top adds a second, weaker model of that fact — and a second model can disagree with reality, which #633's did three times, turning retryable failures into hard ones. The injection-point claim did not survive either: the map that was supposed to double as the table was partly wrong and two-thirds incomplete, with no reader. If a machine is wanted later it should be for a property the code does not already have — resume, or the turn half — and the map has to be total and read by something. |
| D5 | No `builtin/` tier. Mechanism folds into the core; opinions register through the public policy API | `defaultRegistry()` was a privileged second-class extension path only we could use. Budget *limits*, tool timeout, and loop-breaking are loop invariants (config-driven, in core). Budget nagging, idle-nudge, and permission rulesets are opinions (openomni registers them like any consumer). The core ships **zero policies** — it ships the points. |
| D6 | Compaction lives in `agent/src/compaction/` as pure modules; strategy opinions come in as config | It is not optional: a loop that cannot survive its own context window is broken, not unopinionated. But the *boundary invariant* — a kept window must start at a user message or the provider rejects it — is mechanism, true regardless of strategy, and belongs in core where every `run.replace_messages` application passes through it. |
| D7 | Summarization uses the run's model | senpi does the same. A cheaper summarizer degrades every downstream turn. |
| D8 | Speculative compaction overlaps the in-flight model call; **application stays at one deterministic seam** | Computing during the model's network wait is free. Applying at an arbitrary moment is not: it would make two identical runs produce different histories and break resume-by-replay. Compute in background, apply at `run.completion.pre`, record the applied result as the effect. |
| D9 | Idle warm-up between runs is **openomni's**, not the core's | senpi's `agent_end` warm-up exploits human thinking time. Our workers are headless — there is no idle *inside* a run. Idle exists between runs, which requires a session outliving the run, which is `Wait`/work-item territory. openomni can layer it on the exported pure modules. |
| D10 | Approval-and-resume is out of scope; `tool.require_approval` stays fail-closed as a denial | Real approval means the run suspends and resumes, which needs durable `Wait` ([#215](https://github.com/INONONO66/openomni/issues/215)). The FSM reserves a state for it. |
| D11 | Opaque trace ids convert **at the origin**, never in the emitter. No normalizing adapter exists, and a test pins its absence | `requireTraceScope` takes W3C 32-hex; 102 sites across 39 files still write a minted uuid into `traceId`. Measure it with `grep -rn randomUUID --include='*.ts' packages/*/src apps/*/src | grep -i traceid` — bare `randomUUID()` imports count too, and an earlier `crypto.randomUUID`-only grep undercounted by three. Those are per-line ids wearing a trace's name — each one correlates to exactly one row. A normalizer would make them *look* correlated while leaving every caller minting its own vocabulary, so the shortcut is refused: Phase 1b converts each site to inherit a scope, or to mint via `newTraceId()` where it is a genuine origin. Until then `scope()` is on no production path. |

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
| [#612](https://github.com/INONONO66/openomni/pull/612) | create `@openomni/telemetry`, move `Bus`, add scope/span/sink; `session` re-exports for compatibility | ✅ |
| [#616](https://github.com/INONONO66/openomni/pull/616) | `agent` and `llm` drop `@openomni/session`; the allowlists close behind them | ✅ |
| [#617](https://github.com/INONONO66/openomni/pull/617), [#618](https://github.com/INONONO66/openomni/pull/618) | `agent` and `llm` take an injected `Sink` rather than importing `Bus`; both `src/` trees are gate-enforced | ✅ |
| [#612](https://github.com/INONONO66/openomni/pull/612) | move `TraceContext` off `packages/session` — it owned a second, contradictory trace convention | ✅ |
| [#613](https://github.com/INONONO66/openomni/pull/613), [#615](https://github.com/INONONO66/openomni/pull/615) | convert every opaque-`traceId` site in `packages/agent/src` (D11) — 13 + 3, the package now mints none | ✅ |
| [#653](https://github.com/INONONO66/openomni/pull/653) | D11 batch 1 — 45 of 102: every pure origin mints W3C (`newTraceId()`), the boot sweep inherits ONE trace through recovery/shutdown/config/messaging (was 10+ unrelated ids per boot), discord's close→reconnect chain carries one id, the coordinator's queue-saturation and wall-time-kill events carry the run's own trace, and the channels band contract (#499 gate) widens to the leaf telemetry package because channels ARE trace origins | ✅ |
| [#654](https://github.com/INONONO66/openomni/pull/654) | D11 batch 2 — the keystone: `Adapter.InboundMessage`, the shared ingress `InboundEventBase`, and `Surface.start/stop` carry required `traceId`; `ingest`/`ingestInternal` inherit instead of re-minting; each channel mints ONE origin per inbound frame (discord threads it from `handleDispatch`, the true first frame) shared by every emitter down to `sendTyping`/`postComment` and the run itself; the cron job's trace rides `CronAdapter.fire` into the internal event — 57 → 33 sites | ✅ |
| [#655](https://github.com/INONONO66/openomni/pull/655) | D11 batch 3 — 33 → 17: the entire `WorkItemStore` mutation API takes a required trace, so one state transition publishes under ONE id (was 3); completion-admission's request carries its trace through the terminal commit's three events; the persistence backstop's mint becomes the loud `"untraced"` sentinel (a random id laundered an untraceable event into the ledger hash; refusing would drop the observe-only record); the effects reconciler escalation inherits its caller | ✅ |
| [#656](https://github.com/INONONO66/openomni/pull/656) | D11 batch 4 — 17 → 7: the `Scheduler` owner carries `command.traceId`; `resolveDefaultProviderModel` splits boot-inherit from a CLI origin; fetch-retry's recursion shares ONE id per logical request through all three channel clients; the websocket upgrade mints once and carries it on the auth state; the context loaders finally read the policy ctx that `middleware.ts` had been discarding (refuse, not fallback, when traceContext is absent); discord `onReady` is its own occurrence ([#657](https://github.com/INONONO66/openomni/pull/657) follow-up: the refuse pin also asserts the recorded middleware error — refuse-and-report, not silence). What remains is exactly coordinator's **Owner-gated** seven | ✅ |
| — | D11 remainder — 7 mint sites, all `packages/coordinator` (six supervisor generation traces + the socket-dir sweep), **Owner-gated**: the ring-2 dep set excludes telemetry by explicit ratchet comment, and minting W3C locally would fork the vocabulary. Beyond the mint count, two structural leftovers from the #655 review: ~~29 event definitions across whole families carry no `traceId` field~~ — **done** (#658–#664, rows below): every PERSISTED event definition in the repo now requires `traceId` (103/104 — `session.updated` is ephemeral by design and never reaches the writer) and every live producer threads its caller's trace, so the `"untraced"` sentinel marks only rows whose payload genuinely lacks a trace at publish (a bug signal, no longer steady-state); and the HTTP request middleware's `requestId` mint is still a dashed uuid that now reaches `trace_id` through the reconciler — converting it to W3C changes the externally visible `X-Request-Id` format, so it stays until that trade is ruled | ⬜ |
| [#658](https://github.com/INONONO66/openomni/pull/658) | trace batch 1 — `Dispatch.Events` had `traceId` **optional** while `Command.traceId` is required and `submit` hard-rejects a missing one: drop `.optional()`, and `eventBase`/`policyTraceContext` stop pretending the field can be absent (the `?? fallbackTraceId` parameter was dead by type AND by value — both callers passed the same `trace.traceId` the command was parsed from) — the closure is compile-time (`Bus.publish<T>` + the required payload type) for every typed producer; persistence never strict-parses, so the schema states the invariant for future strict consumers rather than refusing rows at runtime | ✅ |
| [#659](https://github.com/INONONO66/openomni/pull/659) | trace batch 2 — PendingAsk + PendingInteraction bases gain `traceId` (10 definitions, zero producers: both stores are frozen writers) — forward-looking hygiene, removes nothing from today's untraced population | ✅ |
| [#660](https://github.com/INONONO66/openomni/pull/660) | trace batch 3 — Session `Created`/`Deleted` gain `traceId`; `create`/`createChild`/`remove` take the caller's trace (`command.traceId` or the resolver's `traceContext`, all four production sites one hop away). `Updated` is ephemeral and never persists | ✅ |
| [#661](https://github.com/INONONO66/openomni/pull/661) | trace batch 4 — WorkerGrant base gains `traceId`; the only live emitter is `evaluate` (once **per grant row scanned** — the highest-volume untraced event in production), whose dispatch-policy caller already holds `ctx.traceContext` | ✅ |
| [#662](https://github.com/INONONO66/openomni/pull/662) | trace batch 5 — `wait.sync_ask` gains `traceId`: `auditSyncAsk`'s single caller holds `command.traceId` | ✅ |
| [#663](https://github.com/INONONO66/openomni/pull/663) | trace batch 6 — the six Wait store events + the two messaging events share one call path: `SendInput` gains `traceId` (serving `messaging.*` and `WaitService.open`/`recordDeliveryReceipt`), and the `WaitStore` mutation API threads the caller's trace (routing-execution and the recovery sweep already hold one) — the biggest real reduction of untraced rows | ✅ |
| [#664](https://github.com/INONONO66/openomni/pull/664) | trace batches 7+8 — injection-queue (also fixes its `timestamp` field name that dodges the persistence `time` reader): `drain` and the child-agent settlement enqueue have `traceContext` in scope; the worker IPC enqueue needs `traceId` on the `worker.deliver_message` contract (4 layers, precedent: `worker.inbound_wait`), so the field goes required in one shot with the IPC change | ✅ |
| [#666](https://github.com/INONONO66/openomni/pull/666) | `openomni`/`server` import-path cleanup; remove the compatibility re-export — 95 files (+7 session-local tests, +2 script/conformance deep-relative imports the CI conformance job caught) import `Bus`/`BusEvent` from `@openomni/telemetry` directly; the band-boundary fixture swaps `Bus`→`Storage` to stay a violation example | ✅ |

### Phase 2 — core

| PR | title | status |
|---|---|---|
| [#610](https://github.com/INONONO66/openomni/pull/610) | delete the unimplemented second event channel | ✅ |
| [#621](https://github.com/INONONO66/openomni/pull/621) | single output channel: remove the `AgentEvent` generator and `ChatAgent.stream` | ✅ |
| [#623](https://github.com/INONONO66/openomni/pull/623) | slop comments and `agentBaseForState`; the last `as unknown as` is earned, not removed | ✅ |
| [#624](https://github.com/INONONO66/openomni/pull/624) | duplicate helpers: one `requireTrace`, one `nonEmptyString` | ✅ |
| [#631](https://github.com/INONONO66/openomni/pull/631) | one run exit, one terminal record — the observable half of D4's "started with no terminal is unrepresentable" | ✅ |
| [#632](https://github.com/INONONO66/openomni/pull/632) | the runner owns both terminals — every exit, return or throw, records one | ✅ |
| [#636](https://github.com/INONONO66/openomni/pull/636) | file layout: the five files Phase 4 rule 1 names — `turn.ts` folds prepare and settle, which share the turn's state and a single consumer rather than any symbol | ✅ |
| [#622](https://github.com/INONONO66/openomni/pull/622) | drop the policy snapshot's `eventEmitter` carve-out — unreachable since #610, and `point-context-immutability.test.ts` asserts behavior with no production producer | ✅ |
| [#625](https://github.com/INONONO66/openomni/pull/625) | dissolve `builtin/` per D5 — `builtin:idle-nudge` moves to openomni | ✅ |
| [#626](https://github.com/INONONO66/openomni/pull/626) | dissolve `builtin/` per D5 — the two budget nudges move to openomni | ✅ |
| [#629](https://github.com/INONONO66/openomni/pull/629) | dissolve `builtin/` per D5 — `builtin:tool-permission` moves to openomni | ✅ |
| [#641](https://github.com/INONONO66/openomni/pull/641) | dissolve `builtin/`: the mechanism moved to its D6 home (`src/compaction/compact.ts`, namespace `Compaction` — the `InMemory` prefix implied a durable sibling that never existed) and the seam adapter sits beside it (`compaction/policy.ts` — wiring `run.completion.pre` + `run.replace_messages` is D8 mechanism, not opinion; the strategy still arrives as config — except `priority: 900`, an ordering opinion that was still hard-coded in the adapter until #642 made it the caller's required parameter). The directory is gone | ✅ |
| [#642](https://github.com/INONONO66/openomni/pull/642)+[#643](https://github.com/INONONO66/openomni/pull/643) | compaction registration (config parse + `registry.register` + the `priority: 900` opinion) moved to openomni's `compaction-policy.ts`; `defaultRegistry` and `core/policy/registry.ts` deleted; rule 3 restated as the `agent-registry-assembly` guard. #643 landed the review's conditions: the guard catches `create<T>()`, and the two resolve-contract pins the deletion lost (optional-missing record, `factory(config, runtime)`) live in `registry-portability` | ✅ |
| [#630](https://github.com/INONONO66/openomni/pull/630) | retry no longer double-counts the turn budget | ✅ |

### Phase 3 — compaction

| PR | title | status |
|---|---|---|
| — | remove `handleContinue`, `handleCompact`, and the `Run.Outcome` `continue`/`compact` variants. Both are unproduced: `packages/llm/src/run.ts` returns only `stop`, `aborted`, `error`, and no production site injects `config.llm.run`. **Owner-gated** — deleting a union member trips `lint:tools`' positional schema snapshot (`Run.Outcome#4`), whose `--update` needs sign-off, and `.omo/evidence/p3/protocol-concept-disposition.json` records this symbol as claimed by #498's run→llm `StepResult` move. Not splittable: `run.ts`'s `_exhaustive: never` fails whichever half lands first | ⬜ |
| [#641](https://github.com/INONONO66/openomni/pull/641) | ~~`InMemoryCompactor`~~ → `Compaction` in `src/compaction/` — **not dead**, and not deleted: mechanism and seam adapter moved to the D6 home, reachable exactly as before. The dead root re-export of the namespace (zero external importers, entry-exempt) is gone | ✅ |
| [#644](https://github.com/INONONO66/openomni/pull/644) ✅→ | `compaction/measure.ts` — the trigger reads the turn's **last step-finish part's `tokens.input`**: the ai SDK normalizes each step's input to the cache-inclusive prompt total on both bundled providers, so the cache lanes are components, not addends, and the message-level tokens field sums every step of a tool-using turn. Recorded off the tracking sink, exposed as `PolicyContext.contextTokens`, cleared when `run.replace_messages` rewrites the history it described. The old trigger summed cumulative run spend, which re-counts every prior turn's input and only ever grows. An unmeasured seam skips and records the skip | ✅ |
| — | `compaction/`: measure, adaptive policy with yield feedback, guard | ⬜ |
| [#645](https://github.com/INONONO66/openomni/pull/645) | deterministic no-LLM reduction: `compaction/reduce.ts` elides old completed tool outputs (sized marker + head excerpt, part identity preserved) before the cut. Termination is **structural** — an output is elided only when its replacement is strictly shorter, so a fixed point exists for every config (the review demonstrated marker-stacking non-convergence for schema-legal configs otherwise), and `elidedChars` is net shrink. Cut starvation under sustained tool use (review MAJOR 2) is closed by the same-round rule: when estimated net reclaim (chars/4, eagerness-only) cannot cover the measured overage, the cut also runs on the already-elided history. Opt-in strategy block through the plan schema | ✅ |
| — | cut planning, incremental summarization — unblocked by the wiring ruling; next after live usage data | ⬜ |
| — | speculative overlap and bounded overflow retry (D8) — unblocked by the wiring ruling | ⬜ |
| [#649](https://github.com/INONONO66/openomni/pull/649) | **Compaction registered by default (Owner ruled: proceed, 2026-08-16) — reachability stated honestly.** The window is the loop's fact (`run.ts` records `limit.context`; config may only narrow it), the strategy default is elision-only, and every non-action is a recorded skip (`no_window`, `no_boundary`, `nothing_reclaimed`); the boundary refusal is a value, not a throw, since assistant-first hydration is reachable and `run.completion.pre` is fail-closed. **The seam itself reached only worker-parent injected-continuation turns** until #651's window yield made every path re-enter it | ✅ |
| [#651](https://github.com/INONONO66/openomni/pull/651) | **continuation-independent seam: the loop yields at the window.** The llm step loop takes `yieldAtInputTokens` (a second `stopWhen` condition on the last step's cache-inclusive input) and stops gracefully at a step boundary; the agent arms it from the recorded window fact × the same ratio the trigger defaults to, detects the yield (last step-finish reason still asking for tools, below the step cap), dispatches the existing seam, and re-enters a new turn when history shrank — so the Resident and the in-`llmRun` tool loop reach compaction on every path. A yield the seam could not reduce **disarms the yield and continues** — the headroom above the arm point is real (review M4); yield-borne seam dispatches bypass the config threshold gate via `contextYielded`, since the loop stopping IS the trigger (M2); drained injections outrank the yield — the continuation path runs first (review BLOCKER); the step cap is the remaining pool the budget actually enforces, `-1` unlimited included (M1/M3), and ends as an honest `max-steps` | ✅ |

### Phase 4 — lock

| PR | title | status |
|---|---|---|
| [#637](https://github.com/INONONO66/openomni/pull/637) | close the run loop's reason-code vocabulary (rule 1's real target); amend rules 2–4 with what the tree shows | ✅ |
| [#638](https://github.com/INONONO66/openomni/pull/638) | rule 5: policy points with zero production registration vs an explicit allowlist (`policy-point-registration` guard, 9 of 18 pinned) | ✅ |
| [#639](https://github.com/INONONO66/openomni/pull/639) | close the tool source-label vocabulary: grammar lives in `Tool.sourceLabel`/`Tool.sourceFromLabels` next to `Tool.Source`; dot separator retired; rejections pinned | ✅ |
| [#640](https://github.com/INONONO66/openomni/pull/640) | close the `mcp.<serverId>` label vocabulary (`Tool.mcpServerLabel`/`Tool.mcpServerFromLabels`); `worker-bootstrap` reads the typed `descriptor.source.serverId` instead of re-deriving from the tool name | ✅ |
| — | `RuntimeToolCatalogEntry.mcpServer` is write-only on the wire — no production reader (#640 review); grow a consumer or delete the field (protocol schema surface, Owner review) | ⬜ |
| — | rule 3: core may not import `builtin/` — blocked on the Owner-gated `builtin:compaction` row | ⬜ |

Then [#502](https://github.com/INONONO66/openomni/issues/502) runs against a `session` package that holds only durable facts.

## Owner ruling requested: the Stakes value surface

`packages/openomni/src/ledger/stakes-*.ts` is 1,033 LOC of mechanism whose
only living connections are one type import (`CompletionStakesInjection` into
`completion-admission.ts`) and an optional `stakesResolver` seam **with zero
production suppliers**; every other reference in `effect/` and server
`recovery` is prose in comments, and its remaining knip-visible consumers are
its own tests (#650 review, re-verified 2026-08-16). Against deletion: the
concept docs (`core-model.md`, `design-philosophy.md`, `bets-and-kill-criteria.md`)
claim Stakes as designed future machinery, and the product thesis values the
ledger as the delegated-trust safety anchor. This is a product call, not a
hygiene call: **delete now and reimplement from the docs when a consumer
arrives, or keep as a design asset and accept the standing dead cluster.**

## What Phase 4 locks

Each was to become a `script/lint-guards.ts` rule so the boundary survives the
next contributor. Checking them against the tree the earlier phases actually
produced, only one of the five was both true and worth a rule. The list is
amended below with what each turned out to be; the reasoning is the deliverable,
since a rule that catches nothing is worse than no rule — it reads as coverage.

1. ~~Core files contain no domain string literals.~~ **Redundant, and aimed at
   the wrong target.** `dispatchPoint<TPointId extends PolicyPointId>` and the
   effect unions already make every policy-point and effect literal a compile
   error when misspelled — stricter than a regex, and it survives renames. What
   the rule was reaching for was real, but it was not in the literals the
   compiler checks. The most consequential set the compiler *couldn't* see —
   the three reason codes crossing in from openomni that the loop branches
   on — is fixed as a closed vocabulary (`core/policy/reason-codes.ts`) plus
   the `run-reason-code-vocabulary` guard. Not the only such set:
   `tools.ts` classifies tool source from free-form label strings, and its
   producers have already drifted (`define.ts` emits `source:`-prefixed labels,
   `runtime/mcp/client-descriptor.ts` emits `source.`-prefixed ones — the
   consumer strips both). That vocabulary is a follow-up row below.
2. ~~`packages/agent/src/pure/` may not import the telemetry package.~~
   **Vacuous** — no such directory exists, and none of the phases created one.
3. ~~Core may not import `builtin/`.~~ **Resolved by dissolution, not by a
   guard** (#641): the directory no longer exists. What the rule was locking —
   mechanism must not depend on opinion content — now holds by construction:
   `compaction/policy.ts` is seam wiring (D8), and the strategy enters as
   config from the product. The replacement lock is the
   `agent-registry-assembly` guard (#642): the agent package defines policy
   mechanism but never assembles a registry of opinions.
4. ~~No `crypto.randomUUID()` in a `traceId` position.~~ **Out of these
   packages.** Every `randomUUID` in agent mints a *message* id, not a trace;
   the D11 mint sites are 170 across server/openomni/session/coordinator, so
   this belongs to the Phase 1 remainder, not here.
5. **The set of policy points with zero production registration equals an
   explicit allowlist** — a point silently losing its last registration fails
   CI. Holds, and the one rule of the five with nothing else already enforcing
   it: written as the `policy-point-registration` guard, pinned both ways
   (losing a last registration fails; a stale allowlist entry fails). 9 of the
   18 registry points are acknowledged empty.

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
- **Type-checking blind spots hide exactly this class of defect.** `apps/server`, `packages/openomni`, `packages/protocol`, and `packages/session` still set `include: ["src"]`, so their tests are never type-checked. A required `traceId` broke 25 `new McpToolProvider()` call sites and a stray argument sat in a `Promise` constructor, both invisible to `check-types`. `packages/llm` (#619) and `packages/agent` (#620) are now under a `tsconfig.test.json`; between them that surfaced 199 errors, including a hand-written `declare module "bun:test"` in the agent tree that had been shadowing the real matcher types with `(...args: unknown[]) => void`. A gate that cannot see a file cannot ratchet it — and one that sees a file through a stub declaration is no better.
- **Adversarial review is a separate session** that re-runs the suites itself and tries to refute the PR body. Phase 0's reviewer returned BLOCK on a real defect the author's green run did not surface.
