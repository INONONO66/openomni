import { Effect } from "effect";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Alarm } from "@openomni/protocol";
import { bounded } from "./helpers/bounded";
import { countingRunner } from "./helpers/counting-runner-g1";
import { rearmSessionId, WAIT_SIGNAL } from "./helpers/retry-rearm-g3t";
import { wakeSession, closeSessions, type SessionRuntime } from "../src/session-handle";
import { isolated } from "./helpers/isolated";

const worker = new URL("./helpers/retry-rearm-g3t.ts", import.meta.url).pathname;
async function stdoutSignal(stream: ReadableStream<Uint8Array>, signal: string): Promise<void> {
  const decoder = new TextDecoder(); let seen = "";
  for await (const chunk of stream) { seen += decoder.decode(chunk, { stream: true }); if (seen.includes(`${signal}\n`)) return; }
  throw new Error(`child exited before signalling ${signal}: ${seen}`);
}

test("killing the kernel during the retry wait leaves a durable schedule that boot recovery consumes and the attempt completes exactly once", () => {
  const directory = mkdtempSync(join(tmpdir(), "retry-rearm-"));
  const program = Effect.gen(function* () {
    const dbPath = join(directory, "kernel.sqlite");
    const child = yield* Effect.sync(() => Bun.spawn([process.execPath, worker, dbPath], { stdin: "ignore", stdout: "pipe", stderr: "inherit" }));
    try {
      yield* Effect.promise(() => bounded(stdoutSignal(child.stdout, WAIT_SIGNAL), "retry wait entered"));
    } finally {
      child.kill("SIGKILL");
      yield* Effect.promise(() => child.exited);
    }
    yield* Effect.sync(() => { Storage.reset(); Storage.initialize({ dbPath }); });
    try {
      const tree = SessionHandleStore.tree(rearmSessionId);
      const attemptIntent = tree.find((action: import("@openomni/protocol").LedgerAction.Node) => action.kind === "attempt" && typeof action.intent.value === "object" && action.intent.value !== null && !Array.isArray(action.intent.value) && action.intent.value.phase === "intent");
      if (attemptIntent === undefined) throw new Error("missing durable attempt intent");
      const alarmId = `${attemptIntent.id}:retry:1`;
      const row = Storage.get().alarms?.get(alarmId);
      expect(row).toMatchObject({ id: alarmId, kind: "at", status: "armed" });
      expect(Alarm.RetrySchedule.parse(row?.spec?.value)).toMatchObject({ kind: "retry.scheduled", attempt: 1, reason: "transient_error" });
      const alarms = Storage.get().alarms;
      if (alarms === undefined) throw new Error("missing test storage capability");
      expect(yield* alarms.cancel(alarmId, rearmSessionId, 100_000)).toMatchObject({ status: "cancelled" });
      const second = yield* Effect.exit(alarms.cancel(alarmId, rearmSessionId, 100_000));
      expect(second._tag).toBe("Failure");
      const calls = { model: 0 };
      const runtime: SessionRuntime = { observations: { publish: () => undefined }, clock: () => 200_000 };
      const runner = countingRunner(runtime, calls);
      yield* wakeSession(rearmSessionId, runner, runtime);
      expect(calls.model).toBe(1);
      expect(SessionHandleStore.openTurns(SessionHandleStore.tree(rearmSessionId))).toEqual([]);
      const settled = SessionHandleStore.tree(rearmSessionId);
      yield* wakeSession(rearmSessionId, runner, runtime);
      expect(SessionHandleStore.tree(rearmSessionId)).toEqual(settled);
      expect(calls.model).toBe(1);
      yield* closeSessions(runtime);
    } finally { yield* Effect.sync(() => Storage.reset()); }
  });
  return isolated(Effect.scoped(program)).finally(() => rmSync(directory, { recursive: true, force: true }));
});
