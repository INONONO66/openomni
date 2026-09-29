import { sessionTree } from "./helpers/session-tree";
import { Effect } from "effect";
import { expect, spyOn, test } from "bun:test";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { allowConfigure, isolatedRuntime } from "./helpers/session-services";
import { openRequest } from "./helpers/open-request";
import type { SessionTransition } from "@openomni/protocol";
import { commitSessionRequest } from "../src/session-admission";

import { requestLedger } from "./helpers/g0-request-ledger";

function pending(id: string) {
  return Effect.gen(function* () {
    const fixture = yield* requestLedger({ id });
    const { identity } = fixture;
    const request = openRequest({
      requestId: `${id}:original`,
      sessionId: id,
      turnId: identity.turnId,
      callId: `${id}:call`,
      parsedInput: { path: id },
      toolsGeneration: identity.toolsGeneration,
      toolsHash: identity.toolsHash,
      systemHash: identity.systemHash,
      deadline: 1000,
      createdAt: 100,
    });
    yield* fixture.ledger.commit({
      id: request.requestId,
      parentId: identity.parentActionId,
      sessionId: id,
      kind: "tool",
      intent: {
        encodingVersion: 1,
        value: { phase: "intent", value: request.parsedInput, effectHash: request.effectHash },
      },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      irreversible: true,
      ts: 100,
    });
    return request;
  });
}

function open(request: SessionTransition.Request) {
  return commitSessionRequest(
    isolatedLedger().kernel,
    request.sessionId,
    { owner: `${request.sessionId}:owner`, fence: 1 },
    { kind: "request.open", request },
    `${request.requestId}:open`,
    100,
    { authorizeConfigure: allowConfigure, ...isolatedRuntime() },
  );
}

test("admission carries its observed count into the real SQLite transaction", () =>
  isolated(
    Effect.gen(function* () {
      const first = yield* pending("first");
      const second = yield* pending("second");
      const kernel = isolatedLedger().kernel;
      const sessions = isolatedLedger().session.sessions;
      const commit = sessions.commit;
      let interleaved = false;
      const intercepted = spyOn(sessions, "commit").mockImplementation(
        (input: Parameters<typeof commit>[0]) =>
          Effect.gen(function* () {
            if (input.sessionId === first.sessionId && !interleaved) {
              interleaved = true;
              expect((yield* open(second).pipe(Effect.orDie)).resolution).toBe("opened");
            }
            return yield* commit(input);
          }),
      );
      try {
        const before = kernel.row(first.sessionId);
        const actions = sessionTree(kernel, first.sessionId);
        expect(yield* Effect.flip(open(first))).toMatchObject({
          _tag: "CommitFailed",
          error: { _tag: "CommitRefused" },
        });
        expect(kernel.row(first.sessionId)).toEqual(before);
        expect(sessionTree(kernel, first.sessionId)).toEqual(actions);
        expect(
          kernel.requestRows().map(
            (request: SessionTransition.Request) => request.requestId,
          ),
        ).toEqual([second.requestId]);
        expect(yield* open(first)).toMatchObject({
          resolution: "opened",
          requestCount: { since: 100 - 3_600_000, count: 1 },
        });
      } finally {
        intercepted.mockRestore();
      }
    }),
  ));
