import { Effect, Result } from "effect";
import { ThrownError } from "./thrown";
import { AppInvariantError } from "./invariant";
import { bootResource } from "./composition/boot";
import { foreignFailure } from "./composition/failure";
import { shutdownSessions } from "./shutdown";
import {
  AppScope,
  SessionEntityBinding,
  type AppRuntime, type AppServices,
  lifecycleFailure,
} from "./runtime";
import { timingSafeEqual } from "node:crypto";
import { configuredCompaction } from "./compaction/strategy";
import { seedKernelPolicyRows } from "./policy-seed";
import { AppPointTable } from "./composition/point-table";
import { Core, Bundle } from "@openomni/agent";
const BundleDefinitions = Bundle.BundleDefinitions;
const Entropy = Core.Entropy;
const GenerationLayers = Core.GenerationLayers;
const ObservationSink = Core.ObservationSink;
const createSessionEntityRunTurn = Core.createSessionEntityRunTurn;
const createSessionRequests = Core.createSessionRequests;
const SessionEntity = Core.SessionEntity;
type SessionHandle = Core.SessionHandle;
type SessionRuntime = Core.SessionRuntime;
const AgentFailure = Core.AgentFailure;
const ExecutionApprovalError = Core.ExecutionApprovalError;
const CommitRefused = Core.CommitRefused;
import { SessionGeneration, SessionTransition, type LedgerAction } from "@openomni/protocol";
import {
  type ChannelDeliveryRoute,
  type GatewayRouter,
  decodeChannelFailure,
  ChannelsFailure,
  WebSocketHandler,
} from "@openomni/channels";
import type { ActorRegistry } from "@openomni/channels";

import {
  createMachineHost,
  MachinesFailure,
  type MachineHost,
} from "@openomni/machines";
import { traceIdFromUuid, type Channel } from "@openomni/protocol";
import { desiredChannels, materializePersons } from "./provisioning/declared";
import { type ChannelSupervisor, createChannelSupervisor } from "./provisioning/supervisor";
import type { ProvisionPort } from "./provisioning/channels";
import {
  assertWsExposure,
  loadConfig,
  modelTransport,
  resolveClusterStorage,
  type OpenOmniConfig,
  type RegisteredActor,
} from "./config";
import { createCompletionPort } from "./composition/completion";
import { processEntryPath } from "./process-entry-path";
import { createProcessSessionTransport } from "./composition/process-session";
import { createMessageInboxCommit, prepareMessage } from "./composition/message-session";
import { dispatchOutboundMessage } from "./composition/terminal-message";
import {
  AppLedger,
  createSessionLivePlane,
  requestAuthorityKernel,
  sessionTimerPort,
} from "./composition/cluster-runtime";
import { GATEWAY_INGRESS_SESSION } from "./composition/ingress-executor";
import { captureNow } from "./composition/platform";
import { createWatchSources } from "./composition/watch-sources";
import {
  watchFiredHook,
  watchOccurrenceKey,
  watchTimeoutHook,
} from "./composition/monitor-ports";
import {
  acquireAppResource,
  channelRequests,
  createMonitorPorts,
  createMountedChannelGrantRegistrar,
  createResidentGateway,
  gatewayRuntime,
  runAppBoot,
  runAppEffect,
  toolPorts,
  webSocketCallbacks,
} from "./gateway";
import { configureAuthority } from "./composition/generation-layers";
import { createResident } from "./resident";
import { composeCodemode, type ComposedCodemode } from "./composition/codemode";
import { createRequestDomainRevisions } from "./tools/core/request-domain-revisions";

/** A channel message the gateway refused pre-admission: the driver reports it to the sender. */
class MessageAdmissionRefused extends Error {
  constructor(reasonCode: string) {
    super(`message admission refused: ${reasonCode}`);
    this.name = "MessageAdmissionRefused";
  }
}

interface StartOptions {
  readonly runtime?: AppRuntime;
  readonly sessionRuntime?: Pick<
    SessionRuntime,
    | "closeGraceMs"
    | "approvalTimeoutMs"
    | "retryAlarm"
    | "openIntent"
    | "onHibernate"
  >;
  readonly config?: OpenOmniConfig;
  readonly toolDefinitions?: readonly import("@openomni/protocol").AnyToolDefinition[];
}

/**
 * Owner-admitted delegation targets, recorded as durable identity facts.
 * Registration is an upsert, so a restart re-asserting the same actors is a
 * no-op — which is also why this is not a scoped resource: durable facts are
 * history, not runtime handles.
 */
function registerActors(registry: ActorRegistry, actors: readonly RegisteredActor[]): void {
  for (const actor of actors) {
    registry.registerIdentity({
      id: actor.actorId,
      kind: actor.kind,
      trustTier: actor.trustTier,
      ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    });
    const channel = actor.channel ?? "ws";
    registry.registerEndpoint({
      id: `${channel}:${actor.externalId}`,
      actorId: actor.actorId,
      channel,
      externalId: actor.externalId,
    });
  }
}

/**
 * The app's HTTP surface: the ws upgrade seam, unauthenticated liveness (no
 * clock, no version, no state), and — only when a GitHub channel is composed —
 * its webhook ingress. Everything else is 404. The webhook handler is read
 * live from the supervisor's table so a channel_add landing a GitHub
 * instance mid-run is reachable without rebinding the server.
 */
function createHttpRoutes(
  wsHandler: WebSocketHandler,
  githubWebhookHandler: () => ((request: Request) => Promise<Response>) | undefined,
) {
  return (
    request: Request,
    bunServer: Parameters<WebSocketHandler["handleUpgrade"]>[1],
  ): Response | Promise<Response> | undefined => {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") === "websocket" && url.pathname === "/ws") {
      // undefined = the upgrade succeeded; a Response = the upgrade was denied.
      return wsHandler.handleUpgrade(request, bunServer);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/github/webhook") {
      const handler = githubWebhookHandler();
      if (handler !== undefined) return handler(request);
    }
    return new Response("Not found", { status: 404 });
  };
}

function residentModelOptions(
  model: OpenOmniConfig["model"],
  transport: ReturnType<typeof modelTransport>,
) {
  return {
    model,
    ...(model.fallbacks === undefined ? {} : { modelFallbacks: model.fallbacks }),
    apiKey: model.apiKey,
    ...(transport === undefined ? {} : { transport }),
  };
}

export async function startOpenOmni(options: StartOptions = {}) {
  const config = options.config ?? loadConfig();
  assertWsExposure(config);
  const authenticateOwner = (credential: string, requestId: string) => {
    const expected = Buffer.from(config.wsToken ?? "");
    const presented = Buffer.from(credential);
    if (
      expected.length === 0 ||
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      throw new ExecutionApprovalError({ code: "unauthenticated" });
    }
    return { kind: "owner" as const, principalId: "owner", evidenceId: `ws-owner:${requestId}` };
  };
  // One resolution of the operator's endpoint and headers, shared by every
  // model caller this composition builds.
  const transport = modelTransport(config.model);
  const runtime =
    options.runtime ??
    gatewayRuntime({
      // Cluster storage rides only on configs that resolved it (loadConfig
      // always does); injected literal test configs stay on the in-memory
      // host so no path outside their fixture directory is ever touched.
      ...(config.catalogPath === undefined ? {} : resolveClusterStorage(config)),
    });
  const boot = async () => {
    const services = await runAppBoot(
      runtime,
      Effect.gen(function* () {
        return {
          context: yield* Effect.context<AppServices>(),
          plane: yield* AppLedger,
          scope: yield* AppScope,
          now: yield* captureNow,
          entropy: yield* Entropy,
          observations: yield* ObservationSink,
          bundles: yield* BundleDefinitions,
          generations: yield* GenerationLayers,
          pointTable: yield* AppPointTable,
          // Late-bound entity ports: the runtime mounts the entity layer over
          // this seam; the real turn/timer ports resolve below.
          entityPorts: yield* SessionEntityBinding,
        };
      }),
    );
    const acquire = <A, E, E2>(
      resource: Effect.Effect<A, E>,
      release: (value: A) => Effect.Effect<void, E2>,
    ) => runAppBoot(runtime, bootResource(resource, release));
    const plane = services.plane;
    seedKernelPolicyRows(
      plane.catalog.policies,
      services.bundles.select(services.bundles.names).rows,
      services.pointTable,
    );
    // The Session entity client: THE delivery path for message and timer
    // traffic (W5.2 plan §1) — the RPC ack means the receiver committed.
    const entityClient = await runAppBoot(runtime, SessionEntity.client);

    const domainRevisions = createRequestDomainRevisions({
      actors: plane.stores.actors,
      persons: plane.stores.persons,
    });
    // Live entity turns publish their approval gate + boundary drain here;
    // request readiness and the session facade reach running turns through it.
    const liveTurns = createSessionLivePlane();
    const notifyLiveApprovals = (id: string): void => {
      const approvals = liveTurns.get(id)?.approvals;
      if (approvals === undefined) return;
      for (const request of plane.openKernel(id).requestRows(id)) {
        if (request.mode === "approval") approvals.notify?.(request);
      }
    };
    const sessionRuntime: SessionRuntime = {
      ...options.sessionRuntime,
      openKernel: plane.openKernel,
      listSessions: plane.listSessions,
      dispatchOutbound: dispatchOutboundMessage(
        (...args) => messages.ingest(...args),
        services.now,
        plane.openKernel,
      ),
      requestDomainRevisions: domainRevisions,
      onRequestReady: (id) => {
        notifyLiveApprovals(id);
        sessionRuntime.onInboxCommitted?.([id]);
      },
      // Entity sessions drain inside the delivering RPC before it acks; only
      // process-runner sessions still need this doorbell.
      onInboxCommitted: (ids) => {
        for (const id of ids) void wake(id);
      },
      authorizeApproval: (credential, request) =>
        Effect.try({
          try: () => authenticateOwner(credential, request.id),
          catch: () => new ExecutionApprovalError({ code: "unauthenticated" }),
        }),
      authorizeConfigure: configureAuthority(services.generations, plane.openKernel),
    };
    // Request transitions never steal a live activation's fence: the borrowed
    // kernel view commits under the running turn's authority (idle sessions
    // keep the documented takeover adoption).
    const bootRequests = await runAppBoot(
      runtime,
      createSessionRequests({
        ...sessionRuntime,
        openKernel: (id) => requestAuthorityKernel(plane.openKernel(id), id),
      }),
    );
    // An out-of-turn answer on an entity session must land through the
    // entity's own RequestResolve RPC: the RPC handler commits AND drains, so
    // a suspended chain (including a crashed-"running" session whose acked
    // Prompt will never redeliver) recovers its open turn before the ack.
    // Only a turn LIVE IN THIS PROCESS keeps the borrowed-authority direct
    // commit — its approval gate needs the app-side notify, and the entity
    // drain defers to the detached turn anyway (W5.2 S4: `row.state` no
    // longer implies a live runner, since the delivering RPC acks at the
    // durable boundary). Process runners keep direct commit + doorbell.
    const requests: typeof bootRequests = {
      ...bootRequests,
      answer: (answer) =>
        Effect.suspend(() => {
          if (liveTurns.get(answer.sessionId) !== undefined || sessionRunner(answer.sessionId) === "process")
            return bootRequests.answer(answer);
          return entityClient(answer.sessionId)
            .RequestResolve({
              requestId: answer.requestId,
              inputId: answer.inputId,
              payload: JSON.stringify({ kind: "request.answer", answer }),
              principal: JSON.stringify(answer.principal),
            })
            .pipe(
              Effect.map((receipt) => SessionTransition.Resolution.parse(receipt.resolution)),
              Effect.mapError(foreignFailure((fields) => new AgentFailure(fields), "request.answer")),
            );
        }),
    };
    // Recovery is the cluster's: persisted undelivered entity messages redeliver
    // on activation; there is no boot sweep to await.
    const recovery: Promise<void> = Promise.resolve();
    await acquire(Effect.void, () => shutdownSessions(sessionRuntime, recovery));
    const actors: readonly RegisteredActor[] = config.actors ?? [];
    registerActors(plane.stores.actors, actors);
    // Declared Person manifests materialize alongside env actors — both are
    // idempotent identity upserts; the provisioning store is the durable one.
    const materializeDeclaredPersons = () =>
      materializePersons({ persons: plane.stores.persons, actors: plane.stores.actors });
    materializeDeclaredPersons();

    let gateway: GatewayRouter | undefined;
    const messages = {
      ingest: (...args: Parameters<GatewayRouter["ingest"]>) => {
        if (gateway === undefined) return Effect.die(new Error("gateway is not composed"));
        return gateway.ingest(...args);
      },
    };
    // Provisioning administration port: the supervisor is created after the
    // Resident (it needs the routing handler), so the port reaches it through
    // a late binding — tools cannot run before composition finishes anyway.
    let channelSupervisor: ChannelSupervisor | undefined;
    const liveSupervisor = (): ChannelSupervisor => {
      if (channelSupervisor === undefined)
        throw new AppInvariantError("provisioning used before composition finished");
      return channelSupervisor;
    };
    const provisioningPort: ProvisionPort = {
      persons: plane.stores.persons,
      instances: plane.stores.instances,
      secrets: plane.stores.secrets,
      actors: plane.stores.actors,
      transaction: plane.catalog.transaction,
      kek: config.kek,
      supervisor: {
        reconcile: () => liveSupervisor().reconcile(),
        resume: (instanceId) => liveSupervisor().resume(instanceId),
        status: () => liveSupervisor().status(),
        source: () => liveSupervisor().source(),
      },
      materialize: materializeDeclaredPersons,
      removeIdentity: plane.stores.actors.removeIdentity,
    };
    // The cell door is bound per cell rather than globally, so a cell serves
    // exactly the tools its own dispatcher holds.
    let cells: ComposedCodemode | undefined;
    const machines = config.machines;
    const host: MachineHost | undefined =
      machines === undefined
        ? undefined
        : await acquireAppResource(
            runtime,
            createMachineHost({
              socketPath: machines.socketPath,
              enrollment: (machineId) => machines.enrolled.find((e) => e.machineId === machineId),
              events: services.observations,
              id: services.entropy.id,
              now: services.now,
              callTool: (call) =>
                cells === undefined
                  ? Effect.succeed({ status: "failed" as const, error: "codemode is not composed" })
                  : cells.callTool(call).pipe(
                      Effect.mapError(
                        (error) =>
                          new MachinesFailure({
                            operation: "codemode.callTool",
                            cause: String(error),
                          }),
                      ),
                    ),
            }),
          );

    // A cell's catalog shares the dispatcher's tool.pre policy boundary.
    const llmPort = createCompletionPort(
      { ...config.model, ...(transport === undefined ? {} : { transport }) },
      { now: services.now, id: services.entropy.id },
    );
    if (host !== undefined) {
      cells = await acquireAppResource(runtime, composeCodemode(host, { id: services.entropy.id }));
    }

    // Watch plane: native sources deliver occurrences as WatchFired entity
    // messages; the occurrence chain id is the durable dedupe (plan F2).
    const watchSources = createWatchSources(
      {
        watchFired: (fire) =>
          runAppEffect(
            runtime,
            entityClient(fire.sessionId)
              .WatchFired({
                watchId: fire.watchId,
                epoch: fire.epoch,
                sourceKey: watchOccurrenceKey(fire.watchId, fire.epoch, fire.sourceKey),
                batch: JSON.stringify({ content: fire.content, terminal: fire.terminal }),
              })
              .pipe(Effect.asVoid),
          ),
        watchTimeout: (arm) =>
          runAppEffect(
            runtime,
            entityClient(arm.sessionId)
              .WatchTimeout({ watchId: arm.watchId, epoch: arm.epoch, fireAt: arm.fireAt })
              .pipe(Effect.asVoid),
          ),
      },
      {
        clock: services.now,
        failure: (watchId, error) => console.error(`watch ${watchId} send failed`, error),
      },
    );
    await acquire(Effect.succeed(watchSources), (resource) =>
      Effect.tryPromise({
        try: () => resource.closeAll(),
        catch: lifecycleFailure("watches.close"),
      }),
    );
    const resident = createResident({
      toolDefinitions: options.toolDefinitions,
      ...residentModelOptions(config.model, transport),
      compaction: configuredCompaction(config, { now: services.now, id: services.entropy.id }),
      bundles: services.bundles.names,
      tools: {
        ...toolPorts(runtime, {
          machines: host, cells, completion: llmPort, messages,
          now: services.now, id: services.entropy.id,
        }),
        alarms: await createMonitorPorts(runtime, watchSources),
        provisioning: provisioningPort,
      },
      sessionRuntime,
      policyGeneration: () =>
        plane.openKernel(GATEWAY_INGRESS_SESSION).currentPolicyGeneration(),
    });

    await runAppBoot(runtime, services.generations.initialize(resident.definitions));

    const routingHandler: Channel.MessageHandler = async ({ sender, facts }) => {
      const admission = await runAppEffect(runtime, messages.ingest(sender, facts));
      if (admission.status === "blocked_pre") {
        throw new MessageAdmissionRefused(admission.reasonCode);
      }
    };
    let wsHandler: WebSocketHandler | undefined;
    const wsRoute = async (externalId: string, body: string, idempotencyKey: string) => {
      if (wsHandler === undefined) throw new AppInvariantError("ws delivery used before composition finished");
      return wsHandler.push(externalId, body, idempotencyKey);
    };
    // Live table: channel components register and revoke their own outbound
    // routes while the gateway keeps reading it per delivery.
    const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
    deliveryRoutes.set("ws", wsRoute);
    // One runtime owner for external channels (provisioning §5): boot
    // reconcile and every tool-driven mutation run the SAME diff over
    // declared ChannelInstances, the only source of external channel config.
    const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
    const supervisor = createChannelSupervisor({
      desired: () =>
        desiredChannels(
          { instances: plane.stores.instances, secrets: plane.stores.secrets },
          config.kek,
          {
            publish: services.observations.publish,
            now: services.now,
            id: services.entropy.id,
            random: services.entropy.random,
            run: (effect) => runAppEffect(runtime, effect),
          },
        ),
      build: (component) => component.build(routingHandler),
      // The tier is the row's, never this call site's: mounting a named
      // surface materializes no owner authority (#931).
      grant: createMountedChannelGrantRegistrar(
        plane.stores.channelGrants,
        config.channelAllowedSenders,
      ),
      deliveryRoutes,
      webhookHandlers,
      traceId: () => traceIdFromUuid(services.entropy.id()),
    });
    channelSupervisor = supervisor;
    const processSessions = createProcessSessionTransport({
      answer: (answer) =>
        runAppEffect(
          runtime,
          requests.answer({ ...answer, receivedAt: services.now() }),
        ),
      command: [process.execPath, processEntryPath(import.meta.url)],
      worker: {
        ...resolveClusterStorage(config),
        model: config.model,
        apiKey: config.model.apiKey,
        ...(transport === undefined ? {} : { transport }),
      },
      committed: (ids) => {
        for (const id of ids) void wake(id);
      },
    });
    await acquire(Effect.succeed(processSessions), (resource) =>
      Effect.tryPromise({
        try: () => resource.close(),
        catch: lifecycleFailure("processes.close"),
      }),
    );
    /** The runner block a session's current generation pins ("process" | "resident" | ...). */
    const sessionRunner = (id: string): string | undefined => {
      try {
        return plane
          .openKernel(id)
          .latestGenerationFor(id)
          .systemBlocks.find((block) => block.id === "runner" && block.source === "app:runner")
          ?.content;
      } catch {
        return undefined;
      }
    };
    // Entity sessions drain inside the delivering RPC; only process-runner
    // sessions (external child transport) still take an app-side wake.
    const wake = (id: string): Promise<void> => {
      if (sessionRunner(id) !== "process") return Promise.resolve();
      return processSessions.wake(id).catch((error: Error) => {
        console.error("process session wake failed", error);
      });
    };
    const commitInbox = createMessageInboxCommit({
      plane,
      client: entityClient,
      clock: services.now,
    });
    // Deadline-carrying requests arm one persisted DeliverAt wake on the
    // owning session; the chain fold decides applied-versus-noop at delivery.
    // The arm is forked, never awaited: requests open inside the owning
    // entity's own turn RPC, and awaiting a second RPC on that same entity
    // from within its handler would deadlock the mailbox. The fork joins the
    // app runtime's lifetime scope (never detached), so shutdown interrupts
    // or awaits it; a lost arm is a logged incident, not a refused request.
    const appScope = await runAppBoot(runtime, AppScope);
    const requestPorts = channelRequests(requests);
    const requestsWithDeadlines: typeof requestPorts = {
      ...requestPorts,
      open: (input) =>
        requestPorts.open(input).pipe(
          Effect.tap((request) =>
            request.deadline === undefined
              ? Effect.void
              : entityClient(request.sessionId)
                  .Deadline({ requestId: request.requestId, deadlineAt: request.deadline })
                  .pipe(
                    Effect.asVoid,
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        console.error(`deadline arm failed: ${request.requestId}`, error);
                      }),
                    ),
                    Effect.forkIn(appScope),
                    Effect.asVoid,
                  ),
          ),
        ),
    };
    gateway = await runAppBoot(
      runtime,
      createResidentGateway(
        {
          inbox: {
            commit: (input) =>
              commitInbox(input).pipe(
                Effect.mapError(decodeChannelFailure("message.commit")),
              ),
          },
          prepare: prepareMessage(plane, resident.materialize),
          requests: requestsWithDeadlines,
          authenticateAnswer: (_sender, credential, requestId) =>
            Effect.try({
              try: () => authenticateOwner(credential, requestId),
              catch: decodeChannelFailure("answer.authenticate"),
            }),
          committed: (row) => {
            void wake(row.sessionId);
          },
          now: services.now,
          id: services.entropy.id,
        },
        {
          deliveryRoutes,
          grants: () =>
            plane
              .listSessions()
              .filter((row) => row.role === "resident")
              .flatMap((row) =>
                actors.map((actor) => ({
                  id: `${row.id}->${actor.actorId}`,
                  senderId: row.id,
                  targetActorId: actor.actorId,
                  operations: ["awaited" as const, "fire_and_forget" as const],
                })),
              ),
          budgets: () => config.socialBudgets ?? [],
          replyGrantRules: () =>
            plane
              .listSessions()
              .filter((row) => row.role === "resident")
              .flatMap((row) =>
                [...deliveryRoutes.keys()].map((surface) => ({
                  id: `reply:${row.id}:${surface}`,
                  senderId: row.id,
                  surface,
                  operations: ["fire_and_forget" as const, "awaited" as const],
                  instanceTtlMs: 86_400_000,
                  maxLiveInstances: 64,
                  createdBy: "resident",
                })),
              ),
        },
      ),
    );
    // Bind the entity's composition-owned ports: turns run the Resident's
    // runner over the activation's kernel + fence; process-runner sessions
    // delegate to the child transport without committing under this fence.
    const resolvedRuntime: Parameters<typeof createSessionEntityRunTurn>[1] = {
      ...sessionRuntime,
      clock: services.now,
      entropy: services.entropy.id,
      observations: services.observations,
      generations: services.generations,
      services: services.context,
    };
    services.entityPorts.bind({
      runTurn: (input) =>
        sessionRunner(input.authority.sessionId) === "process"
          ? Effect.tryPromise({
              try: () => processSessions.wake(input.authority.sessionId),
              catch: foreignFailure((fields) => new AgentFailure(fields), "process.wake"),
            }).pipe(Effect.asVoid)
          : createSessionEntityRunTurn(
              liveTurns.wrapRunner(
                input.authority.sessionId,
                resident.runnerFor(input.kernel.row(input.authority.sessionId)),
              ),
              resolvedRuntime,
              services.scope,
            )(input),
      timers: sessionTimerPort({
        requestDomainRevisions: domainRevisions,
        watchFired: watchFiredHook({
          closeSource: (watchId) => void watchSources.close(watchId),
        }),
        watchTimeout: watchTimeoutHook({
          closeSource: (watchId) => void watchSources.close(watchId),
        }),
      }),
      requestDomainRevisions: domainRevisions,
    });

    await acquire(Effect.succeed(supervisor), (resource) =>
      Effect.tryPromise({
        try: () => resource.stopAll(),
        catch: lifecycleFailure("channels.close"),
      }),
    );
    await supervisor.reconcile();

    wsHandler = new WebSocketHandler(
      ({ sender, facts }) =>
        messages.ingest(sender, facts).pipe(
          Effect.flatMap((admission) =>
            admission.status === "blocked_pre"
              ? Effect.fail(
                  new ChannelsFailure({
                    operation: "message.admission",
                    cause: admission.reasonCode,
                  }),
                )
              : Effect.succeed(admission),
          ),
        ),
      services.observations.publish,
      {
        now: services.now,
        id: services.entropy.id,
        ...(config.wsToken === undefined ? {} : { token: config.wsToken }),
        onRequestAnswer: (sender, answer) => messages.ingest(sender, answer),
      },
    );

    const wsCallbacks = webSocketCallbacks(runtime, wsHandler, services.observations, (id) =>
      plane.catalog.sessionIndex(id) === undefined ? undefined : plane.openKernel(id));
    const server = Bun.serve({
      hostname: config.host,
      port: config.wsPort,
      websocket: wsCallbacks.callbacks,
      fetch: createHttpRoutes(wsHandler, () => webhookHandlers.get("github")),
    });

    if (server.port === undefined) throw new AppInvariantError("OpenOmni ws server did not bind a TCP port");
    const boundServer = server;
    const boundPort: number = server.port;
    await acquire(Effect.succeed(boundServer), (resource) =>
      Effect.tryPromise({
        try: () => resource.stop(true),
        catch: lifecycleFailure("websocket.close"),
      }),
    );
    /**
     * The live-turn facade (replaces the deleted registry handle): approvals
     * and interrupts reach the turn running inside the entity's delivering
     * RPC through the composition's live plane; configuration commits ride
     * the activation's borrowed authority. Only live turns have a handle -
     * a hibernated entity session answers through the entity client instead.
     */
    const borrowedAuthority = (id: string) => {
      const kernel = plane.openKernel(id);
      const row = kernel.row(id);
      if (row.fenceOwner === null) throw new AppInvariantError(`session has no activation authority: ${id}`);
      return { kernel, row, owner: row.fenceOwner, fence: row.fence };
    };
    const sessionFacade = (id: string): AppSessionHandle | undefined => {
      if (liveTurns.get(id) === undefined) return undefined;
      return {
        id,
        approvals: {
          pending: () => liveTurns.get(id)?.approvals?.pending() ?? [],
          answer: (answer) =>
            Effect.suspend(() => {
              const approvals = liveTurns.get(id)?.approvals;
              return approvals === undefined
                ? Effect.fail(new ExecutionApprovalError({ code: "stale_approval" }))
                : approvals.answer(answer);
            }),
        },
        // The mid-turn deadline seam (W5.2): a durable DeliverAt Deadline
        // serializes behind the running turn's own entity RPC, so a live
        // turn's request timeout rides the turn's own transition port (the
        // deleted controller handle's `requests.transition` path) and then
        // notifies the turn's live approval gate.
        requests: {
          timeout: (requestId, at) =>
            Effect.gen(function* () {
              const entry = liveTurns.get(id);
              if (entry?.ledger.transition === undefined)
                return yield* Effect.fail(
                  new ExecutionApprovalError({ code: "approval_authority_unavailable" }),
                );
              const decision = yield* entry.ledger.transition(
                { kind: "request.timeout", requestId },
                `${requestId}:deadline`,
                at,
              );
              if (decision.request !== undefined) entry.approvals?.notify?.(decision.request);
            }),
        },
        interrupt: () =>
          Effect.gen(function* () {
            const entry = liveTurns.get(id);
            if (entry === undefined) return;
            // The durable interrupt row first (cancellation is chain evidence),
            // then the turn's own boundary drain consumes it and aborts the wave.
            const attempt = () => Effect.suspend(() => {
              const { kernel, row, owner, fence } = borrowedAuthority(id);
              const received: LedgerAction.Append = {
                id: services.entropy.id(),
                parentId: kernel.latestAction(id)?.id ?? null,
                sessionId: id,
                kind: "prompt",
                intent: { encodingVersion: 1, value: { kind: "session", id } },
                effect: { encodingVersion: 1, value: { inboxKind: "interrupt", content: "" } },
                irreversible: true,
                ts: services.now(),
              };
              return kernel.commit({
                sessionId: id, owner, fence, now: services.now(),
                expectedRevision: row.revision, actions: [received],
                state: row.state === "running" ? "interrupted" : row.state,
              });
            });
            yield* attempt().pipe(
              Effect.catchIf(
                (error) => error instanceof CommitRefused && error.reason === "revision",
                () => attempt(),
              ),
              Effect.mapError(foreignFailure((fields) => new AgentFailure(fields), "session.interrupt")),
            );
            yield* entry.boundary("before_llm");
          }),
        tools: {
          add: (additions) =>
            Effect.gen(function* () {
              const { kernel, row, owner, fence } = borrowedAuthority(id);
              const before = kernel.latestGenerationFor(id);
              const generation = before.generation + 1;
              const accepted = yield* sessionRuntime.authorizeConfigure({
                sessionId: id, role: row.role, operation: "tools.add", generation,
              });
              if (!accepted)
                return yield* Effect.fail(new AgentFailure({ operation: "session.configure", cause: "denied" }));
              const snapshot = Core.SessionHandleStore.generationSnapshot({
                generation,
                revertTo: before.generation,
                tools: [...before.tools, ...additions.map((tool) => SessionGeneration.Tool.parse(tool))],
                system: { preset: before.systemPreset, blocks: before.systemBlocks },
                policyGeneration: before.policyGeneration,
                bundles: before.bundles,
              });
              const configured = Core.SessionHandleStore.configureAction({
                id: services.entropy.id(), sessionId: id,
                parentId: kernel.latestAction(id)?.id ?? null,
                operation: "tools.add", snapshot, at: services.now(),
              });
              const commit = kernel
                .commit({
                  sessionId: id, owner, fence, now: services.now(),
                  expectedRevision: row.revision, actions: [configured], state: row.state,
                  generation: {
                    toolsGeneration: snapshot.generation,
                    systemHash: snapshot.systemHash,
                    policyGeneration: snapshot.policyGeneration,
                  },
                })
                .pipe(Effect.mapError(foreignFailure((fields) => new AgentFailure(fields), "session.configure")));
              yield* services.generations.configure({ sessionId: id, generation }, snapshot, commit);
              return { generation: snapshot.generation, revertTo: snapshot.revertTo };
            }),
        },
      };
    };
    let stopping: Promise<void> | undefined;
    const stop = async () => {
      await boundServer.stop(true);
      await supervisor.stopAll();
      await runAppEffect(runtime, shutdownSessions(sessionRuntime, recovery));
      if (cells !== undefined) await runAppEffect(runtime, cells.close().pipe(Effect.mapError(lifecycleFailure("shutdown.cell_unsettled"))));
      // Shutdown join contract (W5.2 S4): the delivering entity RPC acks at
      // the durable turn boundary and the turn's remainder runs detached
      // under the activation, so a turn suspended in a protected tool wave
      // (open request, no answer) holds its captured generations — not its
      // frame — until interrupted. Interrupt every live turn through the
      // facade: the interrupt row, the wave's request.cancel and the
      // interrupted turn terminal are all durable chain commits (fail-closed
      // — a refused commit fails stop loud), after which each detached turn
      // unwinds and releases its generation before the drain below.
      await Promise.all(
        liveTurns.ids().map((id) => {
          const facade = sessionFacade(id);
          return facade === undefined ? Promise.resolve() : runAppEffect(runtime, facade.interrupt());
        }),
      );
      // Every accepted ws frame's ingest holds a captured ingress generation
      // until it unwinds; join them before the generation drain.
      await wsCallbacks.settled();
      // Join the interrupted detached turns: await every live generation
      // owner so dispose's fail-fast drain observes zero owners.
      await runAppEffect(runtime, Effect.flatMap(GenerationLayers, (generations) => generations.settle));
      await runtime.dispose();
    };
    return {
      port: boundPort,
      gateway,
      sessions: { get: sessionFacade },
      // The boot's honest channel record: where config came from and why each
      // declared row did or did not mount (provision_status reads this later).
      channels: { source: liveSupervisor().source(), statuses: liveSupervisor().status() },
      runtime,
      stop: () => {
        stopping ??= stop().catch((error: Error) => { stopping = undefined; throw error; });
        return stopping;
      },
    };
  };
  const outcome = await boot().then(Result.succeed, ThrownError.transform((cause) => Result.fail(cause)).parse);
  if (Result.isFailure(outcome)) {
    await runtime.dispose().catch((disposal: Error) => {
      throw new AggregateError([outcome.failure, disposal], "app boot and disposal failed");
    });
    throw outcome.failure;
  }
  return outcome.success;
}

/**
 * Entry-point shutdown wiring, extracted behind seams so tests can drive it
 * deterministically. The handler awaits the full async stop before any exit.
 */
export function installShutdownHandlers(deps: {
  readonly stop: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly on: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}): void {
  let stopping = false;
  const handler = () => {
    if (stopping) return;
    stopping = true;
    void deps.stop().then(
      () => deps.exit(0),
      (error: Error) => {
        console.error("app shutdown incident", error);
        deps.exit(1);
      },
    );
  };
  deps.on("SIGINT", handler);
  deps.on("SIGTERM", handler);
}

/**
 * The composition-owned live session handle (W5.2): the subset of the deleted
 * registry `SessionHandle` a live entity turn can honestly serve. `get`
 * returns one only while a turn is running - a hibernated entity session has
 * no live surface, its interaction is the entity client's mailbox.
 */
export interface AppSessionHandle {
  readonly id: string;
  readonly approvals: SessionHandle["approvals"];
  readonly requests: {
    timeout(
      requestId: string,
      at: number,
    ): Effect.Effect<void, Core.ExecutionError>;
  };
  interrupt(): Effect.Effect<void, Core.SessionError>;
  readonly tools: {
    add: SessionHandle["tools"]["add"];
  };
}
