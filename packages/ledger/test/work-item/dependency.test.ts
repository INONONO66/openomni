import { describe, expect, test } from "bun:test";
import { detectCycles } from "../../src/work-item/dependency.js";
import type { WorkItemAdapter } from "../../src/work-item/types.js";

function adapterFor(graph: Readonly<Record<string, readonly string[]>>): WorkItemAdapter {
  return {
    get: (hash: string) => {
      const dependsOn = graph[hash];
      if (dependsOn === undefined) return undefined;
      return { relations: { dependsOn } };
    },
  } as unknown as WorkItemAdapter;
}

describe("detectCycles", () => {
  test("walks transitive dependencies and rejects a back-edge", () => {
    const adapter = adapterFor({ child: ["grandchild"], grandchild: ["root"] });
    let thrown: unknown;

    try {
      detectCycles(adapter, ["child"], new Set(["root"]));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
  });

  test("keeps sibling branches independent and ignores missing leaves", () => {
    const adapter = adapterFor({ left: ["shared"], right: ["shared", "missing"], shared: [] });

    expect(() => detectCycles(adapter, ["left", "right"], new Set(["root"]))).not.toThrow();
  });
});
