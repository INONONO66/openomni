import type { Tool, WorkerBootstrap } from "@openomni/protocol";

export type ToolCallParams = {
  runId: string;
  sessionId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  workspaceRoot?: string;
};

export type ToolCallCancelParams = {
  runId: string;
  sessionId: string;
  callId: string;
};

export type ToolCallContext = {
  readonly signal?: AbortSignal;
};

export type ToolCallResult = Tool.Result;

export type InboundWaitParams = {
  workerId: string;
  sessionId: string;
  callId?: string;
  runId?: string;
  workspaceRoot?: string;
  payload: string;
  signal?: AbortSignal;
};

export type InboundWaitResult = {
  requestId: string;
  accepted: boolean;
  output?: string;
  error?: string;
};

export type ActiveRequest = {
  readonly runId?: string;
  readonly sessionId: string;
  readonly workspaceRoot?: string;
  readonly controller: AbortController;
  readonly respond: (result: unknown) => void;
  completed: boolean;
};

export type ToolCallHandler = (
  params: ToolCallParams,
  context?: ToolCallContext,
) => Promise<ToolCallResult>;

export type SnapshotHandler = (workerId: number, snapshot: WorkerBootstrap.WorkerSnapshot) => void;

export type InboundWaitHandler = (params: InboundWaitParams) => Promise<InboundWaitResult>;
