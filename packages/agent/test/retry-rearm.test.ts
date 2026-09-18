import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Alarm } from "@openomni/protocol";
import { bounded } from "./helpers/bounded";
import { countingRunner } from "./helpers/counting-runner";
import { rearmSessionId, WAIT_SIGNAL } from "./helpers/retry-rearm";
import { wakeSession, closeSessions, type SessionRuntime } from "../src/session-handle";

const worker = new URL("./helpers/retry-rearm.ts", import.meta.url).pathname;

/** Resolves once the child printed `signal` on its own stdout: an exact state signal, never a sleep. */
async function stdoutSignal(stream: ReadableStream<Uint8Array>, signal: string): Promise<void> {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of stream) {
    seen += decoder.decode(chunk, { stream: true });
    if (seen.includes(`${signal}\n`)) return;
  }
  throw new Error(`child exited before signalling ${signal}: ${seen}`);
}

test("killing the kernel during the retry wait leaves a re-armable schedule that completes the attempt exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retry-rearm-"));
  try {
    await Storage.withIsolation(async () => {
      const dbPath = join(directory, "kernel.sqlite");
      const child = Bun.spawn([process.execPath, worker, dbPath], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        await bounded(stdoutSignal(child.stdout, WAIT_SIGNAL), "retry wait entered");
      } finally {
        child.kill("SIGKILL");
      }
      await child.exited;

      // Fresh boot over the survived database: the schedule is durable.
      Storage.initialize({ dbPath });
      try {
        const tree = SessionHandleStore.tree(rearmSessionId);
        const attemptIntent = tree.find(
          (action) =>
            action.kind === "attempt" &&
            typeof action.intent.value === "object" &&
            action.intent.value !== null &&
            !Array.isArray(action.intent.value) &&
            action.intent.value.phase === "intent",
        );
        if (attemptIntent === undefined) throw new Error("missing durable attempt intent");
        const alarmId = `${attemptIntent.id}:retry:1`;
        const row = Storage.get().alarms?.get(alarmId);
        expect(row).toMatchObject({ id: alarmId, kind: "at", status: "armed" });
        expect(Alarm.RetrySchedule.parse(row?.spec?.value)).toMatchObject({
          kind: "retry.scheduled",
          attempt: 1,
          reason: "transient_error",
        });

        // Boot alarm owner: fenced consume-once, then wake the session.
        expect(
          SessionHandleStore.cancelAlarm(alarmId, rearmSessionId, 100_000),
        ).toMatchObject({ status: "cancelled" });
        expect(SessionHandleStore.cancelAlarm(alarmId, rearmSessionId, 100_000)).toBeUndefined();

        const calls = { model: 0 };
        const runtime: SessionRuntime = {
          observations: { publish: () => undefined },
          clock: () => 200_000,
        };
        const runner = countingRunner(runtime, calls);
        try {
          await bounded(wakeSession(rearmSessionId, runner, runtime), "rearmed wake");
          expect(calls.model).toBe(1);
          expect(SessionHandleStore.openTurns(SessionHandleStore.tree(rearmSessionId))).toEqual([]);
          const settled = SessionHandleStore.tree(rearmSessionId);
          await bounded(wakeSession(rearmSessionId, runner, runtime), "idempotent wake");
          expect(SessionHandleStore.tree(rearmSessionId)).toEqual(settled);
          expect(calls.model).toBe(1);
        } finally {
          await closeSessions(runtime);
        }
      } finally {
        Storage.reset();
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
