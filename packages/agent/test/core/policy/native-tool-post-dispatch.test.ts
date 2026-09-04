import { describe, expect, it } from "bun:test";
import { createDispatcher, defineTool, type Executor, ToolRefused } from "../../../src/index";
import { z } from "zod";

const blockedPost: Executor = {
  async run(_request, body) {
    await body();
    return {
      terminal: "blocked_post",
      disposition: "irreversible",
      reason: "output_denied",
    };
  },
};

const definition = defineTool({
  name: "account",
  description: "Read an account",
  category: "query",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ id: z.string() }).strict(),
  visibility: { model: ["resident"], cell: ["resident"] },
  execute: async ({ id }) => ({ id }),
  render: (_input, output) => output.id,
});
const call = { id: "call-1", tool: "account", input: { id: "a-1" } };
const context = { sessionId: "session-1", turnId: "turn-1" };

describe("tool post-policy refusal", () => {
  it("returns an error result through the model door", async () => {
    const result = await createDispatcher([definition], { executor: blockedPost }).execute(
      call,
      context,
    );

    expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
    expect(result.output).toContain("output_denied");
  });

  it("throws through the cell door", () => {
    const running = createDispatcher([definition], { executor: blockedPost }).executeCell(
      call,
      context,
    );

    expect(running).rejects.toBeInstanceOf(ToolRefused);
  });
});
