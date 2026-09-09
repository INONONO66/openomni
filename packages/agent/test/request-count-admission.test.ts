import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { openRequest } from "./helpers/open-request";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import type { SessionTransition } from "@openomni/protocol";
import { commitSessionRequest } from "../src/session-admission";
import { SessionCommitError } from "../src/session-contract";
import { requestLedger } from "./helpers/request-ledger";

beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
afterEach(() => {
  mock.restore();
  Storage.reset();
});

async function pending(id: string) {
  const fixture = requestLedger({ id });
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
  await fixture.ledger.commit({
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
}

function open(request: SessionTransition.Request) {
  return commitSessionRequest(
    request.sessionId,
    { owner: `${request.sessionId}:owner`, fence: 1 },
    { kind: "request.open", request },
    `${request.requestId}:open`,
    100,
    { observations: { publish: () => undefined } },
  );
}

test("admission carries its observed count into the real SQLite transaction", async () => {
  const first = await pending("first");
  const second = await pending("second");
  const sessions = Storage.get().sessions;
  if (sessions === undefined) throw new Error("missing session adapter");
  const commit = sessions.commit;
  let interleaved = false;
  spyOn(sessions, "commit").mockImplementation((input) => {
    if (input.sessionId === first.sessionId && !interleaved) {
      interleaved = true;
      expect(open(second).resolution).toBe("opened");
    }
    return commit(input);
  });
  const before = SessionHandleStore.row(first.sessionId);
  const actions = SessionHandleStore.tree(first.sessionId);
  expect(() => open(first)).toThrow(SessionCommitError);
  expect(SessionHandleStore.row(first.sessionId)).toEqual(before);
  expect(SessionHandleStore.tree(first.sessionId)).toEqual(actions);
  expect(SessionHandleStore.requestRows().map((request) => request.requestId)).toEqual([
    second.requestId,
  ]);
  expect(open(first)).toMatchObject({
    resolution: "opened",
    requestCount: { since: 100 - 3_600_000, count: 1 },
  });
});
