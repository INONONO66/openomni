import { acquireEffect, closeAcquiredEffects, runEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { Effect, Scope, Exit, Result } from "effect";
import { certificateKeyFingerprint, createMachineHost, MachinesFailure } from "@openomni/machines";
import { type BusEvent, Machine } from "@openomni/protocol";
import { attachConfiguredMachine } from "../src/cli/machine";
import { testIds } from "./helpers/test-entropy";

const fixtures = join(import.meta.dir, "../../../packages/machines/test/ipc/fixtures");
const fingerprint = (pem: string) => certificateKeyFingerprint(new X509Certificate(pem).raw);

/** A severable TCP pipe standing in for the network between daemon and host. */
async function startTcpProxy(targetPort: number) {
  const pairs: Array<readonly [net.Socket, net.Socket]> = [];
  const server = net.createServer((inbound) => {
    const outbound = net.connect(targetPort, "127.0.0.1");
    pairs.push([inbound, outbound] as const);
    inbound.pipe(outbound);
    outbound.pipe(inbound);
    inbound.on("error", () => outbound.destroy());
    outbound.on("error", () => inbound.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    sever() {
      for (const [inbound, outbound] of pairs.splice(0)) {
        inbound.destroy();
        outbound.destroy();
      }
    },
    async stop() {
      this.sever();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Event-driven attach signal: no sleeps, no polling. */
function attachSignal() {
  const waiters: Array<() => void> = [];
  const sink: BusEvent.Sink = {
    publish(descriptor) {
      if (descriptor.name === Machine.Events.Attached.name) for (const waiter of waiters.splice(0)) waiter();
    },
  };
  return {
    sink,
    nextAttach(label: string): Promise<void> {
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        AbortSignal.timeout(15_000).addEventListener("abort", () => reject(new Error(`timed out waiting for attach: ${label}`)));
      });
    },
  };
}

test("attachConfiguredMachine dials a pinned network host in-process and redials after a transport drop", async () => {
  const base = mkdtempSync(join(tmpdir(), "om-cfg-tcp-"));
  const root = join(base, "data");
  mkdirSync(root);
  writeFileSync(join(root, "note"), "configured-over-tls");
  const events = attachSignal();
  const host = await acquireEffect(createMachineHost({
    listen: { tcp: { host: "127.0.0.1", port: 0 } },
    tls: {
      certificate: readFileSync(join(fixtures, "host-cert.pem"), "utf8"),
      privateKey: readFileSync(join(fixtures, "host-key.pem"), "utf8"),
    },
    id: testIds("cfg-host"),
    enrollment: (id) => ({
      machineId: id,
      name: id,
      allowedCapabilities: ["fs.read"],
      allowedExports: ["data"],
      publicKey: fingerprint(readFileSync(join(fixtures, "daemon-cert.pem"), "utf8")),
      enrolledAt: 1,
    }),
    events: events.sink,
    now: () => 2,
  }));
  const proxy = await startTcpProxy(host.endpoints.tcp?.port ?? 0);
  const configPath = join(base, "machine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      tcp: { host: "127.0.0.1", port: proxy.port },
      hostPublicKey: fingerprint(readFileSync(join(fixtures, "host-cert.pem"), "utf8")),
      tlsCertificate: join(fixtures, "daemon-cert.pem"),
      tlsPrivateKey: join(fixtures, "daemon-key.pem"),
      offer: {
        machineId: "cfg-1",
        offeredCapabilities: ["fs.read"],
        exports: [{ name: "data", path: root }],
        daemonVersion: "qa",
        platform: `${process.platform}-${process.arch}`,
        offeredAt: 2,
      },
    }),
  );
  try {
    const firstAttach = events.nextAttach("initial");
    const daemon = await acquireEffect(attachConfiguredMachine(configPath, testIds("cfg-daemon")));
    await firstAttach;
    expect(daemon.attachment).toMatchObject({ status: "attached", effectiveCapabilities: ["fs.read"] });
    const read = await runEffect(host.get("cfg-1").fs.read(join(root, "note")));
    expect(Buffer.from(read.data).toString()).toBe("configured-over-tls");
    // The production reconnect (real timers, jittered <=250ms first delay)
    // redials through the surviving listener; the host's attach event is the signal.
    const reattach = events.nextAttach("after transport drop");
    proxy.sever();
    await reattach;
    expect(daemon.attachment.status).toBe("attached");
    const again = await runEffect(host.get("cfg-1").fs.read(join(root, "note")));
    expect(Buffer.from(again.data).toString()).toBe("configured-over-tls");
  } finally {
    await closeAcquiredEffects();
    await proxy.stop();
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

test("attachConfiguredMachine rejects an incomplete TLS configuration with a typed decode failure", async () => {
  const base = mkdtempSync(join(tmpdir(), "om-cfg-bad-"));
  const configPath = join(base, "machine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      tcp: { host: "127.0.0.1", port: 4433 },
      hostPublicKey: fingerprint(readFileSync(join(fixtures, "host-cert.pem"), "utf8")),
      tlsCertificate: join(fixtures, "daemon-cert.pem"),
      // tlsPrivateKey is missing: the config union must refuse, never dial.
      offer: {
        machineId: "cfg-bad",
        offeredCapabilities: ["fs.read"],
        daemonVersion: "qa",
        platform: `${process.platform}-${process.arch}`,
        offeredAt: 2,
      },
    }),
  );
  try {
    const scope = await runEffect(Scope.make());
    const result = await Effect.runPromise(
      Effect.result(Scope.provide(attachConfiguredMachine(configPath, testIds("cfg-bad")), scope)),
    );
    await runEffect(Scope.close(scope, Exit.void));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      const failure = result.failure;
      expect(failure).toBeInstanceOf(MachinesFailure);
      expect((failure as MachinesFailure).operation).toBe("configuration.decode");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 15_000);
