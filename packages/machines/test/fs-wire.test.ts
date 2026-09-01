import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectIpcClient, createIpcServer, typedCall } from "@openomni/ipc";
import type { BusEvent, Machine } from "@openomni/protocol";
import { attachMachineDaemon } from "../src/daemon";
import { type MachineHost, createMachineHost } from "../src/host";
import { socketPath } from "./helpers/socket-path";

// These tests assert the fs wire surface, not attach telemetry.
const silent: BusEvent.Sink = {
  publish() {
    return;
  },
};

function enrollment(overrides: Partial<Machine.Enrollment> = {}): Machine.Enrollment {
  return {
    name: "workstation",
    machineId: "m-1",
    allowedCapabilities: ["fs.read"],
    allowedExports: ["docs"],
    enrolledAt: 1000,
    ...overrides,
  };
}

function offer(overrides: Partial<Machine.Offer> = {}): Machine.Offer {
  return {
    machineId: "m-1",
    daemonVersion: "0.1.0",
    platform: "darwin",
    offeredCapabilities: ["fs.read"],
    exports: [{ name: "docs" }],
    offeredAt: 2000,
    ...overrides,
  };
}

async function withHost(
  enrolled: Machine.Enrollment,
  run: (context: { host: MachineHost; path: string }) => Promise<void>,
): Promise<void> {
  const path = socketPath();
  const host = await createMachineHost({
    socketPath: path,
    enrollment: () => enrolled,
    events: silent,
    now: () => 5000,
  });
  try {
    await run({ host, path });
  } finally {
    host.close();
  }
}

describe("machine fs wire surface", () => {
  test("real host and daemon round-trip read, list, and stat over a unix socket", async () => {
    const base = mkdtempSync(join(tmpdir(), "openomni-machine-wire-fs-"));
    const root = join(base, "docs");
    mkdirSync(root);
    writeFileSync(join(root, "note.txt"), "hello machine");
    try {
      await withHost(enrollment(), async ({ host, path }) => {
        const daemon = await attachMachineDaemon({
          socketPath: path,
          offer: offer(),
          fsExports: new Map([["docs", root]]),
        });
        try {
          expect(daemon.attachment).toEqual({
            status: "attached",
            effectiveCapabilities: ["fs.read"],
            effectiveExports: ["docs"],
          });
          expect(host.attachedExports("m-1")).toEqual(["docs"]);
          await expect(
            host.fsOp("m-1", { op: "read", export: "docs", path: "note.txt" }),
          ).resolves.toEqual({
            status: "completed",
            value: {
              op: "read",
              data: "hello machine",
              bytesRead: 13,
              size: 13,
              truncated: false,
            },
          });
          const list = await host.fsOp("m-1", { op: "list", export: "docs", path: "" });
          expect(list).toEqual({
            status: "completed",
            value: {
              op: "list",
              entries: [{ name: "note.txt", kind: "file", size: 13 }],
              truncated: false,
            },
          });
          const stat = await host.fsOp("m-1", { op: "stat", export: "docs", path: "note.txt" });
          expect(stat).toMatchObject({
            status: "completed",
            value: { op: "stat", kind: "file", size: 13 },
          });
        } finally {
          daemon.close();
        }
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("refuses an unattached machine and an attachment without fs.read", async () => {
    await withHost(enrollment(), async ({ host, path }) => {
      await expect(
        host.fsOp("missing", { op: "stat", export: "docs", path: "" }),
      ).resolves.toEqual({ status: "refused", reason: "machine_not_attached" });

      const daemon = await attachMachineDaemon({
        socketPath: path,
        offer: offer({ offeredCapabilities: [] }),
      });
      try {
        await expect(host.fsOp("m-1", { op: "stat", export: "docs", path: "" })).resolves.toEqual({
          status: "refused",
          reason: "fs_not_available",
        });
      } finally {
        daemon.close();
      }
    });
  });

  test("daemon re-checks its own capability offer across the wire boundary", async () => {
    const path = socketPath();
    const rogueHost = await createIpcServer(path, (_method, _params, respond) => {
      respond({ status: "attached", effectiveCapabilities: ["fs.read"], effectiveExports: ["docs"] });
    });
    const daemon = await attachMachineDaemon({
      socketPath: path,
      offer: offer({ offeredCapabilities: [] }),
    });
    try {
      await expect(
        typedCall(rogueHost, "machine.fs_op", { op: "stat", export: "docs", path: "" }, 5000),
      ).rejects.toThrow("fs.read was not offered by this machine");
    } finally {
      daemon.close();
      rogueHost.close();
    }
  });

  test("daemon re-checks export names from its own offer", async () => {
    const base = mkdtempSync(join(tmpdir(), "openomni-machine-offer-fs-"));
    const root = join(base, "private");
    mkdirSync(root);
    const path = socketPath();
    const rogueHost = await createIpcServer(path, (_method, _params, respond) => {
      respond({ status: "attached", effectiveCapabilities: ["fs.read"], effectiveExports: ["private"] });
    });
    const daemon = await attachMachineDaemon({
      socketPath: path,
      offer: offer({ exports: [{ name: "docs" }] }),
      fsExports: new Map([["private", root]]),
    });
    try {
      await expect(
        typedCall(
          rogueHost,
          "machine.fs_op",
          { op: "stat", export: "private", path: "" },
          5000,
        ),
      ).resolves.toEqual({
        status: "refused",
        reason: "export_not_available",
        message: "export is not available: private",
      });
    } finally {
      daemon.close();
      rogueHost.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("refuses an export outside enrollment without a daemon wire request", async () => {
    await withHost(enrollment(), async ({ host, path }) => {
      let fsRequests = 0;
      const daemon = await connectIpcClient(path, {
        onRequest(method, _params, respond) {
          if (method === "machine.fs_op") {
            fsRequests += 1;
            respond({ status: "completed", value: { op: "stat", kind: "file", size: 1, mtimeMs: 0 } });
          }
        },
      });
      try {
        await typedCall(
          daemon,
          "machine.attach",
          offer({ exports: [{ name: "docs" }, { name: "private" }] }),
          5000,
        );
        await expect(
          host.fsOp("m-1", { op: "stat", export: "private", path: "secret" }),
        ).resolves.toEqual({
          status: "refused",
          reason: "export_not_available",
          message: "export is not available: private",
        });
        expect(fsRequests).toBe(0);
      } finally {
        daemon.close();
      }
    });
  });
});
