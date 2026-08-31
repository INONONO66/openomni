import { describe, expect, it } from "bun:test";
import type { ChatAgentConfig } from "@openomni/agent";
import { createPolicyRegistry, MissingMandatoryPolicyError } from "../src/composition/policy-registry";

type Middleware = NonNullable<ChatAgentConfig["middleware"]>[number];

const runContext = { events: undefined as unknown as ChatAgentConfig["events"] };

function middleware(name: string): Middleware {
  return { kind: "factory", name, create: () => ({}) } as unknown as Middleware;
}

describe("policy registry", () => {
  it("builds middleware from registered factories in registration order", () => {
    const registry = createPolicyRegistry({ mandatory: [] });
    registry.register("first", () => middleware("first"));
    registry.register("second", () => middleware("second"));

    const built = registry.middlewareFor(runContext) as ReadonlyArray<{ name: string }>;
    expect(built.map((entry) => entry.name)).toEqual(["first", "second"]);
  });

  it("passes the run context to each factory per build", () => {
    const registry = createPolicyRegistry({ mandatory: [] });
    const seen: unknown[] = [];
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
    let caught: unknown;
    try {
      registry.middlewareFor(runContext);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingMandatoryPolicyError);
    expect((caught as MissingMandatoryPolicyError).missing).toEqual(["compaction"]);
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
    const built = registry.middlewareFor(runContext) as ReadonlyArray<{ name: string }>;
    expect(built.map((entry) => entry.name)).toEqual(["compaction"]);
  });

  it("never lets a replaced registration's dispose evict its successor", () => {
    const registry = createPolicyRegistry({ mandatory: ["compaction"] });
    const original = registry.register("compaction", () => middleware("original"));
    registry.register("compaction", () => middleware("replacement"));

    original.dispose();
    const built = registry.middlewareFor(runContext) as ReadonlyArray<{ name: string }>;
    expect(built.map((entry) => entry.name)).toEqual(["replacement"]);
  });
});
