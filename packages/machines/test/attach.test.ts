import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { IpcRemoteError, connectIpcClient, createIpcServer } from "@openomni/ipc";
import type { BusEvent, Machine } from "@openomni/protocol";
import { attachMachineDaemon } from "../src/daemon";
import { type MachineHost, createMachineHost } from "../src/host";
import { socketPath } from "./helpers/socket-path";

interface RecordedEvent {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

function eventCollector() {
  const events: RecordedEvent[] = [];
  const waiters: Array<{ name: string; resolve: (event: RecordedEvent) => void }> = [];
  const sink: BusEvent.Sink = {
    publish(descriptor, payload) {
      const event = { name: descriptor.name, payload: payload as Record<string, unknown> };
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (waiter && waiter.name === event.name) {
          waiters.splice(i, 1);
          waiter.resolve(event);
        }
      }
    },
  };
  return {
    sink,
    events,
    /** Resolves on the NEXT event of this name (bounded by bun's test timeout). */
    next(name: string): Promise<RecordedEvent> {
      return new Promise((resolve) => {
        waiters.push({ name, resolve });
      });
    },
  };
}

const enrollment: Machine.Enrollment = {
  name: "studio",
  machineId: "mac-studio",
  allowedCapabilities: ["fs.read", "shell.exec"],
  enrolledAt: 1000,
};

function offer(overrides: Partial<Machine.Offer> = {}): Machine.Offer {
  return {
    machineId: "mac-studio",
    daemonVersion: "0.0.1",
    platform: "darwin-arm64",
    offeredCapabilities: ["fs.read", "browser.control"],
    offeredAt: 2000,
    ...overrides,
  };
}

async function withHost(
  resolve: (machineId: Machine.MachineId) => Machine.Enrollment | undefined,
  run: (context: {
    host: MachineHost;
    path: string;
    collector: ReturnType<typeof eventCollector>;
  }) => Promise<void>,
): Promise<void> {
  const collector = eventCollector();
  const path = socketPath();
  const host = await createMachineHost({
    socketPath: path,
    enrollment: resolve,
    events: collector.sink,
    now: () => 5000,
  });
  try {
    await run({ host, path, collector });
  } finally {
    host.close();
  }
}

describe("machine attach handshake", () => {
  test("enrolled daemon attaches with the enrollment∩offer effective set and the attached event", async () => {
    await withHost(
      () => enrollment,
      async ({ host, path, collector }) => {
        const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
        expect(daemon.attachment).toEqual({
          status: "attached",
          effectiveCapabilities: ["fs.read"],
          effectiveExports: [],
        });
        expect(host.attached("mac-studio")).toEqual(["fs.read"]);
        expect(collector.events).toEqual([
          {
            name: "machine.attached",
            payload: { machineId: "mac-studio", time: 5000, effectiveCapabilities: ["fs.read"] },
          },
        ]);
        daemon.close();
      },
    );
  });

  test("unknown machine is refused machine_not_enrolled and never attaches", async () => {
    await withHost(
      () => undefined,
      async ({ host, path, collector }) => {
        const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
        expect(daemon.attachment).toEqual({ status: "refused", reason: "machine_not_enrolled" });
        expect(host.attached("mac-studio")).toBeUndefined();
        expect(collector.events).toEqual([]);
        daemon.close();
      },
    );
  });

  test("a resolver answering with another machine's enrollment is refused machine_mismatch", async () => {
    await withHost(
      () => ({ ...enrollment, machineId: "other-box" }),
      async ({ path, collector }) => {
        const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
        expect(daemon.attachment).toEqual({ status: "refused", reason: "machine_mismatch" });
        expect(collector.events).toEqual([]);
        daemon.close();
      },
    );
  });

  test("a malformed offer is a remote protocol error, not a refusal", async () => {
    await withHost(
      () => enrollment,
      async ({ path }) => {
        const client = await connectIpcClient(path);
        try {
          await expect(
            client.call("machine.attach", { machineId: "mac-studio" }),
          ).rejects.toBeInstanceOf(IpcRemoteError);
          expect(await client.call("machine.attach", offer())).toEqual({
            status: "attached",
            effectiveCapabilities: ["fs.read"],
            effectiveExports: [],
          });
        } finally {
          client.close();
        }
      },
    );
  });

  test("daemon disconnect publishes machine.detached with connection_closed", async () => {
    await withHost(
      () => enrollment,
      async ({ host, path, collector }) => {
        const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
        const detached = collector.next("machine.detached");
        daemon.close();
        expect((await detached).payload).toEqual({
          machineId: "mac-studio",
          time: 5000,
          reason: "connection_closed",
        });
        expect(host.attached("mac-studio")).toBeUndefined();
      },
    );
  });

  test("re-attach over a new connection supersedes the stale attachment", async () => {
    await withHost(
      () => enrollment,
      async ({ host, path, collector }) => {
        const first = await attachMachineDaemon({ socketPath: path, offer: offer() });
        const superseded = collector.next("machine.detached");
        const second = await attachMachineDaemon({
          socketPath: path,
          offer: offer({ offeredCapabilities: ["shell.exec"] }),
        });
        expect((await superseded).payload).toEqual({
          machineId: "mac-studio",
          time: 5000,
          reason: "superseded_by_reattach",
        });
        expect(second.attachment).toEqual({
          status: "attached",
          effectiveCapabilities: ["shell.exec"],
          effectiveExports: [],
        });
        expect(host.attached("mac-studio")).toEqual(["shell.exec"]);
        second.close();
        first.close();
      },
    );
  });

  test("host socket is owner-only — the localhost trust boundary is real", async () => {
    await withHost(
      () => enrollment,
      async ({ path }) => {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      },
    );
  });

  test("daemon refuses a host reply that violates Machine.AttachResult", async () => {
    const path = socketPath();
    const rogue = await createIpcServer(path, (_method, _params, respond) => {
      respond({ status: "bogus" });
    });
    try {
      await expect(attachMachineDaemon({ socketPath: path, offer: offer() })).rejects.toMatchObject(
        { name: "ZodError" },
      );
    } finally {
      rogue.close();
    }
  });
});
