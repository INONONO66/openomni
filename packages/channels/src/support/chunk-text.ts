export function splitText(text: string, maxLength: number): string[] {
  if (maxLength < 1) throw new Error("maxLength must be at least 1");
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const newlineAt = remaining.lastIndexOf("\n", maxLength);
    if (newlineAt >= maxLength / 2) {
      // Split on the newline and drop it — it separated the chunks; keeping
      // it would prepend every subsequent chunk with a blank first line.
      chunks.push(remaining.slice(0, newlineAt));
      remaining = remaining.slice(newlineAt + 1);
    } else {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
  }

  return chunks;
}
