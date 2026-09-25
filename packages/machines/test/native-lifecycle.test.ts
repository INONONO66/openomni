import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { readdirSync } from "node:fs";
import { Machine } from "@openomni/protocol";
import { Cause, Effect, Exit, Fiber } from "effect";
import { z } from "zod";
import { createIpcServer } from "../../ipc/src/server";
import { acquire, run } from "../../ipc/test/helpers/effects";
import { captureError, deferred, within } from "../../ipc/test/helpers/signal";
import { socketPath } from "../../ipc/test/helpers/socket-path";
import { attachMachineDaemon } from "../src/daemon";
import { execute } from "../src/exec";
import { createMachineHost } from "../src/host";
import { enrollment, offer } from "./helpers";

const command = "sleep 60 & grandchild=$!; printf '%s %s\\n' \"$$\" \"$grandchild\"; wait";
const pidPair = z.tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()]);

/** Observe the real spawn and pipes; never replace process creation or termination. */
function observeProcess() {
  const ready = deferred<readonly [number, number]>();
  const closed = deferred();
  const spawn = childProcess.spawn;
  let child: childProcess.ChildProcess | undefined;
  let output = "";
  const observation = spyOn(childProcess, "spawn").mockImplementation(new Proxy(spawn, {
    apply(target: typeof spawn, _receiver: typeof childProcess, args: Parameters<typeof spawn>) {
      child = target(...args);
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("\n")) ready.resolve(pidPair.parse(output.trim().split(" ")));
      });
      child.once("close", () => closed.resolve());
      return child;
    },
  }));
  return {
    ready: ready.promise,
    closed: closed.promise,
    assertClosed: () => {
      expect(child?.signalCode).toBe("SIGKILL");
      expect(child?.stdout?.destroyed).toBe(true);
      expect(child?.stderr?.destroyed).toBe(true);
    },
    restore: () => observation.mockRestore(),
  };
}

function expectGone(pids: readonly number[]) {
  for (const pid of pids) {
    let code = "alive";
    try { process.kill(pid, 0); }
    catch (error) { code = z.object({ code: z.string() }).parse(error).code; }
    expect(code).toBe("ESRCH");
  }
}

test("interrupting native exec kills the real shell and sleeping grandchild and closes pipes", async () => {
  const observed = observeProcess();
  try {
    await within(run(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(execute({ cmd: command, cwd: "/" }, new AbortController().signal));
      const pids = yield* Effect.promise(() => within(observed.ready, "shell and grandchild PID handshake"));
      const exit = yield* Fiber.interrupt(fiber);
      expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
      yield* Effect.promise(() => within(observed.closed, "real child close"));
      observed.assertClosed();
      expectGone(pids);
    }))), "interrupted exec lifecycle");
  } finally {
    observed.restore();
  }
});

test("closing the attached daemon scope terminates a host-dispatched process group", async () => {
  const path = socketPath("machine-life");
  const detached = deferred();
  const host = await acquire(createMachineHost({
    socketPath: path, enrollment, now: () => 3,
    events: { publish: (event) => { if (event.name === Machine.Events.Detached.name) detached.resolve(); } },
  }));
  const daemon = await acquire(attachMachineDaemon({ socketPath: path, offer: offer("/tmp"), fsExports: new Map([["docs", "/tmp"]]) }));
  const observed = observeProcess();
  try {
    expect(host.value.list()).toHaveLength(1);
    const result = captureError(run(host.value.get("m-1").exec(command, "/tmp")));
    const pids = await within(observed.ready, "remote exec PID handshake");
    await within(daemon.close(), "daemon scope finalizers");
    await within(observed.closed, "remote process close");
    expect(await within(result, "disconnected host RPC")).toMatchObject({ _tag: "TransportFailure", operation: "exec.call" });
    observed.assertClosed();
    expectGone(pids);
    await within(detached.promise, "host detach event");
    expect(host.value.list()).toHaveLength(0);
  } finally {
    await daemon.close();
    await host.close();
    observed.restore();
  }
});

test("failed attach rolls back the acquired daemon, runner and socket", async () => {
  const path = socketPath("attach-fail");
  const disconnected = deferred();
  const runnerClosed = deferred();
  let closeCount = 0;
  const server = await acquire(createIpcServer(path, (method, _params, respond) => Effect.sync(() => {
    expect(method).toBe(Machine.WireMethod.Attach);
    respond({ status: "invalid" });
  }), { onDisconnect: () => Effect.sync(() => disconnected.resolve()) }));
  const descriptors = readdirSync("/dev/fd").length;
  try {
    const error = await captureError(acquire(attachMachineDaemon({
      socketPath: path,
      offer: offer("/tmp"),
      fsExports: new Map([["docs", "/tmp"]]),
      runner: {
        runCode: () => Effect.die("attach failure must not execute code"),
        peekCode: () => undefined,
        close: () => Effect.sync(() => { closeCount += 1; runnerClosed.resolve(); }),
      },
    })));
    expect(error).toMatchObject({ _tag: "ForeignFailure", operation: "daemon.attach.response" });
    await within(runnerClosed.promise, "runner rollback");
    await within(disconnected.promise, "failed daemon socket close");
    expect(closeCount).toBe(1);
    expect(readdirSync("/dev/fd").length).toBe(descriptors);
  } finally {
    await server.close();
  }
});
