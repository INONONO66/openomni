import { IpcProtocolError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 16 MiB — reject any single frame that exceeds this before unbounded growth
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encode(msg: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(msg)}\n`);
}

export class LineDecoder {
  private buffer = "";

  push(chunk: string | Uint8Array): unknown[] {
    this.buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk);

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    if (encoder.encode(this.buffer).byteLength > MAX_FRAME_BYTES) {
      this.buffer = "";
      throw new IpcProtocolError(`IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes`);
    }

    return lines
      .filter((l) => l.trim())
      .map((l) => {
        if (encoder.encode(l).byteLength > MAX_FRAME_BYTES) {
          throw new IpcProtocolError(`IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes`);
        }
        return JSON.parse(l);
      });
  }

  reset(): void {
    this.buffer = "";
  }
}
