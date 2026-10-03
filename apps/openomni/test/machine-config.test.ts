import { acquireEffect, closeAcquiredEffects, runEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Scope, Exit, Result } from "effect";
import { createMachineHost, MachinesFailure } from "@openomni/machines";
import { type BusEvent, Machine } from "@openomni/protocol";
import { attachConfiguredMachine } from "../src/cli/machine";
import { testIds } from "./helpers/test-entropy";
import { startProxy } from "../../../packages/machines/test/helpers/proxy";
import { pinnedTcpHostOptions, qaOffer, tlsFixturesDir } from "./helpers/machine-cli";

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
  const host = await acquireEffect(createMachineHost(pinnedTcpHostOptions(testIds("cfg-host"), ["fs.read"], events.sink)));
  const targetPort = host.endpoints.tcp?.port ?? 0;
  const proxy = await startProxy({ port: 0 }, () => net.connect(targetPort, "127.0.0.1"));
  const configPath = join(base, "machine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      tcp: { host: "127.0.0.1", port: proxy.port },
      hostCertificate: join(tlsFixturesDir, "host-cert.pem"),
      tlsCertificate: join(tlsFixturesDir, "daemon-cert.pem"),
      tlsPrivateKey: join(tlsFixturesDir, "daemon-key.pem"),
      offer: qaOffer("cfg-1", root, ["fs.read"]),
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
      hostCertificate: join(tlsFixturesDir, "host-cert.pem"),
      tlsCertificate: join(tlsFixturesDir, "daemon-cert.pem"),
      // tlsPrivateKey is missing: the config union must refuse, never dial.
      offer: qaOffer("cfg-bad", "/tmp", ["fs.read"]),
    }),
  );
  try {
    const scope = await runEffect(Scope.make());
    const result = await runEffect(
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
