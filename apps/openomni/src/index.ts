import type { ChatAgentConfig } from "@openomni/agent";
import { type GatewayRouter, WebSocketHandler } from "@openomni/channels";
import { ActorRegistry, initialize, Storage } from "@openomni/ledger";
import { createMachineHost, type MachineHost } from "@openomni/machines";
import type { Placement } from "@openomni/placement";
import type { Gateway, Ingress, Machine } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { assertWsExposure, loadConfig, type OpenOmniConfig, type RegisteredActor } from "./config";
import type { MachinesPort } from "./tools/machines";
import { createChannelDriver } from "./delegation/channel-driver";
import { createInlineDriver } from "./delegation/inline-driver";
import { createDelegationKernel, type DelegationKernel } from "./delegation/kernel";
import { createProcessDriver } from "./delegation/process-driver";
import { createInlineWorkerRunner } from "./delegation/worker-loop";
import { createResidentGateway } from "./gateway";
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

/** How a correlated reply's payload reads when handed back to the waiting delegation. */
function replyText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

export async function startOpenOmni(options: StartOptions = {}) {
  const config = options.config ?? loadConfig();
  assertWsExposure(config);
  initialize({ dbPath: config.dbPath });

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
    ActorRegistry.registerEndpoint({
      id: `ws:${actor.externalId}`,
      actorId: actor.actorId,
      channel: "ws",
      externalId: actor.externalId,
    });
  }

  // A worker loop holds the same delegate tool the Resident does, so the
  // runner needs the kernel that the kernel needs the runner to build. The
  // cycle is closed by handing the runner a getter rather than a value.
  let kernel: DelegationKernel | undefined;
  const runner = createInlineWorkerRunner({
    model: config.model,
    apiKey: config.model.apiKey,
    kernel: () => {
      if (kernel === undefined) throw new Error("delegation kernel used before composition finished");
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
    drivers: {
      inline: createInlineDriver(runner),
      channel: channelDriver,
      process: createProcessDriver({
        command: [
          process.execPath,
          new URL("./delegation/process-entry.ts", import.meta.url).pathname,
        ],
        worker: {
          model: { provider: config.model.provider, id: config.model.id },
          apiKey: config.model.apiKey,
        },
      }),
    },
    now: () => Date.now(),
    newDelegationId: () => crypto.randomUUID(),
  });

  // The cell door is bound per cell rather than globally, so a cell serves
  // exactly the tools its own dispatcher holds.
  const registry = createCellRegistry();
  const machines = config.machines;
  const host =
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
  const cells: CellPorts | undefined =
    host === undefined
      ? undefined
      : {
          registry,
          runCell: (machineId, request) => host.runCell(machineId, request),
          toolsFor: (origin) => catalogEntries({ delegation: kernel, cells }, origin),
          newCellId: () => crypto.randomUUID(),
        };

  // The Resident's view of its body: every enrolled machine, attached or
  // not, reduced to the effective (enrollment∩offer) capability fold the
  // host attachment table holds.
  const machinesPort: MachinesPort | undefined =
    host === undefined || machines === undefined
      ? undefined
      : () =>
          machines.enrolled.map((enrollment) => {
            const capabilities = host.attached(enrollment.machineId);
            return capabilities === undefined
              ? { machineId: enrollment.machineId, attached: false, capabilities: [] }
              : { machineId: enrollment.machineId, attached: true, capabilities: [...capabilities] };
          });

  const residentDeliver = createResident({
    model: config.model,
    apiKey: config.model.apiKey,
    tools: {
      delegation: kernel,
      ...(cells === undefined ? {} : { cells }),
      ...(machinesPort === undefined ? {} : { machines: machinesPort }),
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
      channelDriver.resume(wait.waitId, replyText(delivery.event.payload))
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

  // Late-binds the handler the route delivers through: the gateway needs the
  // route before the ws handler that needs the gateway exists.
  let wsHandler: WebSocketHandler | undefined;
  const wsRoute = async (externalId: string, body: string) => {
    if (wsHandler === undefined) throw new Error("ws delivery used before composition finished");
    return wsHandler.push(externalId, body);
  };
  gateway = createResidentGateway(
    deliver,
    actors.length === 0
      ? undefined
      : {
          deliveryRoutes: new Map([["ws", wsRoute]]),
          grants: () =>
            actors.map((actor) => ({
              id: `resident->${actor.actorId}`,
              senderId: "resident",
              targetActorId: actor.actorId,
              operations: ["awaited" as const],
            })),
        },
  );
  const boundGateway = gateway;
  wsHandler = new WebSocketHandler(async (message) => {
    const result = await boundGateway.ingest(buildInboundEvent(message));
    return result.kind === "dropped" ? null : { text: result.result.output };
  }, Bus.publish, config.wsToken === undefined ? {} : { token: config.wsToken });

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
      return new Response("Not found", { status: 404 });
    },
  });

  if (server.port === undefined) throw new Error("OpenOmni ws server did not bind a TCP port");
  return {
    port: server.port,
    stop(): void {
      server.stop();
      host?.close();
      Storage.reset();
    },
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const app = await startOpenOmni({ config });
  console.log(`OpenOmni Resident listening at ws://${config.host}:${app.port}/ws`);
  const stop = () => {
    app.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
