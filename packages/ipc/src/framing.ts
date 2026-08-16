import { IpcProtocolError } from "./errors";

const encoder = new TextEncoder();

// 16 MiB — reject any single frame that exceeds this before unbounded growth
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

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

    const frames: unknown[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line?.trim()) continue;
      if (Buffer.byteLength(line, "utf-8") > MAX_FRAME_BYTES) {
        this.reset();
        throw new IpcProtocolError(`IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes`);
      }
      try {
        frames.push(JSON.parse(line));
      } catch {
        // One malformed frame costs only itself: complete sibling lines go
        // back on the buffer (each re-terminated) ahead of the partial tail,
        // so the next push delivers them in order.
        const rest = lines.slice(i + 1);
        this.buffer = rest.map((l) => `${l}\n`).join("") + this.buffer;
        throw new IpcProtocolError(`IPC frame is not valid JSON: ${line.slice(0, 64)}`);
      }
    }
    return frames;
  }

  reset(): void {
    this.buffer = "";
    this.decoder = new TextDecoder();
  }
}
