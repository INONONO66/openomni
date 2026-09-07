import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, fail, object, sha, text, type Json } from "./input";
const receipts: {
  pid: number;
  exitCode: number;
  operation: string;
  inputHash: string;
  outputHash: string;
}[] = [];
export function toolReceipts() {
  return receipts.splice(0);
}

/** Native analyzer objects cross only the validated JSON boundary. File-backed
 * transfer avoids Bun 1.3.6 synchronous-pipe truncation for large source maps. */
export function invokeTool(request: Json): Json {
  const directory = mkdtempSync(join(tmpdir(), "quality-analyzer-"));
  try {
    const input = JSON.stringify(request);
    const requestPath = join(directory, "request.json"), responsePath = join(directory, "response.json");
    writeFileSync(requestPath, input, { flag: "wx" });
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "tool-runner.mjs"), requestPath, responsePath], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    const stderr = child.stderr.toString();
    if (child.signalCode || stderr || ![0, 2].includes(child.exitCode))
      fail("analyzer", "", `analyzer process exit ${child.exitCode}: ${stderr}`);
    const response = readFileSync(responsePath, "utf8");
    const output = object(decode(response));
    if (child.exitCode !== 0 || output.ok !== true) fail("analyzer", "", text(output.message));
    if (output.result === undefined) fail("analyzer", "", "missing analyzer result");
    receipts.push({ pid: child.pid, exitCode: child.exitCode, operation: text(object(request).operation), inputHash: sha(input), outputHash: sha(response) });
    return output.result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
