import { ChatAgent } from "@openomni/agent";
import { createIpcServer } from "@openomni/coordinator";
import { Execution } from "@openomni/protocol";
import { initialize } from "@openomni/session";
import {
  AgentToolProvider,
  PlanAgent,
  SessionBridge,
  SystemToolProvider,
} from "@openomni/openomni";
import { loadConfig } from "../config";
import { connectMcpServers } from "../bootstrap/mcp";
import { McpToolProvider } from "../tool/mcp";
import { createExecutionToolContext, resolveWorkerDbPath } from "./worker-runtime";

const args = process.argv.slice(2);
const workerId = args[args.indexOf("--worker-id") + 1] ?? "unknown";
const socketPath = args[args.indexOf("--socket") + 1];

if (!socketPath) {
  console.error("worker-entry: missing --socket argument");
  process.exit(1);
}

const config = loadConfig();
initialize({
  dbPath: resolveWorkerDbPath(config),
});

const agentProvider = new AgentToolProvider();
const mcpProvider = new McpToolProvider();
const mcpReady = connectMcpServers(config, mcpProvider);

const server = createIpcServer(socketPath, (method, params, respond) => {
  if (method === "coordinator.spawn_run") {
    let request: Execution.Request;
    try {
      request = Execution.Request.parse(params);
    } catch (err) {
      respond({
        runId: typeof params?.runId === "string" ? params.runId : "unknown",
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : "unknown",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const { runId, sessionId } = request;

    (async () => {
      try {
        await mcpReady;

        if (request.mode === "direct") {
          const messages = SessionBridge.buildDirectMessages(sessionId).filter(
            (m): m is { role: "user"; content: string } | { role: "assistant"; content: string } =>
              m.role === "user" || m.role === "assistant",
          );
          const workspaceRoot = request.toolConfig?.workspaceRoot ?? config.workspace?.root;
          const systemProvider = new SystemToolProvider(workspaceRoot);
          const availableTools = [
            ...systemProvider.listTools(),
            ...agentProvider.listTools(),
            ...mcpProvider.listTools(),
          ];
          const toolContext = createExecutionToolContext(request, availableTools);
          const agent = ChatAgent.create({
            model: request.model,
            systemPrompt: request.systemPrompt,
            budget: request.budget,
            ...toolContext,
          });
          const runResult = await agent.run({ messages });
          respond({
            runId,
            sessionId,
            status: "succeeded",
            output: runResult.text,
            finishReason: runResult.finishReason,
          });
        } else {
          const goal = SessionBridge.buildPlanGoal(sessionId);
          const result = await PlanAgent.generate(goal, {
            model: request.model,
            systemPrompt: request.systemPrompt,
            budget: request.budget,
          });
          respond({
            runId,
            sessionId,
            status: "succeeded",
            output: JSON.stringify(result),
          });
        }
      } catch (err) {
        respond({
          runId,
          sessionId,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  } else if (method === "coordinator.cancel_run") {
    respond({ cancelled: true });
  } else {
    respond({ ok: true });
  }
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

console.log(`Worker ${workerId} started (PID ${process.pid}) socket=${socketPath}`);
