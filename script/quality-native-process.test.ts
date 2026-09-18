import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeFailure, nativeJson } from "./quality-native-process";

test("native failure detail prefers bounded structured errors and raw fallback", () => {
	expect(nativeFailure('{"errors":[{"code":"one"},{"code":"two"}]}', "raw")).toContain('"code":"one"');
	expect(nativeFailure("not json", "raw diagnostic")).toBe("raw diagnostic");
});

test("native JSON preserves argument boundaries and measured nonzero exits", async () => {
	const result = await nativeJson({
		command: [process.execPath, "-e", "console.log(JSON.stringify({complete:true,args:process.argv.slice(1)}));process.exit(1)", "--", "space value", "--flag"],
		cwd: import.meta.dir,
	});
	expect(result.exitCode).toBe(1);
	expect(result.document).toEqual({ complete: true, args: ["space value", "--flag"] });
	expect(result.stdoutHash).toHaveLength(64);
});

test("native JSON streams stderr before child exit and preserves it in the receipt", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "native-progress-"));
	try {
		// The child announces "ready" only after its socket is listening, and
		// completes on the connection that the stderr chunk triggers: an explicit
		// handshake, so the assertion never depends on watcher or scheduler timing.
		const socket = join(cwd, "release.sock");
		const result = await nativeJson({
			command: [process.execPath, "-e", `
				import { createServer } from "node:net";
				const server = createServer((connection) => {
					connection.end();
					server.close(() => console.log('{"complete":true}'));
				});
				server.listen(${JSON.stringify(socket)}, () => process.stderr.write("ready"));
			`],
			cwd,
			timeout: 5000,
			onStderr: () => { connect(socket).on("error", (error) => { throw error; }); },
		});
		expect(result.stderr).toBe("ready");
		expect(result.document).toEqual({ complete: true });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("native JSON reports compact census errors", async () => {
	await expect(nativeJson({
		command: [process.execPath, "-e", "console.log(JSON.stringify({errors:[{code:'first'}, {code:'second'}]}));process.exit(2)"],
		cwd: import.meta.dir,
	})).rejects.toMatchObject({
		code: "native_process",
		message: 'exit 2: {"code":"first"}; {"code":"second"}',
	});
});

test("native JSON rejects infrastructure failures and missing output", async () => {
	for (const code of [
		"process.exit(2)",
		"console.log('{}');process.exit(2)",
		"console.log('not JSON')",
		"process.kill(process.pid,'SIGTERM')",
	]) {
		await expect(nativeJson({
			command: [process.execPath, "-e", code],
			cwd: import.meta.dir,
		})).rejects.toThrow();
	}
});
