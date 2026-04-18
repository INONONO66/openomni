import type { Tool } from "@openomni/protocol";

export function successResult(call: Tool.Call, output: string): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output,
  };
}

export function errorResult(call: Tool.Call, output: string): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output,
    isError: true,
  };
}

export function fromError(call: Tool.Call, err: unknown): Tool.Result {
  return errorResult(call, err instanceof Error ? err.message : String(err));
}
