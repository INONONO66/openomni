/// <reference lib="es2022.object" />
import { expect, test } from "bun:test";
import * as ledgerExports from "../../src/index";

test("967 exports and production adapter expose only canonical session authority", () => {
  expect(Object.hasOwn(ledgerExports, "Session")).toBe(false);
  const adapter = new ledgerExports.SqliteStorageAdapter(":memory:");
  try {
    for (const retired of ["session", "message", "part"]) {
      expect(retired in adapter).toBe(false);
    }
    ledgerExports.Storage.assertComplete(adapter);
    for (const canonical of ["sessions", "actions", "inbox", "alarms"]) {
      expect(Object.hasOwn(adapter, canonical)).toBe(true);
    }
  } finally {
    adapter.close();
  }
});
