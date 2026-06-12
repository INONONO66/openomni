import { beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { command } from "./helpers";

describe("worker message dispatch handlers", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("worker send/resume/cancel call coordinator owner methods", async () => {
    const delivered: Array<{ sessionId: string; message: string; runId?: string }> = [];
    const cancelled: string[] = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch() {
            throw new Error("not used");
          },
          async deliverMessage(sessionId, message, runId) {
            delivered.push({ sessionId, message, runId });
            return { accepted: true };
          },
          async cancelRun(runId) {
            cancelled.push(runId);
            return { cancelled: true };
          },
        },
      },
    });

    await registry.get("worker.send")?.(
      command("worker.send", { kind: "worker", sessionId: "s1", runId: "r1" }, "next"),
    );
    await registry.get("worker.resume")?.(
      command("worker.resume", { kind: "worker", sessionId: "s1", runId: "r1" }, "resume"),
    );
    await registry.get("worker.cancel")?.(
      command("worker.cancel", { kind: "worker", runId: "r1" }),
    );

    expect(delivered).toEqual([
      { sessionId: "s1", message: "next", runId: "r1" },
      { sessionId: "s1", message: "resume", runId: "r1" },
    ]);
    expect(cancelled).toEqual(["r1"]);
  });
});
