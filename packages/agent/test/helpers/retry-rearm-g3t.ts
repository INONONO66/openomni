import { testExecutor } from "./executor";
import { writeSync } from "node:fs";
import { Storage } from "@openomni/ledger";
import { Effect } from "effect";
import { z } from "zod";
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
    const executor = testExecutor({
      ...recording,
      policy: compiledPolicy(),
      observations: { publish: () => undefined },
      retryAlarm: {
        ...createRetryAlarmPort(rearmSessionId, recording.clock),
        wait: () => Effect.sync(() => writeSync(1, `${WAIT_SIGNAL}\n`)).pipe(
          Effect.zipRight(Effect.never),
        ),
      },
    });
    yield* runChatAttempts(executor, () => Effect.fail(providerFailure("overloaded")));
  }));
}
