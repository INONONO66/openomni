import type { ChatAgentConfig } from "@openomni/agent";
import { WebSocketHandler } from "@openomni/channels";
import { initialize, Storage } from "@openomni/ledger";
import { createMachineHost, type MachineHost } from "@openomni/machines";
import type { Placement } from "@openomni/placement";
import type { Machine } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { assertWsExposure, loadConfig, type OpenOmniConfig } from "./config";
import { createInlineDriver } from "./delegation/inline-driver";
import { createDelegationKernel, type DelegationKernel } from "./delegation/kernel";
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

export async function startOpenOmni(options: StartOptions = {}) {
  const config = options.config ?? loadConfig();
  assertWsExposure(config);
  initialize({ dbPath: config.dbPath });

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
  kernel = createDelegationKernel({
    drivers: { inline: createInlineDriver(runner) },
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

  const deliver = createResident({
    model: config.model,
    apiKey: config.model.apiKey,
    tools: { delegation: kernel, ...(cells === undefined ? {} : { cells }) },
    targets: () => attachedTargets(host, machines?.enrolled ?? []),
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  });
  const gateway = createResidentGateway(deliver);
  const wsHandler = new WebSocketHandler(async (message) => {
    const result = await gateway.ingest(buildInboundEvent(message));
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
