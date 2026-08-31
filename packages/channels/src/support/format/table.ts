/**
 * GFM pipe-table rewriting for surfaces that cannot render tables natively
 * (Discord has no table markup; Telegram MarkdownV2 has none either). Tables
 * become bold-heading + bullet groups in STANDARD markdown, so the result can
 * feed a downstream renderer (e.g. MarkdownV2 conversion) unchanged. Tables
 * inside fenced code blocks are never touched.
 */

const SEPARATOR_CELL = /^:?-+:?$/;
const FENCE_LINE = /^\s*(?:`{3,}|~{3,})/;

function isTableRow(line: string): boolean {
  return line.includes("|");
}

/** Cell-wise check (`---`, `:-:`, ...) — linear, no backtracking ambiguity. */
function isSeparatorRow(line: string | undefined): line is string {
  if (line === undefined || !line.includes("|")) return false;
  const parts = cells(line);
  return parts.length > 0 && parts.every((cell) => SEPARATOR_CELL.test(cell));
}

/** Split one pipe row into trimmed cells, dropping the outer empty edges. */
function cells(line: string): string[] {
  const parts = line.split("|").map((cell) => cell.trim());
  if (parts.length > 0 && parts[0] === "") parts.shift();
  if (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts;
}

/** One data row -> a bold lead cell plus `header: value` bullets. */
function rowToGroup(header: readonly string[], row: readonly string[]): string {
  const lead = row[0] ?? "";
  const bullets = header
    .slice(1)
    .map((name, index) => `- ${name}: ${row[index + 1] ?? ""}`)
    .join("\n");
  return bullets === "" ? `**${lead}**` : `**${lead}**\n${bullets}`;
}

function renderTable(lines: readonly string[]): string {
  const header = cells(lines[0] ?? "");
  const groups = lines.slice(2).map((line) => rowToGroup(header, cells(line)));
  if (groups.length === 0) return header.map((name) => `**${name}**`).join("\n");
  return groups.join("\n\n");
}

/**
 * Rewrite every GFM pipe table outside code fences into bullet groups.
 * Anything that does not parse as a table (no separator row) passes through
 * byte-for-byte — this function never loses content.
 */
export function tablesToBullets(text: string): string {
  if (!(text.includes("|") && text.includes("-"))) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (FENCE_LINE.test(line)) inFence = !inFence;
    const next = lines[index + 1];
    const startsTable = !inFence && isTableRow(line) && isSeparatorRow(next);
    if (!startsTable) {
      out.push(line);
      index += 1;
      continue;
    }
    const table: string[] = [line, next];
    index += 2;
    while (index < lines.length && isTableRow(lines[index] ?? "")) {
      table.push(lines[index] ?? "");
      index += 1;
    }
    out.push(renderTable(table));
  }
  return out.join("\n");
}
