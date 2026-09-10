import { expect } from "bun:test";
import { Bus, defineTool, eraseTool, type SessionHandle } from "@openomni/agent";
import { LlmCall, type AnyToolDefinition } from "@openomni/protocol";
import { SessionHandleStore } from "@openomni/ledger";
import { z } from "zod";
import { eventSignal } from "./event-signal";
import type { ResidentSuite } from "./resident-suite";

export function waveTool(
  name: string,
  execute: (signal: AbortSignal) => Promise<string>,
  sequential?: true,
): AnyToolDefinition {
  return eraseTool(
    defineTool({
      name,
      description: `test ${name}`,
      category: "query",
      visibility: { model: ["resident"], cell: [] },
      input: z.object({ slot: z.literal(name) }),
      output: z.string(),
      ...(sequential ? { sequential } : {}),
      execute: (_input, context) => execute(context.signal),
      render: (_input, result) => result,
    }),
  );
}

export function trackedWaveTools(started: string[]) {
  return ["A", "B", "C"].map((name) =>
    waveTool(name, async () => {
      started.push(name);
      return name;
    }),
  );
}

export const ProviderRequest = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(
          z.object({
            type: z.string(),
            tool_use_id: z.string().optional(),
            content: z.string().optional(),
          }),
        ),
      ]),
    }),
  ),
});

export function bounded<T>(promise: Promise<T>): Promise<T> {
  const signal = eventSignal<T>("wave/recovery event");
  void promise.then(signal.resolve, signal.reject);
  return signal.promise;
}

export function interruptSecondModel(
  suite: Pick<ResidentSuite, "defer">,
  requestCount: () => number,
  currentHandle: () => SessionHandle | undefined,
): Promise<void> {
  const interrupted = Promise.withResolvers<void>();
  suite.defer(
    Bus.subscribe(LlmCall.Events.Completed, () => {
      const handle = currentHandle();
      if (requestCount() !== 2 || handle === undefined) return;
      void handle.interrupt().then(interrupted.resolve, interrupted.reject);
    }),
  );
  return interrupted.promise;
}

export function acquireContender(sessionId: string, owner: string, expectedFence: number) {
  const now = Date.now();
  return SessionHandleStore.acquireLease({
    sessionId,
    owner,
    expectedFence,
    now,
    expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
  });
}

export function releaseContender(sessionId: string, owner: string, fence: number | undefined) {
  if (fence === undefined) return;
  const row = SessionHandleStore.row(sessionId);
  expect(
    SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: Date.now(),
      expectedRevision: row.revision,
      actions: [],
      consumeInboxIds: [],
      state: row.state,
      releaseLease: true,
    }).ok,
  ).toBe(true);
}

export function commitInterrupt(sessionId: string, id: string) {
  SessionHandleStore.commitInbox({
    id,
    sessionId,
    kind: "interrupt",
    content: "",
    createdAt: Date.now(),
    origin: { encodingVersion: 1, value: { kind: "sdk" } },
    parentActionId: SessionHandleStore.tree(sessionId).at(-1)?.id ?? null,
  });
}

export function interruptDeliveries(sessionId: string) {
  return SessionHandleStore.tree(sessionId).flatMap((action) => {
    const delivery = SessionHandleStore.delivery(action);
    return delivery?.kind === "interrupt" ? [delivery] : [];
  });
}
