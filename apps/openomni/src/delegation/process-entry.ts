import { initialize, Storage } from "@openomni/ledger";
import { Delegation, Model } from "@openomni/protocol";
import { z } from "zod";
import { createDelegationKernel, type DelegationKernel } from "./kernel";
import { createInlineDriver, type InlineWorkerRunner } from "./inline-driver";
import { createInlineWorkerRunner } from "./worker-loop";

/** Child-process wire: parse, acknowledge delivery, then report one outcome. */
export const ProcessWorkerRequest = z
  .object({
    delegationId: z.string().min(1),
    operation: Delegation.Operation,
    instruction: z.string().min(1),
    acceptanceCriteria: z.array(z.string()),
    origin: Delegation.Origin,
    model: Model.Ref,
    apiKey: z.string().min(1),
    /** Shared ledger path for durable child delegations. */
    dbPath: z.string().min(1).optional(),
  })
  .strict();
export type ProcessWorkerRequest = z.infer<typeof ProcessWorkerRequest>;

export const PROCESS_WORKER_ACK = JSON.stringify({ delivered: true });

export const ProcessWorkerResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      output: z.string(),
      usage: z.object({ tokens: z.number().int().nonnegative() }).strict().optional(),
    })
    .strict(),
  z.object({ status: z.literal("failed"), error: z.string() }).strict(),
]);
export type ProcessWorkerResult = z.infer<typeof ProcessWorkerResult>;

export type ProcessWorkerRun = (
  request: ProcessWorkerRequest,
) => Promise<{ readonly text: string; readonly tokens: number }>;

/** Child processes may only open inline children; independent work is refused. */
export function createChildKernel(runner: InlineWorkerRunner): DelegationKernel {
  return createDelegationKernel({
    drivers: { inline: createInlineDriver(runner) },
    now: () => Date.now(),
    wake: () => undefined,
    newDelegationId: () => crypto.randomUUID(),
    // This process is a worker, not a host restart. Its boot must not sweep
    // the parent host's open process row from the shared ledger.
    bootSweep: false,
  });
}

/**
 * Serves one request. A malformed request throws before the ack, so the parent
 * classifies it as a delivery failure rather than a worker refusal.
 */
export async function serveProcessWorker(
  requestLine: string,
  writeLine: (line: string) => void,
  run: ProcessWorkerRun,
): Promise<void> {
  const request = ProcessWorkerRequest.parse(JSON.parse(requestLine));
  writeLine(PROCESS_WORKER_ACK);
  let result: ProcessWorkerResult;
  try {
    const output = await run(request);
    result = { status: "completed", output: output.text, usage: { tokens: output.tokens } };
  } catch (error) {
    result = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  writeLine(JSON.stringify(result));
}

/** Runs the same Worker loop in the child process. */
function processWorkerRun(
  request: ProcessWorkerRequest,
): Promise<{ readonly text: string; readonly tokens: number }> {
  if (request.dbPath !== undefined && Storage.getInitializedDbPath() === null) {
    initialize({ dbPath: request.dbPath });
  }
  let kernel: DelegationKernel;
  const runner = createInlineWorkerRunner({
    model: request.model,
    apiKey: request.apiKey,
    kernel: () => kernel,
  });
  kernel = createChildKernel(runner);
  return runner({
    delegationId: request.delegationId,
    operation: request.operation,
    instruction: request.instruction,
    acceptanceCriteria: request.acceptanceCriteria,
    origin: request.origin,
    // Never fires by design: process-level cancellation is the driver
    // killing this worker process, not an in-band abort.
    signal: new AbortController().signal,
  });
}

/**
 * Machine sentinel: stdin closed before a request line arrived. Distinct
 * from generic load/runtime failures (exit 1) so callers and the package
 * smoke test can prove the worker reached its own guard.
 */
export const PROCESS_WORKER_NO_REQUEST_EXIT = 78;

if (import.meta.main) {
  const readFirstLine = async (): Promise<string | null> => {
    for await (const line of console) return line;
    return null;
  };
  const requestLine = await readFirstLine();
  if (requestLine === null) {
    process.stderr.write("stdin closed before a request line arrived\n");
    process.exit(PROCESS_WORKER_NO_REQUEST_EXIT);
  }
  await serveProcessWorker(requestLine, (line) => console.log(line), processWorkerRun);
  process.exit(0);
}
