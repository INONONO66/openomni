import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { connectIpcClient, typedCall } from "@openomni/ipc";
import { Machine } from "@openomni/protocol";
import { attachMachineDaemon } from "../src/daemon";
import { type MachineHost, createMachineHost } from "../src/host";
import { MachineCellError } from "../src/index";
import { PythonKernel } from "../src/kernel";
import { socketPath } from "./helpers/socket-path";

const silent = {
  publish() {
    return;
  },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * A host whose tool port only knows `add`, standing in for the composition
 * root's placement-gated executor: everything else comes back refused.
 */
async function withBridge(
  run: (context: { host: MachineHost; calls: Machine.ToolCall[] }) => Promise<void>,
  callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>,
): Promise<void> {
  const path = socketPath();
  const calls: Machine.ToolCall[] = [];
  const host = await createMachineHost({
    socketPath: path,
    enrollment: () => ({
      name: "workstation",
      machineId: "m-1",
      allowedCapabilities: ["kernel.py"],
      enrolledAt: 1000,
    }),
    events: silent,
    now: () => 5000,
    callTool: async (call) => {
      calls.push(call);
      if (callTool) return callTool(call);
      if (call.name === "add") {
        return {
          status: "completed",
          value: (call.arguments.a as number) + (call.arguments.b as number),
        };
      }
      return { status: "failed", error: `tool is not offerable: ${call.name}` };
    },
  });
  const daemon = await attachMachineDaemon({
    socketPath: path,
    offer: {
      machineId: "m-1",
      daemonVersion: "0.1.0",
      platform: "darwin",
      offeredCapabilities: ["kernel.py"],
      offeredAt: 2000,
    },
  });
  try {
    await run({ host, calls });
  } finally {
    daemon.close();
    host.close();
  }
}

describe("code-mode tool bridge", () => {
  test("a cell reaches host tools repeatedly within one run_cell", async () => {
    await withBridge(async ({ host, calls }) => {
      // The whole point of code mode: two tool calls, one round trip.
      const result = await host.runCell("m-1", {
        cellId: "batch",
        code: "first = tool.add(a=1, b=2)\nsecond = tool.add(a=first, b=10)\nsecond",
        timeoutMs: 15_000,
      });

      expect(result).toMatchObject({ status: "completed", value: "13" });
      expect(calls.map((call) => call.name)).toEqual(["add", "add"]);
      expect(calls[0]).toMatchObject({ cellId: "batch", arguments: { a: 1, b: 2 } });
    });
  });

  test("parallel tool calls overlap and interleaved answers route by callId in input order", async () => {
    const secondArrived = deferred<void>();
    let arrivals = 0;
    await withBridge(
      async ({ host }) => {
        const result = await host.runCell("m-1", {
          cellId: "parallel-routing",
          code: [
            "parallel([",
            "    lambda: tool.echo(value='left'),",
            "    lambda: tool.echo(value='right'),",
            "])",
          ].join("\n"),
          timeoutMs: 15_000,
        });

        expect(result).toMatchObject({
          status: "completed",
          value: "['answer:left', 'answer:right']",
        });
      },
      async (call) => {
        arrivals += 1;
        if (arrivals === 1) {
          await secondArrived.promise;
        } else {
          secondArrived.resolve();
        }
        return { status: "completed", value: `answer:${String(call.arguments.value)}` };
      },
    );
    expect(arrivals).toBe(2);
  });

  test("llm sugar calls the llm tool with a prompt", async () => {
    await withBridge(
      async ({ host, calls }) => {
        const result = await host.runCell("m-1", {
          cellId: "llm-sugar",
          code: "llm('summarize this')",
          timeoutMs: 15_000,
        });

        expect(result).toMatchObject({ status: "completed", value: "'summary'" });
        expect(calls).toEqual([
          { cellId: "llm-sugar", name: "llm", arguments: { prompt: "summarize this" } },
        ]);
      },
      () => Promise.resolve({ status: "completed", value: "summary" }),
    );
  });

  test("llm_batched returns llm results in prompt order", async () => {
    await withBridge(
      async ({ host, calls }) => {
        const result = await host.runCell("m-1", {
          cellId: "llm-batched",
          code: "llm_batched(['first', 'second'])",
          timeoutMs: 15_000,
        });

        expect(result).toMatchObject({
          status: "completed",
          value: "['summary:first', 'summary:second']",
        });
        expect(calls).toHaveLength(2);
        expect(calls.every((call) => call.name === "llm")).toBe(true);
        expect(calls.map((call) => call.arguments.prompt).sort()).toEqual(["first", "second"]);
      },
      (call) =>
        Promise.resolve({
          status: "completed",
          value: `summary:${String(call.arguments.prompt)}`,
        }),
    );
  });

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
      const child = (kernel as unknown as { process?: ChildProcessWithoutNullStreams }).process;
      if (!child) throw new Error("expected a running Python process");
      child.stdin.write(
        `${JSON.stringify({ callId: "not-in-flight", status: "completed", value: "stray" })}\n`,
      );
      releaseCall.resolve();

      await expect(running).resolves.toMatchObject({
        status: "completed",
        value: "'real answer'",
      });
    } finally {
      releaseCall.resolve();
      kernel.close();
    }
  });

  test("parallel waits for other thunks before propagating an exception", async () => {
    const completed = deferred<void>();
    await withBridge(
      async ({ host, calls }) => {
        const result = await host.runCell("m-1", {
          cellId: "parallel-error",
          code: [
            "def fail():",
            "    raise ValueError('parallel boom')",
            "parallel([fail, lambda: tool.complete()])",
          ].join("\n"),
          timeoutMs: 15_000,
        });

        expect(result.status).toBe("raised");
        expect(result.status === "raised" && result.error).toContain("ValueError: parallel boom");
        expect(calls.map((call) => call.name)).toEqual(["complete"]);
        await completed.promise;
      },
      () => {
        completed.resolve();
        return Promise.resolve({ status: "completed", value: "done" });
      },
    );
  });

  test("a timeout SIGKILLs a cell with in-flight tool calls and consumes late rejection", async () => {
    const kernel = new PythonKernel();
    const callEntered = deferred<void>();
    const toolAnswer = deferred<Machine.ToolCallResult>();
    type KillSignal = Parameters<ChildProcessWithoutNullStreams["kill"]>[0];
    const signals: KillSignal[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    const rejectionEvents = process as unknown as {
      on(event: "unhandledRejection", listener: (error: unknown) => void): void;
      off(event: "unhandledRejection", listener: (error: unknown) => void): void;
    };
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
      const child = (kernel as unknown as { process?: ChildProcessWithoutNullStreams }).process;
      if (!child) throw new Error("expected a running Python process");
      const kill = child.kill.bind(child);
      child.kill = ((signal?: KillSignal) => {
        signals.push(signal);
        return kill(signal);
      }) as typeof child.kill;

      await expect(running).resolves.toEqual({ status: "timed_out", cellId: "timeout-in-flight" });
      expect(signals).toContain("SIGKILL");
      toolAnswer.reject(new Error("late tool failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      rejectionEvents.off("unhandledRejection", onUnhandled);
      toolAnswer.resolve({ status: "failed", error: "closed" });
      kernel.close();
    }
  });

  test("a tool the host refuses raises a catchable error and does not run", async () => {
    await withBridge(async ({ host, calls }) => {
      const result = await host.runCell("m-1", {
        cellId: "refused",
        code: [
          "try:",
          "    tool.not_offerable(x=1)",
          "    outcome = 'tool ran'",
          "except ToolError as error:",
          "    outcome = 'refused: ' + str(error)",
          "outcome",
        ].join("\n"),
        timeoutMs: 15_000,
      });

      expect(result).toMatchObject({
        status: "completed",
        value: "'refused: tool is not offerable: not_offerable'",
      });
      // The host saw the attempt and answered it; nothing executed on its side.
      expect(calls.map((call) => call.name)).toEqual(["not_offerable"]);
    });
  });

  test("a dotted tool name reaches the host under its canonical spelling", async () => {
    await withBridge(async ({ host, calls }) => {
      await host.runCell("m-1", {
        cellId: "dotted",
        code: "try:\n    tool['screen.capture'](region='full')\nexcept ToolError:\n    pass",
        timeoutMs: 15_000,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        name: "screen.capture",
        arguments: { region: "full" },
      });
    });
  });

  test("a tool that fails on the host surfaces the failure inside the cell", async () => {
    await withBridge(
      async ({ host }) => {
        const result = await host.runCell("m-1", {
          cellId: "failing",
          code: "tool.add(a=1, b=2)",
          timeoutMs: 15_000,
        });

        expect(result).toMatchObject({ status: "raised" });
        expect(result.status === "raised" && result.error).toContain("disk on fire");
      },
      () => Promise.resolve({ status: "failed", error: "disk on fire" }),
    );
  });

  test("a cell blocked on a slow tool still honours its deadline and recovers", async () => {
    await withBridge(
      async ({ host }) => {
        const blocked = await host.runCell("m-1", {
          cellId: "blocked",
          code: "tool.add(a=1, b=2)",
          timeoutMs: 800,
        });
        expect(blocked).toMatchObject({ status: "timed_out", cellId: "blocked" });

        // The interpreter was replaced while it sat inside a tool call; the
        // next cell must still get a working one.
        const next = await host.runCell("m-1", {
          cellId: "after",
          code: "'alive'",
          timeoutMs: 15_000,
        });
        expect(next).toMatchObject({ status: "completed", value: "'alive'" });
      },
      () => new Promise<Machine.ToolCallResult>(() => undefined),
    );
  });

  test("a duplicate in-flight cellId is refused with a typed error on a live connection", async () => {
    const path = socketPath();
    const host = await createMachineHost({
      socketPath: path,
      enrollment: () => ({
        name: "workstation",
        machineId: "m-1",
        allowedCapabilities: ["kernel.py"],
        enrolledAt: 1000,
      }),
      events: silent,
      now: () => 5000,
    });
    let announceFirst!: () => void;
    const firstReceived = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let runCellRequests = 0;
    const daemon = await connectIpcClient(path, {
      onRequest: async (method, params, respond) => {
        if (method !== Machine.WireMethod.RunCell) return;
        runCellRequests += 1;
        const request = Machine.CellRequest.parse(params);
        announceFirst();
        await firstBlocked;
        respond({
          status: "completed",
          cellId: request.cellId,
          output: { stdout: "", stderr: "" },
        });
      },
    });
    try {
      await typedCall(
        daemon,
        Machine.WireMethod.Attach,
        {
          machineId: "m-1",
          daemonVersion: "0.1.0",
          platform: "darwin",
          offeredCapabilities: ["kernel.py"],
          offeredAt: 2000,
        },
        5000,
      );
      const first = host.runCell("m-1", {
        cellId: "duplicate",
        code: "'first'",
        timeoutMs: 15_000,
      });
      await firstReceived;

      let duplicateError: unknown;
      try {
        await host.runCell("m-1", {
          cellId: "duplicate",
          code: "'second'",
          timeoutMs: 15_000,
        });
      } catch (error) {
        duplicateError = error;
      }
      expect(MachineCellError.isInstance(duplicateError)).toBe(true);
      if (!MachineCellError.isInstance(duplicateError)) {
        throw new Error("expected a typed duplicate-cell refusal");
      }
      expect(duplicateError.data).toMatchObject({
        code: "duplicate_cell_id",
        cellId: "duplicate",
      });
      expect(runCellRequests).toBe(1);

      releaseFirst();
      await expect(first).resolves.toMatchObject({ status: "completed", cellId: "duplicate" });
    } finally {
      releaseFirst();
      daemon.close();
      host.close();
    }
  });

  test("a connection that never attached cannot reach host tools", async () => {
    const path = socketPath();
    let reached = false;
    const host = await createMachineHost({
      socketPath: path,
      enrollment: () => ({
        name: "workstation",
        machineId: "m-1",
        allowedCapabilities: ["kernel.py"],
        enrolledAt: 1000,
      }),
      events: silent,
      now: () => 5000,
      callTool: () => {
        reached = true;
        return Promise.resolve({ status: "completed", value: "ran" });
      },
    });
    // A bare connection: no offer, no attach, straight to the tool channel.
    const intruder = await connectIpcClient(path, {});
    try {
      await expect(
        typedCall(
          intruder,
          Machine.WireMethod.CallTool,
          { cellId: "c", name: "add", arguments: {} },
          5000,
        ),
      ).rejects.toThrow("machine is not attached");
      expect(reached).toBe(false);
    } finally {
      intruder.close();
      host.close();
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
      const firstPending = kernel.run(
        { cellId: "one", code: "tool.slow()", timeoutMs: 100 },
        async () => {
          announceSlowCall();
          await slowCallBlocked;
          return { status: "completed", value: "stray" };
        },
      );
      await slowCallEntered;
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
      kernel.close();
    }
  });

  test("an attached daemon cannot invoke tools outside a cell the host dispatched", async () => {
    const path = socketPath();
    let reached = false;
    const host = await createMachineHost({
      socketPath: path,
      enrollment: () => ({
        name: "workstation",
        machineId: "m-1",
        allowedCapabilities: ["kernel.py"],
        enrolledAt: 1000,
      }),
      events: silent,
      now: () => 5000,
      callTool: () => {
        reached = true;
        return Promise.resolve({ status: "completed", value: "ran" });
      },
    });
    const client = await connectIpcClient(path, {});
    try {
      await typedCall(
        client,
        Machine.WireMethod.Attach,
        {
          machineId: "m-1",
          daemonVersion: "0.1.0",
          platform: "darwin",
          offeredCapabilities: ["kernel.py"],
          offeredAt: 2000,
        },
        5000,
      );
      // Attached, but this host never dispatched a cell called "ghost".
      // (See the sibling test for a cellId that WAS dispatched and settled.)
      await expect(
        typedCall(
          client,
          Machine.WireMethod.CallTool,
          { cellId: "ghost", name: "add", arguments: {} },
          5000,
        ),
      ).rejects.toThrow("no cell in flight: ghost");
      expect(reached).toBe(false);
    } finally {
      client.close();
      host.close();
    }
  });

  test("a cellId stops working the moment its cell settles", async () => {
    const path = socketPath();
    let reached = false;
    const host = await createMachineHost({
      socketPath: path,
      enrollment: () => ({
        name: "workstation",
        machineId: "m-1",
        allowedCapabilities: ["kernel.py"],
        enrolledAt: 1000,
      }),
      events: silent,
      now: () => 5000,
      callTool: () => {
        reached = true;
        return Promise.resolve({ status: "completed", value: "ran" });
      },
    });
    // A stand-in daemon: it answers RunCell itself, so the replay below comes
    // from the very connection the cell ran on — the only way to prove the
    // cell is retired rather than merely unknown to some other connection.
    const daemon = await connectIpcClient(path, {
      onRequest: (method, _params, respond) => {
        if (method === Machine.WireMethod.RunCell) {
          respond({
            status: "completed",
            cellId: "spent",
            output: { stdout: "", stderr: "" },
          });
        }
      },
    });
    try {
      await typedCall(
        daemon,
        Machine.WireMethod.Attach,
        {
          machineId: "m-1",
          daemonVersion: "0.1.0",
          platform: "darwin",
          offeredCapabilities: ["kernel.py"],
          offeredAt: 2000,
        },
        5000,
      );
      const cell = await host.runCell("m-1", {
        cellId: "spent",
        code: "'done'",
        timeoutMs: 15_000,
      });
      expect(cell).toMatchObject({ status: "completed" });

      // Same connection, same cellId — but the cell is over, so its name
      // buys nothing. This is what a background thread leaking a call after
      // its cell returned looks like from the host's side.
      await expect(
        typedCall(
          daemon,
          Machine.WireMethod.CallTool,
          { cellId: "spent", name: "add", arguments: {} },
          5000,
        ),
      ).rejects.toThrow("no cell in flight: spent");
      expect(reached).toBe(false);
    } finally {
      daemon.close();
      host.close();
    }
  });

  test("a superseded daemon loses tool access mid-cell without wedging it", async () => {
    const path = socketPath();
    let release: (value: unknown) => void = () => {
      return;
    };
    const firstCallBlocked = new Promise((resolve) => {
      release = resolve;
    });
    let announceEntered: (value: unknown) => void = () => {
      return;
    };
    const firstCallEntered = new Promise((resolve) => {
      announceEntered = resolve;
    });
    let calls = 0;
    const host = await createMachineHost({
      socketPath: path,
      enrollment: () => ({
        name: "workstation",
        machineId: "m-1",
        allowedCapabilities: ["kernel.py"],
        enrolledAt: 1000,
      }),
      events: silent,
      now: () => 5000,
      callTool: async () => {
        calls += 1;
        if (calls === 1) {
          announceEntered(null);
          await firstCallBlocked;
        }
        return { status: "completed", value: calls };
      },
    });
    const offer = {
      machineId: "m-1" as const,
      daemonVersion: "0.1.0",
      platform: "darwin",
      offeredCapabilities: ["kernel.py" as const],
      offeredAt: 2000,
    };
    const first = await attachMachineDaemon({ socketPath: path, offer });
    let second: Awaited<ReturnType<typeof attachMachineDaemon>> | undefined;
    try {
      const cell = host.runCell("m-1", {
        cellId: "live",
        code: [
          "a = tool.t()",
          "try:",
          "    b = tool.t()",
          "except ToolError as error:",
          "    b = 'lost'",
          "(a, b)",
        ].join("\n"),
        timeoutMs: 15_000,
      });

      // Take the machine over while the cell sits inside its first tool call.
      await firstCallEntered;
      second = await attachMachineDaemon({ socketPath: path, offer });
      release(null);

      // Being superseded revokes tools, but the cell still finishes on its
      // own terms instead of hanging on an answer that will never come.
      const result = await cell;
      expect(result).toMatchObject({ status: "completed", value: "(1, 'lost')" });
    } finally {
      first.close();
      second?.close();
      host.close();
    }
  });

  test("a host wired without a tool port says so instead of pretending", async () => {
    const path = socketPath();
    const host = await createMachineHost({
      socketPath: path,
      enrollment: () => ({
        name: "workstation",
        machineId: "m-1",
        allowedCapabilities: ["kernel.py"],
        enrolledAt: 1000,
      }),
      events: silent,
      now: () => 5000,
    });
    const daemon = await attachMachineDaemon({
      socketPath: path,
      offer: {
        machineId: "m-1",
        daemonVersion: "0.1.0",
        platform: "darwin",
        offeredCapabilities: ["kernel.py"],
        offeredAt: 2000,
      },
    });
    try {
      const result = await host.runCell("m-1", {
        cellId: "no-tools",
        code: "tool.add(a=1, b=2)",
        timeoutMs: 15_000,
      });

      expect(result).toMatchObject({ status: "raised" });
      expect(result.status === "raised" && result.error).toContain("this host exposes no tools");
    } finally {
      daemon.close();
      host.close();
    }
  });
});
