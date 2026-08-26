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
  z.object({ status: z.literal("completed"), output: z.string() }).strict(),
  z.object({ status: z.literal("failed"), error: z.string() }).strict(),
]);
export type ProcessWorkerResult = z.infer<typeof ProcessWorkerResult>;

export type ProcessWorkerRun = (request: ProcessWorkerRequest) => Promise<string>;

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
    result = { status: "completed", output: await run(request) };
  } catch (error) {
    result = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  writeLine(JSON.stringify(result));
}

/** Runs the same Worker loop in the child process. */
function processWorkerRun(request: ProcessWorkerRequest): Promise<string> {
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
    instruction: request.instruction,
    acceptanceCriteria: request.acceptanceCriteria,
    origin: request.origin,
    signal: new AbortController().signal,
  });
}

if (import.meta.main) {
  const readFirstLine = async (): Promise<string> => {
    for await (const line of console) return line;
    throw new Error("stdin closed before a request line arrived");
  };
  await serveProcessWorker(await readFirstLine(), (line) => console.log(line), processWorkerRun);
  process.exit(0);
}
