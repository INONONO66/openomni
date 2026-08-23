import { describe, expect, test } from "bun:test";
import { connectIpcClient, typedCall } from "@openomni/ipc";
import { Machine } from "@openomni/protocol";
import { attachMachineDaemon } from "../src/daemon";
import { type MachineHost, createMachineHost } from "../src/host";
import { PythonKernel } from "../src/kernel";

const silent = {
  publish() {
    return;
  },
};

let seq = 0;
const socketPath = () => `/tmp/omo-bridge-${process.pid}-${seq++}.sock`;

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
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { status: "completed", value: "too late" };
      },
    );
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
    // A cell can leave a tool call in flight by making it from a background
    // thread and returning first. The interpreter has one stdin channel, so
    // delivering that late answer while another cell owns the interpreter
    // would hand the successor a value it never asked for.
    const kernel = new PythonKernel();
    try {
      const first = await kernel.run(
        {
          cellId: "one",
          code: [
            "import threading, time",
            "threading.Thread(target=lambda: tool.slow(), daemon=True).start()",
            "time.sleep(0.2)",
            "'one done'",
          ].join("\n"),
          timeoutMs: 15_000,
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return { status: "completed", value: "stray" };
        },
      );
      expect(first).toMatchObject({ status: "completed", value: "'one done'" });

      // The successor settles on its own terms — never with "stray".
      const second = await kernel.run(
        { cellId: "two", code: "tool.mine()", timeoutMs: 2000 },
        async () => ({ status: "completed", value: "mine" }),
      );
      expect(second.cellId).toBe("two");
      expect(JSON.stringify(second)).not.toContain("stray");

      // And the kernel is still usable afterwards.
      const third = await kernel.run({ cellId: "three", code: "1 + 1", timeoutMs: 15_000 }, () =>
        Promise.resolve({ status: "failed", error: "no tools" }),
      );
      expect(third).toMatchObject({ status: "completed", value: "2" });
    } finally {
      kernel.close();
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
