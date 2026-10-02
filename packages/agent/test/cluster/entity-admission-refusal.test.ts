import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SessionHandleStore } from "../../src/store";
import { openCatalogStore, openSessionStore } from "../../../ledger/src/storage/index";
import { SessionEntity } from "../../src/cluster/session-entity";
import { receivedMessageAction } from "../../src/session-record";
import { runAgent } from "../helpers/executor";
import { clusterTempDir, runCluster, sendPrompt, sessionFileFor } from "../helpers/cluster-runtime";

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

// Issue #1245 (3): a refused admission is a typed receipt outcome; RPC callers
// distinguish it from a clean stop and from an admitted turn.
test("admission receipts distinguish turn, stop and refused drains", async () => {
  const { sessionsDir, catalogFile } = clusterTempDir("1245-admission-refusal-");
  await runAgent(seedWedgedSession(sessionsDir, catalogFile));
  await runCluster({ sessionsDir, catalogFile }, Effect.gen(function* () {
    // A healthy prompt is admitted and runs a turn.
    const turn = yield* sendPrompt("healthy", "m1", "hello");
    expect(turn.admission).toBe("turn");
    expect(turn.deduped).toBe(false);

    // An interrupt on the now-idle session is consumed; the drain stops cleanly.
    const makeClient = yield* SessionEntity.client;
    const stop = yield* makeClient("healthy").Interrupt({
      messageId: "m2", content: "", origin: JSON.stringify({ kind: "session", id: "healthy" }),
    });
    expect(stop.admission).toBe("stop");

    // The wedged session's backlog admission is refused: the message is still
    // durably appended, and the receipt carries the typed refusal outcome
    // instead of folding into a successful stop.
    const refused = yield* sendPrompt("wedged", "m3", "are you there?");
    expect(refused.admission).toBe("refused");
    expect(refused.ordinal).toBeGreaterThan(0);
    expect(refused.deduped).toBe(false);
  }));
});
