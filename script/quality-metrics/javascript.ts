import ts from "typescript";
import { array, object, integer, text, fail, sha, type Json, type Source } from "./input";
import { invokeTool } from "./tool";

export type Span = { start: number; end: number };
export type Unit = Span & {
  path: string;
  kind: string;
  name: string;
  body: Span;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  cyclomatic: number;
  cognitive: number;
  halstead: ReturnType<typeof halstead>;
  wrapperHash: string;
};
type AstUnit = {
  node: ts.Node;
  body: ts.Node;
  parameters: readonly ts.ParameterDeclaration[];
  kind: string;
  name: string;
};
const printer = ts.createPrinter({ removeComments: true });

function typeOnly(node: ts.Node): boolean {
  return (
    (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) ||
    (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (ts.canHaveModifiers(node) &&
      Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)))
  );
}
function units(ast: ts.SourceFile): AstUnit[] {
  const result: AstUnit[] = [
    { node: ast, body: ast, parameters: [], kind: "module", name: "<module>" },
  ];
  function visit(node: ts.Node): void {
    if (typeOnly(node)) return;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      node.body
    ) {
      result.push({
        node,
        body: node.body,
        parameters: node.parameters,
        kind: ts.SyntaxKind[node.kind],
        name: node.name?.getText(ast) ?? `<anonymous@${node.getStart(ast)}>`,
      });
    } else if (ts.isClassStaticBlockDeclaration(node)) {
      result.push({ node, body: node.body, parameters: [], kind: "static", name: "<static>" });
    } else if (ts.isPropertyDeclaration(node) && node.initializer) {
      result.push({
        node: node.initializer,
        body: node.initializer,
        parameters: [],
        kind: "field",
        name: node.name.getText(ast),
      });
    } else if (ts.isModuleBlock(node)) {
      result.push({
        node: node.parent,
        body: node,
        parameters: [],
        kind: "namespace",
        name: node.parent.name.getText(ast),
      });
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(ast, visit);
  return result;
}

/** Use the TS parser's leaves to select the scanner's regexp/template/JSX mode.
 * This keeps '/' as division distinct from a regexp operand without heuristics.
 */
function halstead(ast: ts.SourceFile, unit: AstUnit, all: AstUnit[]) {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ast.languageVariant, ast.text);
  const nested = all.filter(
    (u) =>
      u !== unit && u.node.getStart(ast) >= unit.body.getStart(ast) && u.node.end <= unit.body.end,
  );
  const omitted: Span[] = [];
  function excludeTypeParameters(node: ts.Node): void {
    const types =
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isExpressionWithTypeArguments(node) ||
      ts.isJsxOpeningElement(node) ||
      ts.isJsxSelfClosingElement(node)
        ? node.typeArguments
        : ts.isClassLike(node) || ts.isFunctionLike(node)
          ? node.typeParameters
          : undefined;
    if (types) {
      // Match the parser's type list and its actual delimiter siblings. Trivia,
      // nested types and trailing commas cannot move a delimiter out of range.
      const children = node.getChildren(ast);
      const index = children.findIndex(
        (child) =>
          child.kind === ts.SyntaxKind.SyntaxList &&
          child.pos === types.pos &&
          child.end === types.end,
      );
      const open = children[index - 1],
        close = children[index + 1];
      if (
        open?.kind !== ts.SyntaxKind.LessThanToken ||
        close?.kind !== ts.SyntaxKind.GreaterThanToken
      )
        fail("analyzer", ast.fileName, "type argument delimiters could not be joined");
      omitted.push({ start: open.getStart(ast), end: close.end });
    }
  }
  function excludeDeclarationTokens(node: ts.Node, modifiers: readonly ts.Modifier[] | undefined): void {
    // TypeScript 5.9's TypeScriptModifier taxonomy, restricted to AST modifier
    // owners: keep runtime static/async/accessor and keyword-named properties.
    for (const modifier of modifiers ?? [])
      if (
        [
          ts.SyntaxKind.PublicKeyword,
          ts.SyntaxKind.PrivateKeyword,
          ts.SyntaxKind.ProtectedKeyword,
          ts.SyntaxKind.ReadonlyKeyword,
          ts.SyntaxKind.OverrideKeyword,
          ts.SyntaxKind.AbstractKeyword,
          ts.SyntaxKind.DeclareKeyword,
          ts.SyntaxKind.ConstKeyword,
          ts.SyntaxKind.InKeyword,
          ts.SyntaxKind.OutKeyword,
        ].includes(modifier.kind)
      )
        omitted.push({ start: modifier.getStart(ast), end: modifier.end });
    // Declaration-owned ?/! are erased; conditional, optional-chain and prefix
    // negation tokens have expression owners and remain executable source tokens.
    if (
      ts.isQuestionOrExclamationToken(node) &&
      (ts.isVariableDeclaration(node.parent) ||
        ts.isPropertyDeclaration(node.parent) ||
        ts.isParameter(node.parent) ||
        ts.isFunctionLike(node.parent))
    )
      omitted.push({ start: node.getStart(ast), end: node.end });
    if (ts.isTypeAssertionExpression(node))
      omitted.push({ start: node.getStart(ast), end: node.expression.getStart(ast) });
  }
  function exclusions(node: ts.Node): void {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (
      typeOnly(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      (ts.isFunctionLike(node) && !("body" in node && node.body)) ||
      (ts.isPropertyDeclaration(node) &&
        modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword))
    ) {
      let start = node.getStart(ast);
      if (ts.isTypeNode(node)) {
        const siblings = node.parent.getChildren(ast);
        const previous = siblings[siblings.indexOf(node) - 1];
        if (previous?.kind === ts.SyntaxKind.ColonToken) start = previous.getStart(ast);
      }
      omitted.push({ start, end: node.end });
      return;
    }
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))
      omitted.push({ start: node.expression.end, end: node.end });
    excludeDeclarationTokens(node, modifiers);
    excludeTypeParameters(node);
    ts.forEachChild(node, exclusions);
  }
  exclusions(unit.body);
  for (const child of nested)
    omitted.push({ start: child.node.getStart(ast), end: child.node.end });
  function add(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  function visit(node: ts.Node): void {
    const start = [ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxTextAllWhiteSpaces].includes(node.kind)
      ? node.pos
      : node.getStart(ast);
    if (omitted.some((s) => start >= s.start && node.end <= s.end)) return;
    const children = node.getChildren(ast);
    if (children.length) {
      for (const child of children) visit(child);
      return;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken || node.end <= start) return;
    scanner.setTextPos(start);
    let kind = scanner.scan();
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) kind = scanner.reScanSlashToken();
    if (node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail)
      kind = scanner.reScanTemplateToken(false);
    if (node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces) {
      scanner.setTextPos(node.pos);
      kind = scanner.scanJsxToken();
    }
    const raw = ast.text.slice(start, node.end);
    const operand =
      ts.isIdentifier(node) ||
      ts.isPrivateIdentifier(node) ||
      ts.isLiteralExpression(node) ||
      [
        ts.SyntaxKind.TemplateHead,
        ts.SyntaxKind.TemplateMiddle,
        ts.SyntaxKind.TemplateTail,
        ts.SyntaxKind.TrueKeyword,
        ts.SyntaxKind.FalseKeyword,
        ts.SyntaxKind.NullKeyword,
        ts.SyntaxKind.ThisKeyword,
        ts.SyntaxKind.SuperKeyword,
        ts.SyntaxKind.JsxText,
        ts.SyntaxKind.JsxTextAllWhiteSpaces,
      ].includes(node.kind);
    if (operand) add(operands, `${ts.SyntaxKind[node.kind]}:${raw}`);
    else if (
      (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword) ||
      (kind >= ts.SyntaxKind.FirstPunctuation && kind <= ts.SyntaxKind.LastPunctuation)
    )
      add(operators, ts.SyntaxKind[node.kind]);
  }
  visit(unit.body);
  const n1 = operators.size,
    n2 = operands.size;
  const N1 = [...operators.values()].reduce((a, b) => a + b, 0);
  const N2 = [...operands.values()].reduce((a, b) => a + b, 0);
  const difficulty = n2 === 0 ? 0 : (n1 / 2) * (N2 / n2);
  const volume = (N1 + N2) * Math.log2(Math.max(n1 + n2, 1));
  return {
    algorithm: "d945-halstead@1",
    n1,
    n2,
    N1,
    N2,
    difficulty,
    volume,
    effort: difficulty * volume,
    operators: Object.fromEntries([...operators].sort()),
    operands: Object.fromEntries([...operands].sort()),
  };
}

function printExecutable(ast: ts.SourceFile, unit: AstUnit, all: AstUnit[]): string {
  // Rules ignore nested functions, but Sonar does not treat static/field/module
  // bodies as functions. Empty only those separately measured bodies here.
  const separate = new Set(
    all
      .filter((u) => u !== unit && ["static", "field", "namespace"].includes(u.kind))
      .map((u) => u.node),
  );
  const transformed = ts.transform(unit.body, [
    (context) => (root) => {
      const visit: ts.Visitor = (node) => {
        if (separate.has(node)) {
          if (ts.isClassStaticBlockDeclaration(node))
            return ts.factory.createClassStaticBlockDeclaration(ts.factory.createBlock([]));
          if (ts.isModuleDeclaration(node))
            return ts.factory.updateModuleDeclaration(
              node,
              node.modifiers,
              node.name,
              ts.factory.createModuleBlock([]),
            );
          return ts.factory.createNumericLiteral(0);
        }
        if (
          ts.isImportDeclaration(node) ||
          ts.isExportDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          (ts.canHaveModifiers(node) &&
            ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
        )
          return undefined;
        if (ts.isExportAssignment(node))
          return ts.factory.createExpressionStatement(node.expression);
        if (
          ts.isModifier(node) &&
          (node.kind === ts.SyntaxKind.ExportKeyword || node.kind === ts.SyntaxKind.DefaultKeyword)
        )
          return undefined;
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(root, visit) ?? ts.factory.createBlock([]);
    },
  ]);
  try {
    const body = transformed.transformed[0];
    if (!body) fail("analyzer", ast.fileName, "missing executable body");
    const printed = ts.isSourceFile(body)
      ? printer.printFile(body).replace(/^#![^\n]*(?:\n|$)/, "")
      : printer.printNode(ts.EmitHint.Unspecified, body, ast);
    const parameters = unit.parameters
      .map((p) =>
        printer.printNode(
          ts.EmitHint.Unspecified,
          ts.factory.updateParameterDeclaration(
            p,
            undefined,
            p.dotDotDotToken,
            p.name,
            p.questionToken,
            p.type,
            p.initializer,
          ),
          ast,
        ),
      )
      .join(",");
    const isBlock = ts.isBlock(body) || ts.isModuleBlock(body);
    const content = ts.isSourceFile(body)
      ? `{\n${printed}\n}`
      : isBlock
        ? printed
        : `{ return (${printed}); }`;
    // async generator permits await/yield in original bodies; neither modifier
    // introduces a decision in the pinned rules. No source is executed here.
    return `async function* __d945(${parameters}) ${content}`;
  } finally {
    transformed.dispose();
  }
}
function ruleValues(code: string, filename: string, raw: Json) {
  const messages = array(raw).map((value) => {
    const m = object(value);
    return {
      ruleId: m.ruleId === null ? null : text(m.ruleId),
      fatal: m.fatal === true,
      line: integer(m.line),
      column: integer(m.column),
      message: text(m.message),
    };
  });
  for (const m of messages)
    if (m.fatal || !["complexity", "sonarjs/cognitive-complexity"].includes(m.ruleId ?? ""))
      fail("syntax", filename, m.message);
  // Only the synthetic outer function starts on line 1. Nested functions are
  // analyzed again as their own original-source units, never added to this one.
  const classic = messages.filter(
    (m) => m.ruleId === "complexity" && m.line === 1 && m.column === 1,
  );
  const cognitive = messages.filter(
    (m) =>
      m.ruleId === "sonarjs/cognitive-complexity" &&
      m.line === 1 &&
      m.column < code.indexOf("(") + 1,
  );
  const c = classic[0]?.message.match(/complexity of (\d+)\./)?.[1];
  if (classic.length !== 1 || !c || cognitive.length > 1)
    fail("analyzer", filename, "pinned rule result could not be joined");
  const cog = cognitive[0]?.message.match(/Complexity from (\d+) to/)?.[1];
  if (cognitive.length && !cog) fail("analyzer", filename, "invalid Sonar result");
  return { cyclomatic: Number(c), cognitive: Number(cog ?? 0) };
}
export function analyzeJavascript(source: Source): Unit[] {
  const ast = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
  const comments = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ast.languageVariant,
    source.text,
  );
  for (let k = comments.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = comments.scan()) {
    if (
      [ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(k) &&
      /(?:eslint|jscpd|istanbul|c8|v8)[-\s]+(?:disable|ignore)|jscpd:(?:ignore|ignore-start|ignore-end)/i.test(
        comments.getTokenText(),
      )
    )
      fail("directive", source.path, "analysis ignore directives forbidden");
  }
  const all = units(ast);
  const wrappers = all.map((unit) => printExecutable(ast, unit, all));
  const measured = array(
    invokeTool({ operation: "javascript", path: source.path, source: source.text, wrappers }),
  );
  if (measured.length !== all.length) fail("analyzer", source.path, "incomplete rule measurement");
  return all.map((unit, index) => {
    const start = unit.node.getStart(ast),
      end = unit.node.end;
    const pos = ast.getLineAndCharacterOfPosition(start),
      endPos = ast.getLineAndCharacterOfPosition(end);
    const wrapper = wrappers[index],
      raw = measured[index];
    if (wrapper === undefined || raw === undefined)
      fail("analyzer", source.path, "missing rule measurement");
    return {
      path: source.path,
      kind: unit.kind,
      name: unit.name,
      start,
      end,
      body: { start: unit.body.getStart(ast), end: unit.body.end },
      line: pos.line + 1,
      column: pos.character,
      endLine: endPos.line + 1,
      endColumn: endPos.character,
      ...ruleValues(wrapper, source.path, raw),
      halstead: halstead(ast, unit, all),
      wrapperHash: sha(wrapper),
    };
  });
}
