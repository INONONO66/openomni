import { IpcProtocolError } from "./errors";

const encoder = new TextEncoder();

// 16 MiB — reject any single frame that exceeds this before unbounded growth
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encode(msg: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(msg)}\n`);
}

export class LineDecoder {
  private buffer = "";
  private decoder = new TextDecoder();

  push(chunk: string | Uint8Array): unknown[] {
    if (typeof chunk === "string") {
      // String chunks cannot complete a pending byte sequence; discard stale decoder state.
      this.decoder = new TextDecoder();
      this.buffer += chunk;
    } else {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    }

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    if (Buffer.byteLength(this.buffer, "utf-8") > MAX_FRAME_BYTES) {
      this.reset();
      throw new IpcProtocolError(`IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes`);
    }

    return lines
      .filter((l) => l.trim())
      .map((l) => {
        if (Buffer.byteLength(l, "utf-8") > MAX_FRAME_BYTES) {
          this.reset();
          throw new IpcProtocolError(`IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes`);
        }
        return JSON.parse(l);
      });
  }

  reset(): void {
    this.buffer = "";
    this.decoder = new TextDecoder();
  }
}
