import { expect, it } from "bun:test";
import { Effect } from "effect";
import { isolatedLedger } from "../helpers/isolated";
import { childAdmission, fileRequest, requestPlane } from "../helpers/session-request-plane";

it("dbg", () => fileRequest((dbPath) => Effect.gen(function* () {
  const { port, opening } = yield* requestPlane();
  const kernel = isolatedLedger().kernel;
  const store = isolatedLedger().session.sessions as any;
  const commit = store.commit.bind(store);
  store.commit = (input: any) => {
    console.log("COMMIT", JSON.stringify({ sessionId: input.sessionId, owner: input.owner, fence: input.fence, expectedRevision: input.expectedRevision, requestCount: input.requestCount, state: input.state, actions: input.actions.map((a: any) => ({ id: a.id, parentId: a.parentId, kind: a.kind })) }));
    return commit(input);
  };
  const admission = childAdmission("plane:request:request", kernel.row("parent").leaseFence + 1);
  const opened = yield* Effect.result(port.open({ ...opening, admission }));
  console.log("OPENED", JSON.stringify(opened));
})));
