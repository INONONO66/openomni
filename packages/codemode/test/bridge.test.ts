import { describe, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { z } from "zod";
import type { Machine } from "@openomni/protocol";
import { PythonKernel } from "../src/kernel";
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe("interpreter bridge ownership", () => {
  test("an unknown callId answer is ignored without disturbing the waiting call", async () => {
    const kernel = new PythonKernel();
    const callEntered = deferred<void>();
    const releaseCall = deferred<void>();
    try {
      const running = kernel.run(
        { cellId: "unknown-answer", code: "tool.echo(value='real')", timeoutMs: 15_000 },
        async () => {
          callEntered.resolve();
          await releaseCall.promise;
          return { status: "completed", value: "real answer" };
        },
      );
      await callEntered.promise;
      const child = z.instanceof(ChildProcess).parse(Reflect.get(kernel, "process"));
      if (!child) throw new Error("expected a running Python process");
      child.stdin?.write(
        `${JSON.stringify({ callId: "not-in-flight", status: "completed", value: "stray" })}\n`,
      );
      releaseCall.resolve();

      await expect(running).resolves.toMatchObject({
        status: "completed",
        value: "'real answer'",
      });
    } finally {
      releaseCall.resolve();
      await kernel.close();
    }
  });

  test("a timeout SIGKILLs a cell with in-flight tool calls and consumes late rejection", async () => {
    const kernel = new PythonKernel();
    const callEntered = deferred<void>();
    const toolAnswer = deferred<Machine.ToolCallResult>();
    type KillSignal = Parameters<ChildProcess["kill"]>[0];
    const signals: KillSignal[] = [];
    const unhandled: Error[] = [];
    const onUnhandled = (error: Error) => unhandled.push(error);
    const rejectionEvents = process as NodeJS.Process & { on(event: "unhandledRejection", listener: (error: Error) => void): void; off(event: "unhandledRejection", listener: (error: Error) => void): void };
    rejectionEvents.on("unhandledRejection", onUnhandled);
    try {
      const running = kernel.run(
        {
          cellId: "timeout-in-flight",
          code: "parallel([lambda: tool.slow(), lambda: tool.slow()])",
          timeoutMs: 1_000,
        },
        () => {
          callEntered.resolve();
          return toolAnswer.promise;
        },
      );
      await callEntered.promise;
      const child = z.instanceof(ChildProcess).parse(Reflect.get(kernel, "process"));
      if (!child) throw new Error("expected a running Python process");
      const callbacks = [...z.object({ inFlight: z.map(z.string(), z.custom<Promise<void>>((value) => value instanceof Promise)) }).parse(Reflect.get(kernel, "pending")).inFlight.values()];
      const kill = child.kill.bind(child);
      child.kill = ((signal?: KillSignal) => {
        signals.push(signal);
        return kill(signal);
      }) as typeof child.kill;

      await expect(running).resolves.toEqual({ status: "timed_out", cellId: "timeout-in-flight" });
      expect(signals).toContain("SIGKILL");
      toolAnswer.reject(new Error("late tool failure"));
      await Promise.all(callbacks);
      expect(unhandled).toEqual([]);
    } finally {
      rejectionEvents.off("unhandledRejection", onUnhandled);
      toolAnswer.resolve({ status: "failed", error: "closed" });
      await kernel.close();
    }
  });

  test("a tool answer that outlives its cell never reaches the next one", async () => {
    const kernel = new PythonKernel();
    let announceSlowCall!: () => void;
    const slowCallEntered = new Promise<void>((resolve) => {
      announceSlowCall = resolve;
    });
    let releaseSlowCall!: () => void;
    const slowCallBlocked = new Promise<void>((resolve) => {
      releaseSlowCall = resolve;
    });
    try {
      await expect(
        kernel.run({ cellId: "warm", code: "1 + 1", timeoutMs: 15_000 }, async () => ({
          status: "failed",
          error: "no tools during warmup",
        })),
      ).resolves.toMatchObject({ status: "completed", value: "2" });
      const firstPending = kernel.run(
        { cellId: "one", code: "tool.slow()", timeoutMs: 100 },
        async () => {
          announceSlowCall();
          await slowCallBlocked;
          return { status: "completed", value: "stray" };
        },
      );
      await Promise.race([
        slowCallEntered,
        firstPending.then((result) => {
          throw new Error(`cell terminated before tool entry: ${result.status}`);
        }),
      ]);
      await expect(firstPending).resolves.toEqual({ status: "timed_out", cellId: "one" });

      // Timeout replaced the interpreter. The successor completes before the
      // old callback is released, so its result cannot depend on scheduler luck.
      const second = await kernel.run(
        { cellId: "two", code: "tool.mine()", timeoutMs: 2000 },
        async () => ({ status: "completed", value: "mine" }),
      );
      expect(second).toMatchObject({ status: "completed", cellId: "two", value: "'mine'" });

      releaseSlowCall();
      const third = await kernel.run({ cellId: "three", code: "1 + 1", timeoutMs: 15_000 }, () =>
        Promise.resolve({ status: "failed", error: "no tools" }),
      );
      expect(third).toMatchObject({ status: "completed", value: "2" });
    } finally {
      releaseSlowCall();
      await kernel.close();
    }
  });


});
