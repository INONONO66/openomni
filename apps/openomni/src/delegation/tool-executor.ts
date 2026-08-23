import type { ChatAgentConfig } from "@openomni/agent";
import type { DelegationOrigin } from "./admission";
import type { DelegationKernel } from "./kernel";
import { DELEGATE_TOOL_NAME, delegateToolExecutor } from "./tool";

/**
 * The one place a delegate call becomes a tool result. Both loops that hold
 * the tool — the Resident and every inline worker — differ only in the origin
 * they present, so that is the only thing this takes.
 */
export function delegationToolExecutor(
  kernel: DelegationKernel,
  origin: DelegationOrigin,
): NonNullable<ChatAgentConfig["toolExecutor"]> {
  const delegate = delegateToolExecutor(kernel, origin);

  return async (call) => {
    if (call.tool !== DELEGATE_TOOL_NAME) {
      return {
        toolCallId: call.id,
        id: call.id,
        toolName: call.tool,
        output: `unknown tool: ${call.tool}`,
        isError: true,
      };
    }
    return {
      toolCallId: call.id,
      id: call.id,
      toolName: call.tool,
      output: await delegate(call.input),
    };
  };
}
