import { describe, expect, test } from "bun:test";
import { statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("list preserves enrollment fields and stable handles route two attachments without rendering", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-routing-"));
    const data = Buffer.alloc(80_001, 255);
    writeFileSync(join(root, "data"), data);
    const a: Machine.Enrollment = {
      ...enrollment,
      machineId: "A",
      tags: ["fast", "local"],
      allowedCapabilities: ["fs.read", "kernel.py"],
      allowedExports: ["docs"],
    };
    const b: Machine.Enrollment = { ...a, machineId: "B", tags: ["other"] };
    try {
      await withHost(
        (id) => (id === "A" ? a : id === "B" ? b : undefined),
        async ({ host, path }) => {
          const first = host.get("A");
          expect(host.get("A")).toBe(first);
          const connect = (id: string) =>
            attachMachineDaemon({
              socketPath: path,
              offer: offer({
                machineId: id,
                offeredCapabilities: ["fs.read", "kernel.py"],
                exports: [{ name: "docs", path: root }],
              }),
              fsExports: new Map([["docs", root]]),
              runner: {
                runCode: async (request) => ({
                  status: "completed",
                  cellId: request.cellId,
                  value: id,
                  output: { stdout: "", stderr: "" },
                }),
                close: async () => undefined,
              },
            });
          const da = await connect("A");
          const db = await connect("B");
          try {
            expect(host.list()).toEqual(
              [a, b].map((entry) => ({
                ...entry,
                tags: entry.tags ?? [],
                capabilities: ["fs.read", "kernel.py"],
                os: "darwin",
                arch: "arm64",
              })),
            );
            host.list()[0]?.tags.push("mutated");
            expect(host.list()[0]?.tags).toEqual(["fast", "local"]);
            expect((await first.fs.read(join(root, "data"))).data).toEqual(data);
            const request = { cellId: "route", code: "value", timeoutMs: 1000 };
            const results = await Promise.all([
              first.runCode(request),
              host.get("B").runCode(request),
            ]);
            expect(results).toMatchObject([
              { status: "completed", value: "A" },
              { status: "completed", value: "B" },
            ]);
          } finally {
            await da.close();
            await db.close();
          }
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
        expect(host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities).toEqual(
          ["fs.read"],
        );
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
        expect(
          host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities,
        ).toBeUndefined();
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
        expect(
          host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities,
        ).toBeUndefined();
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
        expect(host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities).toEqual(
          ["shell.exec"],
        );
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

  test("daemon rejects host requests outside its wire contract", async () => {
    const path = socketPath();
    const rogue = await createIpcServer(path, (_method, _params, respond) => {
      respond({ status: "attached", effectiveCapabilities: [], effectiveExports: [] });
    });
    try {
      const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
      try {
        await expect(rogue.call("machine.unknown", {})).rejects.toBeInstanceOf(IpcRemoteError);
      } finally {
        daemon.close();
      }
    } finally {
      rogue.close();
    }
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
