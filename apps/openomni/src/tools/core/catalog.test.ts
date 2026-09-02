import { describe, expect, it } from "bun:test";
import { collectToolSpecs, createTools, TOOL_DEFINITIONS } from "./catalog";
import { createDispatcher } from "./dispatch";
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
  it("does not dispatch resident-only memory into a worker catalog", async () => {
    const memory = {
      add: () => "entry",
      replace: () => undefined,
      remove: () => undefined,
      render: () => "",
    };
    const worker = { role: "worker", depth: 1, sessionId: "worker-session" } as const;
    const dispatcher = createDispatcher(createTools({ memory }, worker), worker.sessionId);

    expect(dispatcher.specs.map((tool) => tool.name)).not.toContain("memory");
    expect(
      await dispatcher.execute({
        id: "worker-memory",
        tool: "memory",
        input: { action: "add", store: "system", content: "forbidden" },
      }),
    ).toMatchObject({ isError: true, errorClass: "unknown_tool" });
  });
});
