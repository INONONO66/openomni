import { createCodemode } from "@openomni/codemode";
import { createDispatcher, currentExecutor } from "@openomni/agent";
import type { MachineHost } from "@openomni/machines";
import { type AnyToolDefinition, Machine } from "@openomni/protocol";

/** Bind product dispatch; interpreter state and cell provenance live in codemode. */
export function composeCodemode(machines: MachineHost) {
  const catalogs = new Map<string, readonly AnyToolDefinition[]>();
  const mode = createCodemode({
    machines,
    boundary() {
      const executor = currentExecutor();
      return async (call, body) => {
        if (!call.name.startsWith("codemode.")) return body();
        const result = await executor.run(
          {
            kind: "tool",
            op: call.name,
            intent: call.arguments,
            effect: {
              category:
                call.name === "codemode.read" ||
                call.name === "codemode.list" ||
                call.name === "codemode.stat" ||
                call.name === "codemode.listMachines" ||
                call.name === "codemode.findMachine"
                  ? "query"
                  : "execution",
            },
          },
          body,
        );
        return result.terminal === "executed"
          ? Machine.ToolCallResult.parse(result.value)
          : { status: "failed", error: result.reason };
      };
    },
    tools(tenant) {
      const dispatcher = createDispatcher(
        (catalogs.get(tenant) ?? []).filter(
          (tool) => tool.name !== "run_code" && tool.visibility.cell.length > 0,
        ),
        { executor: currentExecutor() },
      );
      return async (call) => {
        const result = await dispatcher.executeCell(
          {
            id: `cell:${call.cellId}:${crypto.randomUUID()}`,
            tool: call.name,
            input: call.arguments,
          },
          { sessionId: tenant, turnId: call.cellId },
        );
        return Machine.ToolCallResult.parse(
          result.isError
            ? { status: "failed", error: String(result.output) }
            : { status: "completed", value: result.output },
        );
      };
    },
  });
  return {
    ...mode,
    bindTools: (tenant: string, tools: readonly AnyToolDefinition[]) => {
      catalogs.set(tenant, tools);
    },
  };
}
