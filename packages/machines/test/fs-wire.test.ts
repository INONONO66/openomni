import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIpcServer, typedCall } from "@openomni/ipc";
import { Machine } from "@openomni/protocol";
import { attachMachineDaemon, createMachineHost, MachineRefusalError } from "../src/index";
import { socketPath } from "./helpers/socket-path";

const silent = { publish() { return; } };
const capabilities = ["fs.read", "fs.write", "shell.exec", "kernel.py"];
function enrollment(): Machine.Enrollment {
  return { machineId: "m-1", name: "workstation", allowedCapabilities: capabilities, allowedExports: ["docs"], enrolledAt: 1 };
}
function offer(root: string, changes: Partial<Machine.Offer> = {}): Machine.Offer {
  return { machineId: "m-1", offeredCapabilities: capabilities, exports: [{ name: "docs", path: root }], daemonVersion: "test", platform: "darwin-arm64", offeredAt: 2, ...changes };
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "om-wire-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("real machine consumer surface", () => {
  test("write/read/list/stat preserve binary bytes and raw metadata", async () => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await createMachineHost({ socketPath: path, enrollment, events: silent, now: () => 3 });
      const daemon = await attachMachineDaemon({ socketPath: path, offer: offer(root), fsExports: new Map([["docs", root]]) });
      try {
        const target = host.get("m-1");
        const bytes = Buffer.from([0, 255, 128, 10, 65]);
        expect(await target.fs.write(join(root, "data"), bytes)).toEqual({ op: "write", bytesWritten: 5 });
        expect(await target.fs.read(join(root, "data"))).toEqual({ op: "read", data: bytes, bytesRead: 5, size: 5, truncated: false });
        expect(await target.fs.list(root)).toEqual({ op: "list", entries: [{ name: "data", kind: "file", size: 5 }], truncated: false });
        expect(await target.fs.stat(join(root, "data"))).toMatchObject({ op: "stat", kind: "file", size: 5 });
        expect(await target.fs.write(join(root, "data"), Buffer.from("x"))).toEqual({ op: "write", bytesWritten: 1 });
        expect((await target.fs.read(join(root, "data"))).data).toEqual(Buffer.from("x"));
        await expect(target.fs.read("/outside-export")).rejects.toMatchObject({ name: "MachineRefusalError", data: { reason: "export_not_available" } });
        await expect(target.fs.write(join(root, "large"), Buffer.alloc(Machine.FS_WRITE_MAX_BYTES + 1))).rejects.toMatchObject({ name: "MachineRefusalError", data: { reason: "too_large" } });
      } finally { await daemon.close(); host.close(); }
    });
  });

  test("unattached handles throw typed refusal and a capability fold grants no extra authority", async () => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await createMachineHost({ socketPath: path, enrollment: () => ({ ...enrollment(), allowedCapabilities: ["fs.read"] }), events: silent, now: () => 3 });
      await expect(host.get("missing").fs.stat(root)).rejects.toBeInstanceOf(MachineRefusalError);
      const daemon = await attachMachineDaemon({ socketPath: path, offer: offer(root), fsExports: new Map([["docs", root]]) });
      try {
        await expect(host.get("m-1").fs.write(join(root, "no"), Buffer.from("no"))).rejects.toMatchObject({ name: "MachineRefusalError", data: { reason: "fs_not_available" } });
        expect(await host.get("m-1").exec("echo no", root)).toEqual({ status: "refused", reason: "exec_not_available" });
        expect(await host.get("m-1").runCode({ cellId: "no", code: "no", timeoutMs: 1000 })).toEqual({ status: "refused", reason: "kernel_not_available" });
      } finally { await daemon.close(); host.close(); }
    });
  });

  test("exec uses each explicit cwd and returns independent stdout, stderr, exit and signal", async () => {
    await fixture(async (root) => {
      const a = join(root, "a"); const b = join(root, "b");
      mkdirSync(a); mkdirSync(b); writeFileSync(join(a, "mark"), "A"); writeFileSync(join(b, "mark"), "B");
      const path = socketPath();
      const host = await createMachineHost({ socketPath: path, enrollment, events: silent, now: () => 3 });
      const daemon = await attachMachineDaemon({ socketPath: path, offer: offer(root), fsExports: new Map([["docs", root]]) });
      try {
        const target = host.get("m-1");
        await expect(target.exec("true", "/tmp")).resolves.toEqual({ status: "refused", reason: "path_escapes_export" });
        expect(await target.exec("cat mark; printf err >&2; cd /; exit 7", a)).toEqual({ status: "completed", stdout: Buffer.from("A"), stderr: Buffer.from("err"), exitCode: 7, signal: null, truncated: false });
        expect(await target.exec("cat mark", b)).toMatchObject({ status: "completed", stdout: Buffer.from("B"), exitCode: 0 });
        expect(await target.exec("cat mark", a)).toMatchObject({ status: "completed", stdout: Buffer.from("A") });
        expect(await target.exec("kill -TERM $$", a)).toMatchObject({ status: "completed", exitCode: null, signal: "SIGTERM" });
        expect(await target.exec("true", join(root, "absent"))).toEqual({ status: "refused", reason: "io_error" });
        symlinkSync("/tmp", join(root, "outside"));
        await expect(target.exec("true", join(root, "outside"))).resolves.toEqual({ status: "refused", reason: "path_escapes_export" });
        const capped = await target.exec("yes x", root);
        expect(capped.status).toBe("completed");
        if (capped.status !== "completed") throw new Error("expected a capped execution result");
        expect(capped.truncated).toBe(true);
        expect(capped.stdout.length + capped.stderr.length).toBe(Machine.EXEC_MAX_BYTES);
      } finally { await daemon.close(); host.close(); }
    });
  });
});

test("longest normalized root wins, and equal roots refuse rather than selecting arbitrarily", async () => {
  await fixture(async (root) => {
    const nested = join(root, "nested"); mkdirSync(nested);
    const path = socketPath();
    const host = await createMachineHost({ socketPath: path, enrollment, events: silent, now: () => 3 });
    const daemon = await attachMachineDaemon({ socketPath: path, offer: offer(root, { exports: [{ name: "docs", path: root }, { name: "private", path: `${nested}/./` }] }), fsExports: new Map([["docs", root], ["private", `${nested}/./`]]) });
    try {
      await expect(host.get("m-1").fs.stat(nested)).rejects.toMatchObject({ name: "MachineRefusalError", data: { reason: "export_not_available" } });
    } finally { await daemon.close(); }
    const duplicate = await attachMachineDaemon({ socketPath: path, offer: offer(root, { exports: [{ name: "docs", path: root }, { name: "alias", path: `${root}/./` }] }) });
    try {
      await expect(host.get("m-1").fs.stat(root)).rejects.toMatchObject({ name: "MachineRefusalError", data: { reason: "ambiguous_export" } });
    } finally { await duplicate.close(); host.close(); }
  });
});

describe("daemon boundary cannot be bypassed by a rogue host", () => {
  test.each(["read", "write"] as const)("rechecks %s capabilities even when the host fabricates an effective grant", async (op) => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await createIpcServer(path, (_method, _params, respond) => respond({ status: "attached", effectiveCapabilities: capabilities, effectiveExports: ["docs"] }));
      const daemon = await attachMachineDaemon({ socketPath: path, offer: offer(root, { offeredCapabilities: [] }), fsExports: new Map([["docs", root]]) });
      try {
        const request: Machine.FsRequest = op === "write" ? { op, export: "docs", path: "file", data: "eA==" } : { op, export: "docs", path: "file" };
        expect(await typedCall(host, "machine.fs_op", request)).toMatchObject({ status: "refused", reason: "fs_not_available" });
        expect(await typedCall(host, "machine.exec", { cmd: "echo no", cwd: root })).toEqual({ status: "refused", reason: "exec_not_available" });
        expect(await typedCall(host, "machine.run_code", { cellId: "no", code: "no", timeoutMs: 1000 })).toEqual({ status: "refused", reason: "kernel_not_available" });
      } finally { await daemon.close(); host.close(); }
    });
  });

  test.each(["offer", "enrollment"] as const)("rechecks the %s export ceiling over real wire", async (missing) => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await createIpcServer(path, (_method, _params, respond) => respond({ status: "attached", effectiveCapabilities: capabilities, effectiveExports: missing === "enrollment" ? [] : ["docs"] }));
      const daemon = await attachMachineDaemon({ socketPath: path, offer: offer(root, missing === "offer" ? { exports: [] } : {}), fsExports: new Map([["docs", root]]) });
      try {
        expect(await typedCall(host, "machine.fs_op", { op: "write", export: "docs", path: "file", data: "eA==" })).toMatchObject({ status: "refused", reason: "export_not_available" });
        expect(await typedCall(host, "machine.exec", { cmd: "true", cwd: root })).toEqual({ status: "refused", reason: "path_escapes_export" });
      } finally { await daemon.close(); host.close(); }
    });
  });

  test("connection failure closes the injected runner", async () => {
    let closed = 0;
    await expect(attachMachineDaemon({ socketPath: socketPath(), offer: offer("/tmp"), runner: { runCode: async (request) => ({ status: "cancelled", cellId: request.cellId }), close: async () => { closed += 1; } } })).rejects.toMatchObject({ name: "IpcConnectionError" });
    expect(closed).toBe(1);
  });
});
