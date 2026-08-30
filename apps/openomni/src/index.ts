import { processEntryPath } from "./process-entry-path";
import type { ChatAgentConfig } from "@openomni/agent";
import { type GatewayRouter, WaitService, WebSocketHandler } from "@openomni/channels";
import {
  ActorRegistry,
  Artifact,
  BusPersistence,
  initialize,
  Session,
  Storage,
} from "@openomni/ledger";
import { ModelsDev, run as llmRun, type Sink } from "@openomni/llm";
import { createMachineHost, type MachineHost } from "@openomni/machines";
import type { Placement } from "@openomni/placement";
import {
  type Channel,
  Gateway,
  type Ingress,
  type Machine,
  type Message,
  newTraceId,
} from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createChannelDrivers } from "./channels";
import { assertWsExposure, loadConfig, type OpenOmniConfig, type RegisteredActor } from "./config";
import type { ArtifactsPort } from "./tools/artifacts";
import { type LlmPort, resolveLlmToolModel } from "./tools/llm";
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
import { createResidentGateway } from "./gateway";
import { openCuratedMemory } from "./memory/store";
import { buildInboundEvent } from "./inbound";
import { createResident } from "./resident";
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
 * The llm tool's one-shot sub-model call: a single user message, no tools,
 * one step, its own synthesized trace — a nested run must never borrow the
 * turn's run identity. Auth is the configured key, exactly as the Resident
 * and the worker loop authenticate.
 */
function createLlmToolPort(model: OpenOmniConfig["model"]): LlmPort {
  return async (prompt) => {
    const sessionId = "llm-tool";
    const messageId = crypto.randomUUID();
    const request: Message.WithParts = {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "llm-tool",
        model: { providerID: model.provider, modelID: model.id },
      },
      parts: [
        {
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: messageId,
          type: "text",
          text: prompt,
        },
      ],
    };
    let answer = "";
    const sink: Sink = {
      onMessage: (message) => {
        if (message.info.role !== "assistant") return;
        answer = message.parts
          .filter((part): part is Message.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("");
      },
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    };
    const outcome = await llmRun(
      {
        messages: [request],
        tools: [],
        maxSteps: 1,
        model: resolveLlmToolModel(await ModelsDev.get(), { provider: model.provider, id: model.id }),
        auth: { type: "api", key: model.apiKey },
        trace: {
          traceId: newTraceId(),
          sessionId,
          runId: crypto.randomUUID(),
        },
        events: Bus,
      },
      sink,
    );
    if (outcome.type !== "stop") {
      const reason =
        "error" in outcome && outcome.error !== undefined
          ? outcome.error.message
          : `the sub-model run ended as ${outcome.type}`;
      // Thrown, not returned: the consumer is cell code, and a failure string
      // returned as data would be stored as if it were model output.
      throw new Error(`llm failed: ${reason}`);
    }
    return answer;
  };
}

/** How a correlated reply's payload reads when handed back to the waiting delegation. */
function replyText(payload: unknown): string {
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
  const completionWriter = initialize({ dbPath: config.dbPath });
  const stopBusPersistence = BusPersistence.start();
  // Boot owns the kernel and host handles from this scope so the rollback
  // path below can tear down whatever a failed boot already built.
  let kernel: DelegationKernel | undefined;
  let host: MachineHost | undefined;
  let externalSurfaces: Channel.Surface[] = [];
  try {
    // Owner-admitted delegation targets. Registration is an upsert, so a
    // restart re-asserting the same actors is a no-op.
    const actors: readonly RegisteredActor[] = config.actors ?? [];
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
    });
    kernel = createDelegationKernel({
      events: Bus,
      workItems: createWorkItemLinkage({
        model: { provider: config.model.provider, id: config.model.id },
        now: () => Date.now(),
      }),
      wake: (wake) => wakeDelivery.deliver(wake),
      bootSweep: false,
      drivers: {
        inline: createInlineDriver(runner),
        channel: channelDriver,
        process: createProcessDriver({
          command: [process.execPath, processEntryPath(import.meta.url)],
          worker: {
            model: { provider: config.model.provider, id: config.model.id },
            apiKey: config.model.apiKey,
          },
          dbPath: config.dbPath,
        }),
      },
      now: () => Date.now(),
      newDelegationId: () => crypto.randomUUID(),
    });
    // Const capture for the closures below (the outer `let kernel` exists so
    // boot rollback can stop a partially built kernel).
    const delegationKernel = kernel;

    // The cell door is bound per cell rather than globally, so a cell serves
    // exactly the tools its own dispatcher holds.
    const registry = createCellRegistry();
    const machines = config.machines;
    host =
      machines === undefined
        ? undefined
        : await createMachineHost({
            socketPath: machines.socketPath,
            enrollment: (machineId) => machines.enrolled.find((e) => e.machineId === machineId),
            events: Bus,
            now: () => Date.now(),
            callTool: registry.callTool,
          });

    // Self-referential: a cell's catalog is the same one that dispatches cells,
    // and placement subtracts what a cell cannot reach.
    // The Resident's one durable memory (kernel-contract §5): curated through
    // the memory tool, frozen into the system prompt per session.
    const memory = openCuratedMemory(config.memoryPath);

    // The Resident's view of its body: every enrolled machine, attached or
    // not, reduced to the effective (enrollment∩offer) capability fold the
    // host attachment table holds.
    // A const capture keeps the narrowing the closures below rely on (the
    // outer `let host` exists only so boot rollback can reach the handle).
    const machineHost = host;
    const machinesPort: MachinesPort | undefined =
      machineHost === undefined || machines === undefined
        ? undefined
        : () =>
            machines.enrolled.map((enrollment) => {
              const capabilities = machineHost.attached(enrollment.machineId);
              return capabilities === undefined
                ? { machineId: enrollment.machineId, attached: false, capabilities: [] }
                : {
                    machineId: enrollment.machineId,
                    attached: true,
                    capabilities: [...capabilities],
                  };
            });

    const completionPort = createCompletionPort({
      writer: completionWriter,
      now: () => Date.now(),
    });
    const llmPort = createLlmToolPort(config.model);
    const artifactsPort: ArtifactsPort = { store: Artifact.store, get: Artifact.get };
    const cells: CellPorts | undefined =
      machineHost === undefined
        ? undefined
        : {
            registry,
            runCell: (machineId, request) => machineHost.runCell(machineId, request),
            toolsFor: (origin) =>
              catalogEntries(
                {
                  delegation: delegationKernel,
                  cells,
                  ...(machinesPort === undefined ? {} : { machines: machinesPort }),
                  memory,
                  workItems: completionPort,
                  llm: llmPort,
                  artifacts: artifactsPort,
                },
                origin,
              ),
            newCellId: () => crypto.randomUUID(),
          };

    residentDeliver = createResident({
      model: config.model,
      apiKey: config.model.apiKey,
      tools: {
        delegation: delegationKernel,
        ...(cells === undefined ? {} : { cells }),
        ...(machinesPort === undefined ? {} : { machines: machinesPort }),
        memory,
        workItems: completionPort,
        llm: llmPort,
        artifacts: artifactsPort,
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
    const channelSetup = createChannelDrivers(config, routingHandler);
    externalSurfaces = channelSetup.surfaces;

    let wsHandler: WebSocketHandler | undefined;
    const wsRoute = async (externalId: string, body: string) => {
      if (wsHandler === undefined) throw new Error("ws delivery used before composition finished");
      return wsHandler.push(externalId, body);
    };
    const deliveryRoutes = new Map(channelSetup.deliveryRoutes);
    deliveryRoutes.set("ws", wsRoute);
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
      ["ws", ...externalSurfaces.map((surface) => surface.id as "discord" | "telegram" | "github")],
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

    wsHandler = new WebSocketHandler(
      routingHandler,
      Bus.publish,
      config.wsToken === undefined ? {} : { token: config.wsToken },
    );

    const server = Bun.serve({
      hostname: config.host,
      port: config.wsPort,
      websocket: wsHandler.ws,
      fetch(request, bunServer) {
        const url = new URL(request.url);
        if (request.headers.get("upgrade") === "websocket" && url.pathname === "/ws") {
          // undefined = the upgrade succeeded; a Response = the upgrade was denied.
          return wsHandler.handleUpgrade(request, bunServer);
        }
        if (request.method === "GET" && url.pathname === "/health") {
          // Unauthenticated liveness only: no clock, no version, no state.
          return Response.json({ ok: true });
        }
        if (
          request.method === "POST" &&
          url.pathname === "/github/webhook" &&
          channelSetup.githubWebhookHandler !== undefined
        ) {
          return channelSetup.githubWebhookHandler(request);
        }
        return new Response("Not found", { status: 404 });
      },
    });

    if (server.port === undefined) throw new Error("OpenOmni ws server did not bind a TCP port");
    try {
      await Promise.all(externalSurfaces.map((surface) => surface.start(recoveryTraceId)));
    } catch (error) {
      server.stop();
      throw error;
    }
    return {
      port: server.port,
      async stop(): Promise<void> {
        server.stop();
        for (const surface of externalSurfaces) surface.stop(newTraceId());
        kernel?.stop();
        host?.close();
        // Journal shutdown contract: every accepted event row is committed
        // before the observer detaches and storage closes.
        await BusPersistence.flush();
        stopBusPersistence();
        Storage.reset();
      },
    };
  } catch (error) {
    // Fail-closed boot rollback: a failure after the journal started leaves
    // no leaked Bus observer, no armed kernel timer, and no configured
    // storage behind — a later boot starts clean.
    for (const surface of externalSurfaces) surface.stop(newTraceId());
    kernel?.stop();
    host?.close();
    let flushError: unknown;
    try {
      await BusPersistence.flush();
    } catch (caught) {
      flushError = caught;
    } finally {
      stopBusPersistence();
      Storage.reset();
    }
    if (flushError !== undefined) {
      const rollbackFailure = new Error(
        "OpenOmni boot failed and journal rollback flush failed",
      ) as Error & {
        errors: readonly unknown[];
      };
      rollbackFailure.errors = [error, flushError];
      throw rollbackFailure;
    }
    throw error;
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
