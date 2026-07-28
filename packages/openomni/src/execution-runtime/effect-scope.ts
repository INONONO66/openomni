import { createHash } from "node:crypto";
import { Execution } from "@openomni/protocol";
import {
  assertWorkspaceIdentity,
  resolveWorkspaceTarget,
  revalidateWorkspaceTarget,
  toWorkspaceRef,
  type CanonicalWorkspaceTarget,
  type WorkspaceIdentity,
} from "./workspace-identity.js";

export type EffectMutability = "read-only" | "mutating" | "unknown";
/** Intentionally uninhabitable: resolver contracts are repository-frozen, not runtime extensions. */
export type EffectScopeKind = never;
export type EffectScopeRegistration = never;

export type EffectScopeContext = {
  readonly workspace?: WorkspaceIdentity;
  readonly endpointId?: string;
};

export type ResolvedToolEffectV1 = Readonly<{
  operation: string;
  operationVersion: "1";
  scope: Execution.EffectScopeV1;
}>;

export function resolveToolEffect(
  registry: EffectScopeRegistry,
  operation: string,
  input: unknown,
  workspace: WorkspaceIdentity | undefined,
): ResolvedToolEffectV1 | null {
  const operationVersion = "1" as const;
  if (registry.isStaticallyReadOnly(operation, operationVersion)) return null;
  return Object.freeze({
    operation,
    operationVersion,
    scope: registry.resolve(operation, operationVersion, input, { workspace }),
  });
}

export type EffectScopeDenialCode = "effect_scope_unresolved";

export class EffectScopeDeniedError extends Error {
  readonly code: EffectScopeDenialCode;
  readonly operation: string;
  readonly version: string;

  constructor(operation: string, version: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EffectScopeDeniedError";
    this.code = "effect_scope_unresolved";
    this.operation = operation;
    this.version = version;
  }
}

export function digestEffectValue(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function unresolved(
  operation: string,
  version: string,
  reason: string,
  cause?: unknown,
): EffectScopeDeniedError {
  return new EffectScopeDeniedError(
    operation,
    version,
    `effect scope unresolved for ${operation}@${version}: ${reason}`,
    cause,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function exactScope(scope: Execution.EffectScopeV1): string {
  return JSON.stringify(scope);
}

const BASH_RESOLVER = Object.freeze({
  operation: "bash",
  operationVersion: "1",
  resolverId: "bash-workspace-v1",
  resolverVersion: "1",
  mutability: "unknown" as const,
});

const FILESYSTEM_MUTATORS = new Set(["write", "edit", "create", "remove", "rename", "chmod"]);
const STATIC_READ_ONLY = new Set(
  ["read", "glob", "grep.search"].map((operation) => `${operation}\0${1}`),
);
const BASH_INPUT_DIGEST = digestEffectValue("bash-workspace-v1");

type FilesystemInput = { readonly path: string } | { readonly from: string; readonly to: string };

function filesystemPaths(operation: string, input: unknown): readonly string[] {
  if (!input || typeof input !== "object") throw new Error("filesystem target input is missing");
  const candidate = input as Record<string, unknown>;
  if (operation === "rename") {
    if (typeof candidate.from !== "string" || typeof candidate.to !== "string") {
      throw new Error("rename requires from and to targets");
    }
    return [candidate.from, candidate.to];
  }
  if (typeof candidate.path !== "string") throw new Error(`${operation} requires a path target`);
  return [candidate.path];
}

function targetDigest(target: CanonicalWorkspaceTarget): string {
  return digestEffectValue(target.canonicalTarget);
}

function requireResolvedTarget(
  target: CanonicalWorkspaceTarget | undefined,
): CanonicalWorkspaceTarget {
  if (target === undefined) throw new Error("filesystem target resolution is missing");
  return target;
}

function filesystemScope(
  operation: string,
  input: FilesystemInput,
  workspace: WorkspaceIdentity,
): Execution.EffectScopeV1 {
  const paths = filesystemPaths(operation, input);
  const firstPass = paths.map((path) => resolveWorkspaceTarget(workspace, path));
  const targets = paths.map((path, index) =>
    revalidateWorkspaceTarget(workspace, path, requireResolvedTarget(firstPass[index])),
  );
  const targetDigests = [...new Set(targets.map(targetDigest))].sort();
  return {
    version: "effect-scope-v1",
    workspace: toWorkspaceRef(workspace),
    resources: [
      { version: "resource-scope-v1", kind: "workspace", target: "**" },
      ...targetDigests.map((target) => ({
        version: "resource-scope-v1" as const,
        kind: "workspace_path" as const,
        targetDigest: target,
      })),
    ],
    resolver: {
      id: "filesystem-target-v1",
      version: "1",
      inputDigest: digestEffectValue(
        JSON.stringify(targets.map((target) => target.canonicalTarget)),
      ),
    },
    containment: "filesystem-canonicalized",
    mutationClass: "mutating",
  };
}

function bashScope(workspace: WorkspaceIdentity): Execution.EffectScopeV1 {
  return {
    version: "effect-scope-v1",
    workspace: toWorkspaceRef(workspace),
    resources: [{ version: "resource-scope-v1", kind: "workspace", target: "**" }],
    resolver: {
      id: BASH_RESOLVER.resolverId,
      version: BASH_RESOLVER.resolverVersion,
      inputDigest: BASH_INPUT_DIGEST,
    },
    containment: "none",
    mutationClass: "unknown",
  };
}

export class EffectScopeRegistry {
  static readonly bash = BASH_RESOLVER;
  static readonly filesystemMutators = Object.freeze([...FILESYSTEM_MUTATORS].sort());
  static readonly staticReadOnly = Object.freeze([...STATIC_READ_ONLY].sort());

  classification(operation: string, version: string): EffectMutability | undefined {
    if (operation === BASH_RESOLVER.operation && version === BASH_RESOLVER.operationVersion) {
      return "unknown";
    }
    if (version === "1" && FILESYSTEM_MUTATORS.has(operation)) return "mutating";
    if (STATIC_READ_ONLY.has(`${operation}\0${version}`)) return "read-only";
    return undefined;
  }

  isStaticallyReadOnly(operation: string, version: string): boolean {
    return this.classification(operation, version) === "read-only";
  }

  resolve<Input>(
    operation: string,
    version: string,
    input: Input,
    context: EffectScopeContext,
  ): Execution.EffectScopeV1 {
    const classification = this.classification(operation, version);
    if (!classification)
      throw unresolved(operation, version, "resolver is not in the frozen registry");
    if (classification === "read-only") {
      throw unresolved(
        operation,
        version,
        "statically read-only operations do not produce effect scopes",
      );
    }
    if (!context.workspace) throw unresolved(operation, version, "workspace identity is missing");

    try {
      assertWorkspaceIdentity(context.workspace);
      const first =
        operation === "bash"
          ? bashScope(context.workspace)
          : filesystemScope(operation, input as FilesystemInput, context.workspace);
      assertWorkspaceIdentity(context.workspace);
      const second =
        operation === "bash"
          ? bashScope(context.workspace)
          : filesystemScope(operation, input as FilesystemInput, context.workspace);
      if (exactScope(first) !== exactScope(second)) {
        throw unresolved(operation, version, "resolver output is nondeterministic");
      }
      const parsed = Execution.EffectScopeV1.parse(first);
      if (parsed.workspace.workspaceId !== context.workspace.workspaceId) {
        throw unresolved(operation, version, "resolver returned mismatched workspace identity");
      }
      return deepFreeze(parsed);
    } catch (error) {
      if (error instanceof EffectScopeDeniedError) throw error;
      throw unresolved(operation, version, "resolver denied or failed", error);
    }
  }
}
