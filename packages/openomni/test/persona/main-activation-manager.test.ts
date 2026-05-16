import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Session, Storage } from "@openomni/session";
import { MainActivationManager } from "../../src/persona/main-activation-manager";

function makeEvent() {
  return {
    id: crypto.randomUUID(),
    surface: "slack",
    payload: "hello",
    mode: "direct" as const,
    meta: { target: { kind: "main" as const } },
    agent: { model: { provider: "test", id: "fixture" } },
  };
}

describe("MainActivationManager", () => {
  beforeEach(() => {
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("hydrates, runs, and releases idle activations", async () => {
    const manager = MainActivationManager.create({
      idleTimeoutMs: 10,
      runAgent: async (_config, input) => ({
        text: `ran:${input.messages.length}`,
        finishReason: "stop",
      }),
    });

    const session = Session.create({
      title: "main-activation-test",
      model: { providerID: "test", modelID: "fixture" },
    });

    const result = await manager.run({
      sessionId: session.id,
      event: {
        id: "evt-main-1",
        surface: "slack",
        payload: "hello",
        mode: "direct",
        meta: { target: { kind: "main" } },
        agent: {
          model: { provider: "test", id: "fixture" },
        },
      },
    });

    expect(result.output).toBe("ran:0");
    expect(manager.getLifecycle(session.id)).toBe("idle");
    expect(manager.stats().activations).toBe(1);

    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(manager.getLifecycle(session.id)).toBe("sleeping");
    expect(manager.stats().activations).toBe(0);
  });
});

test("MainActivationManager enforces maximum resident activations", async () => {
  let markFirstRunStarted!: () => void;
  let releaseFirstRun!: () => void;
  const firstRunStarted = new Promise<void>((resolve) => {
    markFirstRunStarted = resolve;
  });
  const firstRunCanFinish = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  const manager = MainActivationManager.create({
    maxActive: 1,
    idleTimeoutMs: 1_000,
    runAgent: async () => {
      markFirstRunStarted();
      await firstRunCanFinish;
      return { text: "ok", finishReason: "stop" };
    },
  });

  const firstRun = manager.run({ sessionId: "main-a", event: makeEvent() });
  await firstRunStarted;

  await expect(manager.run({ sessionId: "main-b", event: makeEvent() })).rejects.toThrow(
    "maximum main activations reached",
  );

  releaseFirstRun();
  await firstRun;
});
