import { runAgentSync } from "../helpers/executor";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentProcessLive } from "../../src/layers";
import { Entropy } from "../../src/services";
import { createObservationBus } from "../../src/observation/bus";

describe("process entropy", () => {
  it("returns the supplied source untouched", () => {
    const next = () => "fixed";
    const entropy = runAgentSync(Entropy.pipe(Effect.provide(Layer.succeed(Entropy, { next }))));
    expect(entropy.next).toBe(next);
  });

  it("supplies a fresh uuid per call", () => {
    const entropy = runAgentSync(Entropy.pipe(Effect.provide(AgentProcessLive(createObservationBus()))));
    const first = entropy.next();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(entropy.next()).not.toBe(first);
  });
});
