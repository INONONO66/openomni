export namespace Overflow {
  const PATTERNS: ReadonlyArray<RegExp> = [
    /prompt is too long/i,
    /exceeds the (context window|maximum)/i,
    /context.length.exceeded/i,
    /maximum context length is \d+ tokens/i,
    /request entity too large/i,
  ];

  export function detect(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return PATTERNS.some((p) => p.test(msg));
  }
}
