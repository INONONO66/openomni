/**
 * Format-aware outbound chunking. Replaces the naive length splitter: a split
 * that lands inside a fenced code block closes the fence at the chunk edge
 * and reopens it (with its info string) at the head of the next chunk, so
 * every chunk renders as valid markdown on its own.
 */

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;

/** Fence close + reopen bookkeeping must fit; real surface limits are >=2000. */
const MIN_CHUNK_LENGTH = 64;

export class ChunkLengthError extends Error {
  constructor(maxLength: number) {
    super(`chunkMarkdown requires maxLength >= ${MIN_CHUNK_LENGTH}, got ${maxLength}`);
    this.name = "ChunkLengthError";
  }
}

type Fence = { readonly marker: string; readonly info: string };

/** Fence state after emitting `line` while the state was `fence`. */
function fenceAfterLine(line: string, fence: Fence | undefined): Fence | undefined {
  const match = FENCE_OPEN.exec(line);
  if (!match) return fence;
  const marker = match[1] ?? "";
  const info = (match[2] ?? "").trim();
  if (fence === undefined) return { marker, info };
  const closes =
    marker.charAt(0) === fence.marker.charAt(0) &&
    marker.length >= fence.marker.length &&
    info === "";
  return closes ? undefined : fence;
}

class ChunkBuilder {
  private readonly chunks: string[] = [];
  private lines: string[] = [];
  private bodyLength = 0;
  private fence: Fence | undefined;

  constructor(private readonly maxLength: number) {}

  /** Total chunk length if `line` were appended (separator + closing fence). */
  private lengthWith(line: string): number {
    const next = fenceAfterLine(line, this.fence);
    const separator = this.lines.length === 0 ? 0 : 1;
    const closer = next === undefined ? 0 : next.marker.length + 1;
    return this.bodyLength + separator + line.length + closer;
  }

  private append(line: string): void {
    this.bodyLength += (this.lines.length === 0 ? 0 : 1) + line.length;
    this.lines.push(line);
    this.fence = fenceAfterLine(line, this.fence);
  }

  /** Close the current chunk, reopening an interrupted fence in the next one. */
  private flush(): void {
    if (this.lines.length === 0) return;
    const fence = this.fence;
    const body =
      fence === undefined ? this.lines.join("\n") : `${this.lines.join("\n")}\n${fence.marker}`;
    this.chunks.push(body);
    this.lines = [];
    this.bodyLength = 0;
    this.fence = undefined;
    if (fence !== undefined) this.append(`${fence.marker}${fence.info}`);
  }

  push(line: string): void {
    if (this.lines.length > 0 && this.lengthWith(line) > this.maxLength) this.flush();
    if (this.lengthWith(line) <= this.maxLength) {
      this.append(line);
      return;
    }
    // The line alone exceeds the budget: hard-split it into raw slices sized
    // to fit alongside worst-case fence bookkeeping.
    const sliceLength = this.maxLength - MIN_CHUNK_LENGTH / 2;
    for (let at = 0; at < line.length; at += sliceLength) {
      const slice = line.slice(at, at + sliceLength);
      if (this.lines.length > 0 && this.lengthWith(slice) > this.maxLength) this.flush();
      this.append(slice);
    }
  }

  finish(): string[] {
    this.flush();
    return this.chunks;
  }
}

/**
 * Split markdown into delivery-sized chunks at line boundaries, keeping every
 * chunk independently valid: an open code fence is closed at the edge and
 * reopened (with its info string) in the following chunk.
 */
export function chunkMarkdown(text: string, maxLength: number): string[] {
  if (maxLength < MIN_CHUNK_LENGTH) throw new ChunkLengthError(maxLength);
  if (text.length <= maxLength) return [text];
  const builder = new ChunkBuilder(maxLength);
  for (const line of text.split("\n")) builder.push(line);
  return builder.finish();
}
