import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import { testExecutor } from "./executor";
import { appendFileSync, writeSync } from "node:fs";
import { Storage } from "@openomni/ledger";
import { Effect } from "effect";
import { z } from "zod";
import { effectValue, fiberSessionId, nativeExecutorOptions } from "./native-executor";

if (import.meta.main) {
  const [mode, dbPath, receipt] = z.tuple([
    z.enum(["execute", "recover"]), z.string(), z.enum(["absent", "present"]),
  ]).parse(process.argv.slice(2));
  Storage.initialize({ dbPath });
  await Effect.runPromise(Effect.gen(function* () {
    const options = yield* nativeExecutorOptions(mode === "execute" ? 100 : 100_000);
    const executor = testExecutor({
      ...options,
      ledger: { ...options.ledger, commit: (action) => {
        if (mode === "execute" && action.kind === "tool" && effectValue(action).phase === "result") {
          return Effect.sync(() => writeSync(1, `${JSON.stringify({ barrier: "fiber_exit_after_execute_before_action_commit" })}\n`)).pipe(
            Effect.zipRight(Effect.never),
          );
        }
        return options.ledger.commit(action);
      } },
    });
    if (mode === "recover") {
      const before = sessionTree(fiberSessionId);
      yield* executor.recover();
      const after = sessionTree(fiberSessionId);
      yield* executor.recover();
      writeSync(1, JSON.stringify({
        before, after, repeated: sessionTree(fiberSessionId),
        results: after.filter((action) => action.kind === "tool" && effectValue(action).phase === "result"),
      }));
      return;
    }
    yield* executor.run({
      kind: "tool", op: "write", intent: {}, effect: { category: "mutation" },
      boundary: receipt === "present", toolObservation: { turnId: `${fiberSessionId}:turn`, callId: "write-once" },
    }, () => Effect.sync(() => {
      appendFileSync(`${dbPath}.effect`, "write-once\n");
      return { status: "success", output: "written" };
    }));
  }));
  Storage.reset();
}
