import { describe, expect, test } from "bun:test";
import { statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcRemoteError, connectIpcClient, createIpcServer } from "@openomni/ipc";
import type { BusEvent, Machine } from "@openomni/protocol";
import { attachMachineDaemon, type CodeRunner } from "../src/daemon";
import { type MachineHost, createMachineHost } from "../src/host";
import { socketPath } from "./helpers/socket-path";
import { MachineCellError } from "../src/errors";
import { kernelEnrollment } from "./helpers";

type RecordedEvent<T> = {
  readonly name: string;
  readonly payload: T;
};

function eventCollector() {
  const events: RecordedEvent<unknown>[] = [];
  const waiters: Array<{ name: string; resolve: (event: RecordedEvent<unknown>) => void }> = [];
  const sink: BusEvent.Sink = {
    publish(descriptor, payload) {
      const event = { name: descriptor.name, payload };
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
    next(name: string): Promise<RecordedEvent<unknown>> {
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

/** A daemon offering only the kernel capability, backed by a partial code runner. */
function attachKernel(path: string, runner: Pick<CodeRunner, "runCode"> & Partial<CodeRunner>) {
  return attachMachineDaemon({
    socketPath: path,
    offer: offer({ offeredCapabilities: ["kernel.py"] }),
    runner: { peekCode: () => undefined, close: async () => undefined, ...runner },
  });
}

async function withHost(
  resolve: (machineId: Machine.MachineId) => Machine.Enrollment | undefined,
  run: (context: {
    host: MachineHost;
    path: string;
    collector: ReturnType<typeof eventCollector>;
  }) => Promise<void>,
  callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>,
): Promise<void> {
  const collector = eventCollector();
  const path = socketPath();
  const host = await createMachineHost({
    socketPath: path,
    enrollment: resolve,
    events: collector.sink,
    now: () => 5000,
    callTool,
  });
  try {
    await run({ host, path, collector });
  } finally {
    host.close();
  }
}

describe("machine attach handshake", () => {
  test("rejects unaffiliated tool calls and unknown methods at the host boundary", async () => {
    await withHost(
      () => enrollment,
      async ({ path }) => {
        const client = await connectIpcClient(path);
        try {
          for (const [method, params] of [
            ["machine.call_tool", { cellId: "unknown", name: "tool", arguments: {} }],
            ["machine.unknown", {}],
          ] as const) {
            await expect(client.call(method, params)).rejects.toBeInstanceOf(IpcRemoteError);
          }
        } finally {
          client.close();
        }
      },
    );
  });

  test("returns no-tools failure for a real in-flight cell and refuses duplicate ids", async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    await withHost(
      () => kernelEnrollment(enrollment),
      async ({ host, path }) => {
        const daemon = await attachKernel(path, {
          runCode: async (request, call) => {
            const answer = await call({ cellId: request.cellId, name: "missing", arguments: {} });
            expect(answer).toMatchObject({ status: "failed" });
            entered.resolve();
            await finish.promise;
            return {
              status: "cancelled",
              cellId: request.cellId,
              output: { stdout: "", stderr: "" },
            };
          },
        });
        const cell = { cellId: "same", code: "x", timeoutMs: 1000 };
        try {
          const handle = host.get("mac-studio");
          const running = handle.runCode(cell);
          await entered.promise;
          const duplicate = await handle.runCode(cell).catch((error: unknown) => error);
          expect(MachineCellError.isInstance(duplicate)).toBe(true);
          expect(duplicate).toMatchObject({
            name: "MachineCellError",
            data: { code: "duplicate_cell_id", cellId: cell.cellId },
          });
          finish.resolve();
          expect((await running).status).toBe("cancelled");
          expect(await handle.runCode(cell, AbortSignal.abort())).toEqual({
            status: "cancelled",
            cellId: cell.cellId,
            output: { stdout: "", stderr: "" },
          });
        } finally {
          finish.resolve();
          await daemon.close();
        }
      },
    );
  });

  test("rejects mismatched filesystem replies and propagates wire cancellation failures", async () => {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    await withHost(
      () => ({ ...enrollment, allowedExports: ["docs"] }),
      async ({ host, path }) => {
        const client = await connectIpcClient(path, {
          onRequest: async (method, params, respond) => {
            if (method === "machine.fs_op") {
              respond({
                status: "completed",
                value: { op: "list", entries: [], truncated: false },
              });
            } else if (method === "machine.cancel_code") {
              cancelled.resolve();
              throw new Error("cancel rejected by peer");
            } else {
              started.resolve();
              await cancelled.promise;
              respond({
                status: "cancelled",
                cellId: params?.cellId,
                output: { stdout: "", stderr: "" },
              });
            }
          },
        });
        try {
          await client.call("machine.attach", offer({ exports: [{ name: "docs", path: "/" }] }));
          const handle = host.get("mac-studio");
          await expect(handle.fs.stat("/file")).rejects.toMatchObject({
            name: "MachineRefusalError",
            data: { reason: "invalid_response" },
          });
          const controller = new AbortController();
          const running = handle.runCode(
            { cellId: "cancel", code: "x", timeoutMs: 1000 },
            controller.signal,
          );
          const outcome = running.catch((error: unknown) => error);
          await started.promise;
          controller.abort();
          expect(await outcome).toBeInstanceOf(IpcRemoteError);
        } finally {
          client.close();
        }
      },
    );
  });

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
                peekCode: () => undefined,
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

  test("peekCode answers not-running locally for an unknown cell and forwards a live one to the daemon", async () => {
    let releaseCell!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseCell = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const peeked: string[] = [];
    await withHost(
      () => ({ ...enrollment, allowedCapabilities: ["kernel.py"] }),
      async ({ host, path }) => {
        const daemon = await attachKernel(path, {
          runCode: async (request) => {
            entered();
            await held;
            return {
              status: "completed",
              cellId: request.cellId,
              output: { stdout: "done\n", stderr: "" },
            };
          },
          peekCode: (cellId) => {
            peeked.push(cellId);
            return { stdout: "so far\n", stderr: "warn\n" };
          },
        });
        try {
          const handle = host.get("mac-studio");
          // Not in flight: answered by the host without a wire round trip.
          expect(await handle.peekCode("nobody")).toEqual({
            running: false,
            output: { stdout: "", stderr: "" },
          });
          expect(peeked).toEqual([]);
          const running = handle.runCode({ cellId: "live", code: "x", timeoutMs: 5000 });
          await started;
          expect(await handle.peekCode("live")).toEqual({
            running: true,
            output: { stdout: "so far\n", stderr: "warn\n" },
          });
          expect(peeked).toEqual(["live"]);
          releaseCell();
          expect(await running).toMatchObject({ status: "completed", cellId: "live" });
          expect(await handle.peekCode("live")).toEqual({
            running: false,
            output: { stdout: "", stderr: "" },
          });
          expect(peeked).toEqual(["live"]);
        } finally {
          releaseCell();
          await daemon.close();
        }
      },
    );
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

  test("daemon relays a cell's tool call to the host and cancels the cell on the wire", async () => {
    const calls: Machine.ToolCall[] = [];
    const relayed = Promise.withResolvers<void>();
    await withHost(
      () => kernelEnrollment(enrollment),
      async ({ host, path }) => {
        const daemon = await attachKernel(path, {
          runCode: async (request, call, signal) => {
            const answer = await call({ cellId: request.cellId, name: "answer", arguments: {} });
            // The abort may already have landed while the tool answer was in flight.
            if (!signal.aborted)
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
            return {
              status: "cancelled",
              cellId: request.cellId,
              output: { stdout: JSON.stringify(answer), stderr: "" },
            };
          },
        });
        try {
          const controller = new AbortController();
          const running = host
            .get("mac-studio")
            .runCode({ cellId: "relay", code: "x", timeoutMs: 5000 }, controller.signal);
          await relayed.promise;
          expect(calls).toEqual([{ cellId: "relay", name: "answer", arguments: {} }]);
          controller.abort();
          expect(await running).toEqual({
            status: "cancelled",
            cellId: "relay",
            output: { stdout: '{"status":"completed","value":42}', stderr: "" },
          });
        } finally {
          await daemon.close();
        }
      },
      async (call) => {
        calls.push(call);
        relayed.resolve();
        return { status: "completed", value: 42 };
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
