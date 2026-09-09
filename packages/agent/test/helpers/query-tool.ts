import { z } from "zod";
import { defineTool } from "../../src/index";

/** A resident-visible query tool with no input that returns a string. */
export function stringQueryTool(name: string, description: string, execute: () => Promise<string>) {
  return defineTool({
    name,
    description,
    category: "query",
    input: z.object({}).strict(),
    output: z.string(),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute,
    render: (_input, output) => output,
  });
}
