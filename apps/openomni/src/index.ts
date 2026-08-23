import type { ChatAgentConfig } from "@openomni/agent";
import { WebSocketHandler } from "@openomni/channels";
import { initialize, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { loadConfig, type OpenOmniConfig } from "./config";
import { createResidentGateway } from "./gateway";
import { buildInboundEvent } from "./inbound";
import { createResident } from "./resident";

interface StartOptions {
  readonly config?: OpenOmniConfig;
  readonly llm?: ChatAgentConfig["llm"];
}

export function startOpenOmni(options: StartOptions = {}) {
  const config = options.config ?? loadConfig();
  initialize({ dbPath: config.dbPath });

  const deliver = createResident({
    model: config.model,
    apiKey: config.model.apiKey,
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  });
  const gateway = createResidentGateway(deliver);
  const wsHandler = new WebSocketHandler(async (message) => {
    const result = await gateway.ingest(buildInboundEvent(message));
    return result.kind === "dropped" ? null : { text: result.result.output };
  }, Bus.publish);

  const server = Bun.serve({
    hostname: config.host,
    port: config.wsPort,
    websocket: wsHandler.ws,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade") === "websocket" && url.pathname === "/ws") {
        return wsHandler.handleUpgrade(request, bunServer) ?? new Response(null, { status: 101 });
      }
      return new Response("Not found", { status: 404 });
    },
  });

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
