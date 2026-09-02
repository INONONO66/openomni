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
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async () => undefined,
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

function messages(
  definitions: readonly AnyToolDefinition[],
  locations: readonly LocatedDefinition[],
) {
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

  test("every catalog definition must map to a source file", () => {
    const item = definition("unlocated_query");
    expect(messages([item], [])).toContainEqual(expect.stringContaining("[tool-source-location]"));
  });

  test("tool names must be unique", () => {
    const first = definition("duplicate_name");
    const second = definition("duplicate_name", "mutation");
    expect(
      messages([first, second], [located(first), located(second)]).filter((message) =>
        message.includes("[tool-name-unique]"),
      ),
    ).toHaveLength(2);
  });

  test("derived snapshot drift fails and identical snapshots pass", () => {
    const snapshot = [{ name: "read", safe: true }];
    expect(diffToolSchemaSnapshots(snapshot, snapshot)).toEqual([]);
    expect(diffToolSchemaSnapshots(snapshot, [{ name: "write", safe: false }])).toMatchObject([
      { check: "tool-schema-snapshot", subject: "TOOL_DEFINITIONS" },
    ]);
  });
});
