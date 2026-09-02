import { z } from "zod";
import type { CompletionPort } from "../../work-item/completion";
import { defineTool, ToolRefused } from "../core/define";

const Input = z.object({ workItemId: z.string().min(1).optional().describe("Inspect one WorkItem; omit to list all.") }).strict();
const Summary = z.custom<object>((value) => typeof value === "object" && value !== null);
const Output = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), items: z.array(Summary) }).strict(),
  z.object({ kind: z.literal("item"), item: Summary }).strict(),
]);
const WORK_ITEMS_TOOL_NAME = "work_items";
function executeWorkItems(port: CompletionPort) {
  return async ({ workItemId }: z.output<typeof Input>): Promise<z.output<typeof Output>> => {
    if (workItemId === undefined) return { kind: "list", items: port.list() };
    const item = port.inspect(workItemId);
    if (item === undefined) throw new ToolRefused(WORK_ITEMS_TOOL_NAME, `unknown WorkItem ${workItemId}`);
    return { kind: "item", item };
  };
}
export const workItemsTool = defineTool({
  name: WORK_ITEMS_TOOL_NAME, category: "query",
  description: "Inspect commissioned WorkItems: status, acceptance criteria (with ids), recorded evidence, and the attempt outcome. Pass workItemId for one item's detail; omit it to list everything.",
  input: Input, output: Output, safe: true, execution: { kind: "host" }, placement: "host",
  visibility: { model: ["resident"], cell: ["resident"] },
  bind: (ports) => ports.workItems === undefined ? undefined : executeWorkItems(ports.workItems),
  render: (_args, value) => JSON.stringify(value.kind === "list" ? value.items : value.item, null, 2),
});

export function workItemsToolExecutor(port: CompletionPort) { return async (raw: unknown): Promise<string> => { try { const args = Input.parse(raw ?? {}); return workItemsTool.render(args, await executeWorkItems(port)(args)); } catch (error) { return error instanceof ToolRefused ? error.message : `work_items refused: ${error instanceof Error ? error.message : String(error)}`; } }; }
