import { sessionTree } from "../helpers/session-tree";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { L0Observation } from "@openomni/protocol";
import { Bus } from "../helpers/observation";
import { materializeSession } from "../helpers/session";
import { useMemoryStores } from "../helpers/storage";

const stores = useMemoryStores(Bus);
beforeEach(() => {
  Bus.reset();
});
afterEach(() => {
  Bus.reset();
});

describe("session memory regression", () => {
  test("canonical watch subscribe/unsubscribe releases listeners without deleting history", () => {
    materializeSession(stores.kernel, "watched");
    const baseline = Bus.listenerCount();
    for (let index = 0; index < 200; index += 1) {
      const watch = stores.kernel.watchSnapshot("watched", 1, Bus);
      watch.subscribe(() => undefined);
      expect(Bus.listenerCount()).toBe(baseline + 1);
      watch.unsubscribe();
      expect(Bus.listenerCount()).toBe(baseline);
    }
    expect(sessionTree("watched", stores.session.actions)).toHaveLength(1);
  }, 30_000);

  test("bus subscribe/publish/unsubscribe does not leak", async () => {
    const baseline = Bus.listenerCount();
    let received = 0;
    for (let index = 0; index < 500; index += 1) {
      const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, () => {
        received += 1;
      });
      for (let eventIndex = 0; eventIndex < 10; eventIndex += 1) {
        Bus.publish(L0Observation.ActionCommittedEvent, {
          id: `${index}-${eventIndex}`,
          sessionId: "fanout",
          revision: 1,
          kind: "session.configure",
        });
      }
      unsubscribe();
    }
    await Bus.flush();
    expect(received).toBe(5000);
    expect(Bus.listenerCount()).toBe(baseline);
  }, 30_000);

  test("idempotent canonical materialization does not accumulate rows or history", () => {
    const hydrate = () => {
      materializeSession(stores.kernel, "existing");
      stores.kernel.getSnapshot("existing");
    };
    for (let index = 0; index < 500; index += 1) hydrate();
    expect(stores.kernel.listRows()).toHaveLength(1);
    expect(sessionTree("existing", stores.session.actions)).toHaveLength(1);
  }, 30_000);
});
