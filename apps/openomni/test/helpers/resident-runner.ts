import { testToolPorts } from "./tool-ports";
import { Effect } from "effect";
import { Provider, run } from "@openomni/llm";
import { observationService } from "../../../../packages/agent/test/helpers/service-layers";
import type { ObservationSink } from "@openomni/protocol";
import { allowConfigure, generationServices } from "./generation-services";
import type { FixtureLlm } from "./app-fixture";
import { afterEach } from "bun:test";
import { Bus, closeSessions, type SessionRuntime } from "@openomni/agent";
import { immediateRetryAlarm as nullRetryAlarm } from "./immediate-retry-alarm";
import { createResident, type ResidentOptions } from "../../src/resident";
import { runEffect } from "./effect";
import { effectScope } from "./effect-scope";
import { drainSession, localInbox, resolvedRuntimeFor, testPlane } from "./ledger";

import { seedKernelPolicyRows } from "../../src/policy-seed";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

export function residentRunner(
  options: Omit<ResidentOptions, "sessionRuntime" | "tools" | "policyGeneration"> & {
    tools: Partial<ResidentOptions["tools"]>;
    llm?: Partial<FixtureLlm>;
    sessionRuntime?: Partial<SessionRuntime> & {
      readonly clock?: () => number;
      readonly entropy?: () => string;
      readonly observations?: ObservationSink;
    };
  },
) {
  const plane = testPlane();
  const runtime: SessionRuntime = {
    // Resolve on state, never a sleep: these tests exercise retries, not schedules.
    retryAlarm: nullRetryAlarm,
    authorizeConfigure: allowConfigure,
    openKernel: plane.openKernel,
    listSessions: plane.listSessions,
    ...options.sessionRuntime,
  };
  const scope = effectScope();
  seedKernelPolicyRows(plane.catalog.policies);
  const resident = createResident({
    ...options,
    tools: { ...testToolPorts, ...options.tools },
    sessionRuntime: runtime,
    policyGeneration: () => plane.openKernel("policy-probe").currentPolicyGeneration(),
  });
  const fixture = options.sessionRuntime;
  const context = scope.runSync(generationServices({
    clock: fixture?.clock, entropy: fixture?.entropy,
    observations: fixture?.observations === undefined ? Bus : observationService(fixture.observations),
    definitions: resident.definitions, llm: { run, resolveModel: Provider.resolveModel, ...options.llm },
    plane,
  }));
  cleanups.push(async () => {
    await runEffect(closeSessions(runtime).pipe(Effect.provide(context)));
    await scope.close();
    plane.close();
  });
  const resolved = resolvedRuntimeFor(runtime, context);
  const drain = (sessionId: string) =>
    scope.run(drainSession({
      plane,
      sessionId,
      runner: resident.runnerFor(plane.openKernel(sessionId).row(sessionId)),
      runtime: resolved,
      scope: scope.scope,
    }).pipe(Effect.provide(context)));
  return {
    ...resident,
    services: context,
    runtime,
    plane,
    drain,
    async prompt(sessionId: string, content: string) {
      const exists = plane.listSessions().some((row) => row.id === sessionId);
      await runEffect(localInbox(plane, "resident-runner", fixture?.clock ?? Date.now)({
        id: crypto.randomUUID(),
        sessionId,
        kind: "prompt",
        content,
        origin: { encodingVersion: 1, value: { kind: "test" } },
        createdAt: (fixture?.clock ?? Date.now)(),
        parentActionId: null,
        ...(exists
          ? {}
          : { createSession: resident.materialize(sessionId, null, "resident", "resident") }),
      }));
      const result = await drain(sessionId);
      if (result === undefined) throw new Error("resident turn returned no result");
      return result;
    },
  };
}
