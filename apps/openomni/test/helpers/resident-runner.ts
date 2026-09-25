import { testToolPorts } from "./tool-ports";
import { Effect } from "effect";
import { Provider, run } from "@openomni/llm";
import { observationService } from "../../../../packages/agent/test/helpers/service-layers";
import type { ObservationSink } from "@openomni/protocol";
import { allowConfigure, generationServices } from "./generation-services";
import type { FixtureLlm } from "./app-fixture";
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
  options: Omit<ResidentOptions, "sessionRuntime" | "tools"> & { tools: Partial<ResidentOptions["tools"]>; llm?: Partial<FixtureLlm>; sessionRuntime?: SessionRuntime & { readonly clock?: () => number; readonly entropy?: () => string; readonly observations?: ObservationSink } },
) {
  const runtime = options.sessionRuntime ?? {
    // Resolve on state, never a sleep: these tests exercise retries, not schedules.
    retryAlarm: nullRetryAlarm,
    authorizeConfigure: allowConfigure,
  };
  const scope = effectScope();
  seedKernelPolicyRows();
  const resident = createResident({ ...options, tools: { ...testToolPorts, ...options.tools }, sessionRuntime: runtime });
  const context = scope.runSync(generationServices({
    clock: runtime.clock, entropy: runtime.entropy,
    observations: runtime.observations === undefined ? Bus : observationService(runtime.observations),
    definitions: resident.definitions, llm: { run, resolveModel: Provider.resolveModel, ...options.llm },
  }));
  cleanups.push(async () => {
    await runEffect(closeSessions(runtime).pipe(Effect.provide(context)));
    await scope.close();
  });
  return {
    ...resident,
    services: context,
    runtime,
    async prompt(sessionId: string, content: string) {
      const exists = SessionHandleStore.listRows().some((row) => row.id === sessionId);
      await runEffect(commitMessageInbox({
        id: crypto.randomUUID(),
        sessionId,
        kind: "prompt",
        content,
        origin: { encodingVersion: 1, value: { kind: "test" } },
        createdAt: Date.now(),
        parentActionId: null,
        ...(exists
          ? {}
          : { createSession: resident.materialize(sessionId, null, "resident", "resident") }),
      }));
      const result = await scope.run(wakeSession(
        sessionId,
        resident.runnerFor(SessionHandleStore.row(sessionId)),
        runtime,
      ).pipe(Effect.provide(context)));
      if (result === undefined) throw new Error("resident turn returned no result");
      return result;
    },
  };
}
