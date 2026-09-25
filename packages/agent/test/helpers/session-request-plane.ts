import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { canonicalDigest, type Inbox, type SessionTransition } from "@openomni/protocol";
import { createSessionRequests } from "../../src/session-requests";
import type { RunnerServices } from "../../src/services";
import { isolated } from "./isolated";
import { allowConfigure, withSessionServices } from "./session-services";

export function fileRequest<A, E>(program: (dbPath: string) => Effect.Effect<A, E, import("effect").Scope.Scope | RunnerServices>) {
  return isolated(Effect.scoped(Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "request-plane-"));
    const dbPath = join(directory, "ledger.sqlite");
    Storage.reset();
    Storage.initialize({ dbPath });
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }));
    return yield* program(dbPath);
  })));
}

export const requestPlane = (clock = () => 100) => Effect.gen(function* () {
  yield* SessionHandleStore.materialize({
    id: "parent", parentId: null, role: "resident", tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: 0, actionId: "configure", at: 1,
  });
  const lease = yield* SessionHandleStore.acquireLease({
    sessionId: "parent", owner: "fixture", expectedFence: 0, now: 1, expiresAt: 30_001,
  });
  yield* SessionHandleStore.commit({
    sessionId: "parent", owner: "fixture", fence: lease.fence, now: 1, expectedRevision: 1,
    actions: [{
      id: "invocation", sessionId: "parent", parentId: "configure", kind: "message", ts: 1, irreversible: true,
      intent: { encodingVersion: 1, value: {
        phase: "intent", callId: "original-call", value: { text: "parsed" },
        originalArgs: { text: "captured" }, effectHash: canonicalDigest({ route: "children" }),
      } },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
    }],
    consumeInboxIds: [], state: "idle", releaseLease: true,
  });
  const runtime = {
    authorizeConfigure: allowConfigure, observations: { publish: () => undefined }, clock,
    processId: "plane", entropy: () => "request",
  };
  const port = yield* withSessionServices(createSessionRequests(runtime), runtime);
  const opening = {
    requestId: "invocation", sessionId: "parent", expectedResponders: ["child"], correlation: {},
    allowedActions: ["report_result" as const], resolution: "first" as const, threshold: 1, deadline: 200, at: 100,
  };
  return { runtime, port, opening };
});

export function childAdmission(owner: string, fence: number): Inbox.Commit {
  return {
    id: "child:prompt", sessionId: "child", kind: "prompt", content: "commission",
    origin: { encodingVersion: 1, value: {
      kind: "message", messageId: "commission", senderSessionId: "parent", sourceActionId: "invocation",
    } },
    parentActionId: null, createdAt: 100,
    sender: { sessionId: "parent", owner, fence }, limits: { fanout: 1, depth: 1 },
    createSession: {
      row: {
        id: "child", parentId: "parent", role: "worker", leaseOwner: null, leaseFence: 0,
        leaseExpiresAt: null, revision: 0, state: "idle", toolsGeneration: 1,
        systemHash: SessionHandleStore.row("parent").systemHash, policyGeneration: 0,
      },
      initialAction: SessionHandleStore.configureAction({
        id: "child:configure", sessionId: "child", parentId: null, operation: "create",
        snapshot: SessionHandleStore.latestGenerationFor("parent"), at: 100,
      }),
    },
  };
}

export function planeAnswer(request: SessionTransition.Request, responder = "child", id = `${responder}:answer`): SessionTransition.Answer {
  return {
    inputId: id, requestId: request.requestId, sessionId: request.sessionId, receivedAt: 100,
    principal: { kind: "session", principalId: responder, evidenceId: id },
    bindingDigest: request.bindingDigest, inputHash: request.inputHash, effectHash: request.effectHash,
    generation: request.generation, toolsHash: request.toolsHash, domainRevisions: request.domainRevisions,
    decision: "reply", allowedAction: "report_result", content: responder,
  };
}
