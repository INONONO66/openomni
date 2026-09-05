import { describe, expect, it } from "bun:test";
import { type BusEvent, Tool } from "@openomni/protocol";
import {
  createDispatcher,
  createTurnDispatcher,
  currentExecutor,
  defineTool,
  type Executor,
} from "../src/index";
import { z } from "zod";
import { allowAllPolicy, opPhaseOf, recordingLedger } from "./helpers/compiled-policy";

function tool(name: string, execute: () => Promise<string>, output = z.string()) {
  return defineTool({
    name,
    description: name,
    category: "query",
    input: z.object({}).strict(),
    output,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute,
    render: (_input, value) => value,
  });
}

const passThrough: Executor = {
  async run(_request, body) {
    return { terminal: "executed", value: await body() };
  },
};

const context = { sessionId: "session-1", turnId: "turn-1" };
const call = (name: string) => ({ id: `call-${name}`, tool: name, input: {} });

describe("createTurnDispatcher", () => {
  it("composes a durable executor and commits intent before result", async () => {
    const recording = recordingLedger();
    const dispatcher = createTurnDispatcher(
      [tool("echo", async () => "ok")],
      { sessionId: "session-1", role: "resident", actionId: "turn-1", policy: allowAllPolicy, ledger: recording.ledger },
      { observations: { publish: () => undefined }, clock: () => 1, entropy: recording.entropy },
    );

    const result = await dispatcher.execute(call("echo"), context);

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("ok");
    expect(recording.committed.filter((action) => action.kind === "tool").map(opPhaseOf)).toEqual([
      "echo:intent",
      "echo:result",
    ]);
  });
});

describe("currentExecutor", () => {
  it("throws outside an active execution", () => {
    expect(() => currentExecutor()).toThrow("called outside an active execution");
  });

  it("returns the executor running the tool body", async () => {
    let seen: Executor | undefined;
    const dispatcher = createDispatcher(
      [
        tool("probe", async () => {
          seen = currentExecutor();
          return "probed";
        }),
      ],
      { executor: passThrough },
    );

    await dispatcher.execute(call("probe"), context);

    expect(seen).toBe(passThrough);
  });
});

describe("tool body outcomes", () => {
  it("settles a never-resolving body as timed_out and publishes the observation", async () => {
    const published: string[] = [];
    const observations: BusEvent.Sink = {
      publish(event) {
        published.push(event.name);
      },
    };
    const dispatcher = createDispatcher([tool("stall", () => new Promise<string>(() => undefined))], {
      executor: passThrough,
      timeoutMs: 5,
      observations,
    });

    const result = await dispatcher.execute(call("stall"), context);

    expect(result).toMatchObject({ isError: true, errorKind: "execution_failed" });
    expect(published).toContain(Tool.Events.TimedOut.name);
  });

  it("clears the timer when the body finishes inside the timeout", async () => {
    const dispatcher = createDispatcher([tool("fast", async () => "done")], {
      executor: passThrough,
      timeoutMs: 1000,
    });

    const result = await dispatcher.execute(call("fast"), context);

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("done");
  });

  it("fails closed when the body violates the output schema", async () => {
    const dispatcher = createDispatcher(
      [tool("bad-output", async () => "anything", z.string().refine(() => false))],
      { executor: passThrough },
    );

    const result = await dispatcher.execute(call("bad-output"), context);

    expect(result).toMatchObject({ isError: true, errorKind: "invalid_output" });
  });

  it("propagates an executor failure to the caller", async () => {
    const failing: Executor = {
      run() {
        return Promise.reject(new Error("ledger unavailable"));
      },
    };
    const dispatcher = createDispatcher([tool("echo", async () => "ok")], { executor: failing });

    await expect(dispatcher.execute(call("echo"), context)).rejects.toThrow("ledger unavailable");
  });
});
