# Execution substrate hardening receipts

Snapshot: `substrate-hardening` at `0d3307708597812242704eb3d4b68fc9b2675052`.

Handoff comments:

- [#494 receipt](https://github.com/INONONO66/openomni/issues/494#issuecomment-5381531888)
- [#459 checkpoint](https://github.com/INONONO66/openomni/issues/459#issuecomment-5381531881)

The comments carry the per-leaf decision, integrated branch SHA, and evidence summary. No Todo 22 receipt was present in the evidence set used for this handoff, so this document does not claim terminal R4/C1 proof.

## Honest guarantees and blockers

- Delivery is **at-least-once**. GitHub uses platform read-back reconciliation dedupe. The final app forwards the stable delivery key to its Telegram and Discord adapter bindings (#796); process-local driver dedupe remains bounded and restart durability belongs to the gateway/ledger contract.
- Reply authority is pinned to immutable endpoint evidence in the recorded `route.decided` fact. Restart replay does not consult mutable ActorRegistry bindings.
- Agent owns inter-attempt count, backoff, and fallback selection. Agent calls configure zero nested LLM retries, while standalone `llm.run` retains its bounded default transport retry.
- Todo 8 / D8 is **BLOCKED** until [#493](https://github.com/INONONO66/openomni/issues/493) closes with a current-attempt history projection/export receipt on the target SHA.
- The #506 addendum is **BLOCKED** until [#503](https://github.com/INONONO66/openomni/issues/503), [#504](https://github.com/INONONO66/openomni/issues/504), and [#505](https://github.com/INONONO66/openomni/issues/505) close. Its history/export portion additionally requires the D8/#493 unblock receipt. No external ownership move is included here.

## Current in-scope owner/export map

This map was regenerated from the ten `src/index.ts` package barrels at the snapshot above. Names include value and type exports as resolved by the TypeScript compiler. It intentionally described only the core package barrels present at that historical snapshot.

### `@openomni/protocol`

Owner: shared schemas and pure folds; zero internal package dependencies and no runtime effects, storage, routing decisions, or policy decisions.

Exports: `Actor`, `AppConnector`, `Artifact`, `BusEvent`, `Channel`, `Command`, `Communication`, `CronJob`, `Engagement`, `Execution`, `Gateway`, `Ingress`, `Ipc`, `Ledger`, `LlmCall`, `Mcp`, `McpConfig`, `Message`, `MessagingEvents`, `Model`, `NamedError`, `Operational`, `Policy`, `PolicyDecision`, `PolicyPermission`, `Storage`, `Token`, `Tool`, `TraceContext`, `Transcript`, `Wait`, `WorkItem`, `Worker`, `WorkerBootstrap`, `extractSurfaceKey`, `extractText`, `newTraceId`, `policyKernelVersion`, `resolveTarget`, `targetKey`.

### `@openomni/policy`

Owner: policy registration, evaluation, decision conversion, and effect composition; no business workflow or storage ownership.

Exports: `CanonicalAuditDispatchContextGeneric`, `CanonicalPolicyRegistrationGeneric`, `DispatchContextGeneric`, `DuplicatePolicyFactoryError`, `GenericPolicyContext`, `PolicyDecision`, `PolicyEngine`, `PolicyEngineConfig`, `PolicyEngineInstanceGeneric`, `PolicyEngineMiddlewareGeneric`, `PolicyPointId`, `PolicyRegistrationError`, `PolicyRegistrationFactoryGeneric`, `PolicyRegistry`, `PolicyRegistryInstance`, `composeEffects`, `decisionFromEvaluation`, `evaluatePermission`.

### `@openomni/telemetry`

Owner: observation-only process bus, trace scope, spans, and sink composition; replacing it with no-ops must not change observed behavior.

Exports: `Bus`, `InvalidTraceScopeError`, `SpanOutcome`, `SpanPair`, `TraceScope`, `collector`, `fromTraceparent`, `isSpanId`, `isTraceId`, `newSpanId`, `newTraceId`, `noopSink`, `requireTraceScope`, `rootScope`, `scope`, `spanStatus`, `spanStatusMessage`, `tee`, `toTraceparent`.

### `@openomni/ledger`

Owner: the single durable storage engine and typed store surfaces; stores facts but does not decide product meaning.

Exports: `ActorRegistry`, `AppConnectorInstallationStore`, `Artifact`, `BlacklistStore`, `BusPersistence`, `BusQuery`, `ChannelGrantStore`, `EffectStore`, `EffectStoreError`, `EgressBudgetStore`, `EngagementStore`, `LedgerAppend`, `PendingAskStore`, `PendingInteractionStore`, `Session`, `SqliteStorageAdapter`, `Storage`, `SurfaceKey`, `TranscriptStore`, `WaitStore`, `WorkItemAttemptRun`, `WorkItemStore`, `WorkerGrantStore`, `hasRetryExhaustionBlocker`, `initialize`.

### `@openomni/llm`

Owner: provider/auth abstraction, SDK wiring, streaming, bounded transport retry, message conversion, token accounting, and the `run` entry point; no durable storage.

Exports: `Auth`, `ModelsDev`, `Provider`, `Run`, `RunDependencies`, `RunInput`, `Sink`, `run`.

### `@openomni/agent`

Owner: invocation-scoped ReAct loop, Agent retry/fallback orchestration, policy adapter, compaction, and MCP client runtime; no durable storage or telemetry implementation dependency.

Exports: `AgentResult`, `BudgetState`, `CanonicalPolicyRegistration`, `ChatAgent`, `ChatAgentConfig`, `ChatAgentInput`, `ChatAgentInstance`, `CompactionOptions`, `McpClient`, `PolicyContext`, `PolicyEngine`, `PolicyEngineInstance`, `PolicyEngineRegistration`, `PolicyFn`, `PolicyRegistrationFactory`, `PolicyRegistry`, `PolicyRegistryInstance`, `RunReasonCode`, `checkBudget`, `createCompactionPolicy`, `describeBudgetRemaining`, `isTimeCarriageMarkerPart`.

### `@openomni/placement`

Owner: pure deterministic outbound target selection; the current slice selects models and does not own retry termination, admission, or policy.

Exports: `Placement`.

### `@openomni/ipc`

Owner: bidirectional Unix-socket NDJSON transport, framing, typed transport failures, and schema-derived known-method calls; protocol owns wire schemas.

Exports: `IpcClient`, `IpcConnectionError`, `IpcProtocolError`, `IpcRemoteError`, `IpcServer`, `IpcTimeoutError`, `connectIpcClient`, `createIpcServer`, `encode`, `typedCall`.

### Removed local-process driver (historical)

Owner: on-demand worker process lifecycle, primitive run delivery, and worker supervision; it does not own communication, actor authority, routing, grants, or writeback.

Exports: `InboundWaitParams`, `InboundWaitResult`, `ToolCallContext`, `WorkerDeliveryError`, `WorkerManager`, `createWorkerManager`.

### `@openomni/channels`

Owner: perimeter gateway drivers and judgments, including route recording, wait correlation, ingress authority, reply grants, egress budget gating, and existing-agent delivery.

Exports: `ChannelAuthnDecisionObserver`, `ChannelAuthnMiddleware`, `ChannelDeliveryRoute`, `DeliveryReceipt`, `DiscordAdapter`, `DiscordNormalizer`, `ExistingAgentMessaging`, `GatewayRouter`, `GatewayRouterPorts`, `GitHubAdapter`, `IngressAuthorityMiddleware`, `IngressRoutingError`, `IngressRoutingErrorCode`, `KernelRouteResolution`, `MessagingPorts`, `OutboundMessage`, `PublishPort`, `RouteInbound`, `RouteState`, `TelegramAdapter`, `WaitResolution`, `WaitRouteExecution`, `WaitService`, `WebSocketConfig`, `WebSocketHandler`, `createExistingAgentMessaging`, `createGatewayRouter`, `executeWaitRoute`, `findWaitCandidates`, `pinRouteSession`, `pinSelectedTarget`, `requireRoutedDecision`, `resolveAndRecordRoute`, `resolveIngressActor`, `resolveRoute`, `resolveSenderTargetGrant`, `targetsOfWait`.
