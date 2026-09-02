import type { Placement } from "@openomni/placement";
import type { Tool } from "@openomni/protocol";
import { ToolRefused, type AnyToolDefinition } from "./define";

export const HOST_TARGET: Placement.ToolTarget = { kind: "host", capabilities: [] };

export interface CatalogEntry {
  readonly spec: Tool.Spec;
  readonly definition?: AnyToolDefinition;
  run(input: never): Promise<unknown>;
}

export type DispatchErrorClass =
  | "unknown_tool"
  | "invalid_input"
  | "precondition_failed"
  | "execution_failed"
  | "invalid_output";

export type DispatchResult = Tool.Result & {
  readonly errorClass?: DispatchErrorClass;
};

export interface Dispatcher {
  readonly specs: Tool.Spec[];
  readonly execute: (call: Tool.Call) => Promise<DispatchResult>;
}

function failed(call: Tool.Call, output: string, errorClass: DispatchErrorClass): DispatchResult {
  return {
    toolCallId: call.id,
    id: call.id,
    toolName: call.tool,
    output,
    isError: true,
    errorClass,
  };
}

function issueMessage(issue: { readonly path: PropertyKey[]; readonly message: string }): string {
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

export function createDispatcher(entries: readonly CatalogEntry[]): Dispatcher {
  const known = new Map(entries.map((entry) => [entry.spec.name, entry]));

  return {
    specs: entries.map((entry) => entry.spec),
    execute: async (call) => {
      const entry = known.get(call.tool);
      if (entry === undefined) return failed(call, `unknown tool: ${call.tool}`, "unknown_tool");

      const definition = entry.definition;
      if (definition === undefined) {
        try {
          const output = await entry.run(call.input as never);
          return {
            toolCallId: call.id,
            id: call.id,
            toolName: call.tool,
            output: String(output),
          };
        } catch (error) {
          return failed(
            call,
            error instanceof Error ? error.message : String(error),
            "execution_failed",
          );
        }
      }

      const input = definition.input.safeParse(call.input);
      if (!input.success) {
        const reason = issueMessage(input.error.issues[0] ?? { path: [], message: "invalid input" });
        return failed(call, `\n${definition.name} refused: ${reason}`, "invalid_input");
      }

      try {
        const value = await entry.run(input.data as never);
        let output: unknown;
        try {
          output = definition.output.parse(value);
        } catch {
          return failed(call, `${definition.name} produced invalid output`, "invalid_output");
        }
        return {
          toolCallId: call.id,
          id: call.id,
          toolName: call.tool,
          output: definition.render(input.data as never, output as never),
        };
      } catch (error) {
        return error instanceof ToolRefused
          ? failed(call, error.message, "precondition_failed")
          : failed(
              call,
              error instanceof Error ? error.message : String(error),
              "execution_failed",
            );
      }
    },
  };
}
