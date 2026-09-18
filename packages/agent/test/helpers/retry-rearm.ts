import { writeSync } from "node:fs";
import { Storage } from "@openomni/ledger";
import { z } from "zod";
import { createExecutor } from "../../src/executor";
import { createRetryAlarmPort } from "../../src/executor-retry-alarm";
import { runChatAttempts } from "./chat-attempts";
import { compiledPolicy } from "./compiled-policy";
import { providerFailure } from "./mock-llm";
import { requestLedger } from "./request-ledger";
import { seedPolicy } from "./seed-policy";

export const rearmSessionId = "retry-rearm-session";
export const WAIT_SIGNAL = "retry-wait";

// A kernel that enters the durable retry wait and never leaves it: the parent
// test kills this process mid-wait, so only the committed schedule survives.
if (import.meta.main) {
  const [dbPath] = z.tuple([z.string().min(1)]).parse(process.argv.slice(2));
  Storage.initialize({ dbPath });
  seedPolicy();
  const recording = requestLedger({ id: rearmSessionId });
  const executor = createExecutor({
    ...recording,
    policy: compiledPolicy(),
    observations: { publish: () => undefined },
    retryAlarm: {
      ...createRetryAlarmPort(rearmSessionId, recording.clock),
      wait: () => {
        writeSync(1, `${WAIT_SIGNAL}\n`);
        return new Promise<never>(() => undefined);
      },
    },
  });
  await runChatAttempts(executor, async () => {
    writeSync(1, "llm\n");
    throw providerFailure("overloaded");
  });
}
