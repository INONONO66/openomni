import { Cause, Effect, Scope } from "effect";
import { bootResource } from "./composition/boot";
import { foreignFailure } from "./composition/failure";
import { shutdownSessions } from "./shutdown";
import {
  AppScope,
  type AppRuntime, type AppServices,
  lifecycleFailure,
} from "./runtime";
import { AsyncResource } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { createAlarmWorker } from "./composition/alarm-worker";
import { configuredCompaction } from "./compaction/strategy";
import { seedKernelPolicyRows } from "./policy-seed";
import {
  BundleDefinitions, Clock, Entropy, GenerationLayers, ObservationSink,
  createSessionRequests,
  type SessionRuntime,
  getSessionHandle,
  ForeignFailure as AgentFailure,
  ExecutionApprovalError,
  sweepSessions,
  wakeSession,
} from "@openomni/agent";
import {
  type ChannelDeliveryRoute,
  type GatewayRouter,
  decodeChannelFailure,
  ForeignFailure as ChannelFailure,
  WebSocketHandler,
} from "@openomni/channels";
import { homedir } from "node:os";
import {
  ActorRegistry,
  ChannelInstanceStore,
  LedgerWrites,
  PersonStore,
  SecretStore,
  SessionHandleStore,
} from "@openomni/ledger";

import {
  createMachineHost,
  ForeignFailure as MachineFailure,
  type MachineHost,
} from "@openomni/machines";
import type { Channel } from "@openomni/protocol";
import { Bus, newTraceId } from "@openomni/agent";
import { desiredChannels, materializePersons } from "./provisioning/declared";
import { type ChannelSupervisor, createChannelSupervisor } from "./provisioning/supervisor";
import { resolveKek } from "./provisioning/vault-key";
import type { ProvisionPort } from "./tools/provision";
import {
  assertWsExposure,
  loadConfig,
  modelTransport,
  type OpenOmniConfig,
  type RegisteredActor,
} from "./config";
import { createCompletionPort } from "./composition/completion";
import { processEntryPath } from "./process-entry-path";
import { createProcessSessionTransport } from "./composition/process-session";
import { commitMessageInbox, prepareMessage } from "./composition/message-session";
import { dispatchOutboundMessage } from "./composition/terminal-message";
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
import { requestDomainRevisions } from "./tools/core/request-domain-revisions";

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
function registerActors(actors: readonly RegisteredActor[]): void {
  for (const actor of actors) {
    ActorRegistry.registerIdentity({
      id: actor.actorId,
      kind: actor.kind,
      trustTier: actor.trustTier,
      ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    });
    const channel = actor.channel ?? "ws";
    ActorRegistry.registerEndpoint({
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
      dbPath: config.dbPath,
    });
  try {
    const services = await runAppBoot(
      runtime,
      Effect.gen(function* () {
        return {
          context: yield* Effect.context<AppServices>(),
          ledger: yield* LedgerWrites,
          scope: yield* AppScope,
          clock: yield* Clock,
          entropy: yield* Entropy,
          observations: yield* ObservationSink,
          bundles: yield* BundleDefinitions,
          generations: yield* GenerationLayers,
        };
      }),
    );
    const acquire = <A, E, E2>(
      resource: Effect.Effect<A, E>,
      release: (value: A) => Effect.Effect<void, E2>,
    ) => runAppBoot(runtime, bootResource(resource, release));
    const doorbell = await acquire(
      Effect.sync(() => new AsyncResource("session-inbox")),
      (resource) =>
        Effect.sync(() => {
          resource.emitDestroy();
        }),
    );
    seedKernelPolicyRows(services.bundles.select(services.bundles.names).rows);

    const sessionRuntime: SessionRuntime = {
      ...options.sessionRuntime,
      dispatchOutbound: dispatchOutboundMessage(
        (...args) => messages.ingest(...args),
        services.clock.now,
      ),
      requestDomainRevisions,
      onRequestReady: (id) => sessionRuntime.onInboxCommitted?.([id]),
      onInboxCommitted: (ids) => {
        for (const id of ids)
          doorbell.runInAsyncScope(() => {
            void wake(id);
          });
      },
      authorizeApproval: (credential, request) =>
        Effect.try({
          try: () => authenticateOwner(credential, request.id),
          catch: () => new ExecutionApprovalError({ code: "unauthenticated" }),
        }),
      authorizeConfigure: configureAuthority(services.generations),
    };
    const requests = await runAppBoot(runtime, createSessionRequests(sessionRuntime));
    let recovery: Promise<void> = Promise.resolve();
    await acquire(Effect.void, () => shutdownSessions(sessionRuntime, recovery));
    const actors: readonly RegisteredActor[] = config.actors ?? [];
    registerActors(actors);
    // Declared Person manifests materialize alongside env actors — both are
    // idempotent identity upserts; the provisioning store is the durable one.
    materializePersons();

    let gateway: GatewayRouter | undefined;
    const messages = {
      ingest: (...args: Parameters<GatewayRouter["ingest"]>) => {
        if (gateway === undefined) throw new Error("gateway is not composed");
        return gateway.ingest(...args);
      },
    };
    // Provisioning administration port: the supervisor is created after the
    // Resident (it needs the routing handler), so the port reaches it through
    // a late binding — tools cannot run before composition finishes anyway.
    let channelSupervisor: ChannelSupervisor | undefined;
    const liveSupervisor = (): ChannelSupervisor => {
      if (channelSupervisor === undefined)
        throw new Error("provisioning used before composition finished");
      return channelSupervisor;
    };
    const provisioningPort: ProvisionPort = {
      persons: PersonStore,
      instances: ChannelInstanceStore,
      secrets: SecretStore,
      kek: resolveKek(process.env, homedir()),
      supervisor: {
        reconcile: () => liveSupervisor().reconcile(),
        resume: (instanceId) => liveSupervisor().resume(instanceId),
        status: () => liveSupervisor().status(),
        source: () => liveSupervisor().source(),
      },
      materialize: materializePersons,
      removeIdentity: ActorRegistry.removeIdentity,
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
              events: Bus,
              now: () => Date.now(),
              callTool: (call) =>
                cells === undefined
                  ? Effect.succeed({ status: "failed" as const, error: "codemode is not composed" })
                  : cells.callTool(call).pipe(
                      Effect.mapError(
                        (error) =>
                          new MachineFailure({
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
    );
    if (host !== undefined) {
      cells = await acquireAppResource(runtime, composeCodemode(host));
    }

    const resident = createResident({
      toolDefinitions: options.toolDefinitions,
      ...residentModelOptions(config.model, transport),
      compaction: configuredCompaction(config),
      bundles: services.bundles.names,
      tools: {
        clock: services.clock.now,
        alarms: await createMonitorPorts(runtime),
        ...toolPorts(runtime, { machines: host, cells, completion: llmPort, messages }),
        provisioning: provisioningPort,
      },
      sessionRuntime,
    });

    await runAppBoot(runtime, services.generations.initialize(resident.definitions));

    const routingHandler: Channel.MessageHandler = async ({ sender, facts }) => {
      const admission = await runAppEffect(runtime, messages.ingest(sender, facts));
      if (admission.status === "blocked_pre") {
        throw new Error(`message admission refused: ${admission.reasonCode}`);
      }
    };
    let wsHandler: WebSocketHandler | undefined;
    const wsRoute = async (externalId: string, body: string, idempotencyKey: string) => {
      if (wsHandler === undefined) throw new Error("ws delivery used before composition finished");
      return wsHandler.push(externalId, body, idempotencyKey);
    };
    // Live table: channel components register and revoke their own outbound
    // routes while the gateway keeps reading it per delivery.
    const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
    deliveryRoutes.set("ws", wsRoute);
    // One runtime owner for external channels (provisioning §5): boot
    // reconcile and every tool-driven mutation run the SAME diff — any
    // declared ChannelInstance shadows env channel config entirely (§8.1).
    const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
    const supervisor = createChannelSupervisor({
      desired: () => desiredChannels(config),
      build: (component) => component.build(routingHandler),
      // The tier is the row's, never this call site's: mounting a named
      // surface materializes no owner authority (#931).
      grant: createMountedChannelGrantRegistrar(config.channelAllowedSenders),
      deliveryRoutes,
      webhookHandlers,
      traceId: newTraceId,
    });
    channelSupervisor = supervisor;
    const processSessions = createProcessSessionTransport({
      answer: (answer) =>
        runAppEffect(
          runtime,
          requests.answer({ ...answer, receivedAt: services.clock.now() }),
        ),
      command: [process.execPath, processEntryPath(import.meta.url)],
      worker: {
        dbPath: config.dbPath,
        model: config.model,
        apiKey: config.model.apiKey,
        ...(transport === undefined ? {} : { transport }),
      },
      committed: (ids) => {
        for (const id of ids)
          doorbell.runInAsyncScope(() => {
            void wake(id);
          });
      },
    });
    await acquire(Effect.succeed(processSessions), (resource) =>
      Effect.tryPromise({
        try: () => resource.close(),
        catch: lifecycleFailure("processes.close"),
      }),
    );
    const wakeEffect = (id: string) =>
      Effect.gen(function* () {
        const row = SessionHandleStore.row(id);
        const runner = SessionHandleStore.latestGenerationFor(id).systemBlocks.find(
          (block) => block.id === "runner" && block.source === "app:runner",
        )?.content;
        if (runner === "process") {
          yield* Effect.tryPromise({
            try: () => processSessions.wake(id),
            catch: foreignFailure((fields) => new AgentFailure(fields), "process.wake"),
          });
        } else {
          const scope = yield* AppScope;
          yield* Scope.extend(wakeSession(id, resident.runnerFor(row), sessionRuntime), scope);
        }
      });
    const wake = (id: string) =>
      runAppEffect(
        runtime,
        Effect.gen(function* () {
          const scope = yield* AppScope;
          yield* Effect.forkIn(
            wakeEffect(id).pipe(
              Effect.catchAllCause((cause) =>
                Cause.isInterruptedOnly(cause)
                  ? Effect.void
                  : Effect.sync(() => {
                      console.error("session wake failed", Cause.pretty(cause));
                    }),
              ),
            ),
            scope,
          );
        }),
      );
    gateway = await runAppBoot(
      runtime,
      createResidentGateway(
        {
          inbox: {
            commit: (input) =>
              commitMessageInbox(input).pipe(
                Effect.mapError(decodeChannelFailure("message.commit")),
              ),
          },
          prepare: prepareMessage(resident.materialize),
          requests: channelRequests(requests),
          authenticateAnswer: (_sender, credential, requestId) =>
            Effect.try({
              try: () => authenticateOwner(credential, requestId),
              catch: decodeChannelFailure("answer.authenticate"),
            }),
          committed: (row) => {
            doorbell.runInAsyncScope(() => {
              void wake(row.sessionId);
            });
          },
          clock: services.clock.now,
        },
        {
          deliveryRoutes,
          grants: () =>
            SessionHandleStore.listRows()
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
            SessionHandleStore.listRows()
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
    const alarms = await acquireAppResource(
      runtime,
      createAlarmWorker({
        alarms: services.ledger.alarms,
        requestTimeout: requests.timeout,
        observations: Bus,
        clock: services.clock.now,
        wake: (id) =>
          Effect.flatMap(AppScope, () => wakeEffect(id)).pipe(
            Effect.provide(services.context),
          ),
        failure: (error) => console.error("alarm worker failure", error),
      }),
    );
    await runAppBoot(runtime, alarms.start());

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
                  new ChannelFailure({
                    operation: "message.admission",
                    cause: admission.reasonCode,
                  }),
                )
              : Effect.void,
          ),
        ),
      Bus.publish,
      {
        ...(config.wsToken === undefined ? {} : { token: config.wsToken }),
        onRequestAnswer: (sender, answer) => messages.ingest(sender, answer),
      },
    );

    const server = Bun.serve({
      hostname: config.host,
      port: config.wsPort,
      websocket: webSocketCallbacks(runtime, wsHandler),
      fetch: createHttpRoutes(wsHandler, () => webhookHandlers.get("github")),
    });

    if (server.port === undefined) throw new Error("OpenOmni ws server did not bind a TCP port");
    const boundServer = server;
    const boundPort: number = server.port;
    await acquire(Effect.succeed(boundServer), (resource) =>
      Effect.tryPromise({
        try: () => resource.stop(true),
        catch: lifecycleFailure("websocket.close"),
      }),
    );
    const awaitingOwner = requests
      .list()
      .some((request) => request.mode === "approval" && request.state === "open");
    recovery = acquireAppResource(runtime, sweepSessions(resident.runnerFor, sessionRuntime));
    if (awaitingOwner) {
      void recovery.catch((error: Error) => console.error("session recovery failed", error));
    } else await recovery;
    let stopping: Promise<void> | undefined;
    const stop = async () => {
      await boundServer.stop(true);
      await supervisor.stopAll();
      await runAppEffect(runtime, shutdownSessions(sessionRuntime, recovery));
      if (cells !== undefined) await runAppEffect(runtime, cells.close().pipe(Effect.mapError(lifecycleFailure("shutdown.cell_unsettled"))));
      await runtime.dispose();
    };
    return {
      port: boundPort,
      gateway,
      sessions: { get: (id: string) => getSessionHandle(id, sessionRuntime) },
      // The boot's honest channel record: where config came from and why each
      // declared row did or did not mount (provision_status reads this later).
      channels: { source: liveSupervisor().source(), statuses: liveSupervisor().status() },
      runtime,
      stop: () => {
        stopping ??= stop().catch((error: Error) => { stopping = undefined; throw error; });
        return stopping;
      },
    };
  } catch (error) {
    await runtime.dispose().catch((disposal: Error) => {
      throw new AggregateError([error, disposal], "app boot and disposal failed");
    });
    throw error;
  }
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
