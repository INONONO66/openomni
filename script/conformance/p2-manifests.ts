import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ts from "typescript";
import {
  CLOSED_OPERATION_CATALOG_V1,
  CONFIGURATION_OPERATION_FAMILY_CARDINALITIES,
  NATIVE_TRANSITION_CATALOG_VERSION,
  NATIVE_TRANSITION_FAMILY_CARDINALITIES,
} from "../../packages/openomni/src/ledger/native-transitions.js";

export const P2_MANIFEST_PATH = "script/conformance/p2-manifests.json";

const SECTION_NAMES = [
  "final-schema",
  "store-disposition",
  "production-mutation",
  "native-transition",
  "blob-exception",
  "projection",
  "durable-surface",
  "effect-scope",
  "secret-boundary",
  "p3-disposition",
] as const;

type SectionName = (typeof SECTION_NAMES)[number];
type Status = "current" | "planned-p3";
type ProducerKind =
  | "table"
  | "dml"
  | "filesystem"
  | "environment"
  | "process"
  | "socket"
  | "pid"
  | "error-boundary"
  | "serializer"
  | "secret-boundary"
  | "mutator";
type ProducerAuthority = "authoritative" | "internal-collection" | "cryptographic-builder";

interface InternalCollectionAllowance {
  readonly path: string;
  readonly symbol: string;
  readonly operation: string;
  readonly receiver: string;
  readonly callsite: string;
}

interface InternalCollectionAstAllowance {
  readonly path: string;
  readonly symbol: string;
  readonly operation: string;
  readonly receiver: string;
  readonly astCallsite: string;
}

interface LocatedOperation {
  readonly index: number;
  readonly operation: string;
  readonly receiver: string;
  readonly callsite: string;
  readonly astCallsite: string;
  readonly groundedSanitizer?: "boundary-sanitizer";
  readonly boundaryRisk?: "raw-secret-egress" | "typed-executable-category";
}

type EffectDisposition =
  | "authoritative-ledger-or-infrastructure-port"
  | "workspace-effect-registry"
  | "process-local-not-applicable"
  | "observation-not-applicable"
  | "ephemeral-not-applicable";

const EFFECT_SCOPE_RECEIPT =
  "script/conformance/p2-manifests.test.ts#discriminates exact effect roles without permissive defaults";
const SECRET_CATEGORY_RECEIPT =
  "script/conformance/p2-manifests.test.ts#discriminates executable secret sink roles and rejects raw egress";

export interface ManifestIssue {
  readonly family: string;
  readonly subject: string;
  readonly message: string;
}

export interface Discovery {
  readonly id: string;
  readonly path: string;
  readonly kind: ProducerKind;
  readonly symbol: string;
  readonly operation: string;
  readonly receiver: string;
  readonly callsite: string;
  readonly authority: ProducerAuthority;
  readonly groundedSanitizer?: "boundary-sanitizer";
  readonly boundaryRisk?: "raw-secret-egress" | "typed-executable-category";
}

export type SourceTree = ReadonlyMap<string, string>;
export type P2Manifest = Record<SectionName, readonly Record<string, unknown>[]>;

const COMMON_KEYS = ["id", "status", "evidence"] as const;
const SECTION_KEYS: Record<SectionName, readonly string[]> = {
  "final-schema": [...COMMON_KEYS, "objectKind", "objectName", "definition", "targetShipped"],
  "store-disposition": [
    ...COMMON_KEYS,
    "surfaceId",
    "target",
    "disposition",
    "deleteAt",
    "exception",
    "targetShipped",
  ],
  "production-mutation": [
    ...COMMON_KEYS,
    "surfaceId",
    "file",
    "symbol",
    "operation",
    "receiver",
    "callsite",
    "writer",
    "caller",
    "test",
    "scope",
    "boundary",
    "targetShipped",
  ],
  "native-transition": [
    ...COMMON_KEYS,
    "catalogId",
    "catalogVersion",
    "command",
    "emission",
    "guard",
    "owner",
    "assertions",
    "reducers",
    "projections",
    "bus",
    "effect",
    "reconciler",
    "caller",
    "test",
    "targetShipped",
  ],
  "blob-exception": [
    ...COMMON_KEYS,
    "table",
    "writer",
    "reader",
    "integrityCheck",
    "exception",
    "testIds",
    "targetShipped",
  ],
  projection: [
    ...COMMON_KEYS,
    "projectionId",
    "sourceTable",
    "checkpointTable",
    "reducer",
    "caller",
    "testIds",
    "targetShipped",
  ],
  "durable-surface": [
    ...COMMON_KEYS,
    "path",
    "symbol",
    "operation",
    "receiver",
    "callsite",
    "producerKind",
    "classification",
    "targetShipped",
  ],
  "effect-scope": [
    ...COMMON_KEYS,
    "mutationId",
    "toolOrDriver",
    "scope",
    "resolver",
    "blocker",
    "testIds",
    "targetShipped",
  ],
  "secret-boundary": [
    ...COMMON_KEYS,
    "surfaceId",
    "sink",
    "sanitizer",
    "exception",
    "testIds",
    "targetShipped",
  ],
  "p3-disposition": [...COMMON_KEYS, "module", "export", "caller", "move", "targetShipped"],
};

const BASELINE_MIGRATION_PATH =
  "packages/session/migration/0001_p2_clean_baseline/migration.sql" as const;
const TARGET_TABLES = [
  "_migrations",
  "schema_meta",
  "ledger_event",
  "ledger_head",
  "ledger_request",
  "projection_checkpoint",
  "session_projection",
  "message_projection",
  "part_projection",
  "surface_binding_projection",
  "artifact_reference_projection",
  "actor_identity_projection",
  "actor_endpoint_projection",
  "blacklist_projection",
  "channel_grant_projection",
  "worker_grant_projection",
  "schedule_projection",
  "connector_installation_projection",
  "work_projection",
  "attempt_projection",
  "wait_projection",
  "dispatch_projection",
  "completion_projection",
  "effect_projection",
  "artifact_blob",
] as const;

const TARGET_PROJECTIONS = [
  ...new Set(CLOSED_OPERATION_CATALOG_V1.flatMap((row) => row.projectionIds)),
].sort();
const MUTATION_KINDS = new Set<ProducerKind>([
  "table",
  "dml",
  "filesystem",
  "process",
  "socket",
  "pid",
  "mutator",
]);
const BOUNDARY_KINDS = new Set<ProducerKind>([
  "environment",
  "error-boundary",
  "serializer",
  "secret-boundary",
]);
const LEDGER_WRITER_TABLES = new Set(["ledger_event", "ledger_head", "ledger_request"]);
const AUTH_STORAGE_NAME = /(?:auth|credential|secret|token)/i;
const SOLE_LEDGER_WRITER = {
  path: "packages/session/src/ledger/writer.ts",
  symbols: new Set(["appendInTransaction", "writeProjectionCheckpoint"]),
} as const;
const KNOWN_EXECUTABLE_RECEIPTS = new Set([
  "packages/session/test/ledger/writer.test.ts#appends one-owner batches in owner order and one global sequence",
  "packages/session/test/ledger/projection.test.ts#applies registered projections when append options omit them and across legal sequence gaps",
  "packages/session/test/ledger/blob.test.ts#inserts, deduplicates, and reads immutable bytes",
  "packages/openomni/test/execution-runtime/effect-scope.test.ts#filesystem mutators bind workspace wildcard plus canonical targets",
  "packages/openomni/test/ledger/native-transitions.test.ts#matches the independently reviewed exhaustive full-row golden",
  "packages/openomni/test/ledger/native-transitions.test.ts#locks the exhaustive event ownership census and rejects every omitted relation",
  "packages/openomni/test/ledger/runtime.test.ts#uses one semantic gate and one writer call, then observes the commit",
  "packages/openomni/test/ledger/ports.test.ts#worker face exposes neither raw database nor generic append",
  "packages/session/test/ledger/sole-writer.test.ts#denies alias and second-connection writers until the runtime closes",
  "packages/session/test/ledger/query.test.ts#returns strict, deeply frozen typed rows through primary and indexed reads",

  "packages/protocol/test/p2-contracts.test.ts#parses versioned event, single append, batch, envelope, and receipt fixtures",
  "packages/llm/test/auth/secret-registry.test.ts#forbids serialization and exposes only redacted inspection",
  "packages/llm/test/auth/secret-registry.test.ts#redacts raw, JSON escaped, URL encoded, and common base64 forms",
  "packages/llm/test/auth/secret-registry.test.ts#strictly parses metadata and normalizes only secret-free proxy URLs",
  "apps/server/test/execution/p2-worker-provisioning.test.ts#accepts one authenticated envelope bound to the exact minimal provider set",
  "apps/server/test/integration/one-writer-all-producers.test.ts#production composition commits and reads a semantic session through the owned runtime",
  "packages/openomni/test/evidence/verifier-registry.test.ts#normalizes records to frozen null-prototype data properties without dropping keys",
  "script/conformance/p2-manifests.test.ts#checked manifest is exact and currently green",
  EFFECT_SCOPE_RECEIPT,
  SECRET_CATEGORY_RECEIPT,
]);
const EXECUTABLE_SOURCE_CACHE = new Map<string, string>();

const INTERNAL_COLLECTION_ALLOWANCES: readonly InternalCollectionAllowance[] = [
  ["packages/agent/src/core/runtime-context.ts", "clear", "clear", "agentDefinitions@867", "55:9"],
  [
    "packages/openomni/src/execution-runtime/workspace-identity.ts",
    "provisionWorkspaceIdentity",
    "delete",
    "identitiesById@3703",
    "326:5",
  ],
  ["apps/server/src/context/skills.ts", "discover", "add", "seen@2370", "87:9"],
  [
    "packages/openomni/src/dispatch/pending-interaction-routing.ts",
    "findPendingInteractions",
    "add",
    "seen@1014",
    "34:7",
  ],
  ["packages/policy/src/effects/ordering.ts", "<anonymous>", "add", "seenEffects@1198", "42:7"],
  [
    "packages/openomni/src/execution-runtime/workspace-identity.ts",
    "provisionWorkspaceIdentity",
    "set",
    "adapters@3354",
    "365:3",
  ],
  ["packages/agent/src/core/runtime-context.ts", "define", "set", "agentDefinitions@867", "33:9"],
  ["packages/policy/src/effects/ordering.ts", "uniquePolicyIds", "add", "seen@889", "26:5"],
  [
    "packages/session/src/app-connector/consent-validation.ts",
    "assertUniqueRequiredPermissionActions",
    "add",
    "seen@2767",
    "75:5",
  ],
  [
    "packages/agent/src/core/runtime-context.ts",
    "replaceAll",
    "clear",
    "agentDefinitions@867",
    "59:9",
  ],
  [
    "packages/session/src/ledger/projection.ts",
    "createLedgerProjection",
    "set",
    "definitions@1372",
    "70:3",
  ],
  [
    "packages/openomni/src/evidence/verifier-registry.ts",
    "normalize",
    "add",
    "ancestors@6779",
    "214:5",
  ],
  [
    "packages/openomni/src/execution-runtime/workspace-identity.ts",
    "provisionWorkspaceIdentity",
    "set",
    "identitiesById@3703",
    "348:5",
  ],
  ["packages/agent/src/core/runtime-context.ts", "override", "set", "agentDefinitions@867", "51:9"],
  [
    "packages/openomni/src/execution-runtime/tool/catalog.ts",
    "buildToolCatalog",
    "add",
    "seen@997",
    "45:7",
  ],
  [
    "packages/openomni/src/execution-runtime/workspace-identity.ts",
    "provisionWorkspaceIdentity",
    "add",
    "registryEntry@11228.identities",
    "367:3",
  ],
  ["packages/policy/src/engine/context.ts", "freezePlainValue", "add", "ancestors@3245", "100:3"],
  [
    "packages/agent/src/core/runtime-context.ts",
    "replaceAll",
    "set",
    "agentDefinitions@867",
    "61:11",
  ],
  [
    "packages/openomni/src/evidence/verifier-registry.ts",
    "normalize",
    "delete",
    "ancestors@6779",
    "260:7",
  ],
  [
    "packages/openomni/src/execution-runtime/workspace-identity.ts",
    "activeIdentityCount",
    "delete",
    "entry@6427.identities",
    "194:44",
  ],
  [
    "packages/policy/src/engine/context.ts",
    "freezePlainValue",
    "delete",
    "ancestors@3245",
    "104:3",
  ],
].map(([path, symbol, operation, receiver, callsite]) => ({
  path,
  symbol,
  operation,
  receiver,
  callsite,
}));

const INTERNAL_COLLECTION_AST_ALLOWANCES: readonly InternalCollectionAstAllowance[] = [
  {
    path: "packages/llm/src/auth/boundary-sanitizer.ts",
    symbol: "dispose",
    operation: "clear",
    receiver: "this.#strings",
    astCallsite: "CallExpression:this.#strings.clear()#1",
  },
  {
    path: "packages/llm/src/auth/boundary-sanitizer.ts",
    symbol: "registerExactSecret",
    operation: "add",
    receiver: "this.#strings",
    astCallsite: "CallExpression:this.#strings.add(form)#1",
  },
  {
    path: "packages/llm/src/auth/boundary-sanitizer.ts",
    symbol: "<anonymous>",
    operation: "add",
    receiver: "seen@11461",
    astCallsite: "CallExpression:seen.add(value)#1",
  },
];

const P3_MINIMUM = [
  [
    "p3.package.session-ledger",
    "packages/session/src/index.ts",
    "*",
    "workspace package consumers",
    "move @openomni/session to @openomni/ledger after C1",
  ],
  [
    "p3.package.openomni-kernel",
    "packages/openomni/src/index.ts",
    "*",
    "server and package consumers",
    "move @openomni/openomni to @openomni/kernel after C1",
  ],
  [
    "p3.package.coordinator-ipc",
    "packages/coordinator/src/ipc/index.ts",
    "*",
    "server worker IPC composition",
    "extract @openomni/ipc and repoint worker entry after C1",
  ],
  [
    "p3.export.dispatch-runtime",
    "packages/openomni/src/dispatch/index.ts",
    "DispatchRuntime",
    "apps/server/src/bootstrap/dispatch-owners.ts",
    "rename structural Runtime vocabulary under #465",
  ],
  [
    "p3.export.resident-runtime",
    "packages/openomni/src/resident/index.ts",
    "ResidentRuntime",
    "apps/server/src/profile/resident.ts",
    "rename structural Runtime vocabulary under #465",
  ],
  [
    "p3.module.execution-runtime",
    "packages/openomni/src/execution-runtime/index.ts",
    "*",
    "packages/openomni/src/index.ts",
    "rename execution-runtime module under #465",
  ],
  [
    "p3.module.agent-runtime",
    "packages/agent/src/runtime/index.ts",
    "*",
    "packages/agent/src/index.ts",
    "rename agent runtime module under #465",
  ],
  [
    "p3.protocol.inbound-runtime",
    "packages/protocol/src/ingress/index.ts",
    "Ingress",
    "packages/openomni/src/ingress/index.ts",
    "version protocol field instead of renaming it under #465",
  ],
] as const;

const FILESYSTEM_CALLS = new Set([
  "write",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "mkdir",
  "mkdirSync",
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
]);
const PROCESS_CALLS = new Set(["spawn", "spawnSync", "execFile", "fork", "kill"]);
const SOCKET_CALLS = new Set(["createServer", "createConnection", "connect", "listen"]);
const SERIALIZER_CALLS = new Set(["stringify", "serialize", "canonicalJson", "toJSON"]);
const MUTATOR_CALLS = new Set([
  "run",
  "exec",
  "write",
  "append",
  "insert",
  "update",
  "delete",
  "set",
  "add",
  "clear",
]);
const SQL_CALLS = new Set(["query", "exec", "prepare", "run"]);

function issue(family: string, subject: string, message: string): ManifestIssue {
  return { family, subject, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function rowStatus(value: unknown): value is Status {
  return value === "current" || value === "planned-p3";
}

function executableSource(source: string): string {
  const cached = EXECUTABLE_SOURCE_CACHE.get(source);
  if (cached !== undefined) return cached;
  const masked = [...source];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia &&
      token !== ts.SyntaxKind.ShebangTrivia &&
      token !== ts.SyntaxKind.ConflictMarkerTrivia
    )
      continue;
    for (let index = scanner.getTokenPos(); index < scanner.getTextPos(); index++)
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
  }
  const result = masked.join("");
  EXECUTABLE_SOURCE_CACHE.set(source, result);
  return result;
}

function nearestSymbol(path: string, source: string, offset: number): string {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return "<module>";
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let owner: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getFullStart() || offset >= node.getEnd()) return;
    if (ts.isFunctionLike(node) && node.body && offset >= node.body.getFullStart()) owner = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!owner) return "<module>";
  const name = owner.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)))
    return name.text;
  const parent = owner.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return "<anonymous>";
}

function isSoleLedgerWriter(path: string, symbol: string): boolean {
  if (path === SOLE_LEDGER_WRITER.path) return SOLE_LEDGER_WRITER.symbols.has(symbol);
  return (
    path === "packages/session/src/ledger/projection.ts" &&
    new Set(["rebuildProductionLedgerProjections", "writeCheckpoint", "upsert"]).has(symbol)
  );
}

function focusedReceipts(discovery: Discovery): readonly string[] {
  if (discovery.path === "packages/session/src/ledger/writer.ts")
    return [
      "packages/session/test/ledger/writer.test.ts#appends one-owner batches in owner order and one global sequence",
    ];
  if (discovery.path === "packages/session/src/ledger/projection.ts")
    return [
      "packages/session/test/ledger/projection.test.ts#applies registered projections when append options omit them and across legal sequence gaps",
    ];
  if (discovery.path === "packages/session/src/ledger/blob.ts")
    return [
      "packages/session/test/ledger/blob.test.ts#inserts, deduplicates, and reads immutable bytes",
    ];
  if (discovery.path === "packages/openomni/src/execution-runtime/effect-scope.ts")
    return [
      "packages/openomni/test/execution-runtime/effect-scope.test.ts#filesystem mutators bind workspace wildcard plus canonical targets",
    ];
  if (discovery.path === "packages/openomni/src/ledger/native-transitions.ts")
    return [
      "packages/openomni/test/ledger/native-transitions.test.ts#matches the independently reviewed exhaustive full-row golden",
    ];
  if (discovery.path === "packages/openomni/src/ledger/runtime.ts")
    return [
      "packages/openomni/test/ledger/runtime.test.ts#uses one semantic gate and one writer call, then observes the commit",
    ];
  if (discovery.path === "packages/openomni/src/ledger/ports.ts")
    return [
      "packages/openomni/test/ledger/ports.test.ts#worker face exposes neither raw database nor generic append",
    ];
  if (discovery.path === "packages/session/src/ledger/runtime.ts")
    return [
      "packages/session/test/ledger/sole-writer.test.ts#denies alias and second-connection writers until the runtime closes",
    ];
  if (discovery.path === "packages/session/src/ledger/query.ts")
    return [
      "packages/session/test/ledger/query.test.ts#returns strict, deeply frozen typed rows through primary and indexed reads",
    ];
  if (
    discovery.path === "packages/openomni/src/ledger/production-services.ts" ||
    discovery.path.startsWith("packages/openomni/src/ledger/production/")
  )
    return [
      "apps/server/test/integration/one-writer-all-producers.test.ts#production composition commits and reads a semantic session through the owned runtime",
    ];
  if (discovery.path.startsWith("packages/openomni/src/ledger/reducers/"))
    return [
      "packages/openomni/test/ledger/native-transitions.test.ts#locks the exhaustive event ownership census and rejects every omitted relation",
    ];
  if (discovery.path.startsWith("packages/protocol/src/ledger/"))
    return [
      "packages/protocol/test/p2-contracts.test.ts#parses versioned event, single append, batch, envelope, and receipt fixtures",
    ];
  return [];
}

function stableId(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}
function isCryptographicReceiver(path: string, source: string, offset: number): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  const sourceFile = parseTypeScript(path, source);
  let receiver: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.getStart(sourceFile) === offset &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression))
    )
      receiver = node.expression.expression;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!receiver) return false;
  const initializer = resolveAliasExpression(sourceFile, receiver);
  if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)) return false;
  const factory = initializer.expression;
  if (lexicalBinding(sourceFile, factory)) return false;
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "node:crypto"
    )
      return false;
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          element.name.text === factory.text &&
          (element.propertyName?.text ?? element.name.text) ===
            (factory.text === element.name.text && !element.propertyName
              ? factory.text
              : element.propertyName?.text) &&
          ["createHash", "createHmac"].includes(element.propertyName?.text ?? element.name.text),
      )
    );
  });
}

function isProcessLocalCollectionReceiver(path: string, source: string, offset: number): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  const sourceFile = parseTypeScript(path, source);
  let receiver: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.getStart(sourceFile) === offset &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression))
    )
      receiver = node.expression.expression;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!receiver) return false;
  const resolved = resolveAliasExpression(sourceFile, receiver);
  if (
    ts.isNewExpression(resolved) &&
    ts.isIdentifier(resolved.expression) &&
    /^(?:Map|Set|WeakMap|WeakSet)$/.test(resolved.expression.text) &&
    !lexicalBinding(sourceFile, resolved.expression)
  )
    return true;
  const member = ts.isIdentifier(receiver)
    ? receiver.text
    : ts.isPropertyAccessExpression(receiver)
      ? receiver.name.text
      : undefined;
  if (!member) return false;
  const binding = ts.isIdentifier(receiver) ? lexicalBinding(sourceFile, receiver) : undefined;
  const typeText = binding && "type" in binding ? (binding.type?.getText(sourceFile) ?? "") : "";
  if (/^(?:Readonly)?(?:Map|Set|WeakMap|WeakSet)</.test(typeText)) return true;
  let collectionDeclaration = false;
  const findDeclaration = (node: ts.Node): void => {
    if (collectionDeclaration) return;
    if (
      (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
      node.name.getText(sourceFile) === member
    ) {
      const declaredType = node.type?.getText(sourceFile) ?? "";
      const initializer = ts.isPropertyDeclaration(node) ? node.initializer : undefined;
      collectionDeclaration =
        /^(?:Readonly)?(?:Map|Set|WeakMap|WeakSet)</.test(declaredType) ||
        (initializer !== undefined &&
          ts.isNewExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          /^(?:Map|Set|WeakMap|WeakSet)$/.test(initializer.expression.text));
    }
    ts.forEachChild(node, findDeclaration);
  };
  findDeclaration(sourceFile);
  return collectionDeclaration;
}

function mutationAuthority(
  path: string,
  symbol: string,
  source: string,
  found: LocatedOperation,
): ProducerAuthority {
  if (
    INTERNAL_COLLECTION_ALLOWANCES.some(
      (allowance) =>
        allowance.path === path &&
        allowance.symbol === symbol &&
        allowance.operation === found.operation &&
        allowance.receiver === found.receiver &&
        allowance.callsite === found.callsite,
    ) ||
    INTERNAL_COLLECTION_AST_ALLOWANCES.some(
      (allowance) =>
        allowance.path === path &&
        allowance.symbol === symbol &&
        allowance.operation === found.operation &&
        allowance.receiver === found.receiver &&
        allowance.astCallsite === found.astCallsite,
    )
  )
    return "internal-collection";
  if (isProcessLocalCollectionReceiver(path, source, found.index)) return "internal-collection";
  if (found.operation === "update" && isCryptographicReceiver(path, source, found.index))
    return "cryptographic-builder";
  return "authoritative";
}

function isMutation(discovery: Discovery): boolean {
  return MUTATION_KINDS.has(discovery.kind);
}

const parsedSourceCache = new Map<string, Map<string, ts.SourceFile>>();

function parseTypeScript(path: string, source: string): ts.SourceFile {
  let bySource = parsedSourceCache.get(path);
  if (bySource === undefined) {
    bySource = new Map();
    parsedSourceCache.set(path, bySource);
  }
  const cached = bySource.get(source);
  if (cached !== undefined) return cached;
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  bySource.set(source, parsed);
  return parsed;
}
function callsite(sourceFile: ts.SourceFile, node: ts.Node): string {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${position.line + 1}:${position.character + 1}`;
}

function astCallsite(sourceFile: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(sourceFile);
  let ordinal = 0;
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (candidate.kind === node.kind && candidate.getText(sourceFile) === text) {
      ordinal += 1;
      if (candidate === node) {
        found = true;
        return;
      }
    }
    ts.forEachChild(candidate, visit);
  };
  visit(sourceFile);
  return `${ts.SyntaxKind[node.kind]}:${text}#${ordinal}`;
}

function memberName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  )
    return expression.argumentExpression.text;
  return undefined;
}

function lexicalBinding(
  sourceFile: ts.SourceFile,
  identifier: ts.Identifier,
): ts.VariableDeclaration | ts.ParameterDeclaration | ts.BindingElement | undefined {
  const candidates: Array<ts.VariableDeclaration | ts.ParameterDeclaration | ts.BindingElement> =
    [];
  const contains = (container: ts.Node, node: ts.Node): boolean =>
    node.getStart(sourceFile) >= container.getStart(sourceFile) &&
    node.getEnd() <= container.getEnd();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier.text
    )
      candidates.push(node as ts.VariableDeclaration | ts.ParameterDeclaration | ts.BindingElement);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const use = identifier.getStart(sourceFile);
  return candidates
    .filter((candidate) => {
      if (ts.isVariableDeclaration(candidate) && candidate.getStart(sourceFile) > use) return false;
      let scope: ts.Node = candidate.parent;
      while (
        !ts.isSourceFile(scope) &&
        !ts.isFunctionLike(scope) &&
        !ts.isBlock(scope) &&
        !ts.isCaseBlock(scope) &&
        !ts.isCatchClause(scope)
      )
        scope = scope.parent;
      return contains(scope, identifier);
    })
    .sort((left, right) => {
      const span = (node: ts.Node) => node.parent.getEnd() - node.parent.getStart(sourceFile);
      return span(left) - span(right) || right.getStart(sourceFile) - left.getStart(sourceFile);
    })[0];
}

function bindingIdentity(sourceFile: ts.SourceFile, expression: ts.Expression): string {
  if (ts.isParenthesizedExpression(expression))
    return bindingIdentity(sourceFile, expression.expression);
  if (ts.isIdentifier(expression)) {
    const binding = lexicalBinding(sourceFile, expression);
    return binding
      ? `${expression.text}@${binding.getStart(sourceFile)}`
      : `global:${expression.text}`;
  }
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    return `${bindingIdentity(sourceFile, expression.expression)}.${memberName(expression) ?? "[computed]"}`;
  return `expression@${expression.getStart(sourceFile)}`;
}

function initializerAtUse(
  sourceFile: ts.SourceFile,
  identifier: ts.Identifier,
): ts.Expression | undefined {
  const binding = lexicalBinding(sourceFile, identifier);
  if (!binding) return undefined;
  let value = binding.initializer;
  const bindingKey = `${identifier.text}@${binding.getStart(sourceFile)}`;
  const use = identifier.getStart(sourceFile);
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) >= use) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      bindingIdentity(sourceFile, node.left) === bindingKey
    )
      value = node.right;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return value;
}

function resolveAliasExpression(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  seen = new Set<string>(),
): ts.Expression {
  if (ts.isParenthesizedExpression(expression))
    return resolveAliasExpression(sourceFile, expression.expression, seen);
  if (!ts.isIdentifier(expression)) return expression;
  const identity = bindingIdentity(sourceFile, expression);
  if (seen.has(identity)) return expression;
  const initializer = initializerAtUse(sourceFile, expression);
  return initializer
    ? resolveAliasExpression(sourceFile, initializer, new Set([...seen, identity]))
    : expression;
}

function located(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  operation: string,
  receiver: string,
): LocatedOperation {
  return {
    index: node.getStart(sourceFile),
    operation,
    receiver,
    callsite: callsite(sourceFile, node),
    astCallsite: astCallsite(sourceFile, node),
  };
}

function environmentOperations(path: string, source: string): readonly LocatedOperation[] {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return [];
  const sourceFile = parseTypeScript(path, source);
  const rootName = (node: ts.Expression): string | undefined => {
    const resolved = resolveAliasExpression(sourceFile, node);
    if (
      ts.isPropertyAccessExpression(resolved) &&
      resolved.name.text === "env" &&
      ts.isIdentifier(resolved.expression) &&
      (resolved.expression.text === "process" || resolved.expression.text === "Bun")
    )
      return `${resolved.expression.text}.env`;
    if (ts.isIdentifier(resolved)) {
      const initializer = initializerAtUse(sourceFile, resolved);
      return initializer ? rootName(initializer) : undefined;
    }
    return undefined;
  };
  const found: LocatedOperation[] = [];
  const sanitizerAncestor = (node: ts.Node): boolean => {
    let current = node.parent;
    while (current !== undefined) {
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.expression.getText(sourceFile) === "runtime.sanitizer" &&
        (current.expression.name.text === "sanitizeText" ||
          current.expression.name.text === "sanitizeValue")
      )
        return true;
      current = current.parent;
    }
    return false;
  };
  const add = (node: ts.Node, operation: string, expression: ts.Expression): void => {
    found.push({
      ...located(sourceFile, node, operation, bindingIdentity(sourceFile, expression)),
      ...(sanitizerAncestor(node) ? { groundedSanitizer: "boundary-sanitizer" as const } : {}),
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const root = rootName(node.initializer);
      if (root)
        for (const element of node.name.elements) {
          const property = element.dotDotDotToken
            ? "*"
            : (element.propertyName ?? element.name).getText(sourceFile);
          add(element, `${root}.${property}`, node.initializer);
        }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const root = rootName(node.expression);
      if (root) add(node, node.getText(sourceFile), node.expression);
      else if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "env" &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "process" || node.expression.text === "Bun")
      ) {
        const parent = node.parent;
        const consumedAsMember =
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === node;
        const consumedAsAlias =
          ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
            parent.initializer === node) ||
          (ts.isBinaryExpression(parent) && parent.right === node);
        if (!consumedAsMember && !consumedAsAlias)
          add(node, node.getText(sourceFile), node.expression);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function dmlOperations(path: string, source: string): readonly LocatedOperation[] {
  const operationPattern =
    /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+((?:(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*))/gi;
  const targetName = (identifier: string): string =>
    required(identifier.split(".").at(-1), "SQL target identifier is empty")
      .trim()
      .replace(/^(?:["`[])(.*?)(?:["`\]])$/, "$1")
      .toLowerCase();
  if (path.endsWith(".sql"))
    return [...source.matchAll(operationPattern)].map((match) => {
      const index = match.index ?? 0;
      const before = source.slice(0, index);
      const line = before.split("\n").length;
      const column = index - before.lastIndexOf("\n");
      return {
        index,
        operation: `${String(match[1]).replace(/\s+/g, " ").toUpperCase()}:${targetName(String(match[2]))}`,
        receiver: `sql-file:${path}`,
        callsite: `${line}:${column}`,
      };
    });
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return [];

  const sourceFile = parseTypeScript(path, source);
  const constantBindings: Array<{
    readonly name: string;
    readonly declaration: ts.VariableDeclaration | ts.ParameterDeclaration;
    readonly initializer: ts.Expression | undefined;
  }> = [];
  const sqlReceivers = new Set(["db", "database", "sqlite", "connection", "client", "pool"]);
  const sqlFunctions = new Set<string>();
  const sqlTags = new Set(["sql"]);
  const sqlType = /(?:^|\W)(?:Database|Sqlite|SQL|Client|Pool)(?:\W|$)/;
  const sqlFactory = /^(?:createClient|createPool|connect|getDatabase|openDatabase)$/;
  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (
        /^(?:bun:sqlite|bun:sql|pg|postgres|mysql|mysql2|better-sqlite3|@libsql\/)/.test(moduleName)
      ) {
        const clause = node.importClause;
        if (clause?.name) sqlReceivers.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const element of clause.namedBindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported === "sql") sqlTags.add(element.name.text);
          }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.parent.flags & ts.NodeFlags.Const)
        constantBindings.push({
          name: node.name.text,
          declaration: node,
          initializer: node.initializer,
        });
      const typeText = node.type?.getText(sourceFile) ?? "";
      const initializer = node.initializer;
      const initializedBySqlFactory =
        initializer &&
        ((ts.isNewExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          sqlType.test(initializer.expression.text)) ||
          (ts.isCallExpression(initializer) &&
            ts.isIdentifier(initializer.expression) &&
            sqlFactory.test(initializer.expression.text)));
      if (sqlType.test(typeText) || initializedBySqlFactory) sqlReceivers.add(node.name.text);
      if (
        initializer &&
        ts.isIdentifier(initializer) &&
        (sqlReceivers.has(initializer.text) || sqlTags.has(initializer.text))
      )
        sqlReceivers.add(node.name.text);
      if (
        initializer &&
        (ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) &&
        ts.isIdentifier(initializer.expression) &&
        sqlReceivers.has(initializer.expression.text)
      ) {
        const member = ts.isPropertyAccessExpression(initializer)
          ? initializer.name.text
          : initializer.argumentExpression && ts.isStringLiteralLike(initializer.argumentExpression)
            ? initializer.argumentExpression.text
            : undefined;
        if (SQL_CALLS.has(member ?? "")) sqlFunctions.add(node.name.text);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      constantBindings.push({
        name: node.name.text,
        declaration: node,
        initializer: node.initializer,
      });
      const typeText = node.type?.getText(sourceFile) ?? "";
      if (sqlType.test(typeText)) {
        sqlReceivers.add(node.name.text);
        if (node.modifiers?.length) sqlReceivers.add(`this.${node.name.text}`);
      }
    }
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      const typeText = node.type?.getText(sourceFile) ?? "";
      if (sqlType.test(typeText)) sqlReceivers.add(`this.${node.name.text}`);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      sqlReceivers.has(node.initializer.text)
    ) {
      for (const element of node.name.elements) {
        const member = (element.propertyName ?? element.name).getText(sourceFile);
        if (SQL_CALLS.has(member) && ts.isIdentifier(element.name))
          sqlFunctions.add(element.name.text);
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);
  const lexicalScope = (node: ts.Node): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isSourceFile(current) ||
        ts.isFunctionLike(current) ||
        ts.isBlock(current) ||
        ts.isCaseBlock(current) ||
        ts.isCatchClause(current)
      )
        return current;
      current = current.parent;
    }
    return sourceFile;
  };
  const bindingFor = (
    name: string,
    use: ts.Node,
  ):
    | {
        readonly name: string;
        readonly declaration: ts.VariableDeclaration | ts.ParameterDeclaration;
        readonly initializer: ts.Expression | undefined;
      }
    | undefined => {
    const scopes = new Map<ts.Node, number>();
    let current: ts.Node | undefined = use;
    let depth = 0;
    while (current) {
      if (
        ts.isSourceFile(current) ||
        ts.isFunctionLike(current) ||
        ts.isBlock(current) ||
        ts.isCaseBlock(current) ||
        ts.isCatchClause(current)
      )
        scopes.set(current, depth++);
      current = current.parent;
    }
    return constantBindings
      .filter((binding) => binding.name === name && scopes.has(lexicalScope(binding.declaration)))
      .sort((left, right) => {
        const scopeDifference =
          required(scopes.get(lexicalScope(left.declaration)), "missing scope") -
          required(scopes.get(lexicalScope(right.declaration)), "missing scope");
        return (
          scopeDifference ||
          right.declaration.getStart(sourceFile) - left.declaration.getStart(sourceFile)
        );
      })[0];
  };
  const resolveSql = (expression: ts.Expression, seen = new Set<ts.Node>()): string | undefined => {
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isParenthesizedExpression(expression)) return resolveSql(expression.expression, seen);
    if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const resolved = resolveSql(span.expression, seen);
        if (resolved === undefined) return undefined;
        value += resolved + span.literal.text;
      }
      return value;
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = resolveSql(expression.left, seen);
      const right = resolveSql(expression.right, seen);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isIdentifier(expression)) {
      const binding = bindingFor(expression.text, expression);
      if (!binding?.initializer || seen.has(binding.declaration)) return undefined;
      return resolveSql(binding.initializer, new Set([...seen, binding.declaration]));
    }
    return undefined;
  };
  const found: LocatedOperation[] = [];
  const recordSql = (node: ts.Node, sql: string | undefined, receiver: string): void => {
    if (sql === undefined) {
      found.push(located(sourceFile, node, "UNRESOLVED-SQL", receiver));
      return;
    }
    for (const match of sql.matchAll(operationPattern))
      found.push(
        located(
          sourceFile,
          node,
          `${String(match[1]).replace(/\s+/g, " ").toUpperCase()}:${targetName(String(match[2]))}`,
          receiver,
        ),
      );
  };
  const memberName = (expression: ts.LeftHandSideExpression): string | undefined => {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (
      ts.isElementAccessExpression(expression) &&
      expression.argumentExpression &&
      ts.isStringLiteralLike(expression.argumentExpression)
    )
      return expression.argumentExpression.text;
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const member = memberName(node.expression);
      const receiver =
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
          ? node.expression.expression.getText(sourceFile)
          : undefined;
      const directSqlFunction =
        ts.isIdentifier(node.expression) && sqlFunctions.has(node.expression.text);
      const sql = resolveSql(required(node.arguments[0], "SQL call argument is missing"));
      const repositorySqlCall =
        directSqlFunction ||
        (member !== undefined &&
          SQL_CALLS.has(member) &&
          (sql !== undefined ||
            (receiver !== undefined &&
              (sqlReceivers.has(receiver) ||
                /(?:db|database|sqlite|connection|client|pool)/i.test(receiver)))));
      if (repositorySqlCall) {
        const receiverIdentity =
          ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)
            ? bindingIdentity(sourceFile, node.expression.expression)
            : bindingIdentity(sourceFile, node.expression);
        recordSql(node, sql, receiverIdentity);
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag;
      const repositorySqlTag =
        (ts.isIdentifier(tag) && (sqlTags.has(tag.text) || sqlReceivers.has(tag.text))) ||
        ((ts.isPropertyAccessExpression(tag) || ts.isElementAccessExpression(tag)) &&
          memberName(tag) === "sql");
      if (repositorySqlTag)
        recordSql(node, resolveSql(node.template), bindingIdentity(sourceFile, tag));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function astOperations(
  path: string,
  source: string,
): ReadonlyArray<readonly [ProducerKind, LocatedOperation]> {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return [];
  const sourceFile = parseTypeScript(path, source);
  const found: Array<readonly [ProducerKind, LocatedOperation]> = [];
  const importedName = (identifier: ts.Identifier): string | undefined => {
    let result: string | undefined;
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          if (element.name.text === identifier.text)
            result = element.propertyName?.text ?? element.name.text;
    }
    return result;
  };
  const callee = (
    expression: ts.Expression,
  ): { operation?: string; receiver: string; memberCall: boolean } => {
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
      return {
        operation: memberName(expression),
        receiver: bindingIdentity(sourceFile, expression.expression),
        memberCall: true,
      };
    if (ts.isIdentifier(expression)) {
      const binding = lexicalBinding(sourceFile, expression);
      if (binding && ts.isBindingElement(binding)) {
        const declaration = binding.parent.parent;
        const receiver =
          ts.isVariableDeclaration(declaration) && declaration.initializer
            ? bindingIdentity(sourceFile, declaration.initializer)
            : `destructure@${binding.getStart(sourceFile)}`;
        return {
          operation: (binding.propertyName ?? binding.name).getText(sourceFile),
          receiver,
          memberCall: true,
        };
      }
      const initializer = initializerAtUse(sourceFile, expression);
      if (initializer) {
        const descriptor = callee(resolveAliasExpression(sourceFile, initializer));
        return {
          ...descriptor,
          receiver: `${descriptor.receiver}->${bindingIdentity(sourceFile, expression)}`,
        };
      }
      return {
        operation: importedName(expression) ?? expression.text,
        receiver: bindingIdentity(sourceFile, expression),
        memberCall: false,
      };
    }
    return { receiver: `unresolved@${expression.getStart(sourceFile)}`, memberCall: false };
  };
  const add = (kind: ProducerKind, node: ts.Node, operation: string, receiver: string): void => {
    found.push([kind, located(sourceFile, node, operation, receiver)]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const descriptor = callee(node.expression);
      const operation = descriptor.operation;
      if (!operation && ts.isElementAccessExpression(node.expression))
        add("mutator", node, "UNRESOLVED-CALL", descriptor.receiver);
      if (operation) {
        if (FILESYSTEM_CALLS.has(operation))
          add("filesystem", node, operation, descriptor.receiver);
        if (PROCESS_CALLS.has(operation)) add("process", node, operation, descriptor.receiver);
        if (SOCKET_CALLS.has(operation)) add("socket", node, operation, descriptor.receiver);
        if (SERIALIZER_CALLS.has(operation))
          add("serializer", node, operation, descriptor.receiver);
        if (descriptor.memberCall && MUTATOR_CALLS.has(operation))
          add("mutator", node, operation, descriptor.receiver);
        const first = node.arguments[0];
        if (
          first &&
          (operation === "stringify" || operation === "String") &&
          /^(?:error|err|cause)$/i.test(first.getText(sourceFile))
        )
          add("error-boundary", node, `${operation}(error)`, descriptor.receiver);
      }
    }
    if (
      (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) &&
      node.name.getText(sourceFile) === "toJSON"
    )
      add("serializer", node, "toJSON", bindingIdentity(sourceFile, node.name as ts.Expression));
    if (
      ts.isPropertyDeclaration(node) &&
      node.name.getText(sourceFile) === "toJSON" &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      add("serializer", node, "toJSON", bindingIdentity(sourceFile, node.name as ts.Expression));
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      memberName(node) === "stack" &&
      /^(?:error|err|cause)$/i.test(node.expression.getText(sourceFile))
    )
      add("error-boundary", node, "error.stack", bindingIdentity(sourceFile, node.expression));
    if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === "cause") {
      const value = node.initializer.getText(sourceFile);
      if (/^(?:error|err|cause)$/i.test(value))
        add("error-boundary", node, "cause:error", bindingIdentity(sourceFile, node.initializer));
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      memberName(node) === "pid"
    )
      add("pid", node, node.getText(sourceFile), bindingIdentity(sourceFile, node.expression));
    if (ts.isIdentifier(node) && (node.text === "pidFile" || node.text === "pidPath")) {
      const parent = node.parent;
      if (!((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node))
        add("pid", node, node.text, bindingIdentity(sourceFile, node));
    }
    if (ts.isStringLiteralLike(node)) {
      for (const match of node.text.matchAll(
        /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*))/gi,
      ))
        add(
          "table",
          node,
          String(match[1])
            .replace(/^["`[]|["`\]]$/g, "")
            .toLowerCase(),
          `sql-literal@${node.getStart(sourceFile)}`,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const SECRET_SINK_OPERATIONS = {
  Auth: new Set(["apply", "get", "load", "read", "register", "resolve", "set", "sign"]),
  provider: new Set([
    "chat",
    "complete",
    "create",
    "doGenerate",
    "doStream",
    "generate",
    "generateText",
    "request",
    "stream",
    "streamText",
  ]),
  Bus: new Set(["emit", "publish"]),
  log: new Set(["debug", "error", "info", "log", "trace", "warn"]),
  IPC: new Set(["postMessage", "request", "respond", "send", "write"]),
  worker: new Set(["deliver", "emit", "run", "send", "spawn", "start"]),
  connector: new Set(["call", "emit", "execute", "invoke", "request", "send"]),
  cache: new Set(["get", "load", "put", "set"]),
  result: new Set(["emit", "publish", "send", "write"]),
  run: new Set(["emit", "publish", "send", "write"]),
} as const;

type ConcreteSecretSink = keyof typeof SECRET_SINK_OPERATIONS;

function secretBoundaryOperations(
  path: string,
  source: string,
): ReadonlyArray<readonly [ProducerKind, LocatedOperation]> {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return [];
  const sourceFile = parseTypeScript(path, source);
  const imports = new Map<string, { imported: string; module: string }>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) imports.set(clause.name.text, { imported: "default", module });
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const element of clause.namedBindings.elements)
        imports.set(element.name.text, {
          imported: element.propertyName?.text ?? element.name.text,
          module,
        });
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      imports.set(clause.namedBindings.name.text, { imported: "namespace", module });
  }
  const bindingSemantics = (identifier: ts.Identifier): string => {
    const imported = imports.get(identifier.text);
    if (imported) return `${imported} ${imported.module}`;
    const binding = lexicalBinding(sourceFile, identifier);
    if (!binding) return identifier.text;
    const type = "type" in binding && binding.type ? binding.type.getText(sourceFile) : "";
    const importedTypes = [...type.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)]
      .map((match) => imports.get(match[0])?.imported)
      .filter((name): name is string => name !== undefined)
      .join(" ");
    const initializer = binding.initializer?.getText(sourceFile) ?? "";
    return `${identifier.text} ${type} ${importedTypes} ${initializer}`;
  };
  const expressionSemantics = (expression: ts.Expression): string => {
    if (ts.isIdentifier(expression)) return bindingSemantics(expression);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
      return `${expressionSemantics(expression.expression)} ${memberName(expression) ?? ""}`;
    return expression.getText(sourceFile);
  };
  const classify = (
    operation: string,
    semantics: string,
    payload: string,
  ): ConcreteSecretSink | undefined => {
    const concreteOperation = (sink: ConcreteSecretSink): boolean =>
      SECRET_SINK_OPERATIONS[sink].has(operation as never);
    if (
      /\b(?:SecretRegistry|Auth|Credential|TokenStore)\b/i.test(semantics) &&
      concreteOperation("Auth")
    )
      return "Auth";
    if (
      (/\b(?:Provider|LanguageModel|ChatModel|Completion|Anthropic|OpenAI)\b/i.test(semantics) ||
        /(?:^|\s)ai(?:$|\s)/.test(semantics)) &&
      concreteOperation("provider")
    )
      return "provider";
    if (/\bBus\b/.test(semantics) && concreteOperation("Bus")) {
      if (/\b(?:WorkerRun|RunEvent|RunLifecycle)\b/.test(payload)) return "run";
      if (/(?:Result|Outcome|Completion)/.test(payload)) return "result";
      return "Bus";
    }
    if (
      (/\b(?:Logger|LogSink)\b/i.test(semantics) || /^(?:global:)?console$/.test(semantics)) &&
      concreteOperation("log")
    )
      return "log";
    if (/(?:IPC|Ipc|MessagePort|ChildProcess|Socket)/i.test(semantics) && concreteOperation("IPC"))
      return "IPC";
    if (
      /\b(?:Worker|WorkerManager|WorkerSupervisor)\b/.test(semantics) &&
      concreteOperation("worker")
    )
      return "worker";
    if (/Connector/i.test(semantics) && concreteOperation("connector")) return "connector";
    if (/\bcache\b/i.test(semantics) && concreteOperation("cache")) return "cache";
    if (/\b(?:ResultEmitter|ResultSink)\b/.test(semantics) && concreteOperation("result"))
      return "result";
    if (/\b(?:RunEmitter|RunSink)\b/.test(semantics) && concreteOperation("run")) return "run";
    const direct = /^(?:emit|publish|send|write)(Result|Run)$/.exec(operation)?.[1];
    return direct === "Result" ? "result" : direct === "Run" ? "run" : undefined;
  };
  const containsRawSecret = (node: ts.Node | undefined): boolean => {
    if (!node) return false;
    if (ts.isFunctionLike(node)) return false;
    if (ts.isStringLiteralLike(node)) return /\bsecret\b/i.test(node.text);
    if (ts.isIdentifier(node))
      return /^(?:secret|token|credential|password|apiKey|error|err|cause)$/i.test(node.text);
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sourceFile).replace(/["']/g, "");
      if (/^(?:secret|token|credential|password|apiKey)$/i.test(name)) return true;
      return containsRawSecret(node.initializer);
    }
    if (ts.isShorthandPropertyAssignment(node)) return containsRawSecret(node.name);
    let risky = false;
    ts.forEachChild(node, (child) => {
      if (!risky && containsRawSecret(child)) risky = true;
    });
    return risky;
  };

  const found: Array<readonly [ProducerKind, LocatedOperation]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const operation = ts.isIdentifier(expression)
        ? expression.text
        : memberName(expression as ts.Expression);
      const receiver =
        ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
          ? expression.expression
          : expression;
      if (operation) {
        const importedReceiver = ts.isIdentifier(receiver) ? imports.get(receiver.text) : undefined;
        const semantics = importedReceiver
          ? `${importedReceiver.imported} ${importedReceiver.module}`
          : expressionSemantics(receiver);
        const discriminator = node.arguments[0]?.getText(sourceFile) ?? "";
        const sink = classify(operation, semantics, discriminator);
        const payload =
          sink === "Bus" || sink === "run" || sink === "result"
            ? (node.arguments[1] ?? node.arguments[0])
            : sink === "cache" && operation === "set"
              ? node.arguments[1]
              : node.arguments[0];
        if (sink) {
          const boundaryRisk = containsRawSecret(payload)
            ? "raw-secret-egress"
            : "typed-executable-category";
          found.push([
            "secret-boundary",
            {
              ...located(
                sourceFile,
                node,
                `${sink}:${operation}`,
                bindingIdentity(sourceFile, receiver),
              ),
              boundaryRisk,
            },
          ]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function mutationDisposition(discovery: Discovery): {
  status: Status;
  writer: string;
  caller: string;
  test: string;
  scope: string;
  boundary: string;
} {
  const scope = scopeDisposition(discovery);
  const status: Status = "current";
  const receipts = focusedReceipts(discovery);
  return {
    status,
    writer: isSoleLedgerWriter(discovery.path, discovery.symbol)
      ? "sole-ledger-writer"
      : "current-target-mutation",
    caller:
      discovery.symbol === "<module>"
        ? `${discovery.path} module initialization`
        : discovery.symbol,
    test:
      receipts[0] ??
      "script/conformance/p2-manifests.test.ts#checked manifest is exact and currently green",
    scope: scope.scope,
    boundary: discovery.kind,
  };
}

function sourceTreeCacheKey(sources: SourceTree): string {
  const hash = createHash("sha256");
  for (const [path, source] of sources) hash.update(path).update("\0").update(source).update("\0");
  return hash.digest("hex");
}

const DISCOVERY_CACHE = new Map<string, readonly Discovery[]>();
const FILE_DISCOVERY_CACHE = new Map<string, Map<string, readonly Discovery[]>>();

export function discoverP2Producers(sources: SourceTree): readonly Discovery[] {
  const cacheKey = sourceTreeCacheKey(sources);
  const cached = DISCOVERY_CACHE.get(cacheKey);
  if (cached) return cached;
  const discoveries = new Map<string, Discovery>();
  for (const [path, raw] of sources) {
    if (path.includes("/test/") || path.endsWith(".test.ts") || path.endsWith(".test.tsx"))
      continue;
    let fileCache = FILE_DISCOVERY_CACHE.get(path);
    if (fileCache === undefined) {
      fileCache = new Map();
      FILE_DISCOVERY_CACHE.set(path, fileCache);
    }
    const fileCached = fileCache.get(raw);
    if (fileCached !== undefined) {
      for (const discovery of fileCached) discoveries.set(discovery.id, discovery);
      continue;
    }
    const fileDiscoveries: Discovery[] = [];
    const source = executableSource(raw);
    const operations: Array<readonly [ProducerKind, LocatedOperation]> = [
      ...dmlOperations(path, source).map((entry) => ["dml", entry] as const),
      ...environmentOperations(path, source).map((entry) => ["environment", entry] as const),
      ...astOperations(path, source),
      ...secretBoundaryOperations(path, source),
    ];
    if (path.endsWith(".sql")) {
      for (const match of source.matchAll(
        /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*))/gi,
      )) {
        const index = match.index ?? 0;
        const before = source.slice(0, index);
        operations.push([
          "table",
          {
            index,
            operation: String(match[1])
              .replace(/^["`[]|["`\]]$/g, "")
              .toLowerCase(),
            receiver: `sql-file:${path}`,
            callsite: `${before.split("\n").length}:${index - before.lastIndexOf("\n")}`,
          },
        ]);
      }
    }
    for (const [kind, found] of operations) {
      const symbol = nearestSymbol(path, source, found.index);
      const key = `${path}\u0000${kind}\u0000${symbol}\u0000${found.operation}\u0000${found.receiver}\u0000${found.callsite}`;
      const authority =
        kind === "mutator" ? mutationAuthority(path, symbol, source, found) : "authoritative";
      const discovery = {
        id: stableId("producer", key),
        path,
        kind,
        symbol,
        operation: found.operation,
        receiver: found.receiver,
        callsite: found.callsite,
        authority,
        ...(found.groundedSanitizer === undefined
          ? {}
          : { groundedSanitizer: found.groundedSanitizer }),
        ...(found.boundaryRisk === undefined ? {} : { boundaryRisk: found.boundaryRisk }),
      } satisfies Discovery;
      discoveries.set(key, discovery);
      fileDiscoveries.push(discovery);
    }
    if (fileCache.size >= 128) fileCache.clear();
    fileCache.set(raw, fileDiscoveries);
  }
  const result = [...discoveries.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (DISCOVERY_CACHE.size >= 32) DISCOVERY_CACHE.clear();
  DISCOVERY_CACHE.set(cacheKey, result);
  return result;
}

function validField(key: string, value: unknown): boolean {
  if (key === "evidence") return strings(value);
  if (key === "testIds")
    return (
      Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
    );
  if (key === "targetShipped") return typeof value === "boolean";
  if (key === "status") return rowStatus(value);
  return typeof value === "string" && value.length > 0;
}

function indexRows(
  manifest: P2Manifest,
  issues: ManifestIssue[],
): Map<string, { section: SectionName; row: Record<string, unknown> }> {
  const index = new Map<string, { section: SectionName; row: Record<string, unknown> }>();
  for (const section of SECTION_NAMES) {
    const rows = manifest[section];
    if (!Array.isArray(rows)) {
      issues.push(issue("schema", section, "section must be an array"));
      continue;
    }
    for (const [position, row] of rows.entries()) {
      if (!isRecord(row)) {
        issues.push(issue("schema", `${section}[${position}]`, "row must be an object"));
        continue;
      }
      const allowed = new Set(SECTION_KEYS[section]);
      const unknown = Object.keys(row).filter((key) => !allowed.has(key));
      const missing = SECTION_KEYS[section].filter((key) => !(key in row));
      const invalid = SECTION_KEYS[section].filter(
        (key) => key in row && !validField(key, row[key]),
      );
      if (unknown.length > 0 || missing.length > 0 || invalid.length > 0) {
        issues.push(
          issue(
            "schema",
            `${section}[${position}]`,
            `strict row mismatch; missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"}; invalid=${invalid.join(",") || "none"}`,
          ),
        );
        continue;
      }
      const id = String(row.id);
      if (index.has(id))
        issues.push(issue("duplicate-row", id, "ID must resolve exactly once across all sections"));
      else index.set(id, { section, row });
    }
  }
  return index;
}

function exactRows(
  family: string,
  expected: readonly string[],
  actual: readonly string[],
  issues: ManifestIssue[],
): void {
  const expectedCounts = new Map<string, number>();
  const actualCounts = new Map<string, number>();
  for (const value of expected) expectedCounts.set(value, (expectedCounts.get(value) ?? 0) + 1);
  for (const value of actual) actualCounts.set(value, (actualCounts.get(value) ?? 0) + 1);
  for (const value of new Set([...expected, ...actual])) {
    const wanted = expectedCounts.get(value) ?? 0;
    const found = actualCounts.get(value) ?? 0;
    if (wanted !== found)
      issues.push(
        issue(
          family,
          value,
          `exact catalog cardinality mismatch; expected ${wanted}, found ${found}`,
        ),
      );
  }
}

function validateEvidence(
  manifest: P2Manifest,
  sources: SourceTree,
  issues: ManifestIssue[],
): void {
  for (const section of SECTION_NAMES) {
    for (const row of manifest[section] ?? []) {
      if (!isRecord(row) || !strings(row.evidence)) continue;
      for (const path of row.evidence)
        if (!sources.has(path))
          issues.push(
            issue("missing-evidence", String(row.id), `${path} is absent from the current tree`),
          );
      if (row.status === "planned-p3" && section !== "p3-disposition")
        issues.push(
          issue(
            "planned-claim",
            String(row.id),
            "later-milestone status is permitted only in p3-disposition",
          ),
        );
      if (section !== "p3-disposition" && (row.status !== "current" || row.targetShipped !== true))
        issues.push(
          issue("production-claim", String(row.id), "every P2 row must be current and shipped"),
        );
      if (
        /legacy compatibility|upcast/i.test(
          Object.values(row)
            .filter((value) => typeof value === "string")
            .join(" "),
        )
      )
        issues.push(
          issue(
            "stale-compatibility",
            String(row.id),
            "revision 9 requires delete-at-P2-04 clean break wording",
          ),
        );
    }
  }
}

const RECEIPT_TITLE_CACHE = new Map<string, ReadonlySet<string>>();

function declaresExactTestTitle(source: string, title: string): boolean {
  const cached = RECEIPT_TITLE_CACHE.get(source);
  if (cached !== undefined) return cached.has(title);
  const sourceFile = parseTypeScript("receipt.test.ts", source);
  const testBindings = new Set(["test", "it"]);
  const describeBindings = new Set(["describe"]);
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "bun:test" ||
      statement.importClause?.isTypeOnly
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "test" || imported === "it") testBindings.add(element.name.text);
      if (imported === "describe") describeBindings.add(element.name.text);
    }
  }

  const registration = (
    call: ts.CallExpression,
    bindings: ReadonlySet<string>,
  ): { readonly modifier?: string } | undefined => {
    const expression = call.expression;
    const identifier = ts.isIdentifier(expression)
      ? expression
      : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
        ? expression.expression
        : undefined;
    if (!identifier || !bindings.has(identifier.text) || lexicalBinding(sourceFile, identifier))
      return undefined;
    return {
      modifier: ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined,
    };
  };
  const staticTruthiness = (expression: ts.Expression): boolean | undefined => {
    if (ts.isParenthesizedExpression(expression)) return staticTruthiness(expression.expression);
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword
    )
      return false;
    if (ts.isNumericLiteral(expression)) return Number(expression.text) !== 0;
    if (ts.isStringLiteralLike(expression)) return expression.text.length > 0;
    if (
      ts.isPrefixUnaryExpression(expression) &&
      expression.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const operand = staticTruthiness(expression.operand);
      return operand === undefined ? undefined : !operand;
    }
    return undefined;
  };

  const declared = new Set<string>();
  const visitExpression = (expression: ts.Expression, skippedSuite: boolean): void => {
    if (!ts.isCallExpression(expression)) return;
    const testRegistration = registration(expression, testBindings);
    if (testRegistration) {
      const skipped =
        skippedSuite ||
        testRegistration.modifier === "skip" ||
        testRegistration.modifier === "todo";
      if (
        !skipped &&
        expression.arguments[0] &&
        ts.isStringLiteralLike(expression.arguments[0]) &&
        expression.arguments[1] !== undefined
      )
        declared.add(expression.arguments[0].text);
      return;
    }
    const describeRegistration = registration(expression, describeBindings);
    if (!describeRegistration) return;
    const callback = expression.arguments[1];
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;
    const skipped =
      skippedSuite ||
      describeRegistration.modifier === "skip" ||
      describeRegistration.modifier === "todo";
    if (ts.isBlock(callback.body)) visitStatements(callback.body.statements, skipped);
    else visitExpression(callback.body, skipped);
  };
  const visitStatement = (statement: ts.Statement, skippedSuite: boolean): boolean => {
    if (ts.isBlock(statement)) return visitStatements(statement.statements, skippedSuite);
    if (ts.isExpressionStatement(statement)) {
      visitExpression(statement.expression, skippedSuite);
      return true;
    }
    if (ts.isIfStatement(statement)) {
      const condition = staticTruthiness(statement.expression);
      if (condition !== false) visitStatement(statement.thenStatement, skippedSuite);
      if (condition !== true && statement.elseStatement)
        visitStatement(statement.elseStatement, skippedSuite);
      return true;
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      if (staticTruthiness(statement.expression) !== false)
        visitStatement(statement.statement, skippedSuite);
      return true;
    }
    if (ts.isForStatement(statement)) {
      if (!statement.condition || staticTruthiness(statement.condition) !== false)
        visitStatement(statement.statement, skippedSuite);
      return true;
    }
    if (ts.isLabeledStatement(statement)) return visitStatement(statement.statement, skippedSuite);
    return !(
      ts.isReturnStatement(statement) ||
      ts.isThrowStatement(statement) ||
      ts.isBreakStatement(statement) ||
      ts.isContinueStatement(statement)
    );
  };
  const visitStatements = (
    statements: ts.NodeArray<ts.Statement>,
    skippedSuite: boolean,
  ): boolean => {
    for (const statement of statements) if (!visitStatement(statement, skippedSuite)) return false;
    return true;
  };
  visitStatements(sourceFile.statements, false);
  RECEIPT_TITLE_CACHE.set(source, declared);
  return declared.has(title);
}

function validateReceipts(
  manifest: P2Manifest,
  sources: SourceTree,
  issues: ManifestIssue[],
): void {
  for (const section of SECTION_NAMES) {
    for (const row of manifest[section]) {
      const receipts =
        typeof row.test === "string"
          ? [row.test]
          : Array.isArray(row.testIds)
            ? row.testIds.filter((entry): entry is string => typeof entry === "string")
            : undefined;
      if (!receipts) continue;
      if (receipts.length === 0) {
        issues.push(
          issue(
            "missing-receipt",
            String(row.id),
            "every receipt-bearing current row requires a nonempty executable receipt",
          ),
        );
        continue;
      }
      for (const receiptId of receipts) {
        const [declaredPath, declaredTitle] = receiptId.split("#", 2);
        const source = sources.get(declaredPath ?? "");
        const testPath = /(?:\.test\.tsx?|\/test\/.*\.ts)$/.test(declaredPath ?? "");
        const related =
          (Array.isArray(row.evidence) && row.evidence.includes(declaredPath)) ||
          KNOWN_EXECUTABLE_RECEIPTS.has(receiptId);
        const resolvesByNamedReceipt =
          declaredTitle !== undefined &&
          declaredTitle.length > 0 &&
          testPath &&
          source !== undefined &&
          related &&
          declaresExactTestTitle(source, declaredTitle);
        if (!resolvesByNamedReceipt)
          issues.push(
            issue(
              "missing-receipt",
              String(row.id),
              `${receiptId} does not name a non-skipped executable test`,
            ),
          );
      }
    }
  }
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;])\s*/g, "$1")
    .trim();
}

function finalSchemaDefinitions(sources: SourceTree): ReadonlyMap<string, string> {
  const baseline = sources.get(BASELINE_MIGRATION_PATH) ?? "";
  const definitions = new Map<string, string>();
  for (const match of baseline.matchAll(
    /CREATE\s+TABLE\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*STRICT\s*;/gi,
  )) {
    const name = String(match[1]).toLowerCase();
    if (definitions.has(`table:${name}`))
      throw new Error(`duplicate STRICT baseline table DDL: ${name}`);
    definitions.set(`table:${name}`, normalizeSql(match[0]));
  }
  const missingTables = TARGET_TABLES.filter((name) => !definitions.has(`table:${name}`));
  if (missingTables.length > 0)
    throw new Error(`missing STRICT baseline table DDL: ${missingTables.join(", ")}`);
  if (definitions.size !== TARGET_TABLES.length)
    throw new Error(
      `baseline table cardinality must be ${TARGET_TABLES.length}; found ${definitions.size}`,
    );
  return definitions;
}

function validateSchemaCatalog(
  manifest: P2Manifest,
  sources: SourceTree,
  issues: ManifestIssue[],
): void {
  const baseline = sources.get(BASELINE_MIGRATION_PATH) ?? "";
  const actualTables = [...baseline.matchAll(/CREATE TABLE\s+([a-z_]+)/gi)].map((match) =>
    String(match[1]).toLowerCase(),
  );
  exactRows("schema-catalog", TARGET_TABLES, actualTables, issues);
  try {
    finalSchemaDefinitions(sources);
  } catch (error) {
    issues.push(
      issue(
        "schema-ddl",
        BASELINE_MIGRATION_PATH,
        error instanceof Error ? error.message : "production baseline DDL extraction failed",
      ),
    );
  }
  const expected = TARGET_TABLES.map((name) => `table:${name}`);
  const actual = manifest["final-schema"].map((row) => `${row.objectKind}:${row.objectName}`);
  exactRows("schema-catalog", expected, actual, issues);
  for (const row of manifest["final-schema"]) {
    if (row.status !== "current" || row.targetShipped !== true)
      issues.push(
        issue(
          "production-claim",
          String(row.id),
          "production baseline schema foundation is current and shipped",
        ),
      );
  }
}

function catalogSignature(
  row: (typeof CLOSED_OPERATION_CATALOG_V1)[number],
): Record<string, string> {
  return {
    catalogId: row.id,
    catalogVersion: NATIVE_TRANSITION_CATALOG_VERSION,
    command: row.command,
    emission: JSON.stringify(row.emission),
    guard: JSON.stringify({ expectedHead: row.expectedHeadAssertions, reads: row.readAssertions }),
    owner: row.ownerDerivation,
    assertions: JSON.stringify([...row.expectedHeadAssertions, ...row.readAssertions]),
    reducers: JSON.stringify(row.reducerIds),
    projections: JSON.stringify(row.projectionIds),
    bus: row.busObservation,
    effect: JSON.stringify(row.effect),
    reconciler: row.effect.reconcilerId ?? "none",
    caller: row.callerReplacement,
    test: "packages/openomni/test/ledger/native-transitions.test.ts#matches the independently reviewed exhaustive full-row golden",
  };
}

function validateNativeCatalog(manifest: P2Manifest, issues: ManifestIssue[]): void {
  exactRows(
    "native-catalog",
    CLOSED_OPERATION_CATALOG_V1.map((row) => row.id),

    manifest["native-transition"].map((row) => String(row.catalogId)),
    issues,
  );
  for (const row of manifest["native-transition"]) {
    const expected = CLOSED_OPERATION_CATALOG_V1.find((entry) => entry.id === row.catalogId);

    if (!expected) continue;
    for (const [key, value] of Object.entries(catalogSignature(expected))) {
      if (row[key] !== value)
        issues.push(
          issue(
            "native-catalog",
            String(row.id),
            `${key} does not match closed native catalog ${expected.id}`,
          ),
        );
    }
    const expectedRow = {
      id: `transition.${expected.id}`,
      status: "current",
      evidence: [
        "packages/openomni/src/ledger/native-transitions.ts",
        "packages/openomni/test/ledger/native-transitions.test.ts",
      ],
      ...catalogSignature(expected),
      targetShipped: true,
    };
    if (rowSignature(row) !== rowSignature(expectedRow))
      issues.push(
        issue(
          "native-catalog",
          String(row.id),
          `complete row metadata does not match closed native catalog ${expected.id}`,
        ),
      );
  }
  const expectedFamilyCounts = {
    ...NATIVE_TRANSITION_FAMILY_CARDINALITIES,
    ...CONFIGURATION_OPERATION_FAMILY_CARDINALITIES,
  };
  const familyCounts = Object.fromEntries(
    Object.keys(expectedFamilyCounts).map((family) => [
      family,
      manifest["native-transition"].filter((row) => String(row.catalogId).startsWith(`${family}-`))
        .length,
    ]),
  );
  for (const [family, count] of Object.entries(expectedFamilyCounts))
    if (familyCounts[family] !== count)
      issues.push(
        issue(
          "native-cardinality",
          family,
          `expected ${count}, found ${familyCounts[family] ?? 0}`,
        ),
      );
}

function hasConcreteEffectUse(path: string, source: string): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  const sourceFile = parseTypeScript(path, source);
  const effectBindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      if (
        /^(?:EffectScope|EffectScopeRegistry|EffectRegistry|EffectResolver|resolveEffectScope)$/.test(
          imported,
        )
      )
        effectBindings.add(element.name.text);
    }
  }

  const resolvesEffectValue = (expression: ts.Expression, seen = new Set<string>()): boolean => {
    if (ts.isParenthesizedExpression(expression))
      return resolvesEffectValue(expression.expression, seen);
    if (ts.isIdentifier(expression)) {
      const binding = lexicalBinding(sourceFile, expression);
      if (!binding) return effectBindings.has(expression.text);
      const identity = `${expression.text}@${binding.getStart(sourceFile)}`;
      if (seen.has(identity) || !binding.initializer) return false;
      return resolvesEffectValue(binding.initializer, new Set([...seen, identity]));
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
      return resolvesEffectValue(expression.expression, seen);
    if (ts.isNewExpression(expression)) return resolvesEffectValue(expression.expression, seen);
    if (ts.isCallExpression(expression)) return resolvesEffectValue(expression.expression, seen);
    return false;
  };

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isNewExpression(node)) {
      found =
        resolvesEffectValue(node.expression) ||
        node.arguments?.some((argument) => resolvesEffectValue(argument)) === true;
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      found =
        resolvesEffectValue(expression) ||
        ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
          resolvesEffectValue(expression.expression)) ||
        node.arguments.some((argument) => resolvesEffectValue(argument));
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function discoverEffectConsumers(sources: SourceTree): readonly string[] {
  return [...sources]
    .filter(([path]) => !path.includes("/test/") && !path.endsWith(".test.ts"))
    .filter(([path, source]) => hasConcreteEffectUse(path, executableSource(source)))
    .map(([path]) => path)
    .sort();
}

function validateSourceCensus(
  manifest: P2Manifest,
  sources: SourceTree,
  issues: ManifestIssue[],
): void {
  const discovered = discoverP2Producers(sources);
  const key = (entry: {
    path: unknown;
    kind?: unknown;
    producerKind?: unknown;
    symbol: unknown;
    operation: unknown;
    receiver: unknown;
    callsite: unknown;
  }) =>
    `${entry.path}\u0000${entry.kind ?? entry.producerKind}\u0000${entry.symbol}\u0000${entry.operation}\u0000${entry.receiver}\u0000${entry.callsite}`;
  exactRows("unknown-producer", discovered.map(key), manifest["durable-surface"].map(key), issues);
  if (
    manifest["durable-surface"].some((row) => row.path === "**" || String(row.path).includes("*"))
  )
    issues.push(issue("blanket-surface", "durable-surface", "glob or blanket rows are forbidden"));
  const classifiedCounts = new Map<string, number>();
  for (const row of manifest["durable-surface"])
    classifiedCounts.set(key(row), (classifiedCounts.get(key(row)) ?? 0) + 1);
  for (const [surfaceKey, count] of classifiedCounts)
    if (count > 1)
      issues.push(
        issue("duplicate-classification", surfaceKey, `exact surface is classified ${count} times`),
      );

  const surfaceByKey = new Map(manifest["durable-surface"].map((row) => [key(row), row]));
  const mutations = discovered.filter(isMutation);
  const mutationKey = (row: Record<string, unknown>) =>
    `${row.file}\u0000${row.operation}\u0000${row.symbol}\u0000${row.receiver}\u0000${row.callsite}\u0000${row.boundary}`;
  exactRows(
    "mutation-catalog",
    mutations.map(
      (entry) =>
        `${entry.path}\u0000${entry.operation}\u0000${entry.symbol}\u0000${entry.receiver}\u0000${entry.callsite}\u0000${entry.kind}`,
    ),
    manifest["production-mutation"].map(mutationKey),
    issues,
  );
  const discoveriesByMutationKey = new Map(
    mutations.map((entry) => [
      `${entry.path}\u0000${entry.operation}\u0000${entry.symbol}\u0000${entry.receiver}\u0000${entry.callsite}\u0000${entry.kind}`,
      entry,
    ]),
  );
  for (const row of manifest["production-mutation"]) {
    const discovery = discoveriesByMutationKey.get(mutationKey(row));
    if (!discovery) continue;
    const expected = mutationDisposition(discovery);
    for (const field of ["status", "writer", "caller", "test", "scope", "boundary"] as const) {
      if (row[field] !== expected[field])
        issues.push(
          issue(
            "mutation-disposition",
            String(row.id),
            `${field} must be derived from discovered source; expected ${expected[field]}`,
          ),
        );
    }
    const expectedSurface = surfaceByKey.get(key(discovery));
    if (
      row.id !== stableId("mutation", discovery.id) ||
      row.surfaceId !== expectedSurface?.id ||
      row.targetShipped !== (expected.status === "current") ||
      !Array.isArray(row.evidence) ||
      row.evidence.length !== 1 ||
      row.evidence[0] !== discovery.path
    )
      issues.push(
        issue(
          "mutation-disposition",
          String(row.id),
          "id, surface, evidence, and shipped state must be derived exactly from source discovery",
        ),
      );
    if (
      row.file !== discovery.path ||
      row.symbol !== discovery.symbol ||
      row.operation !== discovery.operation ||
      row.receiver !== discovery.receiver ||
      row.callsite !== discovery.callsite
    )
      issues.push(
        issue(
          "mutation-disposition",
          String(row.id),
          "file, symbol, and operation must exactly match syntax-aware source discovery",
        ),
      );
  }
  for (const discovery of discovered) {
    const surface = surfaceByKey.get(key(discovery));
    const expected = surfaceClassification(discovery);
    if (surface?.classification !== expected) {
      issues.push(
        issue(
          "surface-classification",
          discovery.id,
          `expected grounded classification ${expected}`,
        ),
      );
    }
  }

  for (const row of manifest["production-mutation"]) {
    const surface = [...surfaceByKey.values()].find((entry) => entry.id === row.surfaceId);
    if (!surface)
      issues.push(
        issue(
          "unresolved-reference",
          String(row.id),
          `surface ${String(row.surfaceId)} resolves zero times`,
        ),
      );
    if (!String(row.caller) || !String(row.test))
      issues.push(
        issue("missing-caller", String(row.id), "caller and test disposition are required"),
      );
    const scopes = manifest["effect-scope"].filter((scope) => scope.mutationId === row.id);
    if (scopes.length !== 1)
      issues.push(
        issue(
          "unscoped-mutation",
          String(row.id),
          `mutation requires exactly one scope row; found ${scopes.length}`,
        ),
      );
  }
  for (const surface of manifest["durable-surface"]) {
    const dispositions = manifest["store-disposition"].filter(
      (row) => row.surfaceId === surface.id,
    );
    if (dispositions.length !== 1)
      issues.push(
        issue(
          "store-disposition",
          String(surface.id),
          `surface requires exactly one disposition; found ${dispositions.length}`,
        ),
      );
  }
  for (const boundary of discovered.filter((entry) => BOUNDARY_KINDS.has(entry.kind))) {
    const surface = surfaceByKey.get(key(boundary));
    const rows = manifest["secret-boundary"].filter((row) => row.surfaceId === surface?.id);
    const row = rows[0];
    const groundedDisposition =
      row?.status === "current" &&
      row.targetShipped === true &&
      row.sanitizer !== "none" &&
      typeof row.exception === "string" &&
      row.exception !== "none" &&
      Array.isArray(row.testIds) &&
      row.testIds.length > 0;
    if (rows.length !== 1 || !groundedDisposition)
      issues.push(
        issue(
          "unsanitized-boundary",
          boundary.id,
          "boundary requires an exact current sanitizer or not-a-secret-boundary disposition with executable receipts",
        ),
      );
  }
  const expectedEffectConsumers = discoverEffectConsumers(sources);
  const actualEffectConsumers = manifest["effect-scope"]
    .filter((row) => row.mutationId === "none")
    .map((row) => String(row.toolOrDriver));
  exactRows("effect-catalog", expectedEffectConsumers, actualEffectConsumers, issues);
}

function dmlTargets(path: string, source: string): readonly string[] {
  return dmlOperations(path, source).map((entry) =>
    entry.operation.slice(entry.operation.indexOf(":") + 1),
  );
}

function validateForbiddenSources(sources: SourceTree, issues: ManifestIssue[]): void {
  const writerFiles = new Set([SOLE_LEDGER_WRITER.path]);
  for (const [path, raw] of sources) {
    if (path.includes("/test/") || path.endsWith(".test.ts") || path.endsWith(".test.tsx"))
      continue;
    const source = executableSource(raw);
    if (/\b(?:UNSAFE|unsafeMarker|bypassSafety)\b/.test(source))
      issues.push(issue("unsafe-marker", path, "unsafe marker is prohibited"));
    if (
      AUTH_STORAGE_NAME.test(path) &&
      (/\b(?:writeFile|Bun\.write)\s*\(/.test(source) ||
        /\.(?:set|save|delete)\s*\(/.test(source)) &&
      !path.endsWith("secret-registry.ts") &&
      !path.endsWith("boundary-sanitizer.ts") &&
      !path.endsWith("storage.ts")
    )
      issues.push(
        issue(
          "auth-writer",
          path,
          "Auth target is read-only; only current source/registry exceptions may remain until P2-04",
        ),
      );
    if (/\b(?:authority|sourceOfTruth)\s*=\s*model[A-Za-z0-9_]*cache\b/i.test(source))
      issues.push(
        issue("model-cache-authority", path, "model cache is derived and non-authoritative"),
      );
    if (
      dmlTargets(path, source).some((table) => LEDGER_WRITER_TABLES.has(table)) &&
      !writerFiles.has(path)
    )
      issues.push(issue("second-writer", path, "ledger authority tables have exactly one writer"));
    if (writerFiles.has(path)) {
      const rogueWriterSymbols = dmlOperations(path, source)
        .filter((entry) =>
          LEDGER_WRITER_TABLES.has(entry.operation.slice(entry.operation.indexOf(":") + 1)),
        )
        .map((entry) => nearestSymbol(path, source, entry.index))
        .filter((symbol) => !isSoleLedgerWriter(path, symbol));
      if (rogueWriterSymbols.length > 0)
        issues.push(
          issue(
            "second-writer",
            path,
            `ledger authority DML is outside the authoritative writer symbol: ${rogueWriterSymbols.join(", ")}`,
          ),
        );
    }
    if (/\b(?:JSON\.stringify\s*\(\s*error|error\.stack|stack:\s*error)/i.test(source))
      issues.push(issue("raw-error-boundary", path, "raw error or stack crosses a boundary"));
  }
}

function actualModuleExports(path: string, source: string): ReadonlySet<string> {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return new Set();
  const sourceFile = parseTypeScript(path, source);
  const names = new Set<string>();
  const hasExport = (node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean =>
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) names.add("*");
      else if (ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.add("default");
      continue;
    }
    if (!hasExport(statement)) continue;
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name
    )
      names.add(statement.name.text);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
  }
  return names;
}
function validateProjectionBlobAndP3(
  manifest: P2Manifest,
  sources: SourceTree,
  issues: ManifestIssue[],
): void {
  exactRows(
    "projection-catalog",
    TARGET_PROJECTIONS,
    manifest.projection.map((row) => String(row.projectionId)),
    issues,
  );
  for (const row of manifest.projection) {
    if (
      row.caller !==
      "SynchronousLedgerWriter.applyProjections inside the authoritative append transaction"
    ) {
      issues.push(
        issue(
          "projection-catalog",
          String(row.id),
          "projection caller must be the authoritative ledger writer",
        ),
      );
    }
  }
  if (
    manifest["blob-exception"].length !== 1 ||
    manifest["blob-exception"][0]?.table !== "artifact_blob"
  )
    issues.push(
      issue(
        "blob-catalog",
        "artifact_blob",
        "exactly one content-addressed blob exception is required",
      ),
    );
  exactRows(
    "p3-catalog",
    P3_MINIMUM.map((row) => row[0]),
    manifest["p3-disposition"].map((row) => String(row.id)),
    issues,
  );
  for (const row of manifest["p3-disposition"]) {
    const expected = P3_MINIMUM.find((entry) => entry[0] === row.id);
    if (
      !expected ||
      row.module !== expected[1] ||
      row.export !== expected[2] ||
      row.caller !== expected[3] ||
      row.move !== expected[4]
    )
      issues.push(
        issue("p3-catalog", String(row.id), "frozen revision-9 module/export/caller move mismatch"),
      );
    const moduleSource = sources.get(String(row.module));
    if (moduleSource === undefined)
      issues.push(issue("package-export", String(row.id), `${String(row.module)} is absent`));
    else {
      const exports = actualModuleExports(String(row.module), moduleSource);
      if (
        (row.export === "*" && exports.size === 0) ||
        (row.export !== "*" && !exports.has(String(row.export)))
      )
        issues.push(
          issue(
            "package-export",
            String(row.id),
            `${String(row.export)} is not an actual module export`,
          ),
        );
    }
    if (row.status !== "planned-p3")
      issues.push(issue("p3-catalog", String(row.id), "P3 rows require planned-p3 status"));
    if (row.targetShipped !== false)
      issues.push(issue("production-claim", String(row.id), "P3 move is frozen but not shipped"));
  }
}

function rowSignature(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function validateExactDerivedRows(
  manifest: P2Manifest,
  sources: SourceTree,
  issues: ManifestIssue[],
): void {
  let expected: P2Manifest;
  try {
    expected = generateP2Manifest(sources);
  } catch (error) {
    issues.push(
      issue(
        "final-schema-signature",
        BASELINE_MIGRATION_PATH,
        error instanceof Error
          ? error.message
          : "production baseline schema generation failed closed",
      ),
    );
    return;
  }
  for (const section of [
    "final-schema",
    "store-disposition",
    "blob-exception",
    "projection",
    "effect-scope",
    "secret-boundary",
  ] as const)
    exactRows(
      `${section}-signature`,
      expected[section].map(rowSignature),
      manifest[section].map(rowSignature),
      issues,
    );
}

export function validateP2Manifest(value: unknown, sources: SourceTree): readonly ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (!isRecord(value)) return [issue("schema", "manifest", "manifest must be an object")];
  const unknownSections = Object.keys(value).filter(
    (key) => !SECTION_NAMES.includes(key as SectionName),
  );
  const missingSections = SECTION_NAMES.filter((key) => !(key in value));
  if (unknownSections.length > 0 || missingSections.length > 0)
    issues.push(
      issue(
        "schema",
        "manifest",
        `exactly ten sections required; missing=${missingSections.join(",") || "none"}; unknown=${unknownSections.join(",") || "none"}`,
      ),
    );
  const manifest = Object.fromEntries(
    SECTION_NAMES.map((section) => [section, Array.isArray(value[section]) ? value[section] : []]),
  ) as P2Manifest;
  indexRows(manifest, issues);
  validateEvidence(manifest, sources, issues);
  validateReceipts(manifest, sources, issues);
  validateSchemaCatalog(manifest, sources, issues);
  validateNativeCatalog(manifest, issues);
  validateSourceCensus(manifest, sources, issues);
  validateProjectionBlobAndP3(manifest, sources, issues);
  validateForbiddenSources(sources, issues);
  validateExactDerivedRows(manifest, sources, issues);
  return issues;
}

function surfaceClassification(discovery: Discovery): string {
  if (discovery.authority === "internal-collection")
    return "process-local-non-authoritative-collection";
  if (discovery.authority === "cryptographic-builder") return "ephemeral-cryptographic-builder";
  if (
    discovery.path.includes("/ledger/") ||
    discovery.path === BASELINE_MIGRATION_PATH ||
    discovery.path.includes("/storage/")
  )
    return "current-target-authority";
  if (discovery.path.includes("bus-persistence")) return "current-delete-at-p2-04";
  if (BOUNDARY_KINDS.has(discovery.kind)) return "boundary-sink";
  return "current-effect-or-runtime-state";
}

function scopeDisposition(discovery: Discovery): {
  status: Status;
  scope: EffectDisposition;
  resolver: string;
  blocker: string;
} {
  if (discovery.authority === "internal-collection")
    return {
      status: "current",
      scope: "process-local-not-applicable",
      resolver: "exact-ast-process-local-collection",
      blocker:
        "scope is not applicable: process-local collection grants no durable or external authority",
    };
  if (discovery.authority === "cryptographic-builder")
    return {
      status: "current",
      scope: "ephemeral-not-applicable",
      resolver: "exact-ast-cryptographic-builder",
      blocker: "scope is not applicable: canonical cryptographic computation is ephemeral",
    };
  if (discovery.kind === "pid")
    return {
      status: "current",
      scope: "observation-not-applicable",
      resolver: "exact-ast-process-observation",
      blocker:
        "scope is not applicable: PID access observes process identity and does not mutate it",
    };
  if (discovery.kind === "mutator") {
    if (
      /messagePartWriter/.test(discovery.receiver) ||
      discovery.operation === "run" ||
      discovery.operation === "UNRESOLVED-CALL"
    )
      return {
        status: "current",
        scope: "observation-not-applicable",
        resolver: "exact-ast-control-or-observation-call",
        blocker:
          "scope is not applicable: call emits observation or invokes typed internal control flow",
      };
    if (discovery.operation === "write" && discovery.receiver === "global:Bun")
      return {
        status: "current",
        scope: "workspace-effect-registry",
        resolver: "EffectScopeRegistry.resolve(workspace-v1)",
        blocker: "none",
      };
    if (
      ["write", "exec", "append"].includes(discovery.operation) &&
      /(?:socket|sock|stdin|\bdb\b|expression|runtime|writer|owned)/i.test(discovery.receiver)
    )
      return {
        status: "current",
        scope: "authoritative-ledger-or-infrastructure-port",
        resolver: `exact-mutator-port:${discovery.receiver}.${discovery.operation}`,
        blocker: "none",
      };
    if (
      ["set", "add", "delete", "clear"].includes(discovery.operation) &&
      /(?:activeRuns|seen|clients|connected|slots|sessionAffinity|entries|retained|activations|handlers|queues|identities|reminders|ambiguities|selections|responses|followUps)/.test(
        discovery.receiver,
      )
    )
      return {
        status: "current",
        scope: "process-local-not-applicable",
        resolver: "exact-ast-process-local-collection-role",
        blocker:
          "scope is not applicable: typed process-local collection grants no durable authority",
      };
    if (discovery.operation === "set" && /^c@/.test(discovery.receiver))
      return {
        status: "current",
        scope: "process-local-not-applicable",
        resolver: "exact-ast-request-context",
        blocker: "scope is not applicable: request context is process-local and non-authoritative",
      };
    if (discovery.operation === "set" && /(?:output|body|headers)/i.test(discovery.receiver))
      return {
        status: "current",
        scope: "ephemeral-not-applicable",
        resolver: "exact-ast-typed-canonical-buffer",
        blocker: "scope is not applicable: typed canonical bytes are process-local and ephemeral",
      };
    throw new Error(
      `unclassified external mutation ${discovery.path}:${discovery.callsite} ${discovery.receiver}.${discovery.operation}`,
    );
  }
  if (discovery.kind === "table" || discovery.kind === "dml")
    return {
      status: "current",
      scope: "authoritative-ledger-or-infrastructure-port",
      resolver: `exact-${discovery.kind}-operation:${discovery.receiver}`,
      blocker: "none",
    };
  if (
    discovery.kind === "filesystem" ||
    discovery.kind === "process" ||
    discovery.kind === "socket"
  )
    return {
      status: "current",
      scope: "authoritative-ledger-or-infrastructure-port",
      resolver: `exact-${discovery.kind}-port:${discovery.receiver}`,
      blocker: "none",
    };
  throw new Error(
    `missing exact effect disposition ${discovery.path}:${discovery.callsite} ${discovery.kind}`,
  );
}

function secretSink(discovery: Discovery): string {
  if (discovery.kind === "secret-boundary") return required(discovery.operation.split(":", 1)[0]);
  if (discovery.kind === "error-boundary") return "error";
  if (discovery.kind === "environment") return "env";
  return "serializer";
}
function secretDisposition(discovery: Discovery): {
  sanitizer: string;
  exception: string;
  testIds: readonly string[];
} {
  if (discovery.kind !== "secret-boundary" && discovery.kind !== "serializer") {
    const category =
      discovery.kind === "environment"
        ? "environment source read"
        : discovery.kind === "error-boundary"
          ? "internal error control-flow conversion"
          : "typed canonical serialization";
    return {
      sanitizer: "not-a-secret-boundary",
      exception: `${category} is not executable external egress`,
      testIds: [SECRET_CATEGORY_RECEIPT],
    };
  }
  if (/^(?:Auth|cache):/.test(discovery.operation))
    return {
      sanitizer: "not-a-secret-boundary",
      exception:
        "typed secret custody control or process-local cache operation is not external egress",
      testIds: [SECRET_CATEGORY_RECEIPT],
    };
  if (
    discovery.boundaryRisk === "raw-secret-egress" &&
    discovery.groundedSanitizer !== "boundary-sanitizer"
  )
    throw new Error(
      `unsanitized secret egress ${discovery.path}:${discovery.callsite} ${discovery.operation}`,
    );
  if (discovery.groundedSanitizer === "boundary-sanitizer") {
    return {
      sanitizer: "owner-boundary-sanitizer",
      exception: "ambient runtime configuration is sanitized before validation and consumption",
      testIds: [
        "packages/llm/test/auth/secret-registry.test.ts#redacts raw, JSON escaped, URL encoded, and common base64 forms",
      ],
    };
  }
  if (
    discovery.path === "apps/server/src/connector/process-driver.ts" &&
    discovery.symbol === "connectorEffectIntent" &&
    discovery.kind === "serializer" &&
    discovery.operation === "stringify"
  ) {
    return {
      sanitizer: "canonical-effect-digest-no-boundary-emission",
      exception:
        "canonical connector intent values are serialized only as immediate SHA-256 input; the transient bytes are neither emitted nor retained",
      testIds: [
        "script/conformance/p2-manifests.test.ts#checked manifest is exact and currently green",
      ],
    };
  }
  if (
    discovery.path === "packages/llm/src/auth/secret-registry.ts" &&
    discovery.kind === "serializer" &&
    discovery.operation === "toJSON" &&
    (discovery.symbol === "<module>" || discovery.symbol === "create")
  ) {
    return {
      sanitizer: "throwing-secret-serialization-prohibition",
      exception:
        "SecretRegistry and its opaque handles throw before secret custody objects can be serialized",
      testIds: [
        "packages/llm/test/auth/secret-registry.test.ts#forbids serialization and exposes only redacted inspection",
      ],
    };
  }
  if (discovery.path === "packages/llm/src/auth/boundary-sanitizer.ts") {
    return {
      sanitizer: "registration-only-no-boundary-emission",
      exception:
        "JSON escaping registers an exact secret form inside the sanitizer; sanitizing it first would defeat redaction",
      testIds: [
        "packages/llm/test/auth/secret-registry.test.ts#redacts raw, JSON escaped, URL encoded, and common base64 forms",
      ],
    };
  }
  if (discovery.path === "packages/llm/src/auth/credential-source.ts") {
    return {
      sanitizer: "credential-source-json-escape-only",
      exception:
        "read-only credential parsing escapes a string for validation and emits no serialized boundary",
      testIds: [
        "packages/llm/test/auth/secret-registry.test.ts#strictly parses metadata and normalizes only secret-free proxy URLs",
      ],
    };
  }
  if (discovery.path === "packages/openomni/src/execution-runtime/effect-scope.ts") {
    return {
      sanitizer: "canonical-non-secret-effect-scope",
      exception:
        "closed effect-scope protocol values are canonicalized for equality and hashing before any boundary",
      testIds: [
        "packages/openomni/test/execution-runtime/effect-scope.test.ts#filesystem mutators bind workspace wildcard plus canonical targets",
      ],
    };
  }
  if (discovery.path === "apps/server/src/execution/p2-worker-provisioning.ts") {
    return {
      sanitizer: "authenticated-canonical-bytes-no-secret-material",
      exception:
        "closed request and peer identity fields are canonicalized for HMAC or equality; credential bytes are excluded",
      testIds: [
        "apps/server/test/execution/p2-worker-provisioning.test.ts#accepts one authenticated envelope bound to the exact minimal provider set",
      ],
    };
  }
  if (discovery.path === "packages/openomni/src/evidence/verifier-registry.ts") {
    return {
      sanitizer: "canonical-verifier-value-no-credential-material",
      exception:
        "closed verifier Serializable values are normalized and encoded for deterministic local comparison",
      testIds: [
        "packages/openomni/test/evidence/verifier-registry.test.ts#normalizes records to frozen null-prototype data properties without dropping keys",
      ],
    };
  }
  return {
    sanitizer: "not-a-secret-boundary",
    exception:
      "typed executable category carries a strict canonical control or wire value, not secret custody material",
    testIds: [SECRET_CATEGORY_RECEIPT],
  };
}

const GENERATED_MANIFEST_CACHE = new Map<string, P2Manifest>();

export function generateP2Manifest(sources: SourceTree): P2Manifest {
  const cacheKey = sourceTreeCacheKey(sources);
  const cached = GENERATED_MANIFEST_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const discoveries = discoverP2Producers(sources);
  const unresolvedSecretEgress = discoveries.filter(
    (entry) =>
      entry.kind === "secret-boundary" &&
      entry.boundaryRisk === "raw-secret-egress" &&
      entry.groundedSanitizer !== "boundary-sanitizer" &&
      !/^(?:Auth|cache):/.test(entry.operation),
  );
  if (unresolvedSecretEgress.length > 0)
    throw new Error(
      `unsanitized secret egress:\n${unresolvedSecretEgress
        .map((entry) => `${entry.path}:${entry.callsite} ${entry.operation}`)
        .join("\n")}`,
    );
  const surfaces = discoveries.map((entry) => ({
    id: stableId(
      "surface",
      `${entry.path}\u0000${entry.kind}\u0000${entry.symbol}\u0000${entry.operation}\u0000${entry.receiver}\u0000${entry.callsite}`,
    ),
    status: "current",
    evidence: [entry.path],
    path: entry.path,
    symbol: entry.symbol,
    operation: entry.operation,
    receiver: entry.receiver,
    callsite: entry.callsite,
    producerKind: entry.kind,
    classification: surfaceClassification(entry),
    targetShipped: true,
  }));
  const surfaceFor = (entry: Discovery) =>
    findRequired(
      surfaces,
      (surface) =>
        surface.path === entry.path &&
        surface.producerKind === entry.kind &&
        surface.symbol === entry.symbol &&
        surface.operation === entry.operation &&
        surface.receiver === entry.receiver &&
        surface.callsite === entry.callsite,
    );
  const mutations = discoveries.filter(isMutation).map((entry) => {
    const disposition = mutationDisposition(entry);
    return {
      id: stableId("mutation", entry.id),
      status: disposition.status,
      evidence: [entry.path],
      surfaceId: surfaceFor(entry).id,
      file: entry.path,
      symbol: entry.symbol,
      operation: entry.operation,
      receiver: entry.receiver,
      callsite: entry.callsite,
      writer: disposition.writer,
      caller: disposition.caller,
      test: disposition.test,
      scope: disposition.scope,
      boundary: disposition.boundary,
      targetShipped: disposition.status === "current",
    };
  });
  const mutationFor = (entry: Discovery) =>
    findRequired(
      mutations,
      (mutation) =>
        mutation.file === entry.path &&
        mutation.symbol === entry.symbol &&
        mutation.operation === entry.operation &&
        mutation.receiver === entry.receiver &&
        mutation.callsite === entry.callsite &&
        mutation.boundary === entry.kind,
    );
  const schemaDefinitions = finalSchemaDefinitions(sources);
  const manifest: P2Manifest = {
    "final-schema": TARGET_TABLES.map((name) => ({
      id: `schema.table.${name}`,
      status: "current",
      evidence: [BASELINE_MIGRATION_PATH],
      objectKind: "table",
      objectName: name,
      definition: required(schemaDefinitions.get(`table:${name}`), `schema ${name} is missing`),
      targetShipped: true,
    })),
    "store-disposition": surfaces.map((surface) => ({
      id: stableId("store", surface.id),
      status: "current",
      evidence: surface.evidence,
      surfaceId: surface.id,
      target:
        surface.classification === "current-target-authority"
          ? "fresh-baseline ledger/projection/blob authority"
          : surface.classification === "process-local-non-authoritative-collection"
            ? "process-local immutable catalog, redaction, registration, or collision tracking"
            : surface.classification === "ephemeral-cryptographic-builder"
              ? "ephemeral authentication or integrity bytes"
              : BOUNDARY_KINDS.has(surface.producerKind as ProducerKind)
                ? "single sanitized boundary or explicit source exception"
                : "native transition plus ledger projection/effect intent",
      disposition:
        surface.classification === "current-target-authority"
          ? "retain shipped fresh-baseline authority"
          : surface.classification === "process-local-non-authoritative-collection"
            ? "retain as non-durable non-authoritative runtime state"
            : surface.classification === "ephemeral-cryptographic-builder"
              ? "retain as ephemeral cryptographic computation; no durable write authority"
              : BOUNDARY_KINDS.has(surface.producerKind as ProducerKind)
                ? "retain behind the single sanitized boundary or reviewed source exception"
                : "retain behind native transition plus ledger projection/effect intent",
      deleteAt: "not-applicable",
      exception: surface.path.includes("auth/storage.ts")
        ? "current credential-source exception; target Auth is read-only"
        : surface.path.includes("catalog-cache.ts")
          ? "derived non-authoritative cache exception"
          : surface.classification === "process-local-non-authoritative-collection"
            ? "collection lifetime is process-local and grants no durable or effect authority"
            : "none",
      targetShipped: true,
    })),
    "production-mutation": mutations,
    "native-transition": CLOSED_OPERATION_CATALOG_V1.map((entry) => ({
      id: `transition.${entry.id}`,
      status: "current",
      evidence: [
        "packages/openomni/src/ledger/native-transitions.ts",
        "packages/openomni/test/ledger/native-transitions.test.ts",
      ],
      ...catalogSignature(entry),
      targetShipped: true,
    })),
    "blob-exception": [
      {
        id: "blob.artifact-content-addressed",
        status: "current",
        evidence: [
          "packages/session/src/ledger/blob.ts",
          "packages/session/test/ledger/blob.test.ts",
        ],
        table: "artifact_blob",
        writer: "insertArtifactBlob/ArtifactBlobStore.put",
        reader: "ArtifactBlobStore.get",
        integrityCheck: "sha256 and byte length before and after persistence",
        exception: "large immutable bytes only; canonical event JSON retains content hash",
        testIds: [
          "packages/session/test/ledger/blob.test.ts#inserts, deduplicates, and reads immutable bytes",
        ],
        targetShipped: true,
      },
    ],
    projection: TARGET_PROJECTIONS.map((projectionId) => ({
      id: `projection.${projectionId}`,
      status: "current",
      evidence: [
        "packages/openomni/src/ledger/native-transitions.ts",
        "packages/session/src/ledger/projection.ts",
        "packages/session/test/ledger/projection.test.ts",
      ],
      projectionId,
      sourceTable: "ledger_event",
      checkpointTable: "projection_checkpoint",
      reducer: `${projectionId.replace(/_projection$/, "")}-reducer-v1`,
      caller:
        "SynchronousLedgerWriter.applyProjections inside the authoritative append transaction",
      testIds: [
        "packages/session/test/ledger/projection.test.ts#applies registered projections when append options omit them and across legal sequence gaps",
      ],
      targetShipped: true,
    })),
    "durable-surface": surfaces,
    "effect-scope": [
      ...discoveries.filter(isMutation).map((entry) => {
        const mutation = mutationFor(entry);
        const scope = scopeDisposition(entry);
        return {
          id: stableId("scope", mutation.id),
          status: scope.status,
          evidence: [entry.path],
          mutationId: mutation.id,
          toolOrDriver: entry.symbol,
          scope: scope.scope,
          resolver: scope.resolver,
          blocker: scope.blocker,
          testIds:
            focusedReceipts(entry).length > 0 ? focusedReceipts(entry) : [EFFECT_SCOPE_RECEIPT],
          targetShipped: scope.status === "current",
        };
      }),
      ...discoverEffectConsumers(sources).map((path) => ({
        id: stableId("scope.consumer", path),
        status: "current",
        evidence: [path],
        mutationId: "none",
        toolOrDriver: path,
        scope: "workspace-effect-registry",
        resolver: "EffectScopeRegistry.resolve",
        blocker: "none",
        testIds: [
          "packages/openomni/test/execution-runtime/effect-scope.test.ts#filesystem mutators bind workspace wildcard plus canonical targets",
        ],
        targetShipped: true,
      })),
    ],
    "secret-boundary": discoveries
      .filter((entry) => BOUNDARY_KINDS.has(entry.kind))
      .map((entry) => {
        const disposition = secretDisposition(entry);
        return {
          id: stableId("boundary", entry.id),
          status: "current",
          evidence: [entry.path],
          surfaceId: surfaceFor(entry).id,
          sink: secretSink(entry),
          sanitizer: disposition.sanitizer,
          exception: disposition.exception,
          testIds: disposition.testIds,
          targetShipped: true,
        };
      }),
    "p3-disposition": P3_MINIMUM.map(([id, module, exported, caller, move]) => ({
      id,
      status: "planned-p3",
      evidence: [module],
      module,
      export: exported,
      caller,
      move,
      targetShipped: false,
    })),
  };
  if (GENERATED_MANIFEST_CACHE.size >= 32) GENERATED_MANIFEST_CACHE.clear();
  GENERATED_MANIFEST_CACHE.set(cacheKey, manifest);
  return manifest;
}

export async function collectP2Sources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const pattern of [
    "packages/*/src/**/*.ts",
    "packages/*/src/**/*.tsx",
    "apps/*/src/**/*.ts",
    "apps/*/src/**/*.tsx",
    "packages/*/test/**/*.ts",
    "packages/*/test/**/*.tsx",
    "apps/*/test/**/*.ts",
    "apps/*/test/**/*.tsx",
    "script/conformance/**/*.test.ts",
    "**/*.sql",
  ]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: ".", onlyFiles: true })) {
      if (
        path.includes("node_modules/") ||
        path.includes("/.git/") ||
        path.startsWith("tmp/") ||
        path.startsWith("output/")
      )
        continue;
      sources.set(path, await Bun.file(path).text());
    }
  }
  return sources;
}

export async function checkP2Manifest(path = P2_MANIFEST_PATH): Promise<readonly ManifestIssue[]> {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return validateP2Manifest(manifest, await collectP2Sources());
}

function required<T>(value: T | undefined, message = "required invariant is missing"): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function findRequired<T>(values: readonly T[], predicate: (value: T) => boolean): T {
  return required(values.find(predicate));
}
