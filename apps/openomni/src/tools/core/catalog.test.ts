import { describe, expect, it } from "bun:test";
import { collectToolSpecs, TOOL_DEFINITIONS } from "./catalog";
import { toolInputSchema, toolSpec } from "@openomni/agent";

const EXPECTED = [
  "read",
  "write",
  "edit",
  "list",
  "search",
  "bash",
  "monitor",
  "delegate",
  "await_delegation",
  "cancel_delegation",
  "approval",
  "provision",
  "run_code",
  "llm",
];

describe("tool catalog", () => {
  it("has the stage-one tool surface", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(EXPECTED);
    expect(collectToolSpecs().map((tool) => tool.name)).toEqual(EXPECTED);
  });
  it("projects every input as an object root", () => {
    for (const definition of TOOL_DEFINITIONS)
      expect(toolInputSchema(definition).type).toBe("object");
  });
  it("derives safe solely from category and shares both doors for path tools", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(toolSpec(tool).safe).toBe(tool.category === "query");
      expect(toolSpec(tool)).not.toHaveProperty("placement");
      if (["read", "write", "edit", "list", "search", "bash"].includes(tool.name)) {
        expect(tool.visibility).toEqual({
          model: ["resident", "worker"],
          cell: ["resident", "worker"],
        });
        expect(tool.sequential).toBe(
          ["write", "edit", "bash"].includes(tool.name) ? true : undefined,
        );
      }
    }
  });
  it("keeps llm cell-only", () => {
    const llm = TOOL_DEFINITIONS.find((tool) => tool.name === "llm");
    expect(llm?.visibility).toEqual({ model: [], cell: ["resident", "worker"] });
  });
});
