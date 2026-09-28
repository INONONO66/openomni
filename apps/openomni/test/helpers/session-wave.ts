import { sessionTree } from "../../../../packages/ledger/test/helpers/session-tree";
import { Effect } from "effect";
import { Bus, defineTool, eraseTool, type SessionHandle } from "@openomni/agent";
import { LlmCall, type AnyToolDefinition } from "@openomni/protocol";
import { SessionHandleStore } from "@openomni/ledger";
import { z } from "zod";
import { eventSignal } from "./event-signal";
import { runEffect } from "./effect";
import type { AppLedgerPlane } from "../../src/composition/cluster-runtime";
import { localInbox } from "./ledger";
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
      void runEffect(handle.interrupt()).then(interrupted.resolve, interrupted.reject);
    }),
  );
  return interrupted.promise;
}

/**
 * A contender's fence-adoption attempt at an explicit fence value (W5.2):
 * adopting at or below the current fence refuses as stale, adopting above
 * it steals authority. The lease plane's held/expiry states are gone.
 */
export function adoptAtFence(plane: AppLedgerPlane, sessionId: string, owner: string, fence: number) {
  return Effect.runSync(Effect.result(plane.openKernel(sessionId).adoptFence({ sessionId, owner, fence })));
}

export async function commitInterrupt(plane: AppLedgerPlane, sessionId: string, id: string) {
  await runEffect(localInbox(plane, "wave-fixture", Date.now)({
    id,
    sessionId,
    kind: "interrupt",
    content: "",
    createdAt: Date.now(),
    origin: { encodingVersion: 1, value: { kind: "sdk" } },
    parentActionId: sessionTree(sessionId, plane.sessionStore(sessionId).actions).at(-1)?.id ?? null,
  }));
}

export function interruptDeliveries(plane: AppLedgerPlane, sessionId: string) {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions).flatMap((action) => {
    const delivery = SessionHandleStore.delivery(action);
    return delivery?.kind === "interrupt" ? [delivery] : [];
  });
}
