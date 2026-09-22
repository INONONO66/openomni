import { afterEach } from "bun:test";
import { Bus, closeSessions, wakeSession, type SessionRuntime } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { immediateRetryAlarm as nullRetryAlarm } from "./immediate-retry-alarm";
import { createResident, type ResidentOptions } from "../../src/resident";
import { runEffect } from "./effect";
import { effectScope } from "./effect-scope";

import { commitMessageInbox } from "../../src/composition/message-session";
import { seedKernelPolicyRows } from "../../src/policy-seed";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

export function residentRunner(
  options: Omit<ResidentOptions, "sessionRuntime"> & { sessionRuntime?: SessionRuntime },
) {
  const runtime = options.sessionRuntime ?? {
    observations: Bus,
    // Resolve on state, never a sleep: these tests exercise retries, not schedules.
    retryAlarm: nullRetryAlarm,
  };
  const scope = effectScope();
  cleanups.push(async () => {
    await runEffect(closeSessions(runtime));
    await scope.close();
  });
  seedKernelPolicyRows();
  const resident = createResident({ ...options, sessionRuntime: runtime });
  return {
    ...resident,
    runtime,
    async prompt(sessionId: string, content: string) {
      const exists = SessionHandleStore.listRows().some((row) => row.id === sessionId);
      await runEffect(commitMessageInbox({
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
      }));
      const result = await scope.run(wakeSession(
        sessionId,
        resident.runnerFor(SessionHandleStore.row(sessionId)),
        runtime,
      ));
      if (result === undefined) throw new Error("resident turn returned no result");
      return result;
    },
  };
}
