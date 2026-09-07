import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openomni/ledger";
import type { PlainValue } from "@openomni/protocol";
import { z } from "zod";
import { alarmFixture } from "./helpers/alarm";

const parseJson: (text: string) => PlainValue = JSON.parse;
const identity = z
  .object({
    pid: z.number().int().positive(),
    parent: z.number().int().positive(),
    group: z.number().int().positive(),
  })
  .strict();

for (const mode of ["cancel", "timeout", "budget", "exit", "shutdown", "rearm"] as const) {
  test(`command ${mode} kills the whole group including HUP-ignoring child-of-child`, () =>
    Storage.withIsolation(async () => {
      const directory = mkdtempSync(join(tmpdir(), "monitor-group-"));
      const fifo = join(directory, "input");
      const socketPath = join(directory, "witness");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const fixture = alarmFixture();
      const peers: Array<{
        socket: Socket;
        process: z.infer<typeof identity>;
        closed: Promise<void>;
      }> = [];
      const connected = Promise.withResolvers<void>();
      const server = createServer((socket) => {
        const closed = Promise.withResolvers<void>();
        socket.once("close", () => closed.resolve());
        let text = "";
        socket.on("data", (data: Buffer) => {
          text += data.toString();
          if (!text.endsWith("\n")) return;
          peers.push({ socket, process: identity.parse(parseJson(text)), closed: closed.promise });
          if (peers.length === 2) connected.resolve();
        });
      });
      const listening = Promise.withResolvers<void>();
      server.once("listening", () => listening.resolve());
      server.once("error", (error: Error) => listening.reject(error));
      server.listen(socketPath);
      await listening.promise;
      const bound = (signal: Promise<void>) => {
        const failure = Promise.withResolvers<never>();
        const timer = setTimeout(
          () => failure.reject(new Error(`process-group ${mode} signal missing`)),
          5000,
        );
        return Promise.race([signal, failure.promise]).finally(() => clearTimeout(timer));
      };
      let writer: ReturnType<typeof Bun.spawn> | undefined;
      try {
        // Both descendants inherit the owned group, ignore HUP, and keep a socket
        // open until death. Neither voluntarily closes it or exits after readiness.
        const program = `import os,signal,socket,json; signal.signal(signal.SIGHUP,signal.SIG_IGN); os.fork(); s=socket.socket(socket.AF_UNIX); s.connect(${JSON.stringify(socketPath)}); s.sendall((json.dumps(dict(pid=os.getpid(),parent=os.getppid(),group=os.getpgrp()))+"\\n").encode()); signal.pause()`;
        const ready = fixture.next("group", (row) => row.content === "READY");
        fixture.arm(
          "group",
          {
            command: `python3 -u -c '${program}' & printf 'READY\\n'; cat '${fifo}'`,
            description: "owned process group",
            ...(mode === "timeout" ? { timeout_ms: 50 } : { persistent: true as const }),
          },
          1,
        );
        fixture.worker.start();
        await Promise.all([ready, bound(connected.promise)]);
        const group = peers[0]?.process.group;
        if (group === undefined) throw new Error("missing process group");
        expect(peers.every((peer) => peer.process.group === group)).toBe(true);
        expect(
          peers.some((peer) => peers.some((parent) => parent.process.pid === peer.process.parent)),
        ).toBe(true);
        // These subscriptions predate every action below, including physical kill.
        const original = [...peers];
        const gone = bound(Promise.all(original.map((peer) => peer.closed)).then(() => undefined));
        if (mode === "rearm") {
          const readyAgain = fixture.next("group", (row) => row.content === "READY");
          fixture.storage.alarms.rearm("group", 1000);
          fixture.worker.tick();
          await Promise.all([gone, readyAgain]);
          expect(fixture.storage.alarms.get("group")).toMatchObject({ status: "armed", epoch: 2 });
        } else if (mode === "exit" || mode === "budget") {
          const terminal = fixture.next("group", (row) =>
            row.content.includes(mode === "exit" ? '"exit"' : '"wake_budget"'),
          );
          writer = Bun.spawn([
            "/bin/sh",
            "-c",
            `${mode === "budget" ? "printf 'OVER\\n'" : ":"} > '${fifo}'`,
          ]);
          await Promise.all([gone, terminal]);
          expect(await writer.exited).toBe(0);
        } else {
          if (mode === "cancel") fixture.storage.alarms.cancel("group", 1000);
          if (mode === "timeout") fixture.advance(1050);
          if (mode !== "shutdown") fixture.worker.tick();
          await Promise.all([gone, fixture.worker.close()]);
        }
        for (const peer of original) {
          const state = Bun.spawnSync(["ps", "-p", String(peer.process.pid), "-o", "stat="]);
          // A not-yet-reaped zombie is dead; no live descendant may remain.
          expect(state.stdout.toString().trim().replace(/^Z.*$/, "")).toBe("");
        }
        expect(fixture.errors).toEqual([]);
      } finally {
        // Red runs also own their leaked probe processes; never leave a live orphan.
        for (const group of new Set(peers.map((peer) => peer.process.group)))
          Bun.spawnSync(["/bin/kill", "-KILL", "--", `-${group}`]);
        if (writer?.exitCode === null) writer.kill();
        if (writer !== undefined) await writer.exited;
        await fixture.close();
        for (const peer of peers) peer.socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        );
        rmSync(directory, { recursive: true, force: true });
      }
    }));
}
