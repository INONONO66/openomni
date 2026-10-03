import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { DeliverRefused } from "../../src/core/messages";
import * as SessionHandleStore from "../../src/core/store/fence";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import { receivedMessageAction } from "../../src/core/commit";
import { runAgent } from "../helpers/executor";
import { clusterTempDir, readChain, runCluster, sendDeliver, sendPrompt, sessionFileFor } from "../helpers/cluster-runtime";

const seedClock = () => 1_000;

/** One durably inconsistent session: state `running` with no open turn (admission -> refused). */
function seedWedgedSession(sessionsDir: string, catalogFile: string) {
  return Effect.gen(function* () {
    const catalog = openCatalogStore(catalogFile, { now: seedClock });
    const store = openSessionStore(sessionFileFor(sessionsDir, "wedged"), { now: seedClock });
    const kernel = SessionHandleStore.createSessionKernel(store, catalog);
    yield* kernel.materialize({
      id: "wedged", parentId: null, role: "resident", tools: [],
      system: { preset: "", blocks: [] }, policyGeneration: 1,
      actionId: "wedged:materialize", at: seedClock(),
    });
    catalog.indexSession({ id: "wedged", parentId: null, role: "resident", createdAt: seedClock() });
    const fence = catalog.rotateFence("wedged");
    yield* kernel.adoptFence({ sessionId: "wedged", owner: "seed", fence });
    yield* kernel.commit({
      sessionId: "wedged", owner: "seed", fence, now: seedClock(),
      expectedRevision: kernel.row("wedged").revision,
      actions: [
        receivedMessageAction({
          id: "wedged:seed", sessionId: "wedged", kind: "prompt", content: "seed",
          origin: { encodingVersion: 1, value: { kind: "session", id: "wedged" } },
          parentActionId: null, at: seedClock(),
        }),
      ],
      state: "running",
    });
    store.close();
    catalog.close();
  });
}

// #1253 (was #1245 (3)): a refused admission is a typed `deliver` rejection,
// never a success ack, and it appends zero new journal facts; RPC callers
// distinguish it from an admitted turn and from a consumed signal.
test("deliver distinguishes an admitted turn, a consumed signal and a typed denial", async () => {
  const { sessionsDir, catalogFile } = clusterTempDir("1245-admission-refusal-");
  await runAgent(seedWedgedSession(sessionsDir, catalogFile));
  await runCluster({ sessionsDir, catalogFile }, Effect.gen(function* () {
    // A healthy prompt is admitted and runs a turn.
    const turn = yield* sendPrompt("healthy", "m1", "hello");
    expect(turn.existed).toBe(false);
    expect(readChain(sessionFileFor(sessionsDir, "healthy"), "healthy").some(
      (row) => row.kind === "turn",
    )).toBe(true);

    // An interrupt signal on the now-idle session is appended and consumed by
    // the drain: its delivery record lands on the chain.
    const stop = yield* sendDeliver("healthy", {
      kind: "signal", idempotencyKey: "m2", content: "", control: "interrupt",
    });
    expect(stop.existed).toBe(false);
    expect(readChain(sessionFileFor(sessionsDir, "healthy"), "healthy").some(
      (row) => row.id === "m2:delivery",
    )).toBe(true);

    // The wedged session's admission is refused: a typed `denied` rejection
    // with zero new facts — the message is NOT appended.
    const before = readChain(sessionFileFor(sessionsDir, "wedged"), "wedged").length;
    const refused = yield* sendPrompt("wedged", "m3", "are you there?").pipe(Effect.flip);
    expect((refused as DeliverRefused).code).toBe("denied");
    expect(readChain(sessionFileFor(sessionsDir, "wedged"), "wedged").length).toBe(before);
  }));
});
