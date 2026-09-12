import { writeFileSync } from "node:fs";
import { decodeJson, digest, InventoryError, type Json } from "./quality-inventory";

type NativeInput = {
	command: string[];
	cwd: string;
	timeout?: number;
	receipt?: string;
	onStderr?: (chunk: Uint8Array) => void;
};
function structuredFailure(stdout: string): string | undefined {
	try {
		const parsed = decodeJson(stdout);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.errors))
			return parsed.errors.slice(0, 20).map((error: Json) => JSON.stringify(error).slice(0, 400)).join("; ");
	} catch {}
	return undefined;
}
export function nativeFailure(stdout: string, stderr: string): string {
	return structuredFailure(stdout) ?? (stderr || stdout).slice(0, 4096);
}
/** Exit 1 is a complete measurement with findings, not infrastructure success. */
export async function nativeJson(input: NativeInput) {
	const child = Bun.spawn(input.command, {
		cwd: input.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: input.timeout ?? 1_800_000,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) { input.onStderr?.(chunk); controller.enqueue(chunk); },
		}))).text(),
		child.exited,
	]);
	if (input.receipt) writeFileSync(input.receipt, JSON.stringify({ command: input.command, cwd: input.cwd, runtime: Bun.version, exitCode, signal: child.signalCode, stdout, stderr }), { flag: "wx" });
	if (child.signalCode || ![0, 1].includes(exitCode)) {
		throw new InventoryError(
			"native_process",
			input.command[0] ?? "",
			`${child.signalCode ? `signal ${child.signalCode}` : `exit ${exitCode}`}: ${nativeFailure(stdout, stderr).slice(0, 4096)}`,
		);
	}
	return {
		command: input.command, exitCode, stderr,
		stdoutHash: digest(stdout),
		document: decodeJson(stdout),
	};
}
