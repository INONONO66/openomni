import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createMachineHost } from "@openomni/machines";
import { Machine } from "@openomni/protocol";
import { composeCodemode } from "../src/composition/codemode";
import { modelToolOutput } from "./helpers/tool-dispatch";
import { socketPath } from "./helpers/socket-path";

test("machine attach CLI composes real runners; run_code pipelines two machine handles", async () => {
  const base = mkdtempSync(join(tmpdir(), "om-cli-machine-"));
  const rootA = join(base, "a"); const rootB = join(base, "b"); mkdirSync(rootA); mkdirSync(rootB);
  const path = socketPath();
  const capabilities = ["fs.read", "fs.write", "shell.exec", "kernel.py"];
  let cells: ReturnType<typeof composeCodemode>;
  const host = await createMachineHost({ socketPath: path, enrollment: (id) => ({ machineId: id, name: id, tags: [id], allowedCapabilities: capabilities, allowedExports: ["data"], enrolledAt: 1 }), events: { publish() { return; } }, now: () => 2, callTool: (call) => cells.callTool(call) });
  cells = composeCodemode(host);
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<void>[] = [];
  async function attach(id: string, root: string) {
    const configPath = join(base, `${id}.json`);
    writeFileSync(configPath, JSON.stringify({ socketPath: path, offer: { machineId: id, offeredCapabilities: capabilities, exports: [{ name: "data", path: root }], daemonVersion: "qa", platform: `${process.platform}-${process.arch}`, offeredAt: 2 } }));
    const child = spawn(process.execPath, [join(import.meta.dir, "../src/cli/main.ts"), "machine", "attach", configPath], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`machine CLI exited ${code}/${signal}`)));
    });
    exits.push(exited);
    const lines = createInterface({ input: child.stdout });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    try {
      const line = await Promise.race([once(lines, "line", { signal: AbortSignal.timeout(10_000) }), exited.then(() => { throw new Error(`machine CLI ended before attachment: ${errors}`); })]);
      expect(Machine.AttachResult.parse(JSON.parse(String(line[0])))).toMatchObject({ status: "attached", effectiveCapabilities: [...capabilities].sort() });
    } finally { lines.close(); }
  }
  try {
    await attach("A", rootA); await attach("B", rootB);
    const code = [
      "ids = [m['machineId'] for m in codemode.listMachines()]",
      "src = codemode.findMachine({'tag': 'A'})",
      "dst = codemode.getMachine('B')",
      `src.write(${JSON.stringify(join(rootA, "source"))}, bytes([0, 255, 128, 65]))`,
      `data = src.read(${JSON.stringify(join(rootA, "source"))})['data']`,
      `written = dst.write(${JSON.stringify(join(rootB, "copy"))}, data)`,
      `readback = dst.read(${JSON.stringify(join(rootB, "copy"))})['data']`,
      `shell = dst.shell('printf out; printf err >&2; exit 7', ${JSON.stringify(rootB)})`,
      "nested = dst.run('6 * 7')",
      "state = 41",
      "(ids, list(readback), written['bytesWritten'], shell['stdout'], shell['stderr'], shell['exitCode'], nested['value'])",
    ].join("\n");
    const run = modelToolOutput("run_code", { cells }, { role: "resident", depth: 0, sessionId: "qa-one" });
    const result = await run({ code, timeoutMs: 10_000 });
    expect(result).toBe("(['A', 'B'], [0, 255, 128, 65], 4, b'out', b'err', 7, '42')");
    expect(await run({ code: "state + 1", timeoutMs: 1000 })).toBe("42");
    const other = await modelToolOutput("run_code", { cells }, { role: "resident", depth: 0, sessionId: "qa-two" })({ code: "state", timeoutMs: 1000 });
    expect(other).toContain("NameError");
    const write = await host.get("B").fs.write(join(rootB, "receipt"), Buffer.from([0, 255, 128, 65]));
    const execution = await host.get("B").exec("printf out; printf err >&2; exit 7", rootB);
    if (execution.status !== "completed") throw new Error("QA exec did not complete");
    const codeResult = await host.get("B").runCode({ cellId: "qa-code", code: "6 * 7", tenant: "qa-raw", timeoutMs: 1000 });
    expect(codeResult).toMatchObject({ status: "completed", value: "42" });
    console.log("machines-codemode QA", JSON.stringify({ list: host.list(), write, readback: [...(await host.get("B").fs.read(join(rootB, "copy"))).data], exec: { stdout: [...execution.stdout], stderr: [...execution.stderr], exitCode: execution.exitCode, signal: execution.signal }, runCode: codeResult, result, tenantIsolation: "NameError", daemonPids: children.map((child) => child.pid) }));
  } finally {
    await cells.close();
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(exits);
    host.close();
    rmSync(base, { recursive: true, force: true });
    console.log("machines-codemode cleanup", JSON.stringify({ daemonExits: exits.length, socketExists: existsSync(path), directoryExists: existsSync(base) }));
  }
}, 30_000);
