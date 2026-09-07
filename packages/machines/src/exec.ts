import { spawn } from "node:child_process";
import { Machine } from "@openomni/protocol";

/** A shell is machine authority, not an export sandbox. Cwd is explicit per call. */
export function execute(
  request: Machine.ExecRequest,
  signal: AbortSignal,
): Promise<Machine.ExecResult> {
  if (signal.aborted) return Promise.resolve({ status: "cancelled" });
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", request.cmd], {
      cwd: request.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let terminal: "timed_out" | "cancelled" | undefined;
    let failed = false;
    const kill = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "ESRCH" || error.code === "EPERM")
          )
            child.kill("SIGKILL");
          else throw error;
        }
      }
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = Machine.EXEC_MAX_BYTES - size;
      target.push(chunk.subarray(0, remaining));
      size += Math.min(remaining, chunk.length);
      if (chunk.length > remaining) {
        truncated = true;
        kill();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const abort = () => {
      terminal = "cancelled";
      kill();
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      terminal = "timed_out";
      kill();
    }, Machine.EXEC_TIMEOUT_MS);
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failed) resolve({ status: "refused", reason: "io_error" });
      else if (terminal !== undefined) resolve({ status: terminal });
      else
        resolve({
          status: "completed",
          stdout: Buffer.concat(stdout).toString("base64"),
          stderr: Buffer.concat(stderr).toString("base64"),
          exitCode,
          signal: exitSignal,
          truncated,
        });
    });
  });
}
