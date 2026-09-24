import { Effect } from "effect";
import { runEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import { Bus, newTraceId } from "@openomni/agent";
import { Component } from "@openomni/protocol";
import { observeComponent } from "../src/observation/component";
import { createResident } from "../src/resident";
import { allowConfigure } from "./helpers/generation-services";

test("component failure observation preserves an unprintable rejection", async () => {
  const failure = {
    toString() {
      throw new Error("conversion failed");
    },
  };
  const states: string[] = [];
  const unsubscribe = [
    Bus.subscribe(Component.Events.Active, () => {
      states.push("active");
    }),
    Bus.subscribe(Component.Events.Failed, () => {
      states.push("failed");
    }),
    Bus.subscribe(Component.Events.Disposed, () => {
      states.push("disposed");
    }),
  ];
  const component = observeComponent({
    traceId: newTraceId(),
    sessionId: "unprintable",
    runId: "run",
    componentId: "fixture",
    componentGeneration: 1,
  });
  try {
    const result = await runEffect(Effect.flip(component.run(Effect.fail(failure))));
    expect(result).toBe(failure);
    expect(states).toEqual(["active", "failed", "disposed"]);
  } finally {
    for (const stop of unsubscribe) stop();
  }
});

test("resident materialization refuses unregistered runners before storage", () => {
  const resident = createResident({
    model: { provider: "fixture", id: "fixture" },
    apiKey: "fixture",
    tools: {},
    sessionRuntime: { authorizeConfigure: allowConfigure },
  });
  expect(() => resident.materialize("invalid", null, "resident", "missing")).toThrow();
});
