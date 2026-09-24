import type { ResolvedExecutorOptions } from "../../src/executor-contract";
import { executorLayer } from "./service-layers";
import { writeSync } from "node:fs";
import { Storage } from "@openomni/ledger";
import { Effect } from "effect";
import { z } from "zod";
import { createExecutor } from "../../src/executor";
import { createRetryAlarmPort } from "../../src/executor-retry-alarm";
import { compiledPolicy } from "./compiled-policy";
import { requestLedger, runChatAttempts } from "./effect-g1";
import { providerFailure } from "./mock-llm";
import { seedPolicy } from "./seed-policy";

export const rearmSessionId = "retry-rearm-session";
export const WAIT_SIGNAL = "retry-wait";

if (import.meta.main) {
  const [dbPath] = z.tuple([z.string().min(1)]).parse(process.argv.slice(2));
  Storage.initialize({ dbPath });
  seedPolicy();
  await Effect.runPromise(Effect.gen(function* () {
    const recording = yield* requestLedger({ id: rearmSessionId });
    const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
      ...recording,
      policy: compiledPolicy(),
      observations: { publish: () => undefined },
      retryAlarm: {
        ...createRetryAlarmPort(rearmSessionId, recording.clock),
        wait: () => Effect.sync(() => writeSync(1, `${WAIT_SIGNAL}\n`)).pipe(
          Effect.zipRight(Effect.never),
        ),
      },
    }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
    yield* runChatAttempts(executor, () => Effect.fail(providerFailure("overloaded")));
  }));
}
