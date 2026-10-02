import { runAgentSync } from "../helpers/executor";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { AgentProcessLive } from "../../src/layers";
import { Entropy } from "../../src/services";
import { testBus } from "../helpers/bus";

describe("process entropy", () => {
  it("returns the supplied source untouched", () => {
    const source = { id: () => "fixed", random: () => 0.25 };
    const entropy = runAgentSync(Entropy.pipe(Effect.provide(Entropy.layer(source))));
    expect(entropy.id).toBe(source.id);
    expect(entropy.random).toBe(source.random);
  });

  it("AgentProcessLive threads the composition root's entropy, no ambient fallback", () => {
    let n = 0;
    const source = { id: () => { n += 1; return `root-${n}`; }, random: () => 0.5 };
    const entropy = runAgentSync(Entropy.pipe(Effect.provide(AgentProcessLive(testBus(), source))));
    expect(entropy.id()).toBe("root-1");
    expect(entropy.id()).toBe("root-2");
    expect(entropy.random()).toBe(0.5);
  });
});
