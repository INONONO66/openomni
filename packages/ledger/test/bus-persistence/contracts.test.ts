import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BusEvent } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { z } from "zod";
import { getDatabase } from "../../src/bus-persistence/database.js";
import { parsePayload } from "../../src/bus-persistence/payload.js";
import { redactForPersistence } from "../../src/bus-persistence/redaction.js";
import { defaultResolveSessionId } from "../../src/bus-persistence/session-id.js";
import { Storage } from "../../src/storage/storage.js";
import { bareStorageAdapter } from "../helpers/wait.js";

const descriptor = BusEvent.define("test.contract", z.unknown());
type Descriptor = Parameters<typeof parsePayload>[0];

beforeEach(() => {
  Storage.reset();
  Bus.reset();
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("bus persistence boundary contracts", () => {
  test("fails closed without a SQLite telemetry connection", () => {
    Storage.configure(bareStorageAdapter());
    expect(() => getDatabase()).toThrow("requires a SQLite-backed storage adapter");
  });

  test("classifies unavailable and malformed schema parsers", () => {
    const payload = { retained: true };
    expect(parsePayload({ ...descriptor, schema: null } as Descriptor, payload)).toEqual({
      value: payload,
      status: "parse_failed",
      diagnostic: "schema parser unavailable",
    });
    expect(
      parsePayload({ ...descriptor, schema: { safeParse: () => "invalid" } } as Descriptor, payload),
    ).toEqual({
      value: payload,
      status: "parse_failed",
      diagnostic: "schema parser result invalid",
    });
    expect(
      parsePayload({ ...descriptor, schema: { safeParse: "not-callable" } } as Descriptor, payload),
    ).toEqual({
      value: payload,
      status: "parse_failed",
      diagnostic: "schema parser unavailable",
    });
  });

  test("redacts cyclic arrays and preserves safe scalar values", () => {
    const cyclic: unknown[] = ["safe", 7];
    cyclic.push(cyclic);
    expect(redactForPersistence(cyclic)).toEqual(["safe", 7, "[redacted]"]);
    expect(redactForPersistence({ count: 3, enabled: true, input: 7 })).toEqual({
      count: 3,
      enabled: true,
      input: 7,
    });
  });

  test("resolves every nested session attribution shape", () => {
    expect(defaultResolveSessionId(descriptor, { payload: { sessionID: "session-id" } })).toBe(
      "session-id",
    );
    expect(
      defaultResolveSessionId(descriptor, { payload: { originSessionId: "session-origin" } }),
    ).toBe("session-origin");
    expect(
      defaultResolveSessionId(descriptor, { payload: { parentSessionId: "session-parent" } }),
    ).toBe("session-parent");
  });
});
