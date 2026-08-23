import type { ChatAgentConfig } from "@openomni/agent";
import { WebSocketHandler } from "@openomni/channels";
import { initialize, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { assertWsExposure, loadConfig, type OpenOmniConfig } from "./config";
import { createInlineDriver } from "./delegation/inline-driver";
import { createDelegationKernel, type DelegationKernel } from "./delegation/kernel";
import { createInlineWorkerRunner } from "./delegation/worker-loop";
import { createResidentGateway } from "./gateway";
import { buildInboundEvent } from "./inbound";
import { createResident } from "./resident";

interface StartOptions {
  readonly config?: OpenOmniConfig;
  readonly llm?: ChatAgentConfig["llm"];
}

export function startOpenOmni(options: StartOptions = {}) {
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

  const deliver = createResident({
    model: config.model,
    apiKey: config.model.apiKey,
    delegation: kernel,
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
      Storage.reset();
    },
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const app = startOpenOmni({ config });
  console.log(`OpenOmni Resident listening at ws://${config.host}:${app.port}/ws`);
  const stop = () => {
    app.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
