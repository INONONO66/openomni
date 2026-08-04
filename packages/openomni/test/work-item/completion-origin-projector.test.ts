import { describe, expect, test } from "bun:test";
import * as Completion from "../../src/work-item/index.js";

describe("completion source origin projection", () => {
  test.each([
    [{ source: "internal_worker" }, "worker"],
    [{ source: "connector_worker" }, "worker"],
    [{ source: "api" }, "external_actor"],
    [{ source: "a2a" }, "external_actor"],
    [{ source: "human" }, "external_actor"],
    [{ source: "replay" }, "replay"],
    [{ source: "recovery" }, "recovery"],
    [{ source: "resident" }, "resident"],
    [{ source: "sdk", identity: { kind: "resident", id: "resident:owner" } }, "resident"],
    [{ source: "sdk", identity: { kind: "worker", id: "worker:sdk-1" } }, "worker"],
    [{ source: "sdk", identity: { kind: "external_actor", id: "api:client" } }, "external_actor"],
    [{ source: "internal", identity: { kind: "resident", id: "resident:kernel" } }, "resident"],
    [{ source: "internal", identity: { kind: "worker", id: "worker:run-1" } }, "worker"],
    [
      { source: "internal", identity: { kind: "external_actor", id: "service:bridge" } },
      "external_actor",
    ],
  ] as const)("projects %j to the canonical %s origin", (source, expected) => {
    const projector = Reflect.get(Completion, "projectCompletionOrigin");
    expect(typeof projector).toBe("function");
    if (typeof projector !== "function") return;

    expect(Reflect.apply(projector, undefined, [source])).toBe(expected);
  });

  test.each([
    { source: "unknown" },
    { source: "sdk" },
    { source: "internal", identity: { kind: "unknown", id: "system:one" } },
  ])("rejects unqualified or unknown sources instead of falling back: %j", (source) => {
    const projector = Reflect.get(Completion, "projectCompletionOrigin");
    expect(typeof projector).toBe("function");
    if (typeof projector !== "function") return;

    expect(() => Reflect.apply(projector, undefined, [source])).toThrow();
  });
});
