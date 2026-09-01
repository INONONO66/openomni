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
    /** Wire v2: every process request carries the run identity it must consume. */
    workerRunId: z.string().min(1),
    operation: Delegation.Operation,
    instruction: z.string().min(1),
    acceptanceCriteria: z.array(z.string()),
    origin: Delegation.Origin,
    model: Model.Ref,
    apiKey: z.string().min(1),
    /**
     * The host's operator transport config, carried across the process
     * boundary: a child that fell back to the catalog endpoint would send the
     * operator's credential somewhere the operator did not choose.
     */
    transport: z
      .object({
        baseUrl: z.string().min(1).optional(),
        headers: z.record(z.string().min(1), z.string()).optional(),
      })
      .strict()
      .optional(),
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
      workerRunId: z.string().min(1),
      usage: z.object({ tokens: z.number().int().nonnegative() }).strict().optional(),
    })
    .strict(),
  z.object({ status: z.literal("failed"), error: z.string(), workerRunId: z.string().min(1) }).strict(),
]);
export type ProcessWorkerResult = z.infer<typeof ProcessWorkerResult>;

export type ProcessWorkerRun = (
  request: ProcessWorkerRequest,
) => Promise<{ readonly text: string; readonly tokens: number; readonly runId?: string }>;

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
    result = {
      status: "completed",
      output: output.text,
      workerRunId: output.runId ?? request.workerRunId,
      usage: { tokens: output.tokens },
    };
  } catch (error) {
    result = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      workerRunId: request.workerRunId,
    };
  }
  writeLine(JSON.stringify(result));
}

/** Runs the same Worker loop in the child process. */
function processWorkerRun(
  request: ProcessWorkerRequest,
): Promise<{ readonly text: string; readonly tokens: number; readonly runId?: string }> {
  if (request.dbPath !== undefined && Storage.getInitializedDbPath() === null) {
    initialize({ dbPath: request.dbPath });
  }
  let kernel: DelegationKernel;
  const runner = createInlineWorkerRunner({
    model: request.model,
    apiKey: request.apiKey,
    ...(request.transport === undefined ? {} : { transport: request.transport }),
    kernel: () => kernel,
  });
  kernel = createChildKernel(runner);
  return runner({
    delegationId: request.delegationId,
    ...(request.workerRunId === undefined ? {} : { workerRunId: request.workerRunId }),
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
