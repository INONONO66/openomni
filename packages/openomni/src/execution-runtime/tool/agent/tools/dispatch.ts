import { Command, type Tool } from "@openomni/protocol";
import type { DispatchSubmitOptions } from "../../../../dispatch/runtime.js";
import { defineTool } from "../../define.js";
import type { NativeTool, ToolExecutionContext } from "../../types.js";

export type DispatchToolRuntime = {
  submit(input: Command.Input, options: DispatchSubmitOptions): Promise<Command.Result>;
};

export interface DispatchToolOptions {
  readonly description?: string;
  readonly inputSchema?: Tool.Spec["inputSchema"];
  readonly normalizeInput?: (input: RuntimeInput) => Command.Input;
}

type RuntimeInput = Command.Input & {
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
        endpointId: { type: "string" },
        connectorInstallationId: { type: "string" },
        name: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    payload: {
      description:
        "Action payload. worker.spawn requires an object with text or prompt plus acceptanceCriteria: string[].",
    },
    wait: { type: "boolean" },
    timeoutMs: { type: "number" },
    correlation: {
      oneOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            endpointId: { type: "string" },
            channelId: { type: "string" },
            replyToMessageId: { type: "string" },
            threadId: { type: "string" },
            tokenHash: { type: "string" },
            externalConversationId: { type: "string" },
          },
          required: ["endpointId", "channelId"],
          additionalProperties: false,
        },
      ],
    },
    idempotencyKey: { type: "string" },
  },
  required: ["action", "target"],
  additionalProperties: false,
};

function stripRuntimeInput(input: RuntimeInput): Command.Input {
  const {
    sessionId: _sessionId,
    runId: _runId,
    agentName: _agentName,
    workspaceRoot: _workspaceRoot,
    ...publicInput
  } = input;
  return Command.Input.parse(publicInput);
}

function result(call: Tool.Call, output: Command.Result, isError?: boolean): Tool.Result {
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
      "Submit a cross-session OpenOmni action through the Command policy/audit gate.",
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
      let input: Command.Input;
      try {
        input = normalizeInput(call.input);
      } catch (error) {
        return errorResult(call, error instanceof Error ? error.message : String(error));
      }

      // The dispatch belongs to the run that asked for it. `submit` requires
      // the trace by type; a caller reaching this tool outside the executor
      // (which refuses a traceless call) is refused here instead.
      const traceId = context?.traceContext?.traceId;
      if (traceId === undefined || traceId.length === 0) {
        return errorResult(call, "dispatch tool requires the run trace context");
      }

      try {
        const output = await dispatchRuntime.submit(input, {
          signal: context?.signal,
          traceId,
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

function stripWorkerResidentAskInput(input: RuntimeInput): Command.Input {
  const publicInput = stripRuntimeInput(input);
  if (publicInput.action !== Command.Actions.ResidentAsk) {
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
