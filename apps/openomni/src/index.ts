import { processEntryPath } from "./process-entry-path";
import { type ChatAgentConfig, createCompactionPolicy } from "@openomni/agent";
import {
  type ChannelDeliveryRoute,
  type GatewayRouter,
  WaitService,
  WebSocketHandler,
} from "@openomni/channels";
import { homedir } from "node:os";
import {
  ActorRegistry,
  ApprovalStore,
  Artifact,
  BusPersistence,
  ChannelInstanceStore,
  ConversationStore,
  DelegationStore,
  initialize,
  LeaseStore,
  PersonStore,
  SecretStore,
  Session,
  Storage,
} from "@openomni/ledger";

import { createMachineHost, type MachineHost } from "@openomni/machines";
import type { Placement } from "@openomni/placement";
import {
  type Channel,
  Gateway,
  type Ingress,
  type Machine,
} from "@openomni/protocol";
import { Bus, newTraceId } from "@openomni/telemetry";
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
import type { ArtifactsPort } from "./tools/artifacts";
import { createLlmToolPort } from "./tools/llm";
import type { MachinesPort } from "./tools/machines";
import { createChannelDriver } from "./delegation/channel-driver";
import { createInlineDriver } from "./delegation/inline-driver";
import {
  createDelegationKernel,
  type DelegationKernel,
  type DelegationWake,
} from "./delegation/kernel";
import { delegationTraceId } from "./delegation/trace";
import { createWakeDeliveryQueue } from "./delegation/wake-delivery";
import { createWorkItemLinkage } from "./delegation/work-item-linkage";
import { createCompletionPort } from "./work-item/completion";
import { createProcessDriver } from "./delegation/process-driver";
import { createInlineWorkerRunner } from "./delegation/worker-loop";
import { createResidentGateway, registerTrustedChannelGrant } from "./gateway";
import { createComposer, rollbackToCause } from "./composition/composer";
import { createPolicyRegistry } from "./composition/policy-registry";
import { createDriverRegistry } from "./composition/driver-registry";
import { openCuratedMemory } from "./memory/store";
import { buildInboundEvent } from "./inbound";
import { createResident } from "./resident";
import { createMachineVfs, scopeMachineVfs, type MachineVfs } from "./machines/vfs";
import { catalogEntries } from "./tools/catalog";
import { HOST_TARGET } from "./tools/dispatch";
import { createCellRegistry } from "./tools/cell-registry";
import type { CellPorts } from "./tools/run-code";

interface StartOptions {
  readonly config?: OpenOmniConfig;
  readonly llm?: ChatAgentConfig["llm"];
}

/**
 * The targets a turn may place tools on: the brain, plus every enrolled
 * machine that is attached right now, each reduced to what it may actually
 * do. Reading attachment per turn is what makes a machine that connects
 * between two messages offerable on the second one.
 */
function attachedTargets(
  host: MachineHost | undefined,
  enrolled: readonly Machine.Enrollment[],
): readonly Placement.ToolTarget[] {
  if (host === undefined) return [HOST_TARGET];
  const machines = enrolled.flatMap((enrollment): Placement.ToolTarget[] => {
    const capabilities = host.attached(enrollment.machineId);
    return capabilities === undefined
      ? []
      : [{ kind: "machine", id: enrollment.machineId, capabilities: [...capabilities] }];
  });
  return [HOST_TARGET, ...machines];
}

/**
 * Owner-admitted delegation targets, recorded as durable identity facts.
 * Registration is an upsert, so a restart re-asserting the same actors is a
 * no-op — which is also why this is not a composer effect: durable facts are
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
 * The Resident's view of its body: every enrolled machine, attached or not,
 * reduced to the effective (enrollment∩offer) capability fold the host
 * attachment table holds.
 */
export function createMachinesPort(
  host: Pick<MachineHost, "attached" | "attachedExports"> | undefined,
  machines: OpenOmniConfig["machines"],
): MachinesPort | undefined {
  if (host === undefined || machines === undefined) return undefined;
  return () =>
    machines.enrolled.map((enrollment) => {
      const capabilities = host.attached(enrollment.machineId);
      return capabilities === undefined
        ? {
            machineId: enrollment.machineId,
            attached: false,
            capabilities: [],
            effectiveExports: [],
          }
        : {
            machineId: enrollment.machineId,
            attached: true,
            capabilities: [...capabilities],
            // The host's fold, never the enrollment's wish: an export the
            // Owner allowed but the daemon never offered reaches nothing, so
            // reporting it would invite a read that can only refuse.
            effectiveExports: [...(host.attachedExports(enrollment.machineId) ?? [])],
          };
    });
}

/**
 * The app's HTTP surface: the ws upgrade seam, unauthenticated liveness (no
 * clock, no version, no state), and — only when a GitHub channel is composed —
 * its webhook ingress. Everything else is 404. The webhook handler is read
 * live from the supervisor's table so a channel_declare landing a GitHub
 * instance mid-run is reachable without rebinding the server.
 */
export function createHttpRoutes(
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

/** How a correlated reply's payload reads when handed back to the waiting delegation. */
export function replyText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

/** Builds the internal, persisted Resident turn used for one settlement wake. */
function delegationWakeDelivery(wake: DelegationWake): Gateway.Deliver {
  const traceId = delegationTraceId(wake.record.delegationId);
  return Gateway.Deliver.parse({
    sessionId: wake.record.origin.sessionId,
    event: {
      id: `delegation:${wake.record.delegationId}:${wake.settlement.at}`,
      traceId,
      surface: "internal",
      userId: "system",
      payload: wake.message,
      target: { kind: "resident" },
      meta: {
        actor: { role: "system", id: "system" },
        agentName: "system",
        kind: "delegation.settled",
      },
      mode: "direct",
    },
    decision: {
      traceId,
      time: wake.settlement.at,
      inboundId: `delegation:${wake.record.delegationId}:inbound`,
      surface: "internal",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      reason: "durable delegation settlement",
      factsUsed: ["delegation.settled"],
      target: "resident",
      sessionId: wake.record.origin.sessionId,
    },
  });
}

export async function startOpenOmni(options: StartOptions = {}) {
  const config = options.config ?? loadConfig();
  assertWsExposure(config);
  // One resolution of the operator's endpoint and headers, shared by every
  // model caller this composition builds.
  const transport = modelTransport(config.model);
  // Every stage whose teardown matters is mounted on the composer: boot
  // rollback and shutdown are the same reverse-order release, owned by the
  // stage that acquired the thing rather than restated by hand in two places.
  const composer = createComposer();
  let kernel: DelegationKernel | undefined;
  try {
    let completionWriter!: Storage.WorkItemCompletionWriter;
    await composer.mount("journal", (ctx) => {
      completionWriter = initialize({ dbPath: config.dbPath });
      const stopBusPersistence = BusPersistence.start();
      // Journal shutdown contract: every accepted event row is committed
      // before the observer detaches and storage closes.
      ctx.effect(async () => {
        await BusPersistence.flush();
        stopBusPersistence();
        Storage.reset();
      });
    });
    const actors: readonly RegisteredActor[] = config.actors ?? [];
    registerActors(actors);
    // Declared Person manifests materialize alongside env actors — both are
    // idempotent identity upserts; the provisioning store is the durable one.
    materializePersons();

    // A worker loop holds the same delegate tool the Resident does, so the
    // runner needs the kernel that the kernel needs the runner to build. The
    // cycle is closed by handing the runner a getter rather than a value.
    let residentDeliver:
      | ((delivery: Gateway.Deliver) => Promise<Ingress.IngressResult>)
      | undefined;
    // Boot-rescan wakes arrive before the Resident's deliver chain can be
    // bound; they wait in this queue until the arm call below.
    const wakeDelivery = createWakeDeliveryQueue();
    const runner = createInlineWorkerRunner({
      model: config.model,
      apiKey: config.model.apiKey,
      ...(transport === undefined ? {} : { transport }),
      kernel: () => {
        if (kernel === undefined)
          throw new Error("delegation kernel used before composition finished");
        return kernel;
      },
      ...(options.llm === undefined ? {} : { llm: options.llm }),
    });
    // The gateway owns the send kernel the channel driver speaks through, and
    // the gateway needs the deliver chain the kernel is part of — the same
    // late-binding the runner/kernel pair uses.
    let gateway: GatewayRouter | undefined;
    const channelDriver = createChannelDriver({
      send: (input) => {
        if (gateway === undefined) throw new Error("messaging used before composition finished");
        return gateway.messaging.send(input);
      },
      now: () => Date.now(),
      newWaitId: () => crypto.randomUUID(),
      conversations: ConversationStore,
    });
    // The kernel reads this table at dispatch time, so registrations made
    // (or replaced) after boot are visible to the very next dispatch. Each
    // boot registration is a composer-owned effect: disposing revokes the
    // driver's admission to new work while in-flight runs complete under the
    // generation that dispatched them.
    const driverRegistry = createDriverRegistry();
    await composer.mount("delegation.drivers", (ctx) => {
      const registrations = [
        driverRegistry.register("inline", createInlineDriver(runner)),
        driverRegistry.register("channel", channelDriver),
        driverRegistry.register(
          "process",
          createProcessDriver({
            command: [process.execPath, processEntryPath(import.meta.url)],
            worker: {
              model: { provider: config.model.provider, id: config.model.id },
              apiKey: config.model.apiKey,
              ...(transport === undefined ? {} : { transport }),
            },
            dbPath: config.dbPath,
          }),
        ),
      ];
      for (const registration of registrations) {
        ctx.effect(() => registration.dispose());
      }
    });
    // The catalog's Conversation surface: window lifecycle plus the §3.5
    // spatial inverse (settling a window revokes its live leases).
    const conversePort = {
      open: ConversationStore.open,
      get: ConversationStore.get,
      close: ConversationStore.close,
      closeLeases: LeaseStore.closeByConversation,
    };
    const leasePort = {
      issue: LeaseStore.issue,
      getDelegation: (delegationId: string) => DelegationStore.get(delegationId),
    };
    // The catalog's approval lane (§6): Owner-consent requests plus the two
    // acts they authorize — promotion and cross-channel endpoint merge.
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
      approvals: {
        request: ApprovalStore.request,
        get: ApprovalStore.get,
        decision: ApprovalStore.decision,
      },
      materialize: materializePersons,
      removeIdentity: ActorRegistry.removeIdentity,
    };
    const approvalPort = {
      request: ApprovalStore.request,
      get: ApprovalStore.get,
      decide: ApprovalStore.decide,
      decision: ApprovalStore.decision,
      getIdentity: ActorRegistry.getIdentity,
      getEndpoint: ActorRegistry.getEndpoint,
      promote: ActorRegistry.promote,
      mergeEndpoint: ActorRegistry.mergeEndpoint,
    };
    kernel = createDelegationKernel({
      events: Bus,
      // §3.5 lease linkage: live-lease facts admit a worker's channel
      // delegation, and every settlement durably closes the holder's leases.
      leases: {
        listLiveByHolder: (holderDelegationId, now) =>
          LeaseStore.listLiveByHolder(holderDelegationId, now).map((lease) => ({
            id: lease.id,
            conversationId: lease.conversationId,
            holderDelegationId: lease.holderDelegationId,
            contactId: lease.contactId,
          })),
        closeByHolder: LeaseStore.closeByHolder,
      },
      workItems: createWorkItemLinkage({
        model: { provider: config.model.provider, id: config.model.id },
        now: () => Date.now(),
      }),
      wake: (wake) => wakeDelivery.deliver(wake),
      bootSweep: false,
      drivers: driverRegistry.drivers,
      now: () => Date.now(),
      newDelegationId: () => crypto.randomUUID(),
    });
    // Const capture for the closures below (the outer `let kernel` exists so
    // the runner's late-binding getter can reach it).
    const delegationKernel = kernel;
    await composer.mount("delegation.kernel", (ctx) => {
      ctx.effect(() => delegationKernel.stop());
    });

    // The cell door is bound per cell rather than globally, so a cell serves
    // exactly the tools its own dispatcher holds.
    const registry = createCellRegistry();
    const machines = config.machines;
    const host: MachineHost | undefined =
      machines === undefined
        ? undefined
        : await createMachineHost({
            socketPath: machines.socketPath,
            enrollment: (machineId) => machines.enrolled.find((e) => e.machineId === machineId),
            events: Bus,
            now: () => Date.now(),
            callTool: registry.callTool,
          });
    if (host !== undefined) {
      const attachedHost = host;
      await composer.mount("machines", (ctx) => ctx.effect(() => attachedHost.close()));
    }

    // Self-referential: a cell's catalog is the same one that dispatches cells,
    // and placement subtracts what a cell cannot reach.
    // The Resident's one durable memory (kernel-contract §5): curated through
    // the memory tool, frozen into the system prompt per session.
    const memory = openCuratedMemory(config.memoryPath);

    const machineHost = host;
    const machinesPort = createMachinesPort(machineHost, machines);
    // The read-only machine filesystem as one flat namespace, wired only when
    // the Owner has published at least one export to reach. Fail-closed on
    // CONFIG rather than on live attachment: an enrollment naming no export
    // can never yield a readable path, so the tools stay out of the catalog
    // entirely instead of being offered and always refusing. Which machine is
    // readable right now stays a per-call answer — the host owns that.
    const machineFs: MachineVfs | undefined =
      machineHost === undefined ||
      !(machines?.enrolled ?? []).some(
        (enrollment) => (enrollment.allowedExports ?? []).length > 0,
      )
        ? undefined
        : createMachineVfs((machineId, request) => machineHost.fsOp(machineId, request));

    const completionPort = createCompletionPort({
      writer: completionWriter,
      now: () => Date.now(),
    });
    const llmPort = createLlmToolPort(
      { ...config.model, ...(transport === undefined ? {} : { transport }) },
      options.llm ?? {},
    );
    const artifactsPort: ArtifactsPort = { store: Artifact.store, get: Artifact.get };
    const cells: CellPorts | undefined =
      machineHost === undefined
        ? undefined
        : {
            registry,
            runCell: (machineId, request) => machineHost.runCell(machineId, request),
            // The cell door's fs reach is the EXECUTING machine's, not the
            // Owner's whole namespace: `run_code` knows which machine it is
            // dispatching to, so the catalog that cell will call back into is
            // built against a vfs scoped to exactly that machine. The Resident
            // catalog below keeps the unscoped port — that door is the Owner's.
            toolsFor: (origin, machineId) =>
              catalogEntries(
                {
                  delegation: delegationKernel,
                  cells,
                  ...(machinesPort === undefined ? {} : { machines: machinesPort }),
                  ...(machineFs === undefined ? {} : { machineFs: scopeMachineVfs(machineFs, machineId) }),
                  memory,
                  workItems: completionPort,
                  llm: llmPort,
                  artifacts: artifactsPort,
                  conversations: conversePort,
                  leases: leasePort,
                  approvals: approvalPort,
                  provisioning: provisioningPort,
                },
                origin,
              ),
            newCellId: () => crypto.randomUUID(),
          };

    // The Resident's policy floor: compaction is declared mandatory, so a
    // run without it is refused fail-closed rather than run unprotected.
    // The registration is a composer-owned effect — disposing the policy
    // stage suspends dependent runs instead of silently widening them.
    const policyRegistry = createPolicyRegistry({ mandatory: ["compaction"] });
    await composer.mount("policy", (ctx) => {
      const compaction = policyRegistry.register("compaction", (run) =>
        createCompactionPolicy({
          events: run.events,
          priority: 900,
          elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 500 },
        }),
      );
      ctx.effect(() => compaction.dispose());
    });

    residentDeliver = createResident({
      model: config.model,
      ...(config.model.fallbacks === undefined ? {} : { modelFallbacks: config.model.fallbacks }),
      apiKey: config.model.apiKey,
      ...(transport === undefined ? {} : { transport }),
      policies: policyRegistry,
      tools: {
        delegation: delegationKernel,
        ...(cells === undefined ? {} : { cells }),
        ...(machinesPort === undefined ? {} : { machines: machinesPort }),
        ...(machineFs === undefined ? {} : { machineFs }),
        memory,
        workItems: completionPort,
        llm: llmPort,
        artifacts: artifactsPort,
        conversations: conversePort,
        leases: leasePort,
        approvals: approvalPort,
        provisioning: provisioningPort,
      },
      targets: () => attachedTargets(host, machines?.enrolled ?? []),
      ...(options.llm === undefined ? {} : { llm: options.llm }),
    });

    // A delivery the perimeter correlated to an open Wait is an actor's answer
    // to a delegation, not a message for the Resident: it settles the waiting
    // delegate call. A waitContext nothing is waiting on (a resume after this
    // process restarted) falls through to the Resident as an ordinary message.
    const deliver = async (delivery: Gateway.Deliver): Promise<Ingress.IngressResult> => {
      const wait = delivery.waitContext;
      // A wait-correlated route always carries the wait owner's session label
      // (resolve-route pins `sessionId: state.wait.sessionId`), so no fallback:
      // a labelless delivery is ordinary traffic for the Resident.
      const sessionId = delivery.sessionId;
      if (
        wait !== undefined &&
        sessionId !== undefined &&
        delegationKernel.settleFromReply(wait.waitId, replyText(delivery.event.payload))
      ) {
        return {
          mode: "direct",
          target: { kind: "resident" },
          sessionId,
          result: {
            output: "Reply received — the delegation it answers is settling.",
            finishReason: "stop",
          },
        };
      }
      return residentDeliver(delivery);
    };

    // Every channel driver enters through the same gateway ingest seam. The
    // closure is bound before the router exists but cannot be called until a
    // surface starts after composition completes.
    const routingHandler: Channel.MessageHandler = async (message) => {
      if (gateway === undefined)
        throw new Error("channel delivery used before composition finished");
      const result = await gateway.ingest(buildInboundEvent(message));
      return result.kind === "dropped" ? null : { text: result.result.output };
    };
    let wsHandler: WebSocketHandler | undefined;
    const wsRoute = async (externalId: string, body: string) => {
      if (wsHandler === undefined) throw new Error("ws delivery used before composition finished");
      return wsHandler.push(externalId, body);
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
      grant: registerTrustedChannelGrant,
      deliveryRoutes,
      webhookHandlers,
      traceId: newTraceId,
    });
    channelSupervisor = supervisor;
    gateway = createResidentGateway(
      deliver,
      actors.length === 0
        ? undefined
        : {
            deliveryRoutes,
            grants: () =>
              actors.map((actor) => ({
                id: `resident->${actor.actorId}`,
                senderId: "resident",
                targetActorId: actor.actorId,
                operations: ["awaited" as const, "fire_and_forget" as const],
              })),
            budgets: () => config.socialBudgets ?? [],
          },
    );
    // Recovery is deliberately after the Resident and gateway exist: boot
    // settlements must be able to deliver their one owner-session wake.
    const recoveryTraceId = newTraceId();
    WaitService.sweepExpired(recoveryTraceId, Bus.publish);
    Session.sweepExpired(recoveryTraceId);
    kernel.start();
    // Recovery wakes arrived during kernel.start() and queued; arming binds
    // the Resident delivery and flushes them. Reject-only on failure: the
    // kernel's deliverWake is the single owner of wake-failure reporting.
    wakeDelivery.arm((wake) => residentDeliver(delegationWakeDelivery(wake)).then(() => undefined));

    await composer.mount("channels", async (ctx) => {
      ctx.effect(() => supervisor.stopAll());
      await supervisor.reconcile();
    });

    wsHandler = new WebSocketHandler(
      routingHandler,
      Bus.publish,
      config.wsToken === undefined ? {} : { token: config.wsToken },
    );

    const server = Bun.serve({
      hostname: config.host,
      port: config.wsPort,
      websocket: wsHandler.ws,
      fetch: createHttpRoutes(wsHandler, () => webhookHandlers.get("github")),
    });

    if (server.port === undefined) throw new Error("OpenOmni ws server did not bind a TCP port");
    const boundServer = server;
    const boundPort: number = server.port;
    await composer.mount("ws.server", (ctx) => {
      // Initiate the graceful stop without awaiting it: Bun resolves this
      // promise only after every open client connection closes, and shutdown
      // must not wait on clients (the pre-composer stop never did).
      ctx.effect(() => {
        void boundServer.stop();
      });
    });
    return {
      port: boundPort,
      // The boot's honest channel record: where config came from and why each
      // declared row did or did not mount (provision_status reads this later).
      channels: { source: liveSupervisor().source(), statuses: liveSupervisor().status() },
      // Shutdown is the same reverse-order release boot rollback uses: the
      // composer owns the sequence, so a new stage cannot leak by forgetting
      // a line here.
      stop: () => composer.dispose(),
    };
  } catch (error) {
    // Fail-closed boot rollback: a failure after the journal started leaves
    // no leaked Bus observer, no armed kernel timer, and no configured
    // storage behind — a later boot starts clean.
    return rollbackToCause(composer, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Entry-point shutdown wiring, extracted behind seams so tests can drive it
 * deterministically. The handler awaits the full async stop (journal flush,
 * observer detach, storage reset) before any exit — exiting earlier can
 * precede BusPersistence.flush() and lose accepted journal rows.
 */
export function installShutdownHandlers(deps: {
  readonly stop: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly on: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}): void {
  const handler = () => {
    void deps.stop().then(
      () => deps.exit(0),
      () => deps.exit(1),
    );
  };
  deps.on("SIGINT", handler);
  deps.on("SIGTERM", handler);
}
