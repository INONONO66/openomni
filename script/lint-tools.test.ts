import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeKnipIssues, runKnip } from "./check-dead-exports";
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

const DELETED_SYMBOLS = ["TranscriptStore", "claimSurface", "McpClient", "runtime/mcp"] as const;
const knipFixtures: string[] = [];

afterEach(async () => {
  await Promise.all(knipFixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

async function deletedSymbolViolations(): Promise<string[]> {
  const violations: string[] = [];
  for (const root of ["apps", "packages", "script"] as const) {
    const glob = new Bun.Glob(`${root}/**/*.ts`);
    for await (const filePath of glob.scan({ cwd: ".", onlyFiles: true })) {
      if (filePath.endsWith(".test.ts") || filePath.includes("/dist/")) continue;
      const source = await Bun.file(filePath).text();
      for (const symbol of DELETED_SYMBOLS) {
        if (filePath.includes(symbol) || source.includes(symbol)) {
          violations.push(`${symbol} ${filePath}`);
        }
      }
    }
  }
  return violations.sort((left, right) => left.localeCompare(right));
}

describe("deleted surface census", () => {
  test("deleted production symbols stay absent", async () => {
    expect(await deletedSymbolViolations()).toEqual([]);
  });

  test("Knip detects a synthetic unused package-root export and clears after removal", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "openomni-knip-"));
    knipFixtures.push(fixture);
    await writeFile(
      join(fixture, "package.json"),
      `${JSON.stringify({ name: "dead-export-fixture", type: "module" })}\n`,
    );
    await writeFile(join(fixture, "knip.json"), `${JSON.stringify({ entry: ["index.ts"] })}\n`);
    await writeFile(join(fixture, "index.ts"), "export const DormantStore = 1;\n");

    expect(normalizeKnipIssues(await runKnip(fixture, false, true))).toEqual([
      "exports index.ts DormantStore",
    ]);

    await writeFile(join(fixture, "index.ts"), "export {};\n");
    expect(normalizeKnipIssues(await runKnip(fixture, false, true))).toEqual([]);
  });
});

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
