import { AppInvariantError } from "../invariant";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { EffectRunner } from "@openomni/channels";
import { Deferred, Effect, Exit, Result } from "effect";
import { ThrownError } from "../thrown";
import type { SessionTransition } from "@openomni/protocol";
import { ProcessReplyReceipt } from "./process-session";

/** #1248: the receiving session has this long to acknowledge an answer frame. */
const RECEIPT_DEADLINE_MS = 30_000;

/** Transport response correlation only; durable delivery truth remains in the source action tree. */
export function createProcessReplyChannel(
  input: Readable,
  write: (line: string) => void,
  run: EffectRunner,
) {
  const lines = createInterface({ input });
  const first = Promise.withResolvers<string | undefined>();
  let opened = false;
  const pending = new Map<string, Deferred.Deferred<SessionTransition.Resolution, Error>>();
  function fail(error: Error): void {
    first.reject(error);
    for (const entry of pending.values()) Deferred.doneUnsafe(entry, Exit.fail(error));
  }
  lines.on("line", (line) => {
    if (!opened) {
      opened = true;
      first.resolve(line);
      return;
    }
    const parsed = Result.try({
      try: () => ProcessReplyReceipt.parse(JSON.parse(line)),
      catch: ThrownError.parse,
    });
    if (Result.isFailure(parsed)) {
      fail(parsed.failure);
      return;
    }
    const receipt = parsed.success;
    const entry = pending.get(receipt.inputId);
    if (entry === undefined) {
      fail(new Error("unsolicited process receiving receipt"));
      return;
    }
    Deferred.doneUnsafe(
      entry,
      receipt.ok ? Exit.succeed(receipt.resolution) : Exit.fail(new Error(receipt.error)),
    );
  });
  lines.on("close", () => {
    if (!opened) first.resolve(undefined);
    const closed = new Error("process reply transport closed");
    for (const entry of pending.values()) Deferred.doneUnsafe(entry, Exit.fail(closed));
  });
  lines.on("error", fail);
  return {
    first: first.promise,
    async answer(answer: SessionTransition.Answer): Promise<SessionTransition.Resolution> {
      if (pending.has(answer.inputId)) throw new AppInvariantError("process reply is already in flight");
      const response = Deferred.makeUnsafe<SessionTransition.Resolution, Error>();
      pending.set(answer.inputId, response);
      try {
        write(JSON.stringify({ kind: "request_answer", answer }));
        // The wait is an Effect on the injected runtime's clock: hitting the
        // deadline interrupts the wait and fails with the typed timeout error.
        return await run(
          Deferred.await(response).pipe(
            Effect.timeoutOrElse({
              duration: RECEIPT_DEADLINE_MS,
              orElse: () => Effect.fail(new Error("process receiving receipt timed out")),
            }),
          ),
        );
      } finally {
        pending.delete(answer.inputId);
      }
    },
    close() {
      lines.close();
      input.pause();
    },
  };
}
