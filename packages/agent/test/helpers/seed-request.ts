import { canonicalDigest, type SessionTransition } from "@openomni/protocol";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import { decideRequestTransition } from "../../src/core/request";
import { openRequest } from "./open-request";
import { runAgent } from "./executor";
import { sessionFileFor } from "./cluster-runtime";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";

/** Pinned so the answer-side rebuild hashes to the identical binding digest. */
const SEED_DEADLINE = 4_102_444_800_000;
const SEED_CREATED_AT = 1_000;

/**
 * Materialize one session and commit a real open approval request through the
 * pure request authority: the pending tool invocation node first (admission
 * validates the binding against it), then the `request{phase: open}` record.
 */
export async function seedSessionWithOpenRequest(input: {
  readonly sessionsDir: string;
  readonly catalogFile: string;
  readonly sessionId: string;
  readonly requestId: string;
}): Promise<SessionTransition.Request> {
  const { sessionsDir, catalogFile, sessionId, requestId } = input;
  const catalog = openCatalogStore(catalogFile, { now: () => 1 });
  const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
  const kernel = SessionHandleStore.createSessionKernel(store, catalog);
  try {
    await runAgent(
      kernel.materialize({
        id: sessionId,
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 1,
        actionId: `${sessionId}:materialize`,
        at: 1,
      }),
    );
    catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
    const fence = catalog.rotateFence(sessionId);
    await runAgent(kernel.adoptFence({ sessionId, owner: "seeder", fence }));
    const commit = (actions: Parameters<typeof kernel.commit>[0]["actions"]) => {
      const row = kernel.row(sessionId);
      return runAgent(
        kernel.commit({
          sessionId,
          owner: "seeder",
          fence,
          now: Date.now(),
          expectedRevision: row.revision,
          actions,
          state: row.state,
        }),
      );
    };
    const parsedInput = {};
    await commit([
      {
        id: requestId,
        parentId: `${sessionId}:materialize`,
        sessionId,
        kind: "tool",
        intent: {
          encodingVersion: 1,
          value: {
            phase: "intent",
            op: "write",
            value: parsedInput,
            effectHash: canonicalDigest({ category: "mutation" }),
          },
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        ts: Date.now(),
        irreversible: true,
      },
    ]);
    const row = kernel.row(sessionId);
    const request = openRequest({
      requestId,
      sessionId,
      turnId: null,
      callId: `${requestId}:call`,
      parsedInput,
      generation: row.policyGeneration,
      toolsGeneration: row.toolsGeneration,
      systemHash: row.systemHash,
      deadline: SEED_DEADLINE,
      createdAt: SEED_CREATED_AT,
    });
    const decision = decideRequestTransition(
      {
        version: 1,
        sessionId,
        inputId: `${requestId}:open-input`,
        at: Date.now(),
        expectedRevision: row.revision,
        authority: { owner: "seeder", fence },
        payload: { kind: "request.open", request },
      },
      { row, requests: [], invocation: kernel.actionById(requestId) },
      TEST_APPROVAL_POLICY.recentOpen,
    );
    if (decision.resolution !== "opened") {
      throw new Error(`request seed refused: ${decision.resolution}`);
    }
    await commit([...decision.actions]);
    return request;
  } finally {
    store.close();
    catalog.close();
  }
}
