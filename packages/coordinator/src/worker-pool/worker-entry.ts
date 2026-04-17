import { join } from "node:path";
import { homedir } from "node:os";
import { ChatAgent } from "@openomni/agent";
import { Execution } from "@openomni/protocol";
import { initialize } from "@openomni/session";
import { PlanAgent, SessionBridge } from "@openomni/openomni";
import { createIpcServer } from "../ipc/server";

const args = process.argv.slice(2);
const workerId = args[args.indexOf("--worker-id") + 1] ?? "unknown";
const socketPath = args[args.indexOf("--socket") + 1];

if (!socketPath) {
  console.error("worker-entry: missing --socket argument");
  process.exit(1);
}

initialize({
  dbPath: process.env.OPENOMNI_DB_PATH ?? join(homedir(), ".openomni", "storage.db"),
});

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
        if (request.mode === "direct") {
          const messages = SessionBridge.buildDirectMessages(sessionId).filter(
            (m): m is { role: "user"; content: string } | { role: "assistant"; content: string } =>
              m.role === "user" || m.role === "assistant",
          );
          const agent = ChatAgent.create({
            model: request.model,
            systemPrompt: request.systemPrompt,
            budget: request.budget,
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
