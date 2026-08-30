import { LineSplitter } from "@openomni/ipc";
import type { Delegation, Model } from "@openomni/protocol";
import type { Admitted } from "./admission";
import type { DelegationDriver, DriverOutcome, DriverReport } from "./kernel";
import {
  PROCESS_WORKER_ACK,
  ProcessWorkerResult,
  type ProcessWorkerRequest,
} from "./process-entry";

/** One delegation per child OS process; ack and result remain distinct facts. */
export interface ProcessDriverOptions {
  readonly command: readonly string[];
  readonly worker: { readonly model: Model.Ref; readonly apiKey: string };
  /** Shared durable ledger path used if the process opens inline children. */
  readonly dbPath?: string;
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const splitter = new LineSplitter();
  for await (const chunk of stream) {
    yield* splitter.push(chunk);
  }
  const trailing = splitter.finish();
  if (trailing !== undefined) yield trailing;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Process wire owner. The kernel starts this promise in the background for
 * durable process work; the ack reports `delegation.delivered`, while the
 * eventual return is merely an outcome proposal for the kernel's CAS fold.
 */
export function createProcessDriver(options: ProcessDriverOptions): DelegationDriver {
  return {
    async run(
      admitted: Admitted,
      handle: Delegation.Handle,
      signal: AbortSignal,
      report?: DriverReport,
    ): Promise<DriverOutcome> {
      if (signal.aborted) return { status: "cancelled", reason: "delegation stopped" };
      let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
      try {
        child = Bun.spawn({
          cmd: [...options.command],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        return {
          status: "delivery_failed",
          reason: `worker process did not start: ${errorText(error)}`,
        };
      }

      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const request: ProcessWorkerRequest = {
          delegationId: handle.delegationId,
          operation: admitted.request.operation,
          instruction: admitted.request.payload.text,
          acceptanceCriteria: admitted.request.acceptanceCriteria ?? [],
          origin: admitted.childOrigin,
          model: options.worker.model,
          apiKey: options.worker.apiKey,
          ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
        };
        child.stdin.write(`${JSON.stringify(request)}\n`);
        await child.stdin.end();

        const reader = lines(child.stdout);
        const ack = await reader.next();
        if (ack.done || ack.value !== PROCESS_WORKER_ACK) {
          const stderr = (await new Response(child.stderr).text()).trim();
          return {
            status: "delivery_failed",
            reason: `worker process died before acknowledging delivery${stderr ? `: ${stderr}` : ""}`,
          };
        }
        report?.delivered();

        const resultLine = await reader.next();
        if (signal.aborted) return { status: "cancelled", reason: "delegation stopped" };
        if (resultLine.done) {
          return { status: "failed", error: "worker process exited without a result" };
        }
        let resultJson: unknown;
        try {
          resultJson = JSON.parse(resultLine.value);
        } catch {
          // Without this guard a non-JSON line would surface as a generic
          // failure from the outer catch instead of naming the bad output.
          return {
            status: "failed",
            error: `worker process wrote a malformed result: ${resultLine.value}`,
          };
        }
        const parsed = ProcessWorkerResult.safeParse(resultJson);
        if (!parsed.success) {
          return {
            status: "failed",
            error: `worker process wrote a malformed result: ${resultLine.value}`,
          };
        }
        return parsed.data;
      } catch (error) {
        if (signal.aborted) return { status: "cancelled", reason: "delegation stopped" };
        return { status: "failed", error: errorText(error) };
      } finally {
        signal.removeEventListener("abort", onAbort);
        child.kill();
        await child.exited;
      }
    },
  };
}
