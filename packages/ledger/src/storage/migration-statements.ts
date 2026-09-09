// Execute complete statements separately: a failed statement must stop the migration.
// Quoted tokens and comments are opaque; BEGIN/CASE nesting keeps trigger bodies intact.
const tokens =
  /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_]\w*|[^\s]/g;

export function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let trigger = false;
  let hasContent = false;
  const prefix: string[] = [];
  for (const match of sql.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith("--") || token.startsWith("/*")) continue;
    if (["'", '"', "`", "["].includes(token) || (token === "/" && sql[match.index + 1] === "*")) {
      throw new Error("unterminated migration token");
    }
    if (token === ";" && depth === 0) {
      if (hasContent) statements.push(sql.slice(start, match.index + 1));
      start = match.index + 1;
      hasContent = false;
      prefix.length = 0;
      trigger = false;
      continue;
    }
    hasContent = true;
    const word = token.toUpperCase();
    if (prefix.length < 3) prefix.push(word);
    if (
      prefix[0] === "CREATE" &&
      word === "TRIGGER" &&
      (prefix.length === 2 ||
        (prefix.length === 3 && ["TEMP", "TEMPORARY"].includes(prefix[1] ?? "")))
    ) {
      trigger = true;
    }
    if (!trigger) continue;
    if (word === "BEGIN" || word === "CASE") depth += 1;
    if (word === "END") depth -= 1;
  }
  if (depth !== 0) throw new Error("unterminated migration trigger");
  if (hasContent) statements.push(sql.slice(start));
  return statements;
}
