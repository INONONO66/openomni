import { writeFileSync } from "node:fs";
import { decodeJson, digest, InventoryError } from "./quality-inventory";

/** Exit 1 is a complete measurement with findings, not infrastructure success. */
export async function nativeJson(input: {
	command: string[];
	cwd: string;
	timeout?: number;
	receipt?: string;
}) {
	const child = Bun.spawn(input.command, {
		cwd: input.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: input.timeout ?? 1_800_000,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (input.receipt) writeFileSync(input.receipt, JSON.stringify({ command: input.command, cwd: input.cwd, runtime: Bun.version, exitCode, signal: child.signalCode, stdout, stderr }), { flag: "wx" });
	if (child.signalCode || ![0, 1].includes(exitCode))
		throw new InventoryError("native_process", input.command[0] ?? "", `${exitCode}: ${stderr || stdout}`);
	return {
		command: input.command, exitCode, stderr,
		stdoutHash: digest(stdout),
		document: decodeJson(stdout),
	};
}
