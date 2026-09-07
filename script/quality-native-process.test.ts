import { expect, test } from "bun:test";
import { nativeJson } from "./quality-native-process";

test("native JSON preserves argument boundaries and measured nonzero exits", async () => {
	const result = await nativeJson({
		command: [process.execPath, "-e", "console.log(JSON.stringify({complete:true,args:process.argv.slice(1)}));process.exit(1)", "--", "space value", "--flag"],
		cwd: import.meta.dir,
	});
	expect(result.exitCode).toBe(1);
	expect(result.document).toEqual({ complete: true, args: ["space value", "--flag"] });
	expect(result.stdoutHash).toHaveLength(64);
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
