import { afterEach } from "bun:test";
import { Bus, closeSessions, wakeSession, type SessionRuntime } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { createResident, type ResidentOptions } from "../../src/resident";
import { commitMessageInbox } from "../../src/composition/message-session";
import { seedKernelPolicyRows } from "../../src/policy-seed";

const runtimes: SessionRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await closeSessions(runtime);
});

export function residentRunner(
  options: Omit<ResidentOptions, "sessionRuntime"> & { sessionRuntime?: SessionRuntime },
) {
  const runtime = options.sessionRuntime ?? { observations: Bus, waitRetry: async () => undefined };
  runtimes.push(runtime);
  seedKernelPolicyRows();
  const resident = createResident({ ...options, sessionRuntime: runtime });
  return {
    ...resident,
    runtime,
    async prompt(sessionId: string, content: string) {
      const exists = SessionHandleStore.listRows().some((row) => row.id === sessionId);
      commitMessageInbox({
        id: crypto.randomUUID(),
        sessionId,
        kind: "prompt",
        content,
        origin: { encodingVersion: 1, value: { kind: "test" } },
        createdAt: (runtime.clock ?? Date.now)(),
        parentActionId: null,
        ...(exists
          ? {}
          : { createSession: resident.materialize(sessionId, null, "resident", "resident") }),
      });
      const result = await wakeSession(
        sessionId,
        resident.runnerFor(SessionHandleStore.row(sessionId)),
        runtime,
      );
      if (result === undefined) throw new Error("resident turn returned no result");
      return result;
    },
  };
}
