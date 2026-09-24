import { runAgentSync } from "../helpers/executor";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentProcessLive } from "../../src/layers";
import { Clock, Entropy } from "../../src/services";
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

  it("uses the injected clock and entropy sources instead of the real defaults", () => {
    const clock = () => 42;
    const next = () => "fixed";
    const services = runAgentSync(
      Effect.all([Clock, Entropy]).pipe(Effect.provide(AgentProcessLive(createObservationBus(), { clock, entropy: next }))),
    );
    expect(services[0].now).toBe(clock);
    expect(services[1].next).toBe(next);
  });
});
