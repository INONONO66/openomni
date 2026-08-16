import { beforeEach, expect, test } from "bun:test";
import { IngressEvent } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import { ResidentRuntime } from "../../src/resident/runtime";
import { newTraceId } from "@openomni/telemetry";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

function makeEvent() {
  return {
    id: crypto.randomUUID(),
    traceId: "trace-test",
    surface: "slack",
    payload: "hello",
    mode: "direct" as const,
    meta: { target: { kind: "resident" as const } },
    agent: { model: { provider: "test", id: "fixture" } },
  };
}

test("ResidentRuntime enforces maximum resident activations", async () => {
  let markFirstRunStarted!: () => void;
  let releaseFirstRun!: () => void;
  const firstRunStarted = new Promise<void>((resolve) => {
    markFirstRunStarted = resolve;
  });
  const firstRunCanFinish = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  const manager = ResidentRuntime.create({
    maxActive: 1,
    idleTimeoutMs: 1_000,
    runAgent: async () => {
      markFirstRunStarted();
      await firstRunCanFinish;
      return { text: "ok", finishReason: "stop" };
    },
  });

  const firstRun = manager.run({
    sessionId: "resident-a",
    event: makeEvent(),
    traceContext: { traceId: newTraceId() },
  });
  await firstRunStarted;

  const secondError = await manager
    .run({ sessionId: "resident-b", event: makeEvent(), traceContext: { traceId: newTraceId() } })
    .catch((error) => error);
  expect(secondError).toBeInstanceOf(Error);
  if (!(secondError instanceof Error)) throw new TypeError("expected resident activation error");
  expect(secondError.message).toContain("maximum resident activations reached");

  releaseFirstRun();
  await firstRun;
});

test("ResidentRuntime carries the inbound traceId into agent input and the completion event", async () => {
  // Bound, not minted inline: an assertion that only checks "is a string"
  // holds just as well under the `?? crypto.randomUUID()` this replaced.
  const inbound = newTraceId();
  let inputTraceId: string | undefined;
  const completedTraceIds: string[] = [];
  const unsubscribe = Bus.subscribe(IngressEvent.Completed, (event) => {
    completedTraceIds.push(event.traceId);
  });

  const manager = ResidentRuntime.create({
    runAgent: async (_config, input) => {
      inputTraceId = input.traceContext?.traceId;
      return { text: "ok", finishReason: "stop" };
    },
  });

  try {
    await manager.run({
      sessionId: "resident-trace",
      event: makeEvent(),
      traceContext: { traceId: inbound },
    });
  } finally {
    unsubscribe();
  }

  expect(inputTraceId).toBe(inbound);
  expect(completedTraceIds.at(-1)).toBe(inbound);
});

test("ResidentRuntime does not start a queued run after it is aborted", async () => {
  let releaseFirstRun!: () => void;
  let firstRunStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstRunStarted = resolve;
  });
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  let runCount = 0;
  const manager = ResidentRuntime.create({
    runAgent: async () => {
      runCount++;
      if (runCount === 1) {
        firstRunStarted();
        await firstCanFinish;
      }
      return { text: "ok", finishReason: "stop" };
    },
  });

  const firstRun = manager.run({
    sessionId: "resident-queued-abort",
    event: makeEvent(),
    traceContext: { traceId: newTraceId() },
  });
  await firstStarted;

  const controller = new AbortController();
  const secondRun = manager.run({
    sessionId: "resident-queued-abort",
    event: makeEvent(),
    traceContext: { traceId: newTraceId() },
    signal: controller.signal,
  });

  controller.abort();
  const secondError = await secondRun.catch((error) => error);
  expect(secondError).toBeInstanceOf(Error);
  expect((secondError as Error).name).toBe("AbortError");

  releaseFirstRun();
  await firstRun;
  await Bun.sleep(0);
  expect(runCount).toBe(1);
});

/**
 * A run that cannot name its trace is refused, and the refusal happens before
 * a concurrency slot is taken. Rejecting in between would leak the slot for
 * the process lifetime: nothing releases it, so `maxActive` refusals brick the
 * Resident and every later well-formed run waits out `slotWaitTimeoutMs`.
 */
test("a refused traceless run leaves the concurrency slot free", async () => {
  const manager = ResidentRuntime.create({
    maxActive: 1,
    slotWaitTimeoutMs: 200,
    runAgent: async () => ({ text: "ok", finishReason: "stop" }),
  });

  for (const traceContext of [undefined, { traceId: "" }]) {
    const refusal = await manager
      .run({
        sessionId: "resident-traceless",
        event: makeEvent(),
        ...(traceContext === undefined ? {} : { traceContext }),
      })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("resident run requires the inbound trace context");
    expect(manager.stats().activeRuns).toBe(0);
  }

  const result = await manager.run({
    sessionId: "resident-traceless",
    event: makeEvent(),
    traceContext: { traceId: newTraceId() },
  });
  expect(result.output).toBe("ok");
});
