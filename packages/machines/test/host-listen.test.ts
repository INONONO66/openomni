import { describe, expect, test } from "bun:test";
import fs, { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { Machine } from "@openomni/protocol";
import { attachMachineDaemon as nativeDaemon } from "../src/daemon";
import { createMachineHost as nativeHost } from "../src/host";
import { createMachineHost } from "./helpers/native";
import { acquire } from "./ipc/helpers/effects";
import { connectIpcTcpClient } from "./ipc/helpers/native";
import { exit as runExit } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";
import { daemonIdentity, daemonFingerprint, hostIdentity, wrongIdentity } from "./ipc/helpers/tls-fixtures";

const silent = { publish: () => undefined };
function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}
function enrollment(machineId: string, publicKey: Machine.KeyFingerprint): Machine.Enrollment {
  return {
    machineId,
    name: machineId,
    allowedCapabilities: ["fs.read"],
    allowedExports: ["docs"],
    publicKey,
    enrolledAt: 1,
  };
}
function offer(machineId: string, root: string): Machine.Offer {
  return {
    machineId,
    daemonVersion: "test",
    platform: "darwin-arm64",
    offeredCapabilities: ["fs.read"],
    exports: [{ name: "docs", path: root }],
    offeredAt: 2,
  };
}
const unixPin: Machine.KeyFingerprint =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("host listener set (#1270)", () => {
  test("unix and tcp serve ONE attachment registry; unix keeps 0600", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-listen-"));
    writeFileSync(join(root, "note"), "dual");
    const unix = socketPath();
    const enrollments = new Map([
      ["via-unix", enrollment("via-unix", unixPin)],
      ["via-tcp", enrollment("via-tcp", daemonFingerprint)],
    ]);
    const host = await createMachineHost({
      listen: { unix, tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: (id) => enrollments.get(id),
      events: silent,
      now: () => 3,
    });
    try {
      expect(host.endpoints.unix).toBe(unix);
      const port = host.endpoints.tcp?.port ?? 0;
      expect(port).toBeGreaterThan(0);
      expect(statSync(unix).mode & 0o777).toBe(0o600);
      const overUnix = await acquire(
        nativeDaemon({
          socketPath: unix,
          id: sequentialIds("unix-daemon"),
          offer: offer("via-unix", root),
          fsExports: new Map([["docs", root]]),
        }),
      );
      const overTcp = await acquire(
        nativeDaemon({
          tcp: { host: "127.0.0.1", port },
          hostCertificate: hostIdentity.certificate,
          tlsCertificate: daemonIdentity.certificate,
          tlsPrivateKey: daemonIdentity.privateKey,
          id: sequentialIds("tcp-daemon"),
          offer: offer("via-tcp", root),
          fsExports: new Map([["docs", root]]),
        }),
      );
      try {
        expect(overUnix.value.attachment.status).toBe("attached");
        expect(overTcp.value.attachment.status).toBe("attached");
        expect(host.list().map((machine) => machine.machineId)).toEqual(["via-tcp", "via-unix"]);
        // The SAME dispatcher serves both transports: handle operations route
        // by machine identity to whichever listener the daemon came in on.
        const viaUnix = await host.get("via-unix").fs.read(join(root, "note"));
        const viaTcp = await host.get("via-tcp").fs.read(join(root, "note"));
        expect(Buffer.from(viaUnix.data).toString()).toBe("dual");
        expect(Buffer.from(viaTcp.data).toString()).toBe("dual");
      } finally {
        await overUnix.close();
        await overTcp.close();
      }
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pty round trip completes through the tcp listener of a dual-listener host (#1273 r1 F4)", async () => {
    const tmuxSocket = `om-listen-pty-${process.pid}`;
    const unix = socketPath();
    const host = await createMachineHost({
      listen: { unix, tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: () => ({ ...enrollment("via-tcp", daemonFingerprint), allowedCapabilities: ["pty.session"] }),
      events: silent,
      now: () => 3,
    });
    try {
      const port = host.endpoints.tcp?.port ?? 0;
      const daemon = await acquire(
        nativeDaemon({
          tcp: { host: "127.0.0.1", port },
          hostCertificate: hostIdentity.certificate,
          tlsCertificate: daemonIdentity.certificate,
          tlsPrivateKey: daemonIdentity.privateKey,
          id: sequentialIds("tcp-pty-daemon"),
          offer: { ...offer("via-tcp", "/"), offeredCapabilities: ["pty.session"] },
          fsExports: new Map([["docs", "/"]]),
          pty: { socketName: tmuxSocket },
        }),
      );
      try {
        expect(daemon.value.attachment.status).toBe("attached");
        const pty = host.get("via-tcp").pty;
        const opened = await pty.open("qa", "/");
        if (opened.status !== "ok") throw new Error(`open refused: ${opened.reason}`);
        await pty.write("qa", Buffer.from("printf 'TCP-PTY-%s\\n' OK\n", "utf8"));
        // Event-driven drain on the daemon's long-poll; no sleeps.
        let seen = "";
        let cursor = opened.cursor;
        for (let round = 0; round < 200 && !seen.includes("TCP-PTY-OK"); round += 1) {
          const view = await pty.read("qa", { cursor, waitMs: 2000 });
          if (view.status !== "ok") throw new Error(`read refused: ${view.reason}`);
          seen += Buffer.from(view.data).toString("utf8");
          cursor = view.cursor;
        }
        expect(seen).toContain("TCP-PTY-OK");
        expect(await pty.close("qa")).toEqual({ status: "ok" });
      } finally {
        await daemon.close();
      }
    } finally {
      await host.close();
      Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"], { stderr: "pipe" });
    }
  }, 30_000);

  test("a TCP peer whose key is not the enrollment pin is refused peer_key_mismatch before admission", async () => {
    const host = await createMachineHost({
      listen: { tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: (id) => enrollments(id),
      events: silent,
      now: () => 3,
    });
    function enrollments(id: string): Machine.Enrollment | undefined {
      return id === "pinned" ? enrollment("pinned", daemonFingerprint) : undefined;
    }
    try {
      const port = host.endpoints.tcp?.port ?? 0;
      const intruder = await acquire(
        nativeDaemon({
          tcp: { host: "127.0.0.1", port },
          hostCertificate: hostIdentity.certificate,
          tlsCertificate: wrongIdentity.certificate,
          tlsPrivateKey: wrongIdentity.privateKey,
          id: sequentialIds("intruder"),
          offer: { ...offer("pinned", "/tmp"), exports: undefined },
        }),
      );
      try {
        expect(intruder.value.attachment).toEqual({ status: "refused", reason: "peer_key_mismatch" });
        expect(host.list()).toEqual([]);
      } finally {
        await intruder.close();
      }
    } finally {
      await host.close();
    }
  });

  test("same machineId under another key is refused while the valid attachment stays authoritative", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-pin-"));
    writeFileSync(join(root, "note"), "still-mine");
    const host = await createMachineHost({
      listen: { tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: () => enrollment("pinned", daemonFingerprint),
      events: silent,
      now: () => 3,
    });
    try {
      const port = host.endpoints.tcp?.port ?? 0;
      const legitimate = await acquire(
        nativeDaemon({
          tcp: { host: "127.0.0.1", port },
          hostCertificate: hostIdentity.certificate,
          tlsCertificate: daemonIdentity.certificate,
          tlsPrivateKey: daemonIdentity.privateKey,
          id: sequentialIds("legit"),
          offer: offer("pinned", root),
          fsExports: new Map([["docs", root]]),
        }),
      );
      const intruder = await connectIpcTcpClient({
        tcp: { host: "127.0.0.1", port },
        tls: wrongIdentity,
        hostCertificate: hostIdentity.certificate,
      });
      try {
        expect(legitimate.value.attachment.status).toBe("attached");
        expect(await intruder.call("machine.attach", offer("pinned", root))).toEqual({
          status: "refused",
          reason: "peer_key_mismatch",
        });
        // The current valid attachment was not superseded or detached.
        expect(host.list().map((machine) => machine.machineId)).toEqual(["pinned"]);
        const read = await host.get("pinned").fs.read(join(root, "note"));
        expect(Buffer.from(read.data).toString()).toBe("still-mine");
      } finally {
        await intruder.close();
        await legitimate.close();
      }
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("when one of two binds fails, startup fails and the listener that DID bind is closed", async () => {
    const blocker = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() { return; } },
    });
    const unix = socketPath();
    try {
      const outcome = await runExit(
        Effect.scoped(
          nativeHost({
            listen: { unix, tcp: { host: "127.0.0.1", port: blocker.port } },
            tls: hostIdentity,
            id: sequentialIds("half-bound"),
            enrollment: () => undefined,
            events: silent,
            now: () => 3,
          }),
        ),
      );
      expect(outcome._tag).toBe("Failure");
      // The bound unix listener was released: its socket file is gone and the
      // path binds cleanly again.
      expect(fs.existsSync(unix)).toBe(false);
      const rebound = await createMachineHost({
        listen: { unix },
        enrollment: () => undefined,
        events: silent,
        now: () => 3,
      });
      await rebound.close();
    } finally {
      blocker.stop(true);
    }
  });

  test("an empty listener set and tcp without a TLS identity are typed startup failures", async () => {
    const common = {
      id: sequentialIds("invalid"),
      enrollment: () => undefined,
      events: silent,
      now: () => 3,
    };
    const empty = await runExit(Effect.scoped(nativeHost({ listen: {}, ...common })));
    expect(empty._tag).toBe("Failure");
    expect(String(empty)).toContain("at least one of unix or tcp");
    const bare = await runExit(
      Effect.scoped(nativeHost({ listen: { tcp: { host: "127.0.0.1", port: 0 } }, ...common })),
    );
    expect(bare._tag).toBe("Failure");
    expect(String(bare)).toContain("requires the host tls identity");
  });
});
