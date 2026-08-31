import { describe, expect, it } from "bun:test";
import type { ChatAgentConfig } from "@openomni/agent";
import { PolicyDecision } from "@openomni/protocol";
import { createPolicyRegistry, MissingMandatoryPolicyError } from "../src/composition/policy-registry";

type Middleware = NonNullable<ChatAgentConfig["middleware"]>[number];
type RunContext = { events: ChatAgentConfig["events"] };

const runContext: RunContext = {
  events: {
    publish: () => undefined,
  },
};

function middleware(name: string): Middleware {
  return {
    kind: "point",
    name,
    pointIds: [],
    effectCapabilities: {},
    priority: 0,
    fn: () => PolicyDecision.allow({ policyId: name }),
  };
}

describe("policy registry", () => {
  it("builds middleware from registered factories in registration order", () => {
    const registry = createPolicyRegistry({ mandatory: [] });
    registry.register("first", () => middleware("first"));
    registry.register("second", () => middleware("second"));

    const built = registry.middlewareFor(runContext);
    expect(built.map((entry) => entry.name)).toEqual(["first", "second"]);
  });

  it("passes the run context to each factory per build", () => {
    const registry = createPolicyRegistry({ mandatory: [] });
    const seen: RunContext[] = [];
    registry.register("observer", (run) => {
      seen.push(run);
      return middleware("observer");
    });

    registry.middlewareFor(runContext);
    registry.middlewareFor(runContext);
    expect(seen).toEqual([runContext, runContext]);
  });

  it("suspends a run fail-closed when a declared-mandatory policy is missing", () => {
    const registry = createPolicyRegistry({ mandatory: ["compaction"] });
    let caught: MissingMandatoryPolicyError | null = null;
    try {
      registry.middlewareFor(runContext);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingMandatoryPolicyError);
      caught = error as MissingMandatoryPolicyError;
    }
    expect(caught?.missing).toEqual(["compaction"]);
  });

  it("suspends again when a mandatory registration is disposed without replacement", () => {
    const registry = createPolicyRegistry({ mandatory: ["compaction"] });
    const registration = registry.register("compaction", () => middleware("compaction"));
    expect(registration.class).toBe("mandatory");
    expect(registry.middlewareFor(runContext)).toHaveLength(1);

    registration.dispose();
    expect(() => registry.middlewareFor(runContext)).toThrow(MissingMandatoryPolicyError);
  });

  it("omits a disposed optional policy without suspending the run", () => {
    const registry = createPolicyRegistry({ mandatory: ["compaction"] });
    registry.register("compaction", () => middleware("compaction"));
    const optional = registry.register("elision", () => middleware("elision"));
    expect(optional.class).toBe("optional");
    expect(registry.middlewareFor(runContext)).toHaveLength(2);

    optional.dispose();
    expect(registry.middlewareFor(runContext).map((entry) => entry.name)).toEqual(["compaction"]);
  });

  it("never lets a replaced registration's dispose evict its successor", () => {
    const registry = createPolicyRegistry({ mandatory: ["compaction"] });
    const original = registry.register("compaction", () => middleware("original"));
    registry.register("compaction", () => middleware("replacement"));

    original.dispose();
    expect(registry.middlewareFor(runContext).map((entry) => entry.name)).toEqual([
      "replacement",
    ]);
  });
});
