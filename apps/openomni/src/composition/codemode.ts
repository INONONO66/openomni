import { createCodemode } from "@openomni/codemode";
import { createDispatcher, currentExecutor, ForeignFailure } from "@openomni/agent";
import { ForeignFailure as CodeFailure } from "@openomni/codemode";
import { Effect, type Scope } from "effect";
import type { MachineHost } from "@openomni/machines";
import { type AnyToolDefinition, Machine } from "@openomni/protocol";

/** Bind product dispatch; interpreter state and cell provenance live in codemode. */
export type ComposedCodemode = Effect.Effect.Success<ReturnType<typeof createCodemode>> & {
  readonly bindTools: (tenant: string, tools: readonly AnyToolDefinition[]) => void;
};

export function composeCodemode(machines: MachineHost): Effect.Effect<ComposedCodemode, never, Scope.Scope> {
  return Effect.gen(function* () {
  const catalogs = new Map<string, readonly AnyToolDefinition[]>();
  const mode = yield* createCodemode({
    machines,
    boundary() {
      const executor = currentExecutor();
      return (call, body) => Effect.gen(function* () {
        if (!call.name.startsWith("codemode.")) return yield* body();
        const result = yield* executor.run(
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
          () => body().pipe(Effect.mapError((error) => new ForeignFailure({ operation: call.name, cause: String(error) }))),
        );
        return result.terminal === "executed"
          ? Machine.ToolCallResult.parse(result.value)
          : { status: "failed" as const, error: result.reason };
      }).pipe(Effect.mapError((error) => new CodeFailure({ operation: call.name, cause: String(error) })));
    },
    tools(tenant) {
      // Capture executor authority in the dispatcher, not in a lazy Effect's construction context.
      const executor = currentExecutor();
      const dispatcher = createDispatcher(catalogs.get(tenant) ?? [], { executor });
      return (call) => Effect.gen(function* () {
        const result = yield* dispatcher.executeCell(
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
      }).pipe(Effect.mapError((error) => new CodeFailure({ operation: call.name, cause: String(error) })));
    },
  });
  return {
    ...mode,
    bindTools: (tenant: string, tools: readonly AnyToolDefinition[]) => {
      if (tools.length === 0) {
        catalogs.delete(tenant);
        return;
      }
      catalogs.set(tenant, tools.filter((tool) => tool.name !== "eval" && tool.visibility.cell.length > 0));
    },
  };
  });
}
