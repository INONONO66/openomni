import { Dispatch, type Tool } from "@openomni/protocol";
import type { DispatchSubmitOptions } from "../../../../dispatch/runtime.js";
import { defineTool } from "../../define.js";
import type { NativeTool, ToolExecutionContext } from "../../types.js";

export type DispatchToolRuntime = {
  submit(input: Dispatch.Input, options?: DispatchSubmitOptions): Promise<Dispatch.Result>;
};

export interface DispatchToolOptions {
  readonly description?: string;
  readonly inputSchema?: Tool.Spec["inputSchema"];
  readonly normalizeInput?: (input: RuntimeInput) => Dispatch.Input;
}

type RuntimeInput = Dispatch.Input & {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly workspaceRoot?: string;
};

const defaultInputSchema = {
  type: "object",
  properties: {
    action: { type: "string" },
    target: {
      type: "object",
      properties: {
        kind: {
          enum: [
            "worker",
            "resident",
            "external_actor",
            "schedule",
            "session",
            "surface",
            "system",
          ],
        },
        id: { type: "string" },
        sessionId: { type: "string" },
        parentSessionId: { type: "string" },
        runId: { type: "string" },
        name: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    payload: {},
    wait: { type: "boolean" },
    timeoutMs: { type: "number" },
    correlation: { type: "string" },
    idempotencyKey: { type: "string" },
  },
  required: ["action", "target"],
  additionalProperties: false,
};

function stripRuntimeInput(input: RuntimeInput): Dispatch.Input {
  const {
    sessionId: _sessionId,
    runId: _runId,
    agentName: _agentName,
    workspaceRoot: _workspaceRoot,
    ...publicInput
  } = input;
  return Dispatch.Input.parse(publicInput);
}

function result(call: Tool.Call, output: Dispatch.Result, isError?: boolean): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: JSON.stringify(output),
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(call: Tool.Call, message: string): Tool.Result {
  return result(
    call,
    {
      dispatchId: crypto.randomUUID(),
      status: "failed",
      error: message,
    },
    true,
  );
}

export function createDispatchTool(
  dispatchRuntime: DispatchToolRuntime,
  options: DispatchToolOptions = {},
): NativeTool {
  const normalizeInput = options.normalizeInput ?? stripRuntimeInput;
  return defineTool<RuntimeInput>({
    name: "dispatch",
    description:
      options.description ??
      "Submit a cross-session OpenOmni action through the Dispatch policy/audit gate.",
    inputSchema: options.inputSchema ?? defaultInputSchema,
    source: "agent",
    riskTier: 1,
    isReadOnly: false,
    isConcurrencySafe: true,
    implicitInputs: {
      sessionId: "sessionId",
      runId: "runId",
      agentName: "agentName",
      workspaceRoot: "workspaceRoot",
    },
    async execute(call, context?: ToolExecutionContext) {
      let input: Dispatch.Input;
      try {
        input = normalizeInput(call.input);
      } catch (error) {
        return errorResult(call, error instanceof Error ? error.message : String(error));
      }

      try {
        const output = await dispatchRuntime.submit(input, {
          signal: context?.signal,
          ...(call.input.sessionId ? { sessionId: call.input.sessionId } : {}),
          ...(call.input.runId ? { runId: call.input.runId } : {}),
          ...(call.input.agentName ? { agentName: call.input.agentName } : {}),
          ...(call.input.workspaceRoot ? { workspaceRoot: call.input.workspaceRoot } : {}),
          sourceTool: "dispatch",
        });
        return result(call, output, output.status !== "completed");
      } catch (error) {
        return errorResult(call, error instanceof Error ? error.message : String(error));
      }
    },
  });
}

const workerResidentAskInputSchema = {
  type: "object",
  properties: {
    action: { const: "resident.ask" },
    target: {
      type: "object",
      properties: {
        kind: { const: "resident" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    payload: {},
    wait: { const: true },
    timeoutMs: { type: "number" },
    correlation: { type: "string" },
    idempotencyKey: { type: "string" },
  },
  required: ["action", "target", "wait"],
  additionalProperties: false,
};

function stripWorkerResidentAskInput(input: RuntimeInput): Dispatch.Input {
  const publicInput = stripRuntimeInput(input);
  if (publicInput.action !== Dispatch.Actions.ResidentAsk) {
    throw new Error("worker dispatch only supports resident.ask");
  }
  if (publicInput.target.kind !== "resident") {
    throw new Error("worker dispatch resident.ask requires resident target");
  }
  if (publicInput.wait !== true) {
    throw new Error("worker dispatch resident.ask requires wait: true");
  }
  return publicInput;
}

export function createWorkerResidentAskDispatchTool(
  dispatchRuntime: DispatchToolRuntime,
): NativeTool {
  return createDispatchTool(dispatchRuntime, {
    description:
      "Ask the Resident for guidance or approval and wait for the Resident-mediated answer.",
    inputSchema: workerResidentAskInputSchema,
    normalizeInput: stripWorkerResidentAskInput,
  });
}
