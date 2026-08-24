import { Model } from "@openomni/protocol";
import { z } from "zod";
import { createDelegationKernel, type DelegationKernel } from "./kernel";
import { createInlineDriver, type InlineWorkerRunner } from "./inline-driver";
import { createInlineWorkerRunner } from "./worker-loop";

/**
 * The child half of the process transport. The parent driver spawns this
 * file, writes one request line on stdin, and reads two lines back: the ack
 * that delivery happened, then the result. This file owns that wire
 * vocabulary — the request shape, the ack line, the result shape — and the
 * driver imports it rather than spelling its own.
 */

export const ProcessWorkerRequest = z
  .object({
    delegationId: z.string().min(1),
    instruction: z.string().min(1),
    acceptanceCriteria: z.array(z.string()),
    origin: z
      .object({
        role: z.enum(["resident", "worker"]),
        depth: z.number().int().nonnegative(),
        sessionId: z.string().min(1),
      })
      .strict(),
    model: Model.Ref,
    apiKey: z.string().min(1),
  })
  .strict();
export type ProcessWorkerRequest = z.infer<typeof ProcessWorkerRequest>;

/**
 * Printed the moment the request parsed: the request has reached a worker,
 * so from here on a breakage is the worker's, never the wire's.
 */
export const PROCESS_WORKER_ACK = JSON.stringify({ delivered: true });

export const ProcessWorkerResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), output: z.string() }).strict(),
  z.object({ status: z.literal("failed"), error: z.string() }).strict(),
]);
export type ProcessWorkerResult = z.infer<typeof ProcessWorkerResult>;

export type ProcessWorkerRun = (request: ProcessWorkerRequest) => Promise<string>;

/**
 * What a child process may delegate onward: inline work, and nothing else.
 *
 * This is deliberately the second layer rather than the first — admission
 * already refuses a worker who asks for independent work, so a child cannot
 * reach the process transport by the front door. Keeping the map narrow means
 * a child that somehow presented a Resident origin still settles
 * `delivery_failed` instead of spawning, and keeping it here rather than
 * inline inside `processWorkerRun` means a test can hold the same map the
 * child holds. A guard nobody can observe is a guard nobody has.
 */
export function createChildKernel(runner: InlineWorkerRunner): DelegationKernel {
  return createDelegationKernel({
    drivers: { inline: createInlineDriver(runner) },
    now: () => Date.now(),
    newDelegationId: () => crypto.randomUUID(),
  });
}

/**
 * Serve one request. A request that does not parse throws before the ack is
 * written, so the parent reads the empty stream as what it is: a delivery
 * failure, not a worker who declined.
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

/**
 * The real worker: the same loop the inline driver runs, in its own process.
 *
 * The origin arrives carried whole from the parent's admission, so the depth
 * cap keeps binding across the process boundary — a process worker's inline
 * children present the same lineage they would have presented in-process.
 *
 */
export function processWorkerRun(request: ProcessWorkerRequest): Promise<string> {
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
