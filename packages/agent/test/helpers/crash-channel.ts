import { readSync, writeSync } from "node:fs";
import { bounded } from "./bounded";

/** Parent installs stdout and exit subscriptions before releasing this start gate. */
export function awaitCrashStart(): void {
  const command = Buffer.alloc(1);
  if (readSync(0, command, 0, 1, null) !== 1 || command.toString() !== "S")
    throw new Error("crash worker start channel closed");
}

/** The open stdin channel holds the exact synchronous commit seam until SIGKILL. */
export function holdCrashBarrier(value: string): never {
  writeSync(1, `${value}\n`);
  const command = Buffer.alloc(1);
  readSync(0, command, 0, 1, null);
  throw new Error("crash barrier released without SIGKILL");
}

async function line(reader: {
  read(): Promise<{ done: false; value: Uint8Array<ArrayBuffer> } | { done: true; value?: Uint8Array<ArrayBuffer> }>;
}): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("child exited before subscribed crash barrier");
    output += decoder.decode(chunk.value, { stream: true });
  }
  return output.slice(0, output.indexOf("\n"));
}

export async function killAtCrashBarrier(worker: string, args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, worker, ...args], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const exit = child.exited;
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const cut = line(reader);
  child.stdin.write("S");
  try {
    const output = await bounded(cut, "subscribed crash barrier", 30_000);
    child.kill("SIGKILL");
    await bounded(exit, "SIGKILL exit", 30_000);
    const stderr = await errors;
    if (child.signalCode !== "SIGKILL" || stderr !== "")
      throw new Error(`unexpected crash exit: ${child.signalCode}: ${stderr}`);
    return output;
  } finally {
    reader.releaseLock();
    // Failure cleanup is not a campaign cut and must not be recorded as one.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    child.stdin.end();
  }
}
