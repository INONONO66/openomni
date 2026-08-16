import { IpcProtocolError } from "./errors";

const encoder = new TextEncoder();

// 16 MiB — reject any single frame that exceeds this before unbounded growth
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// Cap each reported malformed line so error reporting stays bounded.
const MALFORMED_REPORT_CHARS = 64;

export function encode(msg: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(msg)}\n`);
}

export type DecodedChunk = {
  /** Every parseable frame in the chunk, delivered immediately, in wire order. */
  frames: unknown[];
  /** Each non-JSON line, truncated to 64 chars for reporting — never re-queued. */
  malformed: string[];
};

export class LineDecoder {
  private buffer = "";
  private decoder = new TextDecoder();

  /**
   * Decode a chunk into complete frames. A malformed line costs only itself:
   * every parseable sibling in the chunk still delivers, in order, and the bad
   * line lands in `malformed` for the caller to report. Oversize lines and
   * oversize buffers stay reset+throw — that path is a DoS guard, not a
   * per-frame failure, and it deliberately drops the whole decode buffer.
   */
  push(chunk: string | Uint8Array): DecodedChunk {
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
    const malformed: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf-8") > MAX_FRAME_BYTES) {
        this.reset();
        throw new IpcProtocolError(`IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes`);
      }
      try {
        frames.push(JSON.parse(line));
      } catch {
        malformed.push(line.slice(0, MALFORMED_REPORT_CHARS));
      }
    }
    return { frames, malformed };
  }

  reset(): void {
    this.buffer = "";
    this.decoder = new TextDecoder();
  }
}
