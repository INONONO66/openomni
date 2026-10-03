import { describe, expect, test } from "bun:test";
import net from "node:net";
import { once } from "node:events";
import { type BusEvent, Machine } from "@openomni/protocol";
import { attachMachineDaemon, createMachineHost, type CodeRunner } from "./helpers/native";
import { captureError, within } from "./ipc/helpers/signal";
import { socketPath } from "./helpers/socket-path";

/**
 * #1270 reconnect proof: time is driven ONLY through the injected scheduler
 * and jitter ONLY through the injected randomness — no sleeps, no polling.
 */
type Scheduled = { readonly delay: number; task: () => void; cancelled: boolean };
function fakeScheduler() {
  const entries: Scheduled[] = [];
  const waiters: Array<(entry: Scheduled) => void> = [];
  return {
    entries,
    schedule(delay: number, task: () => void): () => void {
      const entry: Scheduled = { delay, task, cancelled: false };
      entries.push(entry);
      for (const waiter of waiters.splice(0)) waiter(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Resolves on the NEXT schedule() call (bounded by bun's test timeout). */
    nextScheduled(): Promise<Scheduled> {
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** A severable unix-socket pipe: the network between daemon and host. */
async function startProxy(listenPath: string, targetPath: string) {
  const pairs: Array<readonly [net.Socket, net.Socket]> = [];
  const server = net.createServer((inbound) => {
    const outbound = net.connect(targetPath);
    pairs.push([inbound, outbound] as const);
    inbound.pipe(outbound);
    outbound.pipe(inbound);
    inbound.on("error", () => outbound.destroy());
    outbound.on("error", () => inbound.destroy());
  });
  server.listen(listenPath);
  await once(server, "listening");
  return {
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

type HostEvent = { readonly name: string; readonly machineId: string };
function eventCollector() {
  const events: HostEvent[] = [];
  const waiters: Array<{ name: string; resolve: (event: HostEvent) => void }> = [];
  const sink: BusEvent.Sink = {
    publish(descriptor, payload) {
      const parsed =
        descriptor.name === Machine.Events.Attached.name
          ? Machine.Events.Attached.schema.parse(payload)
          : Machine.Events.Detached.schema.parse(payload);
      const event = { name: descriptor.name, machineId: parsed.machineId };
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
    next(name: string): Promise<HostEvent> {
      return new Promise((resolve) => waiters.push({ name, resolve }));
    },
  };
}

const enrollment: Machine.Enrollment = {
  name: "roaming",
  machineId: "m-1",
  allowedCapabilities: ["kernel.py"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 1,
};
function offer(): Machine.Offer {
  return {
    machineId: "m-1",
    daemonVersion: "test",
    platform: "darwin-arm64",
    offeredCapabilities: ["kernel.py"],
    offeredAt: 2,
  };
}
function cell(cellId: string): Machine.CellRequest {
  return { cellId, code: "x", timeoutMs: 60_000 };
}

/** Records every runCode by cellId; "orphan" is held until released. */
function heldRunner() {
  const started = new Map<string, number>();
  const release = Promise.withResolvers<void>();
  let entered: (() => void) | undefined;
  let closes = 0;
  const runner: CodeRunner = {
    runCode: async (request) => {
      started.set(request.cellId, (started.get(request.cellId) ?? 0) + 1);
      entered?.();
      if (request.cellId === "orphan") await release.promise;
      return { status: "completed", cellId: request.cellId, value: request.cellId, output: { stdout: "", stderr: "" } };
    },
    peekCode: () => undefined,
    close: async () => {
      closes += 1;
    },
  };
  return {
    runner,
    started,
    release: () => release.resolve(),
    closes: () => closes,
    entered(): Promise<void> {
      return new Promise((resolve) => {
        entered = resolve;
      });
    },
  };
}

describe("daemon reattach over a dropped transport", () => {
  test("drop fails pending once, jittered attempts reattach, old handle serves the replacement, refusal stops reconnect", async () => {
    const hostPath = socketPath();
    const proxyPath = socketPath();
    const collector = eventCollector();
    let enrolled: Machine.Enrollment | undefined = enrollment;
    const host = await createMachineHost({
      listen: { unix: hostPath },
      enrollment: () => enrolled,
      events: collector.sink,
      now: () => 7,
    });
    const proxy = await startProxy(proxyPath, hostPath);
    const clock = fakeScheduler();
    const randoms = [0.5, 1, 0.25, 1];
    const code = heldRunner();
    const daemon = await attachMachineDaemon({
      socketPath: proxyPath,
      offer: offer(),
      runner: code.runner,
      reconnect: { scheduler: clock, random: () => randoms.shift() ?? 1 },
    });
    try {
      expect(daemon.attachment.status).toBe("attached");
      const handle = host.get("m-1");
      const entered = code.entered();
      const pendingCall = captureError(handle.runCode(cell("orphan")));
      await within(entered, "daemon runner entry");

      // Network loss: the one in-flight call settles once as `disconnected`.
      const detached = collector.next("machine.detached");
      const firstSchedule = clock.nextScheduled();
      proxy.sever();
      expect(await within(pendingCall, "pending call settles")).toMatchObject({
        _tag: "MachineRefusalError",
        reason: "disconnected",
      });
      await within(detached, "host detach");

      // Reconnect-window semantics: known machine reads disconnected,
      // a never-attached identity keeps machine_not_attached.
      expect(await captureError(handle.runCode(cell("window")))).toMatchObject({
        _tag: "MachineRefusalError",
        reason: "disconnected",
      });
      expect(await captureError(host.get("ghost").peekCode("nope"))).toMatchObject({
        _tag: "MachineRefusalError",
        reason: "machine_not_attached",
      });

      // Full jitter with injected randomness: delay = random * min(cap, 250·2^attempt).
      const first = await within(firstSchedule, "first reconnect schedule");
      expect(first.delay).toBe(Math.floor(0.5 * 250));
      await proxy.stop(); // the host endpoint is unreachable for two attempts
      const second = clock.nextScheduled();
      first.task();
      expect((await within(second, "second schedule")).delay).toBe(Math.floor(1 * 500));
      const third = clock.nextScheduled();
      (await second).task();
      expect((await within(third, "third schedule")).delay).toBe(Math.floor(0.25 * 1000));

      // The endpoint returns; the next attempt reattaches the SAME identity.
      const revived = await startProxy(proxyPath, hostPath);
      try {
        const reattached = collector.next("machine.attached");
        (await third).task();
        await within(reattached, "same-identity reattach");
        expect(daemon.attachment.status).toBe("attached");

        // The OLD handle dispatches a NEW request through the replacement
        // connection; the failed call was never replayed.
        expect(await within(handle.runCode(cell("fresh")), "post-reattach call")).toMatchObject({
          status: "completed",
          value: "fresh",
        });
        expect(code.started.get("fresh")).toBe(1);
        expect(code.started.get("orphan")).toBe(1);

        // A successful attach reset the attempt counter: the next drop backs
        // off from the base ceiling again.
        const afterReset = clock.nextScheduled();
        revived.sever();
        expect((await within(afterReset, "post-reset schedule")).delay).toBe(Math.floor(1 * 250));

        // A refused reattach surfaces the refusal, schedules nothing
        // further, and closes the daemon until a restart or config change.
        enrolled = undefined;
        const scheduled = clock.entries.length;
        code.release();
        const settled = daemon.closed;
        (await afterReset).task();
        await within(settled, "daemon closes after refused reattach");
        expect(daemon.attachment).toEqual({ status: "refused", reason: "machine_not_enrolled" });
        expect(clock.entries.length).toBe(scheduled);
        expect(code.closes()).toBe(1);
      } finally {
        await revived.stop();
      }
    } finally {
      code.release();
      await daemon.close();
      await host.close();
    }
  });

  test("a refused initial attachment never schedules reconnect on disconnect", async () => {
    const hostPath = socketPath();
    const host = await createMachineHost({
      listen: { unix: hostPath },
      enrollment: () => undefined,
      events: { publish: () => undefined },
      now: () => 7,
    });
    const clock = fakeScheduler();
    const daemon = await attachMachineDaemon({
      socketPath: hostPath,
      offer: offer(),
      reconnect: { scheduler: clock, random: () => 1 },
    });
    expect(daemon.attachment).toEqual({ status: "refused", reason: "machine_not_enrolled" });
    const settled = daemon.closed;
    await host.close();
    await within(settled, "refused daemon closes on disconnect");
    expect(clock.entries).toHaveLength(0);
  });

  test("explicit close during backoff cancels the scheduled attempt and releases drivers exactly once", async () => {
    const hostPath = socketPath();
    const collector = eventCollector();
    const host = await createMachineHost({
      listen: { unix: hostPath },
      enrollment: () => enrollment,
      events: collector.sink,
      now: () => 7,
    });
    const clock = fakeScheduler();
    const code = heldRunner();
    const daemon = await attachMachineDaemon({
      socketPath: hostPath,
      offer: offer(),
      runner: code.runner,
      reconnect: { scheduler: clock, random: () => 1 },
    });
    expect(daemon.attachment.status).toBe("attached");
    const scheduled = clock.nextScheduled();
    await host.close();
    const entry = await within(scheduled, "backoff scheduled on host loss");
    await daemon.close();
    expect(entry.cancelled).toBe(true);
    expect(clock.entries).toHaveLength(1);
    expect(code.closes()).toBe(1);
    // Idempotent close: drivers are not released a second time.
    await daemon.close();
    expect(code.closes()).toBe(1);
  });

  test("backoff ceilings double from 250 ms and stay capped at 30 s", async () => {
    const hostPath = socketPath();
    const host = await createMachineHost({
      listen: { unix: hostPath },
      enrollment: () => enrollment,
      events: { publish: () => undefined },
      now: () => 7,
    });
    const clock = fakeScheduler();
    const daemon = await attachMachineDaemon({
      socketPath: hostPath,
      offer: offer(),
      reconnect: { scheduler: clock, random: () => 1 },
    });
    try {
      expect(daemon.attachment.status).toBe("attached");
      let scheduled = clock.nextScheduled();
      await host.close(); // endpoint stays gone: every attempt fails
      const delays: number[] = [];
      for (let attempt = 0; attempt < 9; attempt += 1) {
        const entry = await within(scheduled, `schedule ${attempt}`);
        delays.push(entry.delay);
        scheduled = clock.nextScheduled();
        entry.task();
      }
      expect(delays).toEqual([250, 500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    } finally {
      await daemon.close();
    }
  });
});
