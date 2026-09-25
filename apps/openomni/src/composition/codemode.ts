import { createCodemode, ForeignFailure as CodeFailure, type RunOptions } from "@openomni/codemode";
import { forkInvocation, ForeignFailure, type InvocationFrame } from "@openomni/agent";
import { Effect, Exit, type Scope } from "effect";
import type { MachineHost } from "@openomni/machines";
import { Machine } from "@openomni/protocol";

/** Bind product dispatch; interpreter state and cell provenance live in codemode. */
export type ComposedCodemode = Effect.Effect.Success<ReturnType<typeof createCodemode>>;

function bindings(frame: InvocationFrame): NonNullable<RunOptions["bindings"]> {
  return {
    boundary() {
      const { executor } = frame;
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
      const { cell: dispatcher } = frame;
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
  };
}

export function composeCodemode(machines: MachineHost): Effect.Effect<ComposedCodemode, never, Scope.Scope> {
  return Effect.gen(function* () {
    const mode = yield* createCodemode({ machines });
    return {
      ...mode,
      cell: {
        ...mode.cell,
        run: (code, tenant, options = {}) => {
          const owned = forkInvocation("eval.cell");
          let owners = 0;
          const ownership = { interrupt: () => owned.close("interrupted"), retain() {
            const release = owned.frame.generation.retain();
            owners += 1;
            return () => {
              release();
              owners -= 1;
              if (owners === 0) owned.close("settled");
            };
          } };
          return owned.frame.generation.provide(mode.cell.run(code, tenant, {
            ...options, ownership, bindings: bindings(owned.frame),
          })).pipe(Effect.onExit((exit) => Effect.sync(() => {
            if (owners === 0) owned.close(Exit.isFailure(exit) ? "interrupted" : "settled");
          })));
        },
      },
    };
  });
}
