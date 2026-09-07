import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { Migration } from "../packages/ledger/src/storage/migration-runner";
import { initializeSqliteDatabase } from "../packages/ledger/src/storage/sqlite-schema-lifecycle";
import { U967_MIGRATION } from "../packages/ledger/src/storage/u967-preflight";
import { InventoryError } from "./quality-inventory";

function literal(node: ts.Expression, bindings: Map<string, ts.Expression>): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) {
    if (node.text === "U967_MIGRATION") return U967_MIGRATION;
    const value = bindings.get(node.text);
    if (value) return literal(value, bindings);
  }
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans
        .map((span) => literal(span.expression, bindings) + span.literal.text)
        .join("")
    );
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const array = node.expression.expression;
    if (
      node.expression.name.text === "join" &&
      ts.isArrayLiteralExpression(array) &&
      node.arguments[0]
    )
      return array.elements
        .map((element) => literal(element, bindings))
        .join(literal(node.arguments[0], bindings));
  }
  throw new InventoryError("schema", "", "unsupported native migration expression");
}
function topLevelBindings(source: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        bindings.set(declaration.name.text, declaration.initializer);
    }
  }
  return bindings;
}
/** Migration names imported from sibling storage modules (`REQUEST_MIGRATION`,
 * `U967_MIGRATION`, ...) resolve to the exported initializer of that module. */
function importedBindings(
  root: string,
  path: string,
  source: ts.SourceFile,
  bindings: Map<string, ts.Expression>,
): void {
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".") ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue;
    const target = join(dirname(path), `${statement.moduleSpecifier.text}.ts`);
    const exported = topLevelBindings(
      ts.createSourceFile(
        target,
        readFileSync(join(root, target), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ),
    );
    for (const element of statement.importClause.namedBindings.elements) {
      const value = exported.get((element.propertyName ?? element.name).text);
      if (value) bindings.set(element.name.text, value);
    }
  }
}
function migrationOrder(root: string): { name: string }[] {
  const path = "packages/ledger/src/storage/sqlite-schema-lifecycle.ts";
  const source = ts.createSourceFile(
    path,
    readFileSync(join(root, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const bindings = topLevelBindings(source);
  importedBindings(root, path, source, bindings);
  const order = bindings.get("ORDERED_MIGRATIONS");
  if (!order || !ts.isArrayLiteralExpression(order))
    throw new InventoryError("schema", path, "native migration order missing");
  return order.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element))
      throw new InventoryError("schema", path, "invalid migration entry");
    const property = element.properties.find((item) => item.name?.getText(source) === "name");
    if (!property || !ts.isPropertyAssignment(property))
      throw new InventoryError("schema", path, "migration name absent");
    return { name: literal(property.initializer, bindings) };
  });
}

/** Only disposable empty databases are passed here. Both results come from the
 * real lifecycle; historical SQL is never substituted for the live schema. */
export function qualitySchemas(
  root: string,
  directory: string,
): { fresh: string; upgraded: string } {
  const fresh = join(directory, "fresh.db"),
    upgraded = join(directory, "upgraded.db");
  for (const path of [fresh, upgraded]) {
    using db = new Database(path, { create: true });
    if (path === upgraded) {
      const order = migrationOrder(root);
      const boundary = order.findIndex((migration) => migration.name === U967_MIGRATION);
      if (boundary < 0) throw new InventoryError("schema", "", "native guarded migration missing");
      Migration.applyOrdered(db, join(root, "packages/ledger/migration"), order.slice(0, boundary));
    }
    initializeSqliteDatabase(db);
    db.query<{ busy: number; log: number; checkpointed: number }, []>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    ).get();
  }
  return { fresh, upgraded };
}
