import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connectIpcClient, typedCall } from "@openomni/ipc";
import type { BusEvent, Machine } from "@openomni/protocol";
import { attachMachineDaemon } from "../src/daemon";
import { createMachineHost } from "../src/host";
import { PYTHON_DRIVER, PythonKernel } from "../src/kernel";
import { probeSandbox, sandboxedLauncher } from "../src/launcher";
import { socketPath } from "./helpers/socket-path";
import { testProfile } from "./helpers/plain-launcher";

const sandboxRequired = process.env.OPENOMNI_REQUIRE_SANDBOX_TESTS === "1";
const sandboxSupported = process.platform === "linux" && existsSync("/usr/bin/bwrap");
const linuxSandboxTest = test.skipIf(!sandboxSupported && !sandboxRequired);
const silent: BusEvent.Sink = {
  publish() {
    return;
  },
};
const noTools = (): Promise<Machine.ToolCallResult> =>
  Promise.resolve({ status: "failed", error: "unexpected tool call" });

function tenantWorkspace(tenant: string): string {
  return join(testProfile().workspaceRoot, createHash("sha256").update(tenant).digest("hex"));
}

linuxSandboxTest(
  "probe proves writable workspace, read-only host paths, and denied networking",
  async () => {
    // Given: the same real bubblewrap profile CI uses for machine cells.
    const profile = testProfile();

    // When: the daemon preflight executes all confinement probes.
    const result = await probeSandbox(profile);

    // Then: the profile is offerable only after every probe succeeds.
    expect(result).toMatchObject({ ok: true });
  },
);

linuxSandboxTest("a sandboxed cell writes only through its tenant workspace", async () => {
  // Given: a real bubblewrap launcher and a tenant-bound persistent kernel.
  const profile = testProfile();
  const kernel = new PythonKernel({
    launch: () => sandboxedLauncher(profile, PYTHON_DRIVER)("tenant-write"),
  });
  try {
    // When: the cell writes under /workspace.
    const result = await kernel.run(
      {
        cellId: "workspace-write",
        code: "from pathlib import Path\nPath('/workspace/x').write_text('inside')",
        timeoutMs: 15_000,
      },
      noTools,
    );

    // Then: the write is visible only in that tenant's bound host directory.
    expect(result.status).toBe("completed");
    expect(readFileSync(join(tenantWorkspace("tenant-write"), "x"), "utf8")).toBe("inside");
  } finally {
    kernel.close();
  }
});

linuxSandboxTest("a sandboxed cell cannot write to a read-only host path", async () => {
  // Given: /usr is present in the profile as a read-only bind.
  const profile = testProfile();
  const kernel = new PythonKernel({
    launch: () => sandboxedLauncher(profile, PYTHON_DRIVER)("readonly-write"),
  });
  const hostPath = `/usr/openomni-sandbox-${process.pid}`;
  try {
    // When: Python attempts a host-path side effect outside /workspace.
    const result = await kernel.run(
      {
        cellId: "readonly-write",
        code: `from pathlib import Path\nPath(${JSON.stringify(hostPath)}).write_text('escaped')`,
        timeoutMs: 15_000,
      },
      noTools,
    );

    // Then: the cell raises and the host side effect does not exist.
    expect(result.status).toBe("raised");
    expect(existsSync(hostPath)).toBe(false);
  } finally {
    kernel.close();
  }
});

linuxSandboxTest("a sandboxed cell cannot open a network connection", async () => {
  // Given: bubblewrap unshares every namespace, including networking.
  const profile = testProfile();
  const kernel = new PythonKernel({
    launch: () => sandboxedLauncher(profile, PYTHON_DRIVER)("network-denied"),
  });
  try {
    // When: the cell tries to connect through a socket.
    const result = await kernel.run(
      {
        cellId: "network-denied",
        code: "import socket\ntry:\n socket.create_connection(('127.0.0.1', 9), 1)\n denied = False\nexcept OSError:\n denied = True\ndenied",
        timeoutMs: 15_000,
      },
      noTools,
    );

    // Then: the isolated network namespace refuses the connection.
    expect(result).toMatchObject({ status: "completed", value: "True" });
  } finally {
    kernel.close();
  }
});

linuxSandboxTest("timing out a cell kills bubblewrap and its child process tree", async () => {
  // Given: a launcher whose exact exit event and a spawned child pid are observable.
  const profile = testProfile();
  let sandboxExit: Promise<void> | undefined;
  let childPid: number | undefined;
  const kernel = new PythonKernel({
    launch: () => {
      const child = sandboxedLauncher(profile, PYTHON_DRIVER)("timeout-tree");
      sandboxExit = new Promise((resolve) => child.once("exit", () => resolve()));
      return child;
    },
  });
  try {
    // When: the cell starts a child, signals readiness, and exceeds its deadline.
    const result = await kernel.run(
      {
        cellId: "timeout-tree",
        code: "import subprocess\nchild = subprocess.Popen(['/bin/sleep', '30'])\ntool.ready(pid=child.pid)\nchild.wait()",
        timeoutMs: 1_000,
      },
      (call) => {
        const pid = call.arguments.pid;
        if (typeof pid === "number") childPid = pid;
        return Promise.resolve({ status: "completed" });
      },
    );
    expect(result.status).toBe("timed_out");
    const exit = sandboxExit;
    if (exit === undefined) throw new Error("sandbox process was not launched");
    await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("sandbox did not exit after timeout")), 5_000),
      ),
    ]);

    // Then: neither the namespace init nor the subprocess survives.
    expect(childPid).toBeNumber();
    expect(existsSync(`/proc/${String(childPid)}`)).toBe(false);
  } finally {
    kernel.close();
  }
});

test("host refuses kernel-only attachments with isolation_unavailable", async () => {
  // Given: a raw attached peer claims kernel.py but no sandbox.process.
  const path = socketPath();
  const host = await createMachineHost({
    socketPath: path,
    enrollment: () => ({
      machineId: "m-1",
      name: "machine",
      allowedCapabilities: ["kernel.py", "sandbox.process"],
      enrolledAt: 1,
    }),
    events: silent,
    now: () => 2,
  });
  const peer = await connectIpcClient(path);
  try {
    await typedCall(peer, "machine.attach", {
      machineId: "m-1",
      offeredCapabilities: ["kernel.py"],
      daemonVersion: "test",
      platform: process.platform,
      offeredAt: 2,
    });

    // When: the caller asks that kernel-only attachment to execute a cell.
    const result = await host.runCell("m-1", { cellId: "c-1", code: "1", timeoutMs: 1_000 });

    // Then: the user surface returns a typed isolation refusal without a wire execution.
    expect(result).toEqual({ status: "refused", reason: "isolation_unavailable" });
  } finally {
    peer.close();
    host.close();
  }
});

test.skipIf(process.platform === "linux")(
  "unsupported daemons remove both execution capabilities and expose the typed probe refusal",
  async () => {
    // Given: this host cannot run the Linux-only bubblewrap backend.
    const path = socketPath();
    const host = await createMachineHost({
      socketPath: path,
      enrollment: () => ({
        machineId: "m-1",
        name: "machine",
        allowedCapabilities: ["kernel.py", "sandbox.process"],
        enrolledAt: 1,
      }),
      events: silent,
      now: () => 2,
    });
    const daemon = await attachMachineDaemon({
      socketPath: path,
      offer: {
        machineId: "m-1",
        offeredCapabilities: ["kernel.py"],
        daemonVersion: "test",
        platform: process.platform,
        offeredAt: 2,
      },
      sandbox: testProfile(),
    });
    try {
      // When: attachment completes after the mandatory sandbox probe.
      // Then: execution is absent and the daemon reports why it failed closed.
      expect(daemon.sandbox.ok).toBe(false);
      expect(daemon.attachment).toEqual({
        status: "attached",
        effectiveCapabilities: [],
        effectiveExports: [],
      });
      expect(host.attached("m-1")).toEqual([]);
    } finally {
      daemon.close();
      host.close();
    }
  },
);
