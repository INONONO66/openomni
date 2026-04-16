const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(msg: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(msg)}\n`);
}

export class LineDecoder {
  private buffer = "";

  push(chunk: string | Uint8Array): unknown[] {
    this.buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  reset(): void {
    this.buffer = "";
  }
}
