import type { Tool } from "@openomni/protocol";
import { WorkspaceLock } from "../workspace-lock.js";

export type ToolSettlementOutcome =
  | { readonly settled: true; readonly output: string }
  | {
      readonly settled: false;
      readonly clearWhenToolSettles: boolean;
      readonly unsafeToken?: string;
    };

export function hasUnknownSettlement(result: Tool.Result): boolean {
  return result.settlement === "unknown";
}

export function waitForToolSettlement(
  promise: Promise<Tool.Result>,
  graceMs: number,
): Promise<ToolSettlementOutcome> {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = globalThis.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve({ settled: false, clearWhenToolSettles: true });
    }, graceMs);
    const finish = (outcome: ToolSettlementOutcome) => {
      if (resolved) return;
      resolved = true;
      globalThis.clearTimeout(timer);
      resolve(outcome);
    };

    promise.then(
      (result) => {
        if (hasUnknownSettlement(result)) {
          finish({
            settled: false,
            clearWhenToolSettles: false,
            unsafeToken: result.toolCallId || result.id,
          });
          return;
        }
        finish({ settled: true, output: result.output });
      },
      (error: unknown) =>
        finish({
          settled: true,
          output: error instanceof Error ? error.message : String(error),
        }),
    );
  });
}

export function markUnsafeWorkspaceForUnsettledTool(args: {
  readonly workspaceRoot: string | undefined;
  readonly lockAcquired: boolean;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly outcome: Extract<ToolSettlementOutcome, { readonly settled: false }>;
  readonly toolExecution: Promise<Tool.Result>;
}): void {
  if (!args.workspaceRoot || !args.lockAcquired) return;

  const workspaceRoot = args.workspaceRoot;
  const unsafeToken = args.outcome.unsafeToken ?? args.toolCallId;
  WorkspaceLock.markUnsafe(
    workspaceRoot,
    `tool "${args.toolName}" did not settle after timeout/abort grace`,
    unsafeToken,
  );
  if (args.outcome.clearWhenToolSettles) {
    void args.toolExecution
      .finally(() => WorkspaceLock.clearUnsafe(workspaceRoot, unsafeToken))
      .catch(() => undefined);
  }
}
