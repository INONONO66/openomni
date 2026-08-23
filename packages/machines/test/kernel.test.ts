import { describe, expect, test } from "bun:test";
import type { BusEvent, Machine } from "@openomni/protocol";
import { attachMachineDaemon } from "../src/daemon";
import { type MachineHost, createMachineHost } from "../src/host";

let socketCounter = 0;
function socketPath(): string {
  socketCounter += 1;
  return `/tmp/omo-kernel-${process.pid}-${socketCounter}.sock`;
}

// These tests assert cell execution, not attach telemetry.
const silent: BusEvent.Sink = {
  publish() {
    return;
  },
};

const enrollment: Machine.Enrollment = {
  name: "studio",
  machineId: "mac-studio",
  allowedCapabilities: ["kernel.py", "fs.read"],
  enrolledAt: 1000,
};

function offer(capabilities: readonly Machine.CapabilityId[]): Machine.Offer {
  return {
    machineId: "mac-studio",
    daemonVersion: "0.0.1",
    platform: "darwin-arm64",
    offeredCapabilities: [...capabilities],
    offeredAt: 2000,
  };
}

/**
 * Real host + real daemon over a real unix socket. The daemon runs a real
 * python3 interpreter — these are integration tests of the kernel substrate,
 * so nothing about the transport or the interpreter is mocked.
 */
async function withMachine(
  capabilities: readonly Machine.CapabilityId[],
  run: (context: { host: MachineHost }) => Promise<void>,
): Promise<void> {
  const path = socketPath();
  const host = await createMachineHost({
    socketPath: path,
    enrollment: () => enrollment,
    events: silent,
    now: () => 5000,
  });
  const daemon = await attachMachineDaemon({ socketPath: path, offer: offer(capabilities) });
  try {
    await run({ host });
  } finally {
    daemon.close();
    host.close();
  }
}

function cell(code: string, timeoutMs = 15_000): Machine.CellRequest {
  return { cellId: `cell-${socketCounter}-${code.length}`, code, timeoutMs };
}

describe("code-mode kernel substrate", () => {
  test("interpreter state persists across cells in one attachment", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const first = await host.runCell("mac-studio", cell("value = 6 * 7"));
      expect(first.status).toBe("completed");

      const second = await host.runCell("mac-studio", cell("value"));
      expect(second).toMatchObject({ status: "completed", value: "42" });
    });
  });

  test("a raise reports raised with the output produced before it", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const result = await host.runCell(
        "mac-studio",
        cell("print('before the raise')\nraise ValueError('boom')"),
      );

      expect(result.status).toBe("raised");
      if (result.status !== "raised") throw new Error("expected raised");
      expect(result.output.stdout).toContain("before the raise");
      expect(result.error).toContain("ValueError: boom");
    });
  });

  test("a cell over its deadline is timed_out and the next cell still runs", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const timedOut = await host.runCell(
        "mac-studio",
        cell("import time\nwhile True: time.sleep(0.05)", 750),
      );
      expect(timedOut).toMatchObject({ status: "timed_out" });

      // Forward progress is the guarantee: the replacement interpreter serves
      // the next cell. Prior state is gone, which is the documented tradeoff.
      const next = await host.runCell("mac-studio", cell("1 + 1"));
      expect(next).toMatchObject({ status: "completed", value: "2" });
      // The replacement interpreter starts clean — the documented tradeoff.
      const lost = await host.runCell("mac-studio", cell("'time' in dir()"));
      expect(lost).toMatchObject({ status: "completed", value: "False" });
    });
  });

  test("stdout and stderr are both captured on a completed cell", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const result = await host.runCell(
        "mac-studio",
        cell("import sys\nprint('out')\nprint('err', file=sys.stderr)"),
      );

      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("expected completed");
      expect(result.output).toEqual({ stdout: "out\n", stderr: "err\n" });
    });
  });

  test("a statement-only cell completes with no value", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const result = await host.runCell("mac-studio", cell("x = 1"));

      expect(result).toMatchObject({
        status: "completed",
        output: { stdout: "", stderr: "" },
      });
      if (result.status !== "completed") throw new Error("expected completed");
      expect(result.value).toBeUndefined();
    });
  });

  test("a machine attached without kernel.py is refused, not executed", async () => {
    await withMachine(["fs.read"], async ({ host }) => {
      const result = await host.runCell("mac-studio", cell("print('should not run')"));

      expect(result).toEqual({ status: "refused", reason: "kernel_not_available" });
    });
  });

  test("an unattached machine is refused", async () => {
    const path = socketPath();
    const host = await createMachineHost({
      socketPath: path,
      enrollment: () => enrollment,
      events: silent,
      now: () => 5000,
    });
    try {
      const result = await host.runCell("mac-mini", cell("1"));

      expect(result).toEqual({ status: "refused", reason: "machine_not_attached" });
    } finally {
      host.close();
    }
  });
});
