import { describe, expect, it } from "bun:test";
import ts from "typescript";

const SOURCE_FILES = ["../src/ingress/bridge.ts", "../src/handler/conversation.ts"] as const;
const ROUTING_STORES = new Set([
  "PendingAskStore",
  "PendingInteractionStore",
  "ChannelGrantStore",
  "BlacklistStore",
  "WorkerGrantStore",
]);
const ROUTING_PROPERTIES = new Set(["target", "pendingAsk"]);

type ParsedSource = Readonly<{
  path: string;
  source: ts.SourceFile;
}>;

function parseSource(path: string, text: string): ParsedSource {
  return {
    path,
    source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

async function parseSources(): Promise<readonly ParsedSource[]> {
  return Promise.all(
    SOURCE_FILES.map(async (path) =>
      parseSource(path, await Bun.file(new URL(path, import.meta.url)).text()),
    ),
  );
}
function unwrapStaticExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticExpressionName(expression: ts.Expression): string | undefined {
  const unwrapped = unwrapStaticExpression(expression);
  if (ts.isStringLiteralLike(unwrapped) || ts.isNumericLiteral(unwrapped)) {
    return unwrapped.text;
  }
  return undefined;
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return staticExpressionName(name.expression);
  return staticExpressionName(name);
}

type StaticMember = Readonly<{ receiver: ts.Expression; name: string }>;

function staticMember(expression: ts.Expression): StaticMember | undefined {
  const unwrapped = unwrapStaticExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return { receiver: unwrapped.expression, name: unwrapped.name.text };
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const name = staticExpressionName(unwrapped.argumentExpression);
    return name ? { receiver: unwrapped.expression, name } : undefined;
  }
  return undefined;
}

type Binding = Readonly<{
  name: string;
  importKind?: "engine" | "namespace" | "kernel-namespace" | "store";
  importedName?: string;
  initializer?: ts.Expression;
  propertyName?: string;
}>;

// #549: the kernel engine is an injected instance. The single approved
// conversation seam is the `ingress` parameter of processMessage — that
// parameter (and only that one) carries engine provenance.
function isProcessMessageIngressParameter(
  node: ts.SignatureDeclaration,
  parameter: ts.ParameterDeclaration,
): boolean {
  return (
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "processMessage" &&
    ts.isIdentifier(parameter.name) &&
    parameter.name.text === "ingress"
  );
}

type LexicalScope = {
  parent?: LexicalScope;
  kind: "source" | "function" | "block";
  bindings: Map<string, Binding>;
};

type LexicalModel = Readonly<{
  scopeOf(node: ts.Node): LexicalScope;
  resolveIdentifier(identifier: ts.Identifier): Binding | undefined;
}>;

function lexicalModel(source: ts.SourceFile): LexicalModel {
  const scopes = new Map<ts.Node, LexicalScope>();
  const root: LexicalScope = { kind: "source", bindings: new Map() };

  const addBinding = (scope: LexicalScope, binding: Binding): void => {
    scope.bindings.set(binding.name, binding);
  };
  const declareBindingName = (
    scope: LexicalScope,
    name: ts.BindingName,
    initializer?: ts.Expression,
  ): void => {
    if (ts.isIdentifier(name)) {
      addBinding(scope, { name: name.text, initializer });
      return;
    }
    if (!initializer) {
      for (const element of name.elements) {
        if (!ts.isOmittedExpression(element)) {
          declareBindingName(scope, element.name);
        }
      }
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const propertyName = element.propertyName
        ? staticPropertyName(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;
      if (ts.isIdentifier(element.name)) {
        addBinding(scope, {
          name: element.name.text,
          initializer,
          propertyName,
        });
      } else {
        declareBindingName(scope, element.name);
      }
    }
  };
  const childScope = (parent: LexicalScope, kind: "function" | "block"): LexicalScope => ({
    parent,
    kind,
    bindings: new Map(),
  });

  const walk = (node: ts.Node, scope: LexicalScope): void => {
    scopes.set(node, scope);

    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (
        clause &&
        !clause.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        clause.namedBindings
      ) {
        const moduleName = node.moduleSpecifier.text;
        if (ts.isNamespaceImport(clause.namedBindings)) {
          if (moduleName === "@openomni/session") {
            addBinding(scope, {
              name: clause.namedBindings.name.text,
              importKind: "namespace",
            });
          }
          if (moduleName === "@openomni/openomni") {
            addBinding(scope, {
              name: clause.namedBindings.name.text,
              importKind: "kernel-namespace",
            });
          }
        } else {
          for (const element of clause.namedBindings.elements) {
            if (element.isTypeOnly) continue;
            const importedName = element.propertyName?.text ?? element.name.text;
            const importKind =
              moduleName === "@openomni/session" && ROUTING_STORES.has(importedName)
                ? "store"
                : undefined;
            if (importKind) {
              addBinding(scope, {
                name: element.name.text,
                importKind,
                importedName,
              });
            }
          }
        }
      }
      ts.forEachChild(node, (child) => walk(child, scope));
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      addBinding(scope, { name: node.name.text });
    } else if (ts.isClassDeclaration(node) && node.name) {
      addBinding(scope, { name: node.name.text });
    }

    if (ts.isFunctionLike(node)) {
      const functionScope = childScope(scope, "function");
      scopes.set(node, functionScope);
      if (ts.isFunctionExpression(node) && node.name) {
        addBinding(functionScope, { name: node.name.text });
      }
      for (const parameter of node.parameters) {
        scopes.set(parameter, functionScope);
        if (isProcessMessageIngressParameter(node, parameter)) {
          addBinding(functionScope, { name: "ingress", importKind: "engine" });
        } else {
          declareBindingName(functionScope, parameter.name, parameter.initializer);
        }
      }
      ts.forEachChild(node, (child) => {
        if (!node.parameters.includes(child as ts.ParameterDeclaration)) walk(child, functionScope);
      });
      return;
    }

    if (ts.isBlock(node) && !ts.isSourceFile(node)) {
      const blockScope = childScope(scope, "block");
      scopes.set(node, blockScope);
      ts.forEachChild(node, (child) => walk(child, blockScope));
      return;
    }

    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isCaseBlock(node)
    ) {
      const lexicalScope = childScope(scope, "block");
      scopes.set(node, lexicalScope);
      ts.forEachChild(node, (child) => walk(child, lexicalScope));
      return;
    }

    if (ts.isCatchClause(node)) {
      const catchScope = childScope(scope, "block");
      scopes.set(node, catchScope);
      if (node.variableDeclaration) {
        declareBindingName(catchScope, node.variableDeclaration.name);
      }
      ts.forEachChild(node, (child) => walk(child, catchScope));
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      let declarationScope = scope;
      if (
        ts.isVariableDeclarationList(node.parent) &&
        !(node.parent.flags & ts.NodeFlags.BlockScoped)
      ) {
        while (declarationScope.kind === "block" && declarationScope.parent) {
          declarationScope = declarationScope.parent;
        }
      }
      declareBindingName(declarationScope, node.name, node.initializer);
    }
    ts.forEachChild(node, (child) => walk(child, scope));
  };
  walk(source, root);

  const scopeOf = (node: ts.Node): LexicalScope => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      const scope = scopes.get(current);
      if (scope) return scope;
    }
    return root;
  };
  const resolveIdentifier = (identifier: ts.Identifier): Binding | undefined => {
    for (let scope: LexicalScope | undefined = scopeOf(identifier); scope; scope = scope.parent) {
      const binding = scope.bindings.get(identifier.text);
      if (binding) return binding;
    }
    return undefined;
  };
  return { scopeOf, resolveIdentifier };
}

type Provenance = Readonly<{
  kind: "engine" | "method" | "namespace" | "kernel-namespace" | "engine-factory" | "store";
  name?: string;
}>;

function provenanceResolver(
  model: LexicalModel,
): (binding: Binding | undefined) => Provenance | undefined {
  const memo = new Map<Binding, Provenance | undefined>();
  const active = new Set<Binding>();

  const expressionProvenance = (expression: ts.Expression): Provenance | undefined => {
    const unwrapped = unwrapStaticExpression(expression);
    if (ts.isIdentifier(unwrapped)) return resolve(model.resolveIdentifier(unwrapped));
    const member = staticMember(unwrapped);
    if (!member) return undefined;
    const receiver = expressionProvenance(member.receiver);
    if (receiver?.kind === "engine" && member.name === "ingest") return { kind: "method" };
    if (receiver?.kind === "namespace" && ROUTING_STORES.has(member.name)) {
      return { kind: "store", name: member.name };
    }
    if (receiver?.kind === "kernel-namespace" && member.name === "createIngressEngine") {
      return { kind: "engine-factory" };
    }
    return undefined;
  };
  const resolve = (binding: Binding | undefined): Provenance | undefined => {
    if (!binding) return undefined;
    if (memo.has(binding)) return memo.get(binding);
    if (active.has(binding)) return undefined;
    active.add(binding);
    let result: Provenance | undefined;
    if (binding.importKind === "engine") result = { kind: "engine" };
    else if (binding.importKind === "namespace") result = { kind: "namespace" };
    else if (binding.importKind === "kernel-namespace") result = { kind: "kernel-namespace" };
    else if (binding.importKind === "store") result = { kind: "store", name: binding.importedName };
    else if (binding.initializer) {
      const source = expressionProvenance(binding.initializer);
      if (binding.propertyName === undefined) result = source;
      else if (source?.kind === "engine" && binding.propertyName === "ingest") {
        result = { kind: "method" };
      } else if (source?.kind === "namespace" && ROUTING_STORES.has(binding.propertyName)) {
        result = { kind: "store", name: binding.propertyName };
      } else if (
        source?.kind === "kernel-namespace" &&
        binding.propertyName === "createIngressEngine"
      ) {
        result = { kind: "engine-factory" };
      }
    }
    active.delete(binding);
    memo.set(binding, result);
    return result;
  };
  return resolve;
}

function eventBuilderNames(source: ts.SourceFile): ReadonlySet<string> {
  const builders = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      (statement.name?.text === "createBaseEvent" || statement.name?.text === "buildInboundEvent")
    ) {
      builders.add(statement.name.text);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        (declaration.name.text === "createBaseEvent" ||
          declaration.name.text === "buildInboundEvent") &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        builders.add(declaration.name.text);
      }
    }
  }
  return builders;
}

function isEventBuilder(node: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(node) &&
    (node.name?.text === "createBaseEvent" || node.name?.text === "buildInboundEvent")
  ) {
    return true;
  }
  const declaration =
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node.parent : undefined;
  return (
    !!declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    (declaration.name.text === "createBaseEvent" || declaration.name.text === "buildInboundEvent")
  );
}

function detectRoutingBoundaryViolations(parsed: readonly ParsedSource[]): readonly string[] {
  const violations: string[] = [];

  for (const { path, source } of parsed) {
    const model = lexicalModel(source);
    const resolve = provenanceResolver(model);
    const expressionProvenance = (expression: ts.Expression): Provenance | undefined => {
      const unwrapped = unwrapStaticExpression(expression);
      if (ts.isIdentifier(unwrapped)) return resolve(model.resolveIdentifier(unwrapped));
      const member = staticMember(unwrapped);
      if (!member) return undefined;
      const receiver = expressionProvenance(member.receiver);
      if (receiver?.kind === "namespace" && ROUTING_STORES.has(member.name)) {
        return { kind: "store", name: member.name };
      }
      return undefined;
    };

    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !statement.importClause ||
        statement.importClause.isTypeOnly ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.importClause.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }
      const moduleName = statement.moduleSpecifier.text;
      if (moduleName !== "@openomni/session" && moduleName !== "@openomni/openomni") continue;
      for (const element of statement.importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (element.isTypeOnly) continue;
        if (moduleName === "@openomni/session" && ROUTING_STORES.has(importedName)) {
          violations.push(`${path}: imports ${importedName}`);
        }
        // #549: bridge/conversation receive the engine instance — they never
        // construct their own.
        if (moduleName === "@openomni/openomni" && importedName === "createIngressEngine") {
          violations.push(`${path}: imports createIngressEngine`);
        }
      }
    }

    const walk = (node: ts.Node, eventBuilder: boolean): void => {
      const insideEventBuilder = eventBuilder || isEventBuilder(node);

      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const provenance = resolve(model.resolveIdentifier(element.name));
          if (provenance?.kind === "store") {
            violations.push(`${path}: accesses routing store ${provenance.name}`);
          }
        }
      }

      if (
        insideEventBuilder &&
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
      ) {
        const propertyName = staticPropertyName(node.name);
        if (propertyName && ROUTING_PROPERTIES.has(propertyName)) {
          violations.push(`${path}: assigns routing property ${propertyName}`);
        }
      }

      if (
        insideEventBuilder &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const propertyName = staticMember(node.left)?.name;
        if (propertyName && ROUTING_PROPERTIES.has(propertyName)) {
          violations.push(`${path}: assigns routing property ${propertyName}`);
        }
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const receiverExpression = unwrapStaticExpression(node.expression);
        if (ts.isIdentifier(receiverExpression)) {
          const receiver = resolve(model.resolveIdentifier(receiverExpression));
          if (receiver?.kind === "store") {
            violations.push(`${path}: accesses routing store ${receiverExpression.text}`);
          }
        }
        const member = staticMember(node);
        if (
          member &&
          expressionProvenance(member.receiver)?.kind === "namespace" &&
          ROUTING_STORES.has(member.name)
        ) {
          violations.push(`${path}: accesses routing store ${member.name}`);
        }
        // #558 review: `import * as OO` + OO.createIngressEngine bypassed the
        // named-import rule — flag namespace-qualified factory access too.
        if (
          member &&
          expressionProvenance(member.receiver)?.kind === "kernel-namespace" &&
          member.name === "createIngressEngine"
        ) {
          violations.push(`${path}: imports createIngressEngine`);
        }
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = resolve(model.resolveIdentifier(node.expression));
        if (callee?.kind === "engine-factory") {
          violations.push(`${path}: imports createIngressEngine`);
        }
      }

      if (ts.isCallExpression(node) && staticMember(node.expression)?.name === "submit") {
        violations.push(`${path}: calls direct dispatch submit`);
      }

      ts.forEachChild(node, (child) => walk(child, insideEventBuilder));
    };
    walk(source, false);
  }

  return violations;
}

function kernelIngressCallCount(source: ts.SourceFile): number {
  const processMessage = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "processMessage",
  );
  if (!processMessage?.body) throw new Error("processMessage function body was not found");

  const model = lexicalModel(source);
  const resolve = provenanceResolver(model);
  let calls = 0;
  visit(processMessage.body, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrapStaticExpression(node.expression);
    if (ts.isIdentifier(callee)) {
      if (resolve(model.resolveIdentifier(callee))?.kind === "method") calls += 1;
      return;
    }
    const member = staticMember(callee);
    const receiver = member ? unwrapStaticExpression(member.receiver) : undefined;
    if (
      member?.name === "ingest" &&
      receiver &&
      ts.isIdentifier(receiver) &&
      resolve(model.resolveIdentifier(receiver))?.kind === "engine"
    ) {
      calls += 1;
    }
  });
  return calls;
}
function visit(source: ts.Node, callback: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    callback(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
}

describe("server ingress routing ownership boundary", () => {
  it("keeps bridge and conversation free of routing stores and route synthesis", async () => {
    expect(detectRoutingBoundaryViolations(await parseSources())).toEqual([]);
  });

  it("finds both approved event builders in the real bridge source", async () => {
    const parsed = await parseSources();
    const bridge = parsed.find(({ path }) => path === "../src/ingress/bridge.ts");
    if (!bridge) throw new Error("bridge source was not parsed");
    expect([...eventBuilderNames(bridge.source)].sort()).toEqual([
      "buildInboundEvent",
      "createBaseEvent",
    ]);
  });

  const routingPropertyFixtures = [
    [
      "base object target",
      SOURCE_FILES[0],
      "function createBaseEvent() { return { target: candidate }; }",
      "target",
    ],
    [
      "inbound object pendingAsk",
      SOURCE_FILES[0],
      'function buildInboundEvent() { return { ["pendingAsk"]: pending }; }',
      "pendingAsk",
    ],
    [
      "base direct assignment",
      SOURCE_FILES[0],
      "function createBaseEvent() { event.target = candidate; }",
      "target",
    ],
    [
      "inbound static element assignment",
      SOURCE_FILES[0],
      'function buildInboundEvent() { event["pendingAsk"] = pending; }',
      "pendingAsk",
    ],
    [
      "base arrow function",
      SOURCE_FILES[0],
      "const createBaseEvent = () => ({ target: candidate });",
      "target",
    ],
    [
      "inbound function expression",
      SOURCE_FILES[0],
      'const buildInboundEvent = function () { return { ["pendingAsk"]: pending }; };',
      "pendingAsk",
    ],
  ] as const;

  for (const [name, path, text, property] of routingPropertyFixtures) {
    it(`detects ${name} routing property synthesis`, () => {
      const companion = text.includes("createBaseEvent")
        ? "const buildInboundEvent = () => ({});"
        : "const createBaseEvent = function () { return {}; };";
      const parsed = parseSource(path, `${text}\n${companion}`);
      expect([...eventBuilderNames(parsed.source)].sort()).toEqual([
        "buildInboundEvent",
        "createBaseEvent",
      ]);
      expect(detectRoutingBoundaryViolations([parsed])).toContain(
        `${path}: assigns routing property ${property}`,
      );
    });
  }

  it("allows routing-shaped properties outside the approved event builders", () => {
    const path = SOURCE_FILES[1];
    const source = `
      function unrelated() {
        const state = { target: candidate, pendingAsk };
        state.target = candidate;
        state["pendingAsk"] = pending;
      }
    `;
    expect(detectRoutingBoundaryViolations([parseSource(path, source)])).toEqual([]);
  });

  const routingStoreFixtures = [
    [
      "aliased named import",
      'import { PendingAskStore as Ask } from "@openomni/session"; Ask.get("id");',
      "accesses routing store Ask",
    ],
    [
      "worker-grant named import",
      'import { WorkerGrantStore } from "@openomni/session"; WorkerGrantStore.get("id");',
      "accesses routing store WorkerGrantStore",
    ],
    [
      "namespace dot access",
      'import * as Session from "@openomni/session"; Session.PendingInteractionStore.get("id");',
      "accesses routing store PendingInteractionStore",
    ],
    [
      "namespace bracket access",
      'import * as Session from "@openomni/session"; Session["ChannelGrantStore"].get("id");',
      "accesses routing store ChannelGrantStore",
    ],
    [
      "namespace destructuring alias and later use",
      'import * as Session from "@openomni/session"; const { PendingAskStore: Ask } = Session; Ask.get("id");',
      "accesses routing store Ask",
    ],
    [
      "namespace alias dot access",
      'import * as Session from "@openomni/session"; const KernelSession = Session; KernelSession.BlacklistStore.get("id");',
      "accesses routing store BlacklistStore",
    ],
    [
      "namespace alias-chain bracket access",
      'import * as Session from "@openomni/session"; const First = Session; const Second = First; Second["PendingAskStore"].get("id");',
      "accesses routing store PendingAskStore",
    ],
    [
      "namespace alias-chain destructuring",
      'import * as Session from "@openomni/session"; const First = Session; const Second = First; const { ChannelGrantStore: Grants } = Second; Grants.get("id");',
      "accesses routing store Grants",
    ],
    [
      "wrapped session namespace",
      'import * as Session from "@openomni/session"; const KernelSession = ((Session as typeof Session) satisfies typeof Session)!; KernelSession.PendingAskStore.get("id");',
      "accesses routing store PendingAskStore",
    ],
    [
      "wrapped session store alias",
      'import * as Session from "@openomni/session"; const Store = ((Session.BlacklistStore as typeof Session.BlacklistStore) satisfies typeof Session.BlacklistStore)!; (Store as typeof Store)!.get("id");',
      "accesses routing store Store",
    ],
    [
      "wrapped static session member",
      'import * as Session from "@openomni/session"; ((Session as typeof Session)!)[("ChannelGrantStore" as const)].get("id");',
      "accesses routing store ChannelGrantStore",
    ],
    [
      "namespace-qualified engine construction",
      'import * as OpenOmni from "@openomni/openomni"; const engine = OpenOmni.createIngressEngine();',
      "imports createIngressEngine",
    ],
    [
      "destructured namespace engine factory alias",
      'import * as OpenOmni from "@openomni/openomni"; const { createIngressEngine: make } = OpenOmni; make();',
      "imports createIngressEngine",
    ],
  ] as const;

  for (const [name, text, violation] of routingStoreFixtures) {
    it(`detects ${name}`, () => {
      const path = SOURCE_FILES[1];
      expect(detectRoutingBoundaryViolations([parseSource(path, text)])).toContain(
        `${path}: ${violation}`,
      );
    });
  }

  it("allows unrelated local objects with routing-store-shaped names", () => {
    const path = SOURCE_FILES[1];
    const text = `
      const PendingAskStore = { get: () => undefined };
      const Session = { BlacklistStore: { get: () => undefined } };
      PendingAskStore.get("id");
      Session.BlacklistStore.get("id");
    `;
    expect(detectRoutingBoundaryViolations([parseSource(path, text)])).toEqual([]);
  });

  it("ignores routing-store imports from non-canonical modules", () => {
    const path = SOURCE_FILES[1];
    const text = 'import { PendingAskStore } from "other-session"; PendingAskStore.get("id");';
    expect(detectRoutingBoundaryViolations([parseSource(path, text)])).toEqual([]);
  });

  it("flags value imports of createIngressEngine in conversation sources", () => {
    const path = SOURCE_FILES[1];
    const text =
      'import { createIngressEngine } from "@openomni/openomni"; const engine = createIngressEngine();';
    expect(detectRoutingBoundaryViolations([parseSource(path, text)])).toContain(
      `${path}: imports createIngressEngine`,
    );
  });

  it("allows type-only engine imports in conversation sources", () => {
    const path = SOURCE_FILES[1];
    const text =
      'import type { IngressEngine } from "@openomni/openomni"; import { type IngressEngineDeps } from "@openomni/openomni"; export type Seam = Pick<IngressEngine, "ingest">;';
    expect(detectRoutingBoundaryViolations([parseSource(path, text)])).toEqual([]);
  });

  it("keeps parameter and block-local Session shadows unrelated", () => {
    const path = SOURCE_FILES[1];
    const text = `
      import * as Session from "@openomni/session";
      function inspect(Session: unknown) {
        const Alias = Session;
        Alias.PendingAskStore.get("id");
      }
      {
        const Session = fakeSession;
        const Alias = Session;
        Alias.BlacklistStore.get("id");
      }
    `;
    expect(detectRoutingBoundaryViolations([parseSource(path, text)])).toEqual([]);
  });

  it("still detects a canonical Session alias outside sibling shadows", () => {
    const path = SOURCE_FILES[1];
    const text = `
      import * as Session from "@openomni/session";
      const Canonical = Session;
      { const Session = fakeSession; Session.PendingAskStore.get("shadow"); }
      const Store = Canonical["PendingAskStore"];
      const Later = Store;
      Later.get("canonical");
    `;
    expect(detectRoutingBoundaryViolations([parseSource(path, text)])).toContain(
      `${path}: accesses routing store Later`,
    );
  });

  it("isolates loop and switch Session shadows from an outer canonical alias", () => {
    const path = SOURCE_FILES[1];
    const text = `
      import * as Session from "@openomni/session";
      const Canonical = Session;
      for (const Canonical of fakeSessions) Canonical.PendingAskStore.get("for-of-shadow");
      switch (mode) {
        case "shadow":
          const Canonical = fakeSession;
          Canonical.BlacklistStore.get("switch-shadow");
      }
      Canonical.PendingInteractionStore.get("canonical");
    `;
    const violations = detectRoutingBoundaryViolations([parseSource(path, text)]);
    expect(violations).toContain(`${path}: accesses routing store PendingInteractionStore`);
    expect(violations).toHaveLength(1);
  });

  it("keeps dynamic computed Session members unsupported", () => {
    const path = SOURCE_FILES[1];
    const text = `
      import * as Session from "@openomni/session";
      Session[storeName].get("dynamic");
      (Session as typeof Session)![storeName].get("wrapped-dynamic");
    `;
    expect(detectRoutingBoundaryViolations([parseSource(path, text)])).toEqual([]);
  });

  const submitFixtures = [
    ["renamed runtime", "const renamed = dispatchRuntime; renamed.submit(request);"],
    ["aliased element access", 'const alias = dispatchRuntime; alias["submit"](request);'],
    ["factory return", "createRuntime().submit(request);"],
  ] as const;

  for (const [name, text] of submitFixtures) {
    it(`detects ${name} dispatch submit calls`, () => {
      const path = SOURCE_FILES[1];
      expect(detectRoutingBoundaryViolations([parseSource(path, text)])).toContain(
        `${path}: calls direct dispatch submit`,
      );
    });
  }

  it("allows dynamic member names that cannot be resolved statically", () => {
    const path = SOURCE_FILES[1];
    expect(
      detectRoutingBoundaryViolations([parseSource(path, "runtime[method](request);")]),
    ).toEqual([]);
  });

  it("has exactly one conversation-to-kernel ingress call in processMessage", async () => {
    const parsed = await parseSources();
    const conversation = parsed.find(({ path }) => path === "../src/handler/conversation.ts");
    if (!conversation) throw new Error("conversation source was not parsed");
    expect(kernelIngressCallCount(conversation.source)).toBe(1);
  });

  const kernelIngressFixtures = [
    ["zero ingest", "return null;", 0],
    ["duplicate direct", "ingress.ingest(a); ingress.ingest(b);", 2],
    ["duplicate bracket", 'ingress["ingest"](a); ingress["ingest"](b);', 2],
    ["engine alias", "const engine = ingress; engine.ingest(event);", 1],
    ["direct method alias", "const runIngress = ingress.ingest; runIngress(event);", 1],
    [
      "method alias",
      "const { ingest: runIngress } = ingress; const invoke = runIngress; invoke(event);",
      1,
    ],
    [
      "engine alias chain",
      "const kernel = ingress; const engine = kernel; engine.ingest(event);",
      1,
    ],
    ["dynamic ingest member", "ingress[method](event);", 0],
    [
      "wrapped engine receiver",
      "((ingress as typeof ingress) satisfies typeof ingress)!.ingest(event);",
      1,
    ],
    [
      "wrapped ingest method and callee",
      "const runIngress = ((ingress.ingest as typeof ingress.ingest) satisfies typeof ingress.ingest)!; (runIngress as typeof runIngress)!(event);",
      1,
    ],
    ["wrapped static ingest member", 'ingress[("ingest" as const)](event);', 1],
    [
      "duplicate wrapped ingest",
      "((ingress as typeof ingress)!).ingest(first); const invoke = (ingress.ingest satisfies typeof ingress.ingest); (invoke!)(second);",
      2,
    ],
    ["type-asserted engine receiver", "(<typeof ingress>ingress).ingest(event);", 1],
  ] as const;

  for (const [name, body, expectedCalls] of kernelIngressFixtures) {
    it(`counts ${name} calls`, () => {
      const text = `
        function processMessage(message, deps, ingress) { ${body} }
      `;
      const calls = kernelIngressCallCount(parseSource(SOURCE_FILES[1], text).source);
      expect(calls).toBe(expectedCalls);
    });
  }

  it("counts outer canonical calls despite a nested same-name parameter", () => {
    const text = `
      function processMessage(message, deps, ingress) {
        const engine = ingress;
        engine.ingest(first);
        ingress.ingest(second);
        function nested(engine: unknown, ingress: unknown) {
          const alias = engine;
          alias.ingest(shadow);
          ingress.ingest(shadow);
        }
      }
    `;
    expect(kernelIngressCallCount(parseSource(SOURCE_FILES[1], text).source)).toBe(2);
  });

  it("isolates same-name engine aliases in sibling blocks", () => {
    const text = `
      function processMessage(message, deps, ingress) {
        { const engine = ingress; engine.ingest(first); }
        { const engine = fakeEngine; engine.ingest(shadow); }
        { const engine = ingress; const invoke = engine.ingest; invoke(second); }
      }
    `;
    expect(kernelIngressCallCount(parseSource(SOURCE_FILES[1], text).source)).toBe(2);
  });

  const lexicalOwnerFixtures = [
    ["for", "for (let engine = fakeEngine; ready; ready = false) engine.ingest(shadow);"],
    ["for-in", "for (const engine in fakeEngines) fakeEngines[engine].ingest(shadow);"],
    ["for-of", "for (const engine of fakeEngines) engine.ingest(shadow);"],
    [
      "switch case block",
      'switch (mode) { case "shadow": const engine = fakeEngine; engine.ingest(shadow); break; }',
    ],
  ] as const;

  for (const [name, shadow] of lexicalOwnerFixtures) {
    it(`isolates ${name} engine shadows from an outer canonical alias`, () => {
      const text = `
        function processMessage(message, deps, ingress) {
          const engine = ingress;
          engine.ingest(first);
          ${shadow}
          engine.ingest(second);
        }
      `;
      expect(kernelIngressCallCount(parseSource(SOURCE_FILES[1], text).source)).toBe(2);
    });
  }

  const rejectedIngressProvenanceFixtures = [
    [
      "module-level ingress shadow",
      "const ingress = fakeEngine; function processMessage() { ingress.ingest(event); }",
    ],
    [
      "missing ingress parameter",
      "function processMessage(message, deps) { IngressEngine.ingest(event); }",
    ],
    [
      "locally shadowed ingress parameter",
      "function processMessage(message, deps, ingress) { const ingress2 = ingress; { const ingress = fakeEngine; ingress.ingest(event); } }",
    ],
    [
      "nested function ingress parameter",
      "function processMessage(message, deps) { function inner(ingress: unknown) { ingress.ingest(event); } inner(fakeEngine); }",
    ],
  ] as const;

  for (const [name, text] of rejectedIngressProvenanceFixtures) {
    it(`does not count ${name}`, () => {
      expect(kernelIngressCallCount(parseSource(SOURCE_FILES[1], text).source)).toBe(0);
    });
  }
});
