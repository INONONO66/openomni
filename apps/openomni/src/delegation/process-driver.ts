import type { Delegation, Model } from "@openomni/protocol";
import type { Admitted } from "./admission";
import type { DelegationDriver, DriverOutcome } from "./kernel";
import { PROCESS_WORKER_ACK, ProcessWorkerResult, type ProcessWorkerRequest } from "./process-entry";

/**
 * The process transport: one delegation, one child OS process. This driver
 * owns the wire only — spawn, one request line down, an ack and a result
 * line back — and the classification the kernel cannot make alone: a request
 * the worker never held is `delivery_failed`, a worker who held it and broke
 * is `failed`, and a worker who held it and went silent is left to the
 * kernel's deadline.
 */

export interface ProcessDriverOptions {
  /** How to start the worker process, e.g. the bun binary and the entry file. */
  readonly command: readonly string[];
  readonly worker: { readonly model: Model.Ref; readonly apiKey: string };
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      yield buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createProcessDriver(options: ProcessDriverOptions): DelegationDriver {
  return {
    async run(
      admitted: Admitted,
      handle: Delegation.Handle,
      signal: AbortSignal,
    ): Promise<DriverOutcome> {
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
          instruction: admitted.request.payload.text,
          acceptanceCriteria: admitted.request.acceptanceCriteria ?? [],
          origin: admitted.childOrigin,
          model: options.worker.model,
          apiKey: options.worker.apiKey,
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

        const resultLine = await reader.next();
        if (signal.aborted) return { status: "cancelled", reason: "deadline reached" };
        if (resultLine.done) {
          return { status: "failed", error: "worker process exited without a result" };
        }
        const parsed = ProcessWorkerResult.safeParse(JSON.parse(resultLine.value));
        if (!parsed.success) {
          return { status: "failed", error: `worker process wrote a malformed result: ${resultLine.value}` };
        }
        return parsed.data;
      } catch (error) {
        if (signal.aborted) return { status: "cancelled", reason: "deadline reached" };
        return { status: "failed", error: errorText(error) };
      } finally {
        signal.removeEventListener("abort", onAbort);
        child.kill();
        await child.exited;
      }
    },
  };
}
