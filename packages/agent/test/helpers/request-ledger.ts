import { SessionHandleStore } from "@openomni/ledger";
import type { ExecutionLedger } from "../../src/executor";
import { commitSessionRequest } from "../../src/session-admission";
import type { SessionRuntime } from "../../src/session-contract";
import type { SessionTransition } from "@openomni/protocol";
import { collector } from "./observation-collector";
export { bounded } from "./bounded";

export function crashAfterRequestOpen(initial: ReturnType<typeof requestLedger>, message: string) {
  const transition = initial.ledger.transition;
  if (transition === undefined) throw new Error("missing transition port");
  return {
    ...initial,
    ledger: {
      ...initial.ledger,
      async transition(...args: Parameters<typeof transition>) {
        const result = await transition(...args);
        if (args[0].kind === "request.open") throw new Error(message);
        return result;
      },
    },
  };
}

export function requestLedger(
  input: {
    id?: string;
    clock?: () => number;
    onRequest?: (request: SessionTransition.Request) => void;
    domainRevisions?: SessionRuntime["requestDomainRevisions"];
  } = {},
) {
  const id = input.id ?? "request-session";
  const clock = input.clock ?? (() => 100);
  const created = SessionHandleStore.materialize({
    id,
    role: "resident",
    parentId: null,
    policyGeneration: 1,
    tools: [],
    system: { preset: "", blocks: [] },
    actionId: `${id}:configure`,
    at: clock(),
  });
  const owner = `${id}:owner`;
  const lease = SessionHandleStore.acquireLease({
    sessionId: id,
    owner,
    expectedFence: created.row.leaseFence,
    now: clock(),
    expiresAt: clock() + 30_000,
  });
  if (!lease.ok) throw new Error("test lease refused");
  const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(id));
  const turnId = `${id}:turn`;
  if (!SessionHandleStore.tree(id).some((action) => action.id === turnId)) {
    const row = SessionHandleStore.row(id);
    const opened = SessionHandleStore.commit({
      sessionId: id,
      owner,
      fence: lease.fence,
      now: clock(),
      expectedRevision: row.revision,
      consumeInboxIds: [],
      state: "running",
      releaseLease: false,
      actions: [
        {
          id: turnId,
          sessionId: id,
          parentId: `${id}:configure`,
          kind: "turn",
          intent: {
            encodingVersion: 1,
            value: {
              phase: "intent",
              resultId: `${id}:result`,
              inboxIds: [],
              resumeCount: 0,
              boundaryActionId: null,
              toolsGeneration: generation.generation,
              toolsHash: generation.toolsHash,
              systemHash: generation.systemHash,
              policyGeneration: 1,
            },
          },
          effect: { encodingVersion: 1, value: { phase: "pending" } },
          ts: clock(),
          irreversible: true,
        },
      ],
    });
    if (!opened.ok) throw new Error("test turn refused");
  }
  const runtime: SessionRuntime = {
    clock,
    observations: collector(),
    requestDomainRevisions: input.domainRevisions,
  };
  const ledger: ExecutionLedger = {
    actions: () => SessionHandleStore.tree(id),
    async commit(action) {
      const row = SessionHandleStore.row(id);
      const committed = SessionHandleStore.commit({
        sessionId: id,
        owner,
        fence: lease.fence,
        now: clock(),
        expectedRevision: row.revision,
        actions: [action],
        consumeInboxIds: [],
        state: row.state,
        releaseLease: false,
      });
      if (!committed.ok) throw new Error(`test commit ${committed.reason}`);
      const receipt = committed.receipts[0];
      if (receipt === undefined) throw new Error("test receipt missing");
      return receipt;
    },
    async transition(payload, inputId, at) {
      const decision = commitSessionRequest(
        id,
        { owner, fence: lease.fence },
        payload,
        inputId,
        at,
        runtime,
      );
      if (decision.request !== undefined) input.onRequest?.(decision.request);
      return decision;
    },
  };
  return {
    ledger,
    identity: {
      sessionId: id,
      role: "resident" as const,
      parentActionId: turnId,
      turnId,
      toolsGeneration: generation.generation,
      toolsHash: generation.toolsHash,
      systemHash: generation.systemHash,
    },
    entropy: () => crypto.randomUUID(),
    clock,
  };
}
