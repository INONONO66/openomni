import { sessionTree } from "./session-tree";
import { testExecutor } from "./executor";
import { appendFileSync, writeSync } from "node:fs";
import { Effect } from "effect";
import { z } from "zod";
import { openCrashStores } from "./crash-stores";
import { effectValue, fiberSessionId, nativeExecutorOptions } from "./native-executor";

if (import.meta.main) {
  const [mode, dbPath, receipt] = z.tuple([
    z.enum(["execute", "recover"]), z.string(), z.enum(["absent", "present"]),
  ]).parse(process.argv.slice(2));
  const stores = openCrashStores(dbPath);
  await Effect.runPromise(Effect.gen(function* () {
    const options = yield* nativeExecutorOptions(mode === "execute" ? 100 : 100_000, fiberSessionId, stores.kernel);
    const executor = testExecutor({
      ...options,
      ledger: { ...options.ledger, commit: (action) => {
        if (mode === "execute" && action.kind === "tool" && effectValue(action).phase === "result") {
          return Effect.sync(() => writeSync(1, `${JSON.stringify({ barrier: "fiber_exit_after_execute_before_action_commit" })}\n`)).pipe(
            Effect.andThen(Effect.never),
          );
        }
        return options.ledger.commit(action);
      } },
    });
    if (mode === "recover") {
      const before = sessionTree(stores.kernel, fiberSessionId);
      yield* executor.recover();
      const after = sessionTree(stores.kernel, fiberSessionId);
      yield* executor.recover();
      writeSync(1, JSON.stringify({
        before, after, repeated: sessionTree(stores.kernel, fiberSessionId),
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
  stores.close();
}
