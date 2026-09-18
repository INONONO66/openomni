import { afterEach, expect, test } from "bun:test";
import { ActorRegistry } from "../../src/actor/index.js";
import { DecisionFacts } from "../../src/storage/decision-fact-port.js";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage.js";
import { Storage } from "../../src/storage/storage.js";
import { bareStorageAdapter } from "../helpers/session.js";

afterEach(() => {
  Storage.reset();
});

test("named storage surfaces report optional adapter availability", () => {
  Storage.configure(bareStorageAdapter());
  expect(ActorRegistry.isConfigured()).toBe(false);
  expect(DecisionFacts.port()).toBeUndefined();

  Storage.reset();
  Storage.configure(new SqliteStorageAdapter(":memory:"));
  expect(ActorRegistry.isConfigured()).toBe(true);
  expect(DecisionFacts.port()).toBeDefined();
});

test("reset closes and clears an isolated adapter scope", () => {
  let closes = 0;
  Storage.withIsolation(() => {
    Storage.configure({
      ...bareStorageAdapter(),
      close: () => {
        closes += 1;
      },
    });
    Storage.reset();
    expect(() => Storage.get()).toThrow("called before initialize");
    expect(Storage.getInitializedDbPath()).toBeNull();
  });
  expect(closes).toBe(1);
});
