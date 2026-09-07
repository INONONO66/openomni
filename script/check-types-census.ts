import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { qualitySource } from "./quality-source";
import {
  buildInventory,
  cliOptions,
  compareText,
  decodeJson,
  digest,
  errorSchema,
  inventorySchema,
  InventoryError,
  jsonObject,
  jsonString,
  jsonNumber,
  jsonBoolean,
  jsonLiteral,
  jsonChoice,
  jsonArray,
  type Json,
  readContract,
  verifyInventory,
  type CensusError,
  type Contract,
  type Inventory,
} from "./quality-inventory";

const compilerDeclarationHash = "bddc8143c3b0fe2a6462f9811d3b28ea422ffee80d75d3d97d65d6b69f583fad";
function parseAbiDeclaration(value: Json) {
  const object = jsonObject(value);
  return {
    dependency: jsonLiteral(object.dependency, "typescript@5.9.2"),
    declarationPath: jsonLiteral(object.declarationPath, "typescript/lib/typescript.d.ts"),
    declarationHash: jsonLiteral(object.declarationHash, compilerDeclarationHash),
    declarationOffset: jsonNumber(object.declarationOffset),
    declarationSymbol: jsonString(object.declarationSymbol),
  };
}
type AbiDeclaration = ReturnType<typeof parseAbiDeclaration>;
const compilerBrands = new Map([
  [165004, "SortedReadonlyArray. __sortedArrayBrand"],
  [165094, "SortedArray. __sortedArrayBrand"],
  [165163, "Path.__pathBrand"],
  [188832, "JSDocContainer._jsdocContainerBrand"],
  [188918, "LocalsContainer._localsContainerBrand"],
  [189003, "FlowContainer._flowContainerBrand"],
  [197314, "Declaration._declarationBrand"],
  [202086, "AutoAccessorPropertyDeclaration._autoAccessorBrand"],
  [202187, "ObjectLiteralElement._objectLiteralBrand"],
  [204593, "FunctionLikeDeclarationBase._functionLikeDeclarationBrand"],
  [208460, "TypeNode._typeNodeBrand"],
  [214877, "Expression._expressionBrand"],
  [215260, "UnaryExpression._unaryExpressionBrand"],
  [215459, "UpdateExpression._updateExpressionBrand"],
  [216284, "LeftHandSideExpression._leftHandSideExpressionBrand"],
  [216397, "MemberExpression._memberExpressionBrand"],
  [216499, "PrimaryExpression._primaryExpressionBrand"],
  [224485, "LiteralExpression._literalExpressionBrand"],
  [228691, "PropertyAccessChain._optionalChainBrand"],
  [229115, "PropertyAccessEntityNameExpression._propertyAccessExpressionLikeQualifiedNameBrand"],
  [229667, "ElementAccessChain._optionalChainBrand"],
  [230315, "CallChain._optionalChainBrand"],
  [232568, "NonNullChain._optionalChainBrand"],
  [236794, "Statement._statementBrand"],
  [243890, "ClassElement._classElementBrand"],
  [244020, "TypeElement._typeElementBrand"],
  [255271, "JSDocType._jsDocTypeBrand"],
]);

function parseLocation(value: Json) {
  const object = jsonObject(value);
  return {
    path: jsonString(object.path),
    line: jsonNumber(object.line),
    offset: jsonNumber(object.offset),
    symbol: jsonString(object.symbol),
  };
}
export const resultSchema = {
  parse(value: Json) {
    const object = jsonObject(value);
    return {
      version: jsonLiteral(object.version, 1),
      tool: jsonLiteral(object.tool, "typescript@5.9.2"),
      complete: jsonBoolean(object.complete),
      inventoryHash: jsonString(object.inventoryHash),
      measured: jsonArray(object.measured, jsonString),
      semanticMeasured: jsonArray(object.semanticMeasured, jsonString),
      projects: jsonArray(object.projects, jsonString),
      violations: jsonArray(object.violations, (entry) => ({
        ...parseLocation(entry),
        kind: jsonChoice(jsonObject(entry).kind, ["explicitAny", "implicitAny", "unknown"]),
        origin: jsonChoice(jsonObject(entry).origin, origins),
      })),
      abiMetadata: jsonArray(object.abiMetadata, (entry) => ({
        ...parseAbiDeclaration(entry),
        ...parseLocation(entry),
      })),
      errors: jsonArray(object.errors, errorSchema.parse),
    };
  },
};
export type CensusResult = ReturnType<typeof resultSchema.parse>;
type Kind = "implicitAny" | "unknown";
/** `owned`: the top type is written, declared or inferred in campaign-owned source.
 * `foreign`: it is reached only through declarations the campaign does not own
 * (dependency `.d.ts`, `lib.*.d.ts`), e.g. zod internals or `Error.cause`. */
export const origins = ["owned", "foreign"] as const;
export type Origin = (typeof origins)[number];
type Edge = { type: ts.Type; foreign: boolean };
function declaredOutside(declaration: ts.Node | undefined, owned: Set<string>): boolean {
  return declaration !== undefined && !owned.has(declaration.getSourceFile().fileName);
}

function diagnosticError(root: string, diagnostic: ts.Diagnostic): CensusError {
  return {
    code: "typescript",
    path: diagnostic.file ? relative(root, diagnostic.file.fileName) : "",
    message: `${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  };
}
export function projectOptions(
  root: string,
  path: string,
): { fileNames: string[]; options: ts.CompilerOptions } {
  const errors: ts.Diagnostic[] = [];
  // TypeScript projects use JSONC (comments/trailing commas), unlike strict
  // machine receipts. The native project parser owns configuration validation.
  // Use the native config-driven program API, not its raw JSON parse result.
  // This is a one-shot read: no filesystem watchers and no emit callback.
  const host = ts.createWatchCompilerHost(
    join(root, path),
    {},
    {
      ...ts.sys,
      watchFile: () => ({ close: () => undefined }),
      watchDirectory: () => ({ close: () => undefined }),
    },
    ts.createSemanticDiagnosticsBuilderProgram,
    (diagnostic) => errors.push(diagnostic),
    () => undefined,
  );
  host.afterProgramCreate = () => undefined;
  host.onUnRecoverableConfigFileDiagnostic = (diagnostic) => {
    throw new InventoryError(
      "config",
      path,
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    );
  };
  const watch = ts.createWatchProgram(host);
  try {
    const program = watch.getProgram().getProgram();
    if (errors.length || program.getConfigFileParsingDiagnostics().length)
      throw new InventoryError("config", path, "native configuration diagnostic");
    return { fileNames: [...program.getRootFileNames()], options: program.getCompilerOptions() };
  } finally {
    watch.close();
  }
}
function symbolName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      (ts.isVariableDeclaration(current) ||
        ts.isParameter(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isTypeAliasDeclaration(current) ||
        ts.isPropertySignature(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name
    )
      return current.name.getText();
    current = current.parent;
  }
  return ts.SyntaxKind[node.kind];
}
function grammarIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isMetaProperty(parent) || ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isImportSpecifier(parent)) return true;
  const jsx = ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent);
  return jsx && parent.tagName === node && /^[a-z]/.test(node.text);
}
function literalGrammar(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isLiteralTypeNode(parent) || ts.isPrefixUnaryExpression(parent) && ts.isLiteralTypeNode(parent.parent);
}
function isQuery(node: ts.Node): boolean {
  if (ts.isSourceFile(node)) return false;
  const parent = node.parent;
  // Numeric/bigint literal type leaves have no expression type in the compiler;
  // querying them returns error-any. The enclosing LiteralType is authoritative.
  if (literalGrammar(node)) return false;
  if (ts.isIdentifier(node) && grammarIdentifier(node)) return false;
  if (ts.isTypeReferenceNode(node) && node.typeName.getText() === "const") return false;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node)
    return false;
  if (ts.isPropertyAccessExpression(parent)) return false;
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && !ts.isIdentifier(node.name))
    return false;
  return (
    ts.isIdentifier(node) ||
    ts.isTypeNode(node) ||
    ts.isExpression(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node)
  );
}
function memberTypes(
  type: ts.Type,
  checker: ts.TypeChecker,
  owned: Set<string>,
  brands: Map<ts.Symbol, AbiDeclaration>,
  metadata: Set<AbiDeclaration>,
): Edge[] {
  const symbol = type.getSymbol();
  const declarations = symbol?.declarations ?? [];
  if (symbol && symbol.flags & ts.SymbolFlags.Module) return [];
  // A consumed named value is data regardless of whether its declaration is an
  // interface, class, or mapped/alias instantiation. Module namespaces remain
  // the sole named graph that is intentionally not expanded.
  const compilerType = declarations.some(
    (declaration) =>
      realpathSync(declaration.getSourceFile().fileName) ===
      realpathSync(join(dirname(ts.getDefaultLibFilePath({})), "typescript.d.ts")),
  );
  return checker.getPropertiesOfType(type).flatMap((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (
      property.flags & ts.SymbolFlags.Method ||
      (declaration && (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)))
    )
      return [];
    const brand = checker
      .getRootSymbols(property)
      .map((symbol) => brands.get(symbol))
      .find((entry) => entry !== undefined);
    if (brand && compilerType) {
      metadata.add(brand);
      return [];
    }
    const member = declaration
      ? checker.getTypeOfSymbolAtLocation(property, declaration)
      : checker.getTypeOfSymbol(property);
    // Unused callable properties are API members, just like unused methods.
    // The access/call expression itself is still independently classified.
    const callable = checker.getNonNullableType(member);
    if (callable.getCallSignatures().length || callable.getConstructSignatures().length) return [];
    return [{ type: member, foreign: declaredOutside(declaration, owned) }];
  });
}
function childrenOf(
  type: ts.Type,
  checker: ts.TypeChecker,
  owned: Set<string>,
  brands: Map<ts.Symbol, AbiDeclaration>,
  metadata: Set<AbiDeclaration>,
): Edge[] {
  const children: Edge[] = [];
  // Structural edges inherit ownership; edges through a declaration carry its
  // ownership. Type arguments of a generic declared outside the campaign are
  // that declaration's instantiation (zod's ZodType<any, any, any>), not ours.
  const structural = (types: readonly ts.Type[], foreign = false) =>
    children.push(...types.map((child) => ({ type: child, foreign })));
  if (type.isUnionOrIntersection()) structural(type.types);
  if (type.aliasTypeArguments)
    structural(
      type.aliasTypeArguments,
      declaredOutside(type.aliasSymbol?.declarations?.[0], owned),
    );
  if (type.flags & ts.TypeFlags.Object) {
    const object = type as ts.ObjectType;
    if (object.objectFlags & ts.ObjectFlags.Reference) {
      const reference = object as ts.TypeReference;
      structural(
        checker.getTypeArguments(reference),
        declaredOutside(reference.target.getSymbol()?.declarations?.[0], owned),
      );
    }
    children.push(...memberTypes(type, checker, owned, brands, metadata));
    for (const index of checker.getIndexInfosOfType(type))
      children.push({ type: index.type, foreign: declaredOutside(index.declaration, owned) });
  }
  for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    const declaration = signature.getDeclaration();
    children.push({
      type: checker.getReturnTypeOfSignature(signature),
      foreign: declaredOutside(declaration, owned),
    });
    if (declaration && owned.has(declaration.getSourceFile().fileName)) {
      for (const parameter of signature.parameters)
        children.push({
          type: checker.getTypeOfSymbolAtLocation(parameter, declaration),
          foreign: false,
        });
    }
  }
  if (type.flags & ts.TypeFlags.IndexedAccess) {
    const indexed = type as ts.IndexedAccessType;
    structural([indexed.objectType, indexed.indexType]);
  }
  return children;
}
function typeClassifier(program: ts.Program, checker: ts.TypeChecker, owned: Set<string>) {
  const brands = new Map<ts.Symbol, AbiDeclaration>();
  const path = realpathSync(join(dirname(ts.getDefaultLibFilePath({})), "typescript.d.ts"));
  // Absolute imports and preserveSymlinks can retain a package symlink in the
  // program. Compare physical identity, then bind each program-local symbol.
  const sources = program
    .getSourceFiles()
    .filter(
      (source) =>
        source.fileName.endsWith("/typescript.d.ts") && realpathSync(source.fileName) === path,
    );
  // Only declarations of this exact installed compiler qualify. A copied package,
  // augmentation, lookalike field or changed declaration hash receives no waiver.
  for (const source of sources) {
    if (ts.version !== "5.9.2" || digest(source.text) !== compilerDeclarationHash) continue;
    function bind(node: ts.Node): void {
      if (ts.isPropertySignature(node)) {
        const declarationOffset = node.getStart();
        const declarationSymbol = compilerBrands.get(declarationOffset);
        const symbol = checker.getSymbolAtLocation(node.name);
        if (
          declarationSymbol &&
          symbol &&
          symbol.declarations?.length === 1 &&
          symbol.declarations[0] === node
        ) {
          brands.set(symbol, {
            dependency: "typescript@5.9.2",
            declarationPath: "typescript/lib/typescript.d.ts",
            declarationHash: compilerDeclarationHash,
            declarationOffset,
            declarationSymbol,
          });
        }
      }
      ts.forEachChild(node, bind);
    }
    bind(source);
  }
  const edges = new Map<ts.Type, { children: Edge[]; metadata: Set<AbiDeclaration> }>();
  // Reach a top type twice: once over owned/structural edges only, once over
  // every edge. A kind reached only on the second pass is foreign-origin.
  function reach(start: ts.Type, ownedOnly: boolean) {
    const seen = new Set<ts.Type>();
    const pending = [start];
    const kinds = new Set<Kind>();
    const metadata = new Set<AbiDeclaration>();
    while (pending.length) {
      const type = pending.pop();
      if (!type || seen.has(type)) continue;
      seen.add(type);
      if (type.flags & ts.TypeFlags.Any) {
        kinds.add("implicitAny");
        continue;
      }
      if (type.flags & ts.TypeFlags.Unknown) {
        kinds.add("unknown");
        continue;
      }
      // A generic parameter is not an instantiated default or an implicit top type.
      if (type.flags & ts.TypeFlags.TypeParameter) continue;
      let edge = edges.get(type);
      if (!edge) {
        const excluded = new Set<AbiDeclaration>();
        edge = { children: childrenOf(type, checker, owned, brands, excluded), metadata: excluded };
        edges.set(type, edge);
      }
      for (const child of edge.children) if (!ownedOnly || !child.foreign) pending.push(child.type);
      for (const entry of edge.metadata) metadata.add(entry);
    }
    return { kinds, metadata };
  }
  return (start: ts.Type): { kinds: Kind[]; owned: Set<Kind>; metadata: Set<AbiDeclaration> } => {
    const complete = reach(start, false);
    return { kinds: [...complete.kinds].sort(), owned: reach(start, true).kinds, metadata: complete.metadata };
  };
}
/** A directly top-typed node is attributed to the declaration that typed it:
 * the campaign's own binding, parameter or annotation, the resolved callee, or
 * the referenced property/alias. Unresolvable provenance stays owned. */
function declaredHere(node: ts.Node, checker: ts.TypeChecker, owned: Set<string>): boolean {
  const symbolOwned = (symbol: ts.Symbol | undefined) => {
    const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return !declaredOutside(resolved?.valueDeclaration ?? resolved?.declarations?.[0], owned);
  };
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const declaration = checker.getResolvedSignature(node)?.getDeclaration();
    return declaration
      ? !declaredOutside(declaration, owned)
      : symbolOwned(checker.getSymbolAtLocation(node.expression));
  }
  if (ts.isPropertyAccessExpression(node)) return symbolOwned(checker.getSymbolAtLocation(node.name));
  if (ts.isElementAccessExpression(node))
    return symbolOwned(checker.getSymbolAtLocation(node.argumentExpression));
  if (ts.isIdentifier(node)) return symbolOwned(checker.getSymbolAtLocation(node));
  if (ts.isTypeReferenceNode(node)) return symbolOwned(checker.getSymbolAtLocation(node.typeName));
  if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
    return declaredHere(node.expression, checker, owned);
  return true;
}
/** A directly top-typed node is attributed by `declaredHere`; a type reaching a
 * top type through edges is owned when the owned-only pass reached that kind. */
function originOf(
  node: ts.Node,
  type: ts.Type,
  kind: Kind,
  ownedKinds: Set<Kind>,
  checker: ts.TypeChecker,
  owned: Set<string>,
): Origin {
  const direct = type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown);
  return (direct ? declaredHere(node, checker, owned) : ownedKinds.has(kind)) ? "owned" : "foreign";
}
function scanSource(
  source: ts.SourceFile,
  root: string,
  checker: ts.TypeChecker,
  owned: Set<string>,
  classify: ReturnType<typeof typeClassifier>,
  abiMetadata: CensusResult["abiMetadata"],
): CensusResult["violations"] {
  const violations: CensusResult["violations"] = [];
  const path = relative(root, source.fileName);
  function add(node: ts.Node, kind: CensusResult["violations"][number]["kind"], origin: Origin): void {
    const offset = node.getStart(source);
    violations.push({
      path,
      offset,
      line: source.getLineAndCharacterOfPosition(offset).line + 1,
      symbol: symbolName(node),
      kind,
      origin,
    });
  }
  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) add(node, "explicitAny", "owned");
    else if (node.kind === ts.SyntaxKind.UnknownKeyword) add(node, "unknown", "owned");
    else if (isQuery(node) && !ts.isStringLiteralLike(node)) {
      const type = checker.getTypeAtLocation(node);
      const classified = classify(type);
      for (const kind of classified.kinds) add(node, kind, originOf(node, type, kind, classified.owned, checker, owned));
      for (const entry of classified.metadata) {
        const offset = node.getStart(source);
        abiMetadata.push({
          ...entry,
          path,
          offset,
          line: source.getLineAndCharacterOfPosition(offset).line + 1,
          symbol: symbolName(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}
export function census(root: string, contract: Contract, inventory: Inventory): CensusResult {
  const result: CensusResult = {
    version: 1,
    tool: "typescript@5.9.2",
    complete: false,
    inventoryHash: digest(JSON.stringify(inventory)),
    measured: [],
    semanticMeasured: [],
    projects: [],
    violations: [],
    abiMetadata: [],
    errors: [],
  };
  const owned = new Set(
    inventory.files
      .filter((file) => file.language === "typescript" && (!contract.topology || qualitySource(file.path)))
      .map((file) => join(root, file.path)),
  );
  const covered = new Set<string>();
  const semanticCovered = new Set<string>();
  function analyze(project: string, files: string[], options: ts.CompilerOptions): void {
    result.projects.push(project);
    const program = ts.createProgram(files, {
      ...options,
      noEmit: true,
      rootDir: root,
      incremental: false,
      composite: false,
      paths: options.paths,
    });
    const checker = program.getTypeChecker();
    const classify = typeClassifier(program, checker, owned);
    const diagnostics = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    result.errors.push(
      ...diagnostics
        .filter((d) => d.category === ts.DiagnosticCategory.Error)
        .map((d) => ({ ...diagnosticError(root, d), project })),
    );
    // Resolution failures taint checker results. Keep explicit syntax findings,
    // but never report error-any as a genuine inferred type violation.
    const unresolved = diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error);
    for (const source of program.getSourceFiles()) {
      if (!owned.has(source.fileName)) continue;
      covered.add(source.fileName);
      if (!unresolved) semanticCovered.add(source.fileName);
      result.violations.push(
        ...scanSource(
          source,
          root,
          checker,
          owned,
          unresolved
            ? () => ({ kinds: [], owned: new Set<Kind>(), metadata: new Set<AbiDeclaration>() })
            : classify,
          result.abiMetadata,
        ),
      );
    }
  }
  for (const project of contract.projects) {
    try {
      const parsed = projectOptions(root, project);
      analyze(
        project,
        parsed.fileNames.filter((file) => owned.has(file)),
        parsed.options,
      );
    } catch {
      result.errors.push({
        code: "config",
        path: project,
        message: "project could not be parsed or analyzed",
      });
    }
  }
  const remaining = [...owned].filter((file) => !covered.has(file));
  if (remaining.length) {
    analyze("<inventory-fallback>", remaining, {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      skipLibCheck: true,
    });
  }
  result.measured = [...covered].map((file) => relative(root, file)).sort(compareText);
  result.semanticMeasured = [...semanticCovered]
    .map((file) => relative(root, file))
    .sort(compareText);
  const unique = new Map(result.violations.map((v) => [`${v.path}:${v.offset}:${v.kind}`, v]));
  result.violations = [...unique.values()].sort(
    (a, b) =>
      compareText(a.path, b.path) ||
      a.offset - b.offset ||
      compareText(a.symbol, b.symbol) ||
      compareText(a.kind, b.kind),
  );
  result.abiMetadata = [
    ...new Map(result.abiMetadata.map((entry) => [JSON.stringify(entry), entry])).values(),
  ].sort(
    (a, b) =>
      compareText(a.path, b.path) ||
      a.offset - b.offset ||
      a.declarationOffset - b.declarationOffset,
  );
  result.errors = [...new Map(result.errors.map((e) => [JSON.stringify(e), e])).values()].sort(
    (a, b) => compareText(a.path, b.path) || compareText(a.message, b.message),
  );
  result.complete = result.errors.length === 0 && covered.size === owned.size;
  return result;
}
export function censusMain(): number {
  let result: CensusResult = {
    version: 1,
    tool: "typescript@5.9.2",
    complete: false,
    inventoryHash: "",
    measured: [],
    semanticMeasured: [],
    projects: [],
    violations: [],
    abiMetadata: [],
    errors: [],
  };
  try {
    if (ts.version !== "5.9.2")
      throw new InventoryError("compiler", "", "compiler version differs from contract");
    const options = cliOptions();
    const contract = readContract(resolve(options.root, options.contract));
    const inventory = buildInventory(options.root, contract);
    if (!options.inventory)
      throw new InventoryError(
        "inventory",
        "",
        "--inventory is required; generate and review it first",
      );
    const expected = inventorySchema.parse(
      decodeJson(readFileSync(resolve(options.root, options.inventory), "utf8")),
    );
    if (JSON.stringify(inventory) !== JSON.stringify(expected)) {
      result.errors.push({
        code: "inventory_drift",
        path: options.inventory,
        message: "inventory membership or content changed",
      });
    } else {
      verifyInventory(inventory, expected);
      result = census(options.root, contract, inventory);
    }
  } catch {
    result.errors.push({
      code: "analyzer",
      path: "",
      message: "invalid CLI, contract, inventory or analyzer failure",
    });
  }
  console.log(JSON.stringify(resultSchema.parse(result)));
  return result.complete ? Number(result.violations.length > 0) : 2;
}
if (import.meta.main) process.exitCode = censusMain();
