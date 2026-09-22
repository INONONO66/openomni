import { Effect } from "effect";
import { createDispatcher, createExecutor } from "@openomni/agent";
import type {
  AnyToolDefinition,
  ObservationSink,
  PlainValue,
  SessionTransition,
} from "@openomni/protocol";
import { compiledPolicy } from "../../../../packages/agent/test/helpers/compiled-policy";
import { bounded } from "../../../../packages/agent/test/helpers/request-ledger";
import { requestLedger } from "../../../../packages/agent/test/helpers/effect-g1";
import { requestDomainRevisions } from "../../src/tools/core/request-domain-revisions";
import { PROVISION_POLICY_ROWS } from "../../src/tools/provision";
import { runEffect, runSyncEffect } from "./effect";

export { bounded };
export function protectedDispatch(
  definition: AnyToolDefinition,
  input: Record<string, PlainValue>,
  observations: ObservationSink = { publish: () => undefined },
) {
  const opened = Promise.withResolvers<SessionTransition.Request>();
  let now = 100;
  const recording = runSyncEffect(requestLedger({
    id: crypto.randomUUID(),
    clock: () => now,
    domainRevisions: requestDomainRevisions,
    onRequest(request) {
      if (request.state === "open") opened.resolve(request);
    },
  }));
  const controller = new AbortController();
  const executor = createExecutor({
    ...recording,
    policy: compiledPolicy(PROVISION_POLICY_ROWS.map((row) => ({ ...row, generation: 1 }))),
    observations,
    authorizeApproval: () => Effect.succeed({
      kind: "owner" as const,
      principalId: "owner",
      evidenceId: "authenticated",
    }),
  });
  const dispatcher = createDispatcher([definition], { executor });
  const execution = dispatcher.execute(
    { id: "original-call", tool: definition.name, input },
    { sessionId: recording.identity.sessionId, turnId: "turn", signal: controller.signal },
  );
  const outcome = runEffect(Effect.either(execution));
  const running = outcome.then((result) => {
    if (result._tag === "Left") throw result.left;
    return result.right;
  });
  return {
    outcome,
    ...recording,
    executor,
    running,
    opened: opened.promise,
    async answer(decision: "approve" | "refuse" = "approve") {
      await bounded(opened.promise);
      const pending = executor.approvals?.pending()[0];
      if (pending === undefined) throw new Error("missing protected invocation");
      if (executor.approvals === undefined) throw new Error("missing approval port");
      const answer = await runEffect(Effect.either(executor.approvals.answer({ request: pending, decision, credential: "owner-token" })));
      if (answer._tag === "Left") throw answer.left;
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
