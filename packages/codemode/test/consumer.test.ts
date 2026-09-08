import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachMachineDaemon, createMachineHost } from "@openomni/machines";
import { createCodemode } from "../src/index";

const silent = {
  publish() {
    return;
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function pair(
  run: (context: {
    mode: ReturnType<typeof createCodemode>;
    host: Awaited<ReturnType<typeof createMachineHost>>;
    a: string;
    b: string;
    da: Awaited<ReturnType<typeof attachMachineDaemon>>;
  }) => Promise<void>,
  tools?: Parameters<typeof createCodemode>[0],
) {
  const base = mkdtempSync(join(tmpdir(), "oc-consumer-"));
  const a = join(base, "a");
  const b = join(base, "b");
  mkdirSync(a);
  mkdirSync(b);
  const socketPath = join(tmpdir(), `oc-${crypto.randomUUID()}.sock`);
  const capabilities = ["fs.read", "fs.write", "shell.exec", "kernel.py"];
  let mode: ReturnType<typeof createCodemode>;
  const host = await createMachineHost({
    socketPath,
    enrollment: (id) => ({
      machineId: id,
      name: id,
      tags: [id],
      allowedExports: ["data"],
      allowedCapabilities: capabilities,
      enrolledAt: 1,
    }),
    events: silent,
    now: () => 2,
    callTool: (call) => mode.callTool(call),
  });
  mode = createCodemode({ ...tools, machines: host });
  const attach = (id: string, root: string) =>
    attachMachineDaemon({
      socketPath,
      offer: {
        machineId: id,
        daemonVersion: "test",
        platform: `${process.platform}-${process.arch}`,
        offeredAt: 2,
        offeredCapabilities: capabilities,
        exports: [{ name: "data", path: root }],
      },
      fsExports: new Map([["data", root]]),
      runner: createCodemode().runner,
    });
  const da = await attach("A", a);
  const db = await attach("B", b);
  try {
    await run({ mode, host, a, b, da });
  } finally {
    await mode.close();
    await da.close();
    await db.close();
    host.close();
    rmSync(base, { recursive: true, force: true });
  }
}

test("SDK handles and Python globals share raw endpoints across two machines", async () => {
  await pair(async ({ mode, a, b }) => {
    expect(mode.listMachines().map((entry) => entry.machineId)).toEqual(["A", "B"]);
    expect(mode.findMachine({ tag: "A" })).toBe(mode.getMachine("A"));
    expect(() => mode.findMachine({ tag: "missing" })).toThrow(
      expect.objectContaining({
        name: "CodemodeError",
        data: { reason: "machine_not_found", message: expect.any(String) },
      }),
    );
    const bytes = Buffer.from([0, 255, 128, 65]);
    expect(await mode.getMachine("A").write(join(a, "source"), bytes)).toEqual({
      op: "write",
      bytesWritten: 4,
    });
    const result = await mode.cell.run(
      [
        "ids = [m['machineId'] for m in codemode.listMachines()]",
        "src = codemode.findMachine({'tag': 'A'})",
        "dst = codemode.getMachine('B')",
        `raw = src.read(${JSON.stringify(join(a, "source"))})`,
        `written = dst.write(${JSON.stringify(join(b, "copy"))}, raw['data'])`,
        `listed = dst.ls(${JSON.stringify(b)})`,
        `shell = dst.bash('printf out; printf err >&2; exit 3', ${JSON.stringify(b)})`,
        "nested = dst.eval('6 * 7')",
        "(ids, list(raw['data']), written['bytesWritten'], listed['entries'][0]['name'], listed['entries'][0]['size'], shell['stdout'], shell['stderr'], shell['exitCode'], nested['value'])",
      ].join("\n"),
      "consumer",
    );
    expect(result).toMatchObject({
      status: "completed",
      value: "(['A', 'B'], [0, 255, 128, 65], 4, 'copy', 4, b'out', b'err', 3, '42')",
    });
    expect((await mode.getMachine("B").read(join(b, "copy"))).data).toEqual(bytes);
    expect(await mode.getMachine("B").ls(b)).toMatchObject({
      entries: [{ name: "copy", kind: "file", size: 4 }],
    });
    expect(await mode.getMachine("B").bash("printf direct", b)).toMatchObject({
      stdout: Buffer.from("direct"),
    });
    expect(
      await mode
        .getMachine("B")
        .eval({ cellId: "direct", code: "40 + 2", tenant: "direct", timeoutMs: 1000 }),
    ).toMatchObject({ status: "completed", value: "42" });
    // Handle methods are the tool names; the raw endpoint names are gone (KERNEL 3.5).
    expect(Object.keys(mode.getMachine("B")).sort()).toEqual([
      "bash",
      "eval",
      "ls",
      "read",
      "write",
    ]);
  });
});

test("cancellation crosses the real host/daemon boundary and the next cell recovers", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  await pair(
    async ({ mode }) => {
      const controller = new AbortController();
      const running = mode.cell.run("tool.hold()", "cancel", {
        signal: controller.signal,
        timeoutMs: 5000,
      });
      await entered.promise;
      controller.abort();
      expect(await running).toMatchObject({ status: "cancelled" });
      release.resolve();
      expect(await mode.cell.run("6 * 7", "cancel")).toMatchObject({
        status: "completed",
        value: "42",
      });
      await mode.close();
      expect(() => mode.listMachines()).toThrow(expect.objectContaining({ name: "CodemodeError" }));
    },
    {
      tools: () => async () => {
        entered.resolve();
        await release.promise;
        return { status: "completed", value: "late" };
      },
    },
  );
});

test("host disconnect closes the injected runner and awaits its processes", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  await pair(
    async ({ mode, host, da }) => {
      // With a wait window the loss surfaces through the background path too.
      const running = mode.cell.run("tool.hold()", "disconnect", {
        timeoutMs: 5000,
        waitMs: 5000,
      });
      const outcome = running.then(
        (result) => {
          throw new Error(`expected connection loss, received ${result.status}`);
        },
        (error: Error) => error,
      );
      await entered.promise;
      host.close();
      expect(await outcome).toMatchObject({ name: "IpcConnectionError" });
      await da.closed;
      release.resolve();
    },
    {
      tools: () => async () => {
        entered.resolve();
        await release.promise;
        return { status: "completed" };
      },
    },
  );
});

test("close cancels live facade work and no kernel starts without a daemon runner call", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  await pair(
    async ({ mode }) => {
      const running = mode.cell.run("tool.hold()", "closing", { timeoutMs: 5000 });
      await entered.promise;
      await mode.close();
      expect(await running).toMatchObject({ status: "cancelled" });
      release.resolve();
    },
    {
      tools: () => async () => {
        entered.resolve();
        await release.promise;
        return { status: "completed" };
      },
    },
  );
});

test("tag ambiguity and an unbound machine port are typed, never arbitrary selection", async () => {
  const row = {
    machineId: "A",
    name: "A",
    tags: ["same"],
    enrolledAt: 1,
    allowedCapabilities: ["kernel.py"],
    capabilities: ["kernel.py"],
    os: "linux",
    arch: "arm64",
  };
  const mode = createCodemode({
    machines: {
      list: () => [row, { ...row, machineId: "B" }],
      get: () => {
        throw new Error("ambiguous selection must not route");
      },
    },
  });
  expect(() => mode.findMachine({ tag: "same" })).toThrow(
    expect.objectContaining({
      name: "CodemodeError",
      data: { reason: "ambiguous_machine", message: expect.any(String) },
    }),
  );
  await mode.close();
  const runner = createCodemode();
  expect(() => runner.listMachines()).toThrow(
    expect.objectContaining({
      name: "CodemodeError",
      data: { reason: "machines_not_bound", message: expect.any(String) },
    }),
  );
  await expect(
    runner.callTool({ cellId: "ghost", name: "x", arguments: {} }),
  ).resolves.toMatchObject({ status: "failed" });
  await runner.close();
});

test("injected completion batches through parallel and tenant state never crosses interpreters", async () => {
  await pair(
    async ({ mode }) => {
      expect(
        await mode.cell.run(
          "x = 41\nparallel([lambda: completion('first'), lambda: completion('second')])",
          "one",
        ),
      ).toMatchObject({
        status: "completed",
        value: "['answer:first', 'answer:second']",
      });
      expect(await mode.cell.run("x + 1", "one")).toMatchObject({
        status: "completed",
        value: "42",
      });
      expect(await mode.cell.run("x", "two")).toMatchObject({ status: "raised" });
    },
    { completion: async (request) => `answer:${request.prompt}` },
  );
});

test("run leaves a held cell in the background: peek shows its output so far, stop interrupts it once", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let holds = 0;
  await pair(
    async ({ mode }) => {
      // The hold cannot settle until released, so a zero wait answers `running` by construction.
      const started = await mode.cell.run(
        "print('started')\nprint('warn', file=__import__('sys').stderr)\ntool.hold()\nprint('never')",
        "background",
        { timeoutMs: 5000, waitMs: 0 },
      );
      if (started.status !== "running") throw new Error(`expected running, got ${started.status}`);
      await entered.promise;
      // A cell queued behind the held one is in flight with no output yet; stopping it
      // before it executes cancels it without ever touching the interpreter.
      const queued = await mode.cell.run("print('second')", "background", {
        timeoutMs: 5000,
        waitMs: 0,
      });
      if (queued.status !== "running") throw new Error(`expected running, got ${queued.status}`);
      const nothing = { stdout: "", stderr: "" };
      expect(await mode.cell.peek(queued.cellId, "background")).toEqual({
        status: "running",
        cellId: queued.cellId,
        output: nothing,
      });
      expect(await mode.cell.stop(queued.cellId, "background")).toEqual({
        status: "cancelled",
        cellId: queued.cellId,
        output: nothing,
      });
      const partial = { stdout: "started\n", stderr: "warn\n" };
      expect(await mode.cell.peek(started.cellId, "background")).toEqual({
        status: "running",
        cellId: started.cellId,
        output: partial,
      });
      // Another tenant cannot see, let alone stop, this cell.
      for (const op of [mode.cell.peek, mode.cell.stop]) {
        await expect(op(started.cellId, "intruder")).rejects.toMatchObject({
          name: "CodemodeError",
          data: { reason: "unknown_cell_id", message: expect.any(String) },
        });
      }
      expect(await mode.cell.stop(started.cellId, "background")).toEqual({
        status: "cancelled",
        cellId: started.cellId,
        output: partial,
      });
      // Settled state is handed over once; the code never runs again.
      await expect(mode.cell.peek(started.cellId, "background")).rejects.toMatchObject({
        data: { reason: "unknown_cell_id" },
      });
      release.resolve();
      expect(await mode.cell.run("6 * 7", "background")).toMatchObject({
        status: "completed",
        value: "42",
      });
      expect(holds).toBe(1);
    },
    {
      tools: () => async () => {
        holds += 1;
        entered.resolve();
        await release.promise;
        return { status: "completed" };
      },
    },
  );
});

test("a peek and a stop racing on one cell hand its settled state to exactly one of them", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  await pair(
    async ({ mode }) => {
      const started = await mode.cell.run("tool.hold()", "race", { timeoutMs: 5000, waitMs: 0 });
      if (started.status !== "running") throw new Error(`expected running, got ${started.status}`);
      await entered.promise;
      // peek is mid round-trip to the daemon when stop claims the entry synchronously.
      const outcomes = await Promise.allSettled([
        mode.cell.peek(started.cellId, "race"),
        mode.cell.stop(started.cellId, "race"),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
      expect(outcomes[0]).toMatchObject({
        reason: { name: "CodemodeError", data: { reason: "unknown_cell_id" } },
      });
      expect(outcomes[1]).toMatchObject({
        value: { status: "cancelled", cellId: started.cellId },
      });
      release.resolve();
    },
    {
      tools: () => async () => {
        entered.resolve();
        await release.promise;
        return { status: "completed" };
      },
    },
  );
});

test("unread settled cells are retained up to the bound; the oldest is evicted and its id is spent", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  await pair(
    async ({ mode }) => {
      const ids: string[] = [];
      // The first cell holds the interpreter, so the 64 queued behind it are `running` by
      // construction: 65 cells, one more than the facade retains once they settle unread.
      for (let index = 0; index < 65; index += 1) {
        const started = await mode.cell.run(index === 0 ? "tool.hold()" : `${index}`, "bound", {
          timeoutMs: 5000,
          waitMs: 0,
        });
        if (started.status !== "running")
          throw new Error(`expected running, got ${started.status}`);
        ids.push(started.cellId);
      }
      await entered.promise;
      release.resolve();
      // Queued behind all 65 on the same interpreter and connection: when it answers, they
      // have all settled at the facade.
      expect(await mode.cell.run("'barrier'", "bound")).toMatchObject({ status: "completed" });
      await expect(mode.cell.peek(ids[0] ?? "", "bound")).rejects.toMatchObject({
        data: { reason: "unknown_cell_id" },
      });
      expect(await mode.cell.peek(ids[1] ?? "", "bound")).toMatchObject({
        status: "completed",
        value: "1",
      });
      expect(await mode.cell.peek(ids[64] ?? "", "bound")).toMatchObject({
        status: "completed",
        value: "64",
      });
    },
    {
      tools: () => async () => {
        entered.resolve();
        await release.promise;
        return { status: "completed" };
      },
    },
  );
}, 30_000);

test("a run that settles within its wait answers the result and leaves nothing behind", async () => {
  await pair(async ({ mode }) => {
    const settled = await mode.cell.run("print('quick')\n1 + 1", "prompt", {
      timeoutMs: 5000,
      waitMs: 5000,
    });
    expect(settled).toMatchObject({
      status: "completed",
      value: "2",
      output: { stdout: "quick\n", stderr: "" },
    });
    if (settled.status !== "completed") throw new Error("unreachable");
    await expect(mode.cell.peek(settled.cellId, "prompt")).rejects.toMatchObject({
      data: { reason: "unknown_cell_id" },
    });
  });
});
