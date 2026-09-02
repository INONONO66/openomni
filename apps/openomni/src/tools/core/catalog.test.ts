import { describe, expect, it } from "bun:test";
import { collectToolSpecs, TOOL_DEFINITIONS } from "./catalog";
import { toolInputSchema } from "./project";

const EXPECTED = [
  "delegate",
  "await_delegation",
  "cancel_delegation",
  "converse",
  "approval",
  "provision",
  "run_code",
  "memory",
  "work_items",
  "llm",
  "artifacts",
];

describe("tool catalog", () => {
  it("has the consolidated eleven-tool surface", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(EXPECTED);
    expect(collectToolSpecs().map((tool) => tool.name)).toEqual(EXPECTED);
  });
  it("projects every input as an object root", () => {
    for (const definition of TOOL_DEFINITIONS)
      expect(toolInputSchema(definition).type).toBe("object");
  });
  it("keeps llm cell-only", () => {
    const llm = TOOL_DEFINITIONS.find((tool) => tool.name === "llm");
    expect(llm?.visibility).toEqual({ model: [], cell: ["resident", "worker"] });
  });
});
