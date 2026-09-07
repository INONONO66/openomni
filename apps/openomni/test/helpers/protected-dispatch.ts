import { createDispatcher, createExecutor } from "@openomni/agent";
import type {
  AnyToolDefinition,
  ObservationSink,
  PlainValue,
  SessionTransition,
} from "@openomni/protocol";
import { compiledPolicy } from "../../../../packages/agent/test/helpers/compiled-policy";
import { bounded, requestLedger } from "../../../../packages/agent/test/helpers/request-ledger";
import { requestDomainRevisions } from "../../src/tools/core/request-domain-revisions";

export { bounded };
export function protectedDispatch(
  definition: AnyToolDefinition,
  input: Record<string, PlainValue>,
  observations: ObservationSink = { publish: () => undefined },
) {
  const opened = Promise.withResolvers<SessionTransition.Request>();
  let now = 100;
  const recording = requestLedger({
    id: crypto.randomUUID(),
    clock: () => now,
    domainRevisions: requestDomainRevisions,
    onRequest(request) {
      if (request.state === "open") opened.resolve(request);
    },
  });
  const controller = new AbortController();
  const executor = createExecutor({
    ...recording,
    policy: compiledPolicy(),
    observations,
    authorizeApproval: async () => ({
      kind: "owner",
      principalId: "owner",
      evidenceId: "authenticated",
    }),
  });
  const dispatcher = createDispatcher([definition], { executor });
  const running = dispatcher.execute(
    { id: "original-call", tool: definition.name, input },
    { sessionId: recording.identity.sessionId, turnId: "turn", signal: controller.signal },
  );
  return {
    ...recording,
    executor,
    running,
    opened: opened.promise,
    async answer(decision: "approve" | "refuse" = "approve") {
      await bounded(opened.promise);
      const pending = executor.approvals?.pending()[0];
      if (pending === undefined) throw new Error("missing protected invocation");
      await executor.approvals?.answer({ request: pending, decision, credential: "owner-token" });
      return bounded(running);
    },
    setClock(at: number) {
      now = at;
    },
    async close() {
      controller.abort();
      await bounded(Promise.allSettled([running]));
    },
  };
}
