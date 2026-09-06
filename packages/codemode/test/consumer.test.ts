import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachMachineDaemon, createMachineHost } from "@openomni/machines";
import { createCodemode } from "../src/index";

const silent = { publish() { return; } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function pair(run: (context: { mode: ReturnType<typeof createCodemode>; host: Awaited<ReturnType<typeof createMachineHost>>; a: string; b: string; da: Awaited<ReturnType<typeof attachMachineDaemon>> }) => Promise<void>, tools?: Parameters<typeof createCodemode>[0]) {
  const base = mkdtempSync(join(tmpdir(), "oc-consumer-"));
  const a = join(base, "a"); const b = join(base, "b"); mkdirSync(a); mkdirSync(b);
  const socketPath = join(tmpdir(), `oc-${crypto.randomUUID()}.sock`);
  const capabilities = ["fs.read", "fs.write", "shell.exec", "kernel.py"];
  let mode: ReturnType<typeof createCodemode>;
  const host = await createMachineHost({ socketPath, enrollment: (id) => ({ machineId: id, name: id, tags: [id], allowedExports: ["data"], allowedCapabilities: capabilities, enrolledAt: 1 }), events: silent, now: () => 2, callTool: (call) => mode.callTool(call) });
  mode = createCodemode({ ...tools, machines: host });
  const attach = (id: string, root: string) => attachMachineDaemon({ socketPath, offer: { machineId: id, daemonVersion: "test", platform: `${process.platform}-${process.arch}`, offeredAt: 2, offeredCapabilities: capabilities, exports: [{ name: "data", path: root }] }, fsExports: new Map([["data", root]]), runner: createCodemode().runner });
  const da = await attach("A", a); const db = await attach("B", b);
  try { await run({ mode, host, a, b, da }); }
  finally { await mode.close(); await da.close(); await db.close(); host.close(); rmSync(base, { recursive: true, force: true }); }
}

test("SDK handles and Python globals share raw endpoints across two machines", async () => {
  await pair(async ({ mode, a, b }) => {
    expect(mode.listMachines().map((entry) => entry.machineId)).toEqual(["A", "B"]);
    expect(mode.findMachine({ tag: "A" })).toBe(mode.getMachine("A"));
    expect(() => mode.findMachine({ tag: "missing" })).toThrow(expect.objectContaining({ name: "CodemodeError", data: { reason: "machine_not_found", message: expect.any(String) } }));
    const bytes = Buffer.from([0, 255, 128, 65]);
    expect(await mode.getMachine("A").write(join(a, "source"), bytes)).toEqual({ op: "write", bytesWritten: 4 });
    const result = await mode.cell.run([
      "ids = [m['machineId'] for m in codemode.listMachines()]",
      "src = codemode.findMachine({'tag': 'A'})",
      "dst = codemode.getMachine('B')",
      `raw = src.read(${JSON.stringify(join(a, "source"))})`,
      `written = dst.write(${JSON.stringify(join(b, "copy"))}, raw['data'])`,
      `listed = dst.list(${JSON.stringify(b)})`,
      `info = dst.stat(${JSON.stringify(join(b, "copy"))})`,
      `shell = dst.shell('printf out; printf err >&2; exit 3', ${JSON.stringify(b)})`,
      "nested = dst.run('6 * 7')",
      "(ids, list(raw['data']), written['bytesWritten'], listed['entries'][0]['name'], info['size'], shell['stdout'], shell['stderr'], shell['exitCode'], nested['value'])",
    ].join("\n"), "consumer");
    expect(result).toMatchObject({ status: "completed", value: "(['A', 'B'], [0, 255, 128, 65], 4, 'copy', 4, b'out', b'err', 3, '42')" });
    expect((await mode.getMachine("B").read(join(b, "copy"))).data).toEqual(bytes);
    expect(await mode.getMachine("B").stat(join(b, "copy"))).toMatchObject({ kind: "file", size: 4 });
    expect(await mode.getMachine("B").list(b)).toMatchObject({ entries: [{ name: "copy" }] });
    expect(await mode.getMachine("B").shell("printf direct", b)).toMatchObject({ stdout: Buffer.from("direct") });
    expect(await mode.getMachine("B").run({ cellId: "direct", code: "40 + 2", tenant: "direct", timeoutMs: 1000 })).toMatchObject({ status: "completed", value: "42" });
  });
});

test("cancellation crosses the real host/daemon boundary and the next cell recovers", async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  await pair(async ({ mode }) => {
    const controller = new AbortController();
    const running = mode.cell.run("tool.hold()", "cancel", { signal: controller.signal, timeoutMs: 5000 });
    await entered.promise;
    controller.abort();
    expect(await running).toMatchObject({ status: "cancelled" });
    release.resolve();
    expect(await mode.cell.run("6 * 7", "cancel")).toMatchObject({ status: "completed", value: "42" });
    await mode.close();
    expect(() => mode.listMachines()).toThrow(expect.objectContaining({ name: "CodemodeError" }));
  }, { tools: () => async () => { entered.resolve(); await release.promise; return { status: "completed", value: "late" }; } });
});

test("host disconnect closes the injected runner and awaits its processes", async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  await pair(async ({ mode, host, da }) => {
    const running = mode.cell.run("tool.hold()", "disconnect", { timeoutMs: 5000 });
    const outcome = running.then(
      (result) => { throw new Error(`expected connection loss, received ${result.status}`); },
      (error: Error) => error,
    );
    await entered.promise;
    host.close();
    expect(await outcome).toMatchObject({ name: "IpcConnectionError" });
    await da.closed;
    release.resolve();
  }, { tools: () => async () => { entered.resolve(); await release.promise; return { status: "completed" }; } });
});

test("close cancels live facade work and no kernel starts without a daemon runner call", async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  await pair(async ({ mode }) => {
    const running = mode.cell.run("tool.hold()", "closing", { timeoutMs: 5000 });
    await entered.promise;
    await mode.close();
    expect(await running).toMatchObject({ status: "cancelled" });
    release.resolve();
  }, { tools: () => async () => { entered.resolve(); await release.promise; return { status: "completed" }; } });
});

test("tag ambiguity and an unbound machine port are typed, never arbitrary selection", async () => {
  const row = { machineId: "A", name: "A", tags: ["same"], enrolledAt: 1, allowedCapabilities: ["kernel.py"], capabilities: ["kernel.py"], os: "linux", arch: "arm64" };
  const mode = createCodemode({ machines: { list: () => [row, { ...row, machineId: "B" }], get: () => { throw new Error("ambiguous selection must not route"); } } });
  expect(() => mode.findMachine({ tag: "same" })).toThrow(expect.objectContaining({ name: "CodemodeError", data: { reason: "ambiguous_machine", message: expect.any(String) } }));
  await mode.close();
  const runner = createCodemode();
  expect(() => runner.listMachines()).toThrow(expect.objectContaining({ name: "CodemodeError", data: { reason: "machines_not_bound", message: expect.any(String) } }));
  await expect(runner.callTool({ cellId: "ghost", name: "x", arguments: {} })).resolves.toMatchObject({ status: "failed" });
  await runner.close();
});

test("injected llm preserves input order and tenant state never crosses interpreters", async () => {
  await pair(async ({ mode }) => {
    expect(await mode.cell.run("x = 41\nllm(['first', 'second'])", "one")).toMatchObject({ status: "completed", value: "['answer:first', 'answer:second']" });
    expect(await mode.cell.run("x + 1", "one")).toMatchObject({ status: "completed", value: "42" });
    expect(await mode.cell.run("x", "two")).toMatchObject({ status: "raised" });
  }, { llm: async (prompts) => prompts.map((prompt) => `answer:${prompt}`) });
});
