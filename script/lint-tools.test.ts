import { describe, expect, test } from "bun:test";
import type { AnyToolDefinition, ToolCategory } from "../apps/openomni/src/tools/core/define";
import {
  definitionInvariantViolations,
  diffToolSchemaSnapshots,
  type LocatedDefinition,
} from "./lint-tools";

function definition(
  name: string,
  category: ToolCategory = "query",
  overrides: Partial<AnyToolDefinition> = {},
): AnyToolDefinition {
  return {
    name,
    category,
    description: `${name} description`,
    input: {} as never,
    output: {} as never,
    safe: category === "query",
    execution: category === "execution"
      ? { kind: "machine", capability: "kernel.py" }
      : { kind: "host" },
    visibility: { model: ["resident"], cell: ["resident"] },
    bind: () => undefined,
    render: () => "",
    ...overrides,
  };
}

function located(item: AnyToolDefinition, directory = item.category): LocatedDefinition {
  return {
    definition: item,
    filePath: `apps/openomni/src/tools/${directory}/${item.name}.ts`,
  };
}

function messages(definitions: readonly AnyToolDefinition[], locations: readonly LocatedDefinition[]) {
  return definitionInvariantViolations(definitions, locations).map(({ message }) => message);
}

describe("lint-tools definition invariants", () => {
  test("a correctly located definition passes", () => {
    const item = definition("healthy_query");
    expect(definitionInvariantViolations([item], [located(item)])).toEqual([]);
  });

  test("directory and declared category must agree", () => {
    const item = definition("misplaced_query");
    expect(messages([item], [located(item, "mutation")])).toContainEqual(
      expect.stringContaining("[tool-category-directory]"),
    );
  });

  test("queries must be safe", () => {
    const item = definition("unsafe_query", "query", { safe: false });
    expect(messages([item], [located(item)])).toContain("[query-safe] query tools must be safe");
  });

  test("execution tools must have a machine locus", () => {
    const item = definition("host_execution", "execution", { execution: { kind: "host" } });
    expect(messages([item], [located(item)])).toContain(
      "[execution-locus] execution tools must execute on a machine",
    );
  });

  test("tool names must be unique", () => {
    const first = definition("duplicate_name");
    const second = definition("duplicate_name", "mutation");
    expect(messages([first, second], [located(first), located(second)]).filter((message) =>
      message.includes("[tool-name-unique]"),
    )).toHaveLength(2);
  });

  test("derived snapshot drift fails and identical snapshots pass", () => {
    const snapshot = [{ name: "read", safe: true }];
    expect(diffToolSchemaSnapshots(snapshot, snapshot)).toEqual([]);
    expect(diffToolSchemaSnapshots(snapshot, [{ name: "write", safe: false }])).toMatchObject([
      { check: "tool-schema-snapshot", subject: "TOOL_DEFINITIONS" },
    ]);
  });
});
