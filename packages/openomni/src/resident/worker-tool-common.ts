import type { Ingress, Tool } from "@openomni/protocol";

export interface WorkerAgentResolverInput {
  readonly agentName: string;
  readonly workspaceRoot?: string;
}

export interface WorkerToolContextInput {
  readonly sessionId?: string;
  readonly callerAgentName?: string;
}

export function toolResult(call: Tool.Call, output: unknown, isError = false): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: typeof output === "string" ? output : JSON.stringify(output),
    ...(isError ? { isError: true } : {}),
  };
}

export function isResidentCaller(
  agentName: string | undefined,
  residentAgentNames: readonly string[],
): boolean {
  return agentName !== undefined && residentAgentNames.includes(agentName);
}

export function residentActor(
  input: WorkerToolContextInput,
  residentAgentNames: readonly string[],
): Ingress.ActorMetadata {
  const resident = isResidentCaller(input.callerAgentName, residentAgentNames);
  return {
    role: resident ? "resident" : "agent",
    sessionId: input.sessionId,
    agentName: input.callerAgentName,
    isResident: resident,
  };
}

export function denyNonResidentCaller(
  call: Tool.Call,
  input: { readonly callerAgentName?: string },
  residentAgentNames: readonly string[],
): Tool.Result | undefined {
  if (isResidentCaller(input.callerAgentName, residentAgentNames)) return undefined;
  return toolResult(
    call,
    `worker control tools require an explicit Resident caller (${residentAgentNames.join(", ")})`,
    true,
  );
}

export function requireAgentName(
  call: Tool.Call,
  agentName: string | undefined,
): Tool.Result | undefined {
  if (agentName) return undefined;
  return toolResult(call, "worker control tools require an explicit agentName", true);
}
