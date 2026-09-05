import { afterEach, beforeEach, expect, test } from "bun:test";
import { L0Observation } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";
import { materializeSession } from "../helpers/session";
import { Bus } from "../helpers/observation";

beforeEach(() => {
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
});
afterEach(() => {
  Storage.reset();
  Bus.reset();
});

test("canonical commit observation sees the already durable row and action", async () => {
  const seen = Promise.withResolvers<L0Observation.ActionCommitted>();
  const stop = Bus.subscribe(L0Observation.ActionCommittedEvent, seen.resolve);
  const timeout = setTimeout(() => seen.reject(new Error("commit observation timed out")), 1000);
  try {
    materializeSession("observed");
    const event = await seen.promise;
    expect(event).toEqual({
      id: "observed:configure",
      sessionId: "observed",
      kind: "session.configure",
      revision: 1,
    });
    expect(SessionHandleStore.row(event.sessionId).revision).toBe(event.revision);
    expect(SessionHandleStore.tree(event.sessionId).map((action) => action.id)).toEqual([event.id]);
  } finally {
    clearTimeout(timeout);
    stop();
  }
});
