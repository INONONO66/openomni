const ALPHABET = "ZPMQVRWSNKTXJBYH";

type Hasher = (input: string, seed: number) => number;

const DEFAULT_HASHER: Hasher = (input, seed) =>
  (globalThis as unknown as { Bun: { hash: { xxHash32: Hasher } } }).Bun.hash.xxHash32(
    input,
    seed,
  ) >>> 0;

type ParsedRef = {
  lineNumber: number;
  expectedHash: string;
};

const REF_PATTERN = /^([1-9]\d*)#([ZPMQVRWSNKTXJBYH]{2})$/;

const parseRef = (ref: string): ParsedRef | null => {
  const match = REF_PATTERN.exec(ref);
  if (!match) {
    return null;
  }
  const [, lineNumber, expectedHash] = match;
  if (lineNumber == null || expectedHash == null) {
    return null;
  }

  return {
    lineNumber: Number(lineNumber),
    expectedHash,
  };
};

const normalize = (content: string) => content.replace(/\s/g, "");

const lineNumberWidth = (lineCount: number) => String(Math.max(1, lineCount)).length;

export namespace Hashline {
  export type EditOp =
    | { op: "replace"; pos: string; end?: string; lines: string[] }
    | { op: "append"; pos: string; lines: string[] }
    | { op: "prepend"; pos: string; lines: string[] };

  export const computeHash = (
    lineNumber: number,
    content: string,
    hasher: Hasher = DEFAULT_HASHER,
  ): string => {
    const normalized = normalize(content);

    if (normalized.length === 0) {
      const char1 = ALPHABET.charAt(lineNumber & 0xf);
      const char2 = ALPHABET.charAt((lineNumber >>> 4) & 0xf);
      return `${char1}${char2}`;
    }

    const n = hasher(normalized, lineNumber) >>> 0;
    const char1 = ALPHABET.charAt(n & 0xf);
    const char2 = ALPHABET.charAt((n >>> 4) & 0xf);
    return `${char1}${char2}`;
  };

  export const format = (text: string, hasher: Hasher = DEFAULT_HASHER): string => {
    const lines = text.split("\n");
    const width = lineNumberWidth(lines.length);

    return lines
      .map((line, index) => {
        const lineNumber = index + 1;
        const hash = computeHash(lineNumber, line, hasher);
        return `${String(lineNumber).padStart(width, " ")}#${hash}│ ${line}`;
      })
      .join("\n");
  };

  export const formatRange = (
    text: string,
    from: number,
    to: number,
    hasher: Hasher = DEFAULT_HASHER,
  ): string => {
    if (from > to) {
      return "";
    }

    const lines = text.split("\n");
    const width = lineNumberWidth(lines.length);
    const start = Math.max(1, from);
    const end = Math.min(to, lines.length);

    if (start > end) {
      return "";
    }

    const output: string[] = [];

    for (let lineNumber = start; lineNumber <= end; lineNumber++) {
      const line = lines[lineNumber - 1] ?? "";
      const hash = computeHash(lineNumber, line, hasher);
      output.push(`${String(lineNumber).padStart(width, " ")}#${hash}│ ${line}`);
    }

    return output.join("\n");
  };

  export const validateRef = (
    lines: string[],
    ref: string,
    hasher: Hasher = DEFAULT_HASHER,
  ): { valid: true } | { valid: false; current: string } => {
    const parsed = parseRef(ref);
    if (!parsed) {
      return { valid: false, current: ref };
    }

    const line = lines[parsed.lineNumber - 1] ?? "";
    const currentHash = computeHash(parsed.lineNumber, line, hasher);

    if (currentHash === parsed.expectedHash) {
      return { valid: true };
    }

    return {
      valid: false,
      current: `${parsed.lineNumber}#${currentHash}`,
    };
  };

  export const applyEdits = (
    content: string,
    edits: EditOp[],
    hasher: Hasher = DEFAULT_HASHER,
  ): { ok: true; content: string } | { ok: false; errors: string[] } => {
    const lines = content.split("\n");
    const errors: string[] = [];
    const targetedLines = new Set<number>();

    type ValidatedEdit = {
      edit: EditOp;
      posLine: number;
      endLine?: number;
    };

    const validated: ValidatedEdit[] = [];

    for (const edit of edits) {
      const pos = parseRef(edit.pos);
      if (!pos) {
        errors.push(`invalid ref: ${edit.pos}`);
        continue;
      }

      const posValidation = validateRef(lines, edit.pos, hasher);
      if (!posValidation.valid) {
        errors.push(`stale ref: ${edit.pos} (current: ${posValidation.current})`);
      }

      let endLine: number | undefined;

      if (edit.op === "replace" && edit.end !== undefined) {
        const end = parseRef(edit.end);
        if (!end) {
          errors.push(`invalid ref: ${edit.end}`);
        } else {
          const endValidation = validateRef(lines, edit.end, hasher);
          if (!endValidation.valid) {
            errors.push(`stale ref: ${edit.end} (current: ${endValidation.current})`);
          }
          endLine = end.lineNumber;
          if (endLine < pos.lineNumber) {
            errors.push(`invalid range: ${edit.pos}..${edit.end}`);
          }
        }
      }

      const startTarget = pos.lineNumber;
      const endTarget = edit.op === "replace" && endLine !== undefined ? endLine : pos.lineNumber;

      for (let target = startTarget; target <= endTarget; target++) {
        if (targetedLines.has(target)) {
          errors.push(`duplicate target line: ${target}`);
          continue;
        }
        targetedLines.add(target);
      }

      validated.push({ edit, posLine: pos.lineNumber, endLine });
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    const updated = [...lines];

    validated
      .sort((a, b) => b.posLine - a.posLine)
      .forEach(({ edit, posLine, endLine }) => {
        if (edit.op === "replace") {
          const start = posLine - 1;
          const deleteCount = (endLine ?? posLine) - posLine + 1;
          updated.splice(start, deleteCount, ...edit.lines);
          return;
        }

        if (edit.op === "append") {
          updated.splice(posLine, 0, ...edit.lines);
          return;
        }

        updated.splice(posLine - 1, 0, ...edit.lines);
      });

    return { ok: true, content: updated.join("\n") };
  };
}
