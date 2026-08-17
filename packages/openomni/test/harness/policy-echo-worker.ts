/**
 * E2E fixture for the gate → IPC → worker policy pipeline (#462 §7, #479
 * review W4). Speaks the real coordinator IPC protocol, and on spawn_run it
 * runs the REAL worker-side plan resolution (`buildWorkerMiddleware`) on the
 * policyPlan that arrived over the wire, echoing the active policy names back
 * as the run output. This is the same resolution path `worker-runner.ts`
 * uses — what this proves is that a gate-stamped plan survives the IPC
 * boundary and resolves to active policy registrations in a real spawned
 * worker process.
 */
import { createIpcServer } from "@openomni/ipc";
import { Policy } from "@openomni/protocol";
import { buildWorkerMiddleware } from "../../src/execution-runtime/middleware";

function readCliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workerId = readCliArg("--worker-id") ?? "policy-echo";
const socketPath = readCliArg("--socket");
const ipcAuthToken = process.env.OPENOMNI_WORKER_IPC_TOKEN;
delete process.env.OPENOMNI_WORKER_IPC_TOKEN;

if (!socketPath || !ipcAuthToken) {
  console.error("policy-echo-worker: missing --socket argument or IPC auth token");
  process.exit(1);
}

const server = await createIpcServer(
  socketPath,
  (method, params, respond, _notify, connectionId) => {
    if (method === "coordinator.bootstrap") {
      if (params?.authToken !== ipcAuthToken) {
        respond({ ok: false, error: "unauthorized" });
        return;
      }
      server.useConnection(connectionId);
      server.notify("worker.bootstrap_ready", { workerId, authToken: ipcAuthToken });
      respond({ ok: true });
      return;
    }

    if (method === "coordinator.spawn_run") {
      if (params?.authToken !== ipcAuthToken) {
        respond({ status: "failed", error: "unauthorized coordinator request" });
        return;
      }
      const runId = typeof params?.runId === "string" ? params.runId : "unknown";
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "unknown";
      const policyPlan = Policy.PolicyPlan.safeParse(params?.policyPlan);
      const registrations = buildWorkerMiddleware({
        ...(policyPlan.success ? { policyPlan: policyPlan.data } : {}),
      });
      respond({
        runId,
        sessionId,
        status: "succeeded",
        output: JSON.stringify({
          receivedPolicyPlan: policyPlan.success,
          activePolicies: registrations.map((registration) => registration.name),
        }),
        finishReason: "stop",
      });
      return;
    }

    respond({ ok: true });
  },
);

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
