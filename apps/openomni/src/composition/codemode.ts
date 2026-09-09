import { AsyncLocalStorage } from "node:async_hooks";
import { createCodemode } from "@openomni/codemode";
import { createDispatcher, currentExecutor } from "@openomni/agent";
import type { MachineHost } from "@openomni/machines";
import { type AnyToolDefinition, Machine } from "@openomni/protocol";

/** Bind product dispatch; interpreter state and cell provenance live in codemode. */
export function composeCodemode(machines: MachineHost) {
  const empty = createDispatcher([]);
  const catalogs = new Map<string, ReturnType<typeof createDispatcher>>();
  const dispatchers = new WeakMap<readonly AnyToolDefinition[], ReturnType<typeof createDispatcher>>();
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
                call.name === "codemode.ls" ||
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
      const dispatcher = catalogs.get(tenant) ?? empty;
      // RPC responses arrive outside the cell's context; capture this call's
      // authority, not the executor that happened to build the catalog.
      const inContext = AsyncLocalStorage.snapshot();
      return async (call) => {
        const result = await inContext(() => dispatcher.executeCell(
          {
            id: `cell:${call.cellId}:${crypto.randomUUID()}`,
            tool: call.name,
            input: call.arguments,
          },
          { sessionId: tenant, turnId: call.cellId },
        ));
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
      if (tools.length === 0) {
        catalogs.delete(tenant);
        return;
      }
      let dispatcher = dispatchers.get(tools);
      if (dispatcher === undefined) {
        dispatcher = createDispatcher(tools.filter(
          (tool) => tool.name !== "eval" && tool.visibility.cell.length > 0,
        ));
        dispatchers.set(tools, dispatcher);
      }
      catalogs.set(tenant, dispatcher);
    },
  };
}
