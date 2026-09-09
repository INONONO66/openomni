// Execute statements separately so failures stop and roll back the migration.
const tokens =
  /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_]\w*|[^\s]/g;

// Preserve the shipped sqlite_schema bytes: historical execution omitted full-line comments.
function withoutLineComments(sql: string): string {
  let result = "";
  let start = 0;
  for (const match of sql.matchAll(tokens)) {
    if (!match[0].startsWith("--")) continue;
    const lineStart = sql.lastIndexOf("\n", match.index - 1) + 1;
    if (sql.slice(lineStart, match.index).trim().length !== 0) continue;
    result += sql.slice(start, lineStart);
    start = match.index + match[0].length + 1;
  }
  return result + sql.slice(start);
}

class StatementBoundary {
  depth = 0;
  trigger = false;
  private readonly prefix: string[] = [];

  word(token: string): void {
    const word = token.toUpperCase();
    if (this.prefix.length < 3) this.prefix.push(word);
    if (this.prefix.join(" ").match(/^CREATE (?:TEMP |TEMPORARY )?TRIGGER$/)) this.trigger = true;
    if (!this.trigger) return;
    if (word === "BEGIN" || word === "CASE") this.depth += 1;
    if (word === "END") this.depth -= 1;
  }
}

export function migrationStatements(source: string): string[] {
  const sql = withoutLineComments(source);
  const statements: string[] = [];
  let boundary = new StatementBoundary();
  let start = 0;
  let parts = "";
  let hasContent = false;
  for (const match of sql.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith("--") || token.startsWith("/*")) continue;
    if (["'", '"', "`", "["].includes(token) || (token === "/" && sql[match.index + 1] === "*")) {
      throw new Error("unterminated migration token");
    }
    if (token !== ";") {
      hasContent = true;
      boundary.word(token);
      continue;
    }
    parts += sql.slice(start, match.index).trim();
    start = match.index + 1;
    if (boundary.trigger) parts += ";";
    if (boundary.depth !== 0) continue;
    if (hasContent) statements.push(parts);
    parts = "";
    hasContent = false;
    boundary = new StatementBoundary();
  }
  if (boundary.depth !== 0) throw new Error("unterminated migration trigger");
  if (hasContent) statements.push(parts + sql.slice(start).trim());
  return statements;
}
