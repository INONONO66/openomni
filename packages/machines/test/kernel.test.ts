import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { BusEvent, Machine } from "@openomni/protocol";
import { attachMachineDaemon } from "../src/daemon";
import { type MachineHost, createMachineHost } from "../src/host";
import { type CellToolCaller, PythonKernel } from "../src/kernel";
import { plainLauncher, testProfile } from "./helpers/plain-launcher";
import { socketPath } from "./helpers/socket-path";

/** These cells call no tools, so a call is a test bug and must be visible. */
const noTools: CellToolCaller = (call) =>
  Promise.resolve({ status: "failed", error: `unexpected tool call: ${call.name}` });

let cellCounter = 0;

// These tests assert cell execution, not attach telemetry.
const silent: BusEvent.Sink = {
  publish() {
    return;
  },
};

const enrollment: Machine.Enrollment = {
  name: "studio",
  machineId: "mac-studio",
  allowedCapabilities: ["kernel.py", "sandbox.process", "fs.read"],
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
  callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>,
): Promise<void> {
  const path = socketPath();
  const host = await createMachineHost({
    socketPath: path,
    enrollment: () => enrollment,
    events: silent,
    now: () => 5000,
    callTool,
  });
  const daemon = await attachMachineDaemon({
    socketPath: path,
    offer: offer(capabilities),
    sandbox: testProfile(),
  });
  try {
    await run({ host });
  } finally {
    daemon.close();
    host.close();
  }
}

function cell(code: string, timeoutMs = 15_000): Machine.CellRequest {
  cellCounter += 1;
  return { cellId: `cell-${cellCounter}-${code.length}`, code, timeoutMs };
}

describe("cell settlement ownership", () => {
  test.each([
    ["stdout", "print('x' * 2048)"],
    ["stderr", "import sys\nsys.stderr.write('x' * 2048)"],
    ["value", "'x' * 2048"],
    ["error", "raise ValueError('x' * 2048)"],
    ["raw driver frame", "import sys\nsys.__stdout__.write('x' * 2048)\nsys.__stdout__.flush()"],
  ])("%s over the configured byte limit replaces the interpreter", async (_path, code) => {
    // Given: a real public Python kernel with state and a 1024-byte cell output ceiling.
    const kernel = new PythonKernel({ launch: plainLauncher, maxOutputBytes: 1024 });
    try {
      await expect(
        kernel.run(
          { cellId: "before-output-limit", code: "persisted = 42", timeoutMs: 1_000 },
          noTools,
        ),
      ).resolves.toMatchObject({ status: "completed" });

      // When: one cell writes more than the configured limit.
      const limited = await kernel.run({ cellId: "output-limit", code, timeoutMs: 1_000 }, noTools);

      // Then: no oversized bytes return and the unsafe interpreter state is replaced.
      expect(limited).toEqual({
        status: "raised",
        cellId: "output-limit",
        output: { stdout: "", stderr: "" },
        error: "cell output exceeded maxOutputBytes",
      });
      await expect(
        kernel.run({ cellId: "after-output-limit", code: "persisted", timeoutMs: 1_000 }, noTools),
      ).resolves.toMatchObject({ status: "raised" });
    } finally {
      kernel.close();
    }
  });

  test("a queued cell times out from its enqueue deadline without replacing the interpreter", async () => {
    const kernel = new PythonKernel({ launch: plainLauncher });
    try {
      const first = kernel.run(
        {
          cellId: "blocking",
          code: "value = 42\nimport time\ntime.sleep(0.08)",
          timeoutMs: 1_000,
        },
        noTools,
      );
      const queued = kernel.run({ cellId: "queued", code: "value = 99", timeoutMs: 5 }, noTools);

      expect(await first).toMatchObject({ status: "completed", cellId: "blocking" });
      expect(await queued).toMatchObject({ status: "timed_out", cellId: "queued" });
      // The queued timeout never ran, so it must not discard the persistent interpreter.
      await expect(
        kernel.run({ cellId: "after-queue", code: "value", timeoutMs: 1_000 }, noTools),
      ).resolves.toMatchObject({
        status: "completed",
        cellId: "after-queue",
        value: "42",
      });
    } finally {
      kernel.close();
    }
  });

  test("a replaced interpreter's exit never settles its successor's cell", async () => {
    // Queued in the same microtask as the timing-out cell, so the successor is
    // already pending when the killed interpreter's exit event lands. That is
    // the interleaving where a process that settles "whatever is pending"
    // instead of "its own cell" rejects work it never ran.
    const kernel = new PythonKernel({ launch: plainLauncher });
    try {
      const [timedOut, successor] = await Promise.all([
        kernel.run(
          {
            cellId: "wedged",
            code: "import time\nwhile True: time.sleep(0.05)",
            timeoutMs: 700,
          },
          noTools,
        ),
        kernel.run({ cellId: "successor", code: "6 * 7", timeoutMs: 15_000 }, noTools),
      ]);

      expect(timedOut).toMatchObject({ status: "timed_out", cellId: "wedged" });
      expect(successor).toMatchObject({ status: "completed", cellId: "successor", value: "42" });
    } finally {
      kernel.close();
    }
  });
});

describe.skipIf(
  (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) &&
    process.env.OPENOMNI_REQUIRE_SANDBOX_TESTS !== "1",
)("code-mode kernel substrate", () => {
  test("invalid driver output replaces the interpreter", async () => {
    const kernel = new PythonKernel({ launch: plainLauncher });
    try {
      await expect(
        kernel.run(
          { cellId: "before-invalid-driver-output", code: "persisted = 42", timeoutMs: 1_000 },
          noTools,
        ),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        kernel.run(
          {
            cellId: "invalid-driver-output",
            code: "import sys\nsys.__stdout__.write('not-json\\n')\nsys.__stdout__.flush()",
            timeoutMs: 1_000,
          },
          noTools,
        ),
      ).rejects.toBeInstanceOf(SyntaxError);
      await expect(
        kernel.run(
          { cellId: "after-invalid-driver-output", code: "persisted", timeoutMs: 1_000 },
          noTools,
        ),
      ).resolves.toMatchObject({ status: "raised" });
    } finally {
      kernel.close();
    }
  });

  test("an unserializable tool answer rejects the owning cell", async () => {
    const kernel = new PythonKernel({ launch: plainLauncher });
    try {
      await expect(
        kernel.run({ cellId: "unserializable-answer", code: "tool.test()", timeoutMs: 1_000 }, () =>
          Promise.resolve({ status: "completed", value: 1n }),
        ),
      ).rejects.toBeInstanceOf(TypeError);
    } finally {
      kernel.close();
    }
  });

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
      // The traceback belongs to the caller's cell; the driver frame that ran it
      // is an implementation detail and must not surface in the reported error.
      expect(result.error).toContain("<cell ");
      expect(result.error).not.toContain("exec(compile(");
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
