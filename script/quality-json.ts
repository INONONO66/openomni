import ts from "typescript";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
class JsonFailure {
  constructor(readonly message: string) {}
}
function invalid(message: string): never { throw new JsonFailure(message); }
function validateString(token: string): void {
  if (!token.startsWith('"') || !token.endsWith('"')) invalid("invalid JSON string delimiter");
  for (let index = 1; index < token.length - 1; index++) {
    const character = token[index];
    if (token.charCodeAt(index) < 32 || character === '"') invalid("invalid JSON string character");
    if (character !== "\\") continue;
    const escaped = token[++index];
    if (escaped === "u") {
      if (!/^[0-9a-fA-F]{4}$/.test(token.slice(index + 1, index + 5))) invalid("invalid Unicode escape");
      index += 4;
    } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) invalid("invalid JSON escape");
  }
}
export function decodeJson(input: string): Json {
  const source = ts.createSourceFile(
    "input.json",
    input,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSON,
  );
  const options = { noLib: true, allowNonTsExtensions: true, resolveJsonModule: true };
  const program = ts.createProgram(["input.json"], options, {
    ...ts.createCompilerHost(options),
    getSourceFile: (path) => (path === "input.json" ? source : undefined),
  });
  if (program.getSyntacticDiagnostics(source).length) invalid("malformed JSON");
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    input,
  );
  let previous = ts.SyntaxKind.Unknown;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia ||
      (previous === ts.SyntaxKind.CommaToken &&
        (token === ts.SyntaxKind.CloseBraceToken || token === ts.SyntaxKind.CloseBracketToken))
    )
      invalid("non-JSON syntax");
    if (token === ts.SyntaxKind.StringLiteral) validateString(scanner.getTokenText());
    if (token !== ts.SyntaxKind.WhitespaceTrivia && token !== ts.SyntaxKind.NewLineTrivia)
      previous = token;
  }
  function objectValue(node: ts.ObjectLiteralExpression): Json {
    const entries: [string, Json][] = [];
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !property.name.getText(source).startsWith('"')) invalid("invalid JSON key");
      const name = property.name.text;
      if (entries.some(([key]) => key === name)) invalid("duplicate JSON key");
      entries.push([name, value(property.initializer)]);
    }
    return Object.fromEntries(entries);
  }
  function value(node: ts.Expression): Json {
    if (ts.isStringLiteral(node) && node.getText(source).startsWith('"')) return node.text;
    if (ts.isNumericLiteral(node)) {
      const n = Number(node.text);
      if (
        !Number.isFinite(n) ||
        !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(node.getText(source))
      )
        invalid("invalid JSON number");
      return n;
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)
    ) {
      const n = value(node.operand);
      if (typeof n === "number") return -n;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(value);
    if (ts.isObjectLiteralExpression(node)) return objectValue(node);
    return invalid("non-JSON value");
  }
  const statement = source.statements[0];
  if (!statement || source.statements.length !== 1 || !ts.isExpressionStatement(statement))
    invalid("expected one JSON value");
  return value(statement.expression);
}
