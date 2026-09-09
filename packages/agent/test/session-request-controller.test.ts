import { afterEach, beforeEach, expect, it } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import type { SessionTransition } from "@openomni/protocol";
import { session, closeSessions, type SessionRuntime } from "../src/session-handle";
import { createTurnDispatcher, eraseTool, sessionTool } from "../src/tool-dispatcher";
import { valueTool } from "./helpers/query-tool";
import { createSessionRequests } from "../src/session-requests";
import { bounded } from "./helpers/bounded";
import { suspendedRequest } from "./helpers/suspended-request";

let runtime: SessionRuntime;
beforeEach(() => {
  Storage.initialize({
    dbPath: ":memory:",
    observationSink: {
      publish: (event, payload) => runtime?.observations.publish(event, payload),
    },
  });
  seedPolicy();
});
afterEach(async () => {
  await closeSessions(runtime);
  Storage.reset();
});
function setup() {
  let now = 100;
  const suspended = Promise.withResolvers<void>();
  const effects: string[] = [];
  runtime = {
    clock: () => now,
    entropy: () => crypto.randomUUID(),
    observations: {
      publish: () => {
        if (
          SessionHandleStore.requestRows("controller").some((request) => request.state === "open")
        )
          suspended.resolve();
      },
    },
    scheduleHeartbeat: () => () => undefined,
  };
  const tool = eraseTool(
    valueTool({
      name: "protected",
      category: "mutation",
      execute: async (value) => {
        effects.push(value);
        return value;
      },
      approval: () => ({ required: true, domainRevisions: {} }),
    }),
  );
  const handle = session(
    {
      id: "controller",
      role: "resident",
      tools: [sessionTool(tool)],
      runner: async (input) => {
        const dispatcher = createTurnDispatcher([tool], input, runtime);
        await dispatcher.execute(
          { id: "original", tool: tool.name, input: { value: "original" } },
          { sessionId: input.sessionId, turnId: input.turnId, signal: input.signal },
        );
        return { kind: "result", text: "done" };
      },
    },
    runtime,
  );
  return {
    handle,
    effects,
    suspended: suspended.promise,
    setClock(at: number) {
      now = at;
    },
  };
}
function answer(request: SessionTransition.Request): SessionTransition.Answer {
  return {
    inputId: "authenticated-answer",
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt: 100,
    principal: { kind: "owner", principalId: "owner", evidenceId: "auth" },
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "yes",
  };
}
it("the injected gateway port uses the live controller's fence and releases the original call", async () => {
  const f = setup();
  const { running, request, fence } = await suspendedRequest(f.handle, f.suspended);
  expect(f.effects).toEqual([]);
  expect(await createSessionRequests(runtime).answer(answer(request))).toBe("resolved");
  await bounded(running);
  expect(f.effects).toEqual(["original"]);
  expect(SessionHandleStore.row(f.handle.id).leaseFence).toBe(fence);
  expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("resolved");
});
it("configuration drift refuses consent while interruption cancels the whole suspended call", async () => {
  const f = setup();
  const { running, request } = await suspendedRequest(f.handle, f.suspended);
  await f.handle.system.blocks.set([{ id: "new", source: "owner", content: "changed" }]);
  expect(await createSessionRequests(runtime).answer(answer(request))).toBe("rejected");
  expect(f.effects).toEqual([]);
  await bounded(f.handle.interrupt());
  await bounded(running);
  expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("cancelled");
  expect(
    SessionHandleStore.tree(f.handle.id).some((action) => {
      const effect = action.effect.value;
      return (
        action.kind === "tool" &&
        action.parentId === request.requestId &&
        effect !== null &&
        typeof effect === "object" &&
        !Array.isArray(effect) &&
        effect.terminal === "cancelled"
      );
    }),
  ).toBe(true);
  expect(f.effects).toEqual([]);
});
it("does not reacquire an expired lease under a still-live suspended runner", async () => {
  const f = setup();
  const { settled, request, fence } = await suspendedRequest(f.handle, f.suspended);
  f.setClock(40_000);
  await expect(createSessionRequests(runtime).answer(answer(request))).rejects.toMatchObject({
    name: "SessionLeaseError",
    result: { reason: "stale" },
  });
  expect(SessionHandleStore.row(f.handle.id).leaseFence).toBe(fence);
  expect(f.effects).toEqual([]);
  await f.handle.close();
  await bounded(settled);
});
