import type { Dispatch } from "@openomni/protocol";

export interface DispatchHandlerContext {
  readonly signal?: AbortSignal;
  readonly wait?: boolean;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly workspaceRoot?: string;
  readonly sourceTool?: string;
  readonly compatibility?: Record<string, unknown>;
}

export interface DispatchHandlerResult {
  readonly output?: unknown;
}

export type DispatchHandler = (
  command: Dispatch.Command,
  context?: DispatchHandlerContext,
) => Promise<DispatchHandlerResult | unknown> | DispatchHandlerResult | unknown;

export class DispatchRegistry {
  private readonly handlers = new Map<string, DispatchHandler>();

  register(action: string, handler: DispatchHandler): () => void {
    if (!action) throw new Error("dispatch action is required");
    this.handlers.set(action, handler);
    return () => this.unregister(action);
  }

  unregister(action: string): boolean {
    return this.handlers.delete(action);
  }

  get(action: string): DispatchHandler | undefined {
    return this.handlers.get(action);
  }

  has(action: string): boolean {
    return this.handlers.has(action);
  }

  clear(): void {
    this.handlers.clear();
  }

  list(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
