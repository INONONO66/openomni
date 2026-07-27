import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import { posix, type PlatformPath } from "node:path";
import type { Execution } from "@openomni/protocol";

export type WorkspacePlatformTag = "posix" | "win32";
export type WorkspaceCaseMode = "case-sensitive" | "case-insensitive" | "unknown";
export type WorkspaceUnicodeMode = "unicode-preserving" | "unicode-normalizing" | "unknown";

export type WorkspaceObjectIdentityV1 = {
  readonly volumeId: string;
  readonly fileId: string;
};

export type WorkspacePlatformAdapterV1 = {
  readonly platform: WorkspacePlatformTag;
  readonly compositionCwd: string;
  readonly path: PlatformPath;
  realpath(path: string): string;
  identity(path: string): WorkspaceObjectIdentityV1 & { readonly isDirectory: boolean };
  capabilities(path: string): {
    readonly caseMode: WorkspaceCaseMode;
    readonly unicodeMode: WorkspaceUnicodeMode;
  };
};

export type WorkspaceIdentity = {
  readonly canonicalizerVersion: "workspace-v1";
  readonly workspaceId: string;
  readonly canonicalBytesDigest: string;
  canonicalBytes(): Uint8Array;
  readonly platform: WorkspacePlatformTag;
  readonly pathEncoding: "utf8";
  readonly canonicalRoot: string;
  readonly rootIdentity: WorkspaceObjectIdentityV1;
  readonly caseMode: WorkspaceCaseMode;
  readonly unicodeMode: WorkspaceUnicodeMode;
};

export type CanonicalWorkspaceTarget = {
  readonly workspaceId: string;
  readonly canonicalTarget: string;
  readonly existingAncestorIdentity: WorkspaceObjectIdentityV1;
  readonly unresolvedSuffix: string;
  readonly targetMode: "existing" | "create";
};

export type WorkspaceIdentityDenialCode =
  | "workspace_identity_unavailable"
  | "workspace_identity_collision"
  | "workspace_root_required"
  | "workspace_root_unavailable"
  | "workspace_root_moved"
  | "workspace_root_replaced"
  | "workspace_target_invalid"
  | "workspace_target_escape"
  | "workspace_symlink_escape"
  | "workspace_target_changed";

export class WorkspaceIdentityDeniedError extends Error {
  readonly code: WorkspaceIdentityDenialCode;

  constructor(code: WorkspaceIdentityDenialCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkspaceIdentityDeniedError";
    this.code = code;
  }
}

export type WorkspaceProvisioningOptionsV1 = {
  readonly adapter?: WorkspacePlatformAdapterV1;
};

type WorkspaceIdentityWeakRef = {
  deref(): WorkspaceIdentity | undefined;
};

type WorkspaceIdentityRegistryEntry = {
  readonly canonicalBytes: Uint8Array;
  readonly identities: Set<WorkspaceIdentityWeakRef>;
  collided: boolean;
};

type WorkspaceIdentityFinalizerToken = {
  readonly workspaceId: string;
  readonly entry: WorkspaceIdentityRegistryEntry;
  readonly identityRef: WorkspaceIdentityWeakRef;
};

const IdentityWeakRef = (
  globalThis as unknown as {
    readonly WeakRef: new (identity: WorkspaceIdentity) => WorkspaceIdentityWeakRef;
  }
).WeakRef;
const IdentityFinalizationRegistry = (
  globalThis as unknown as {
    readonly FinalizationRegistry: new (
      cleanup: (token: WorkspaceIdentityFinalizerToken) => void,
    ) => {
      register(identity: WorkspaceIdentity, token: WorkspaceIdentityFinalizerToken): void;
    };
  }
).FinalizationRegistry;

const adapters = new WeakMap<WorkspaceIdentity, WorkspacePlatformAdapterV1>();
/**
 * Process-local collision memory is retained only while an identity for the ID is live. A
 * collision poisons every live identity for that ID; once all are collected, the entry can be
 * reclaimed rather than growing for the lifetime of a long-running server.
 */
const identitiesById = new Map<string, WorkspaceIdentityRegistryEntry>();
const identityFinalizer = new IdentityFinalizationRegistry((token) => {
  if (identitiesById.get(token.workspaceId) !== token.entry) return;
  token.entry.identities.delete(token.identityRef);
  for (const identityRef of token.entry.identities) {
    if (identityRef.deref() === undefined) token.entry.identities.delete(identityRef);
  }
  if (token.entry.identities.size === 0) identitiesById.delete(token.workspaceId);
});
const SERVER_COMPOSITION_CWD = process.cwd();

function posixAdapter(): WorkspacePlatformAdapterV1 {
  return {
    platform: "posix",
    compositionCwd: SERVER_COMPOSITION_CWD,
    path: posix,
    realpath: realpathSync,
    identity(path) {
      const stat = statSync(path, { bigint: true });
      return {
        isDirectory: stat.isDirectory(),
        volumeId: stat.dev.toString(10),
        fileId: stat.ino.toString(10),
      };
    },
    capabilities: () => ({ caseMode: "unknown", unicodeMode: "unknown" }),
  };
}

function defaultAdapter(): WorkspacePlatformAdapterV1 {
  if (platform() === "win32") {
    throw new WorkspaceIdentityDeniedError(
      "workspace_identity_unavailable",
      "workspace-v1 on Windows requires an injected stable file-ID and volume-capability adapter",
    );
  }
  return posixAdapter();
}

function validUnsignedDecimal(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function exactRoot(platform: WorkspacePlatformTag, pathApi: PlatformPath, path: string): string {
  const parsedRoot = pathApi.parse(path).root;
  if (path === parsedRoot) return path;
  let end = path.length;
  while (
    end > parsedRoot.length &&
    (path[end - 1] === "/" || (platform === "win32" && path[end - 1] === "\\"))
  )
    end -= 1;
  return path.slice(0, end);
}

function canonicalBytes(fields: {
  platform: WorkspacePlatformTag;
  canonicalRoot: string;
  rootIdentity: WorkspaceObjectIdentityV1;
  caseMode: WorkspaceCaseMode;
  unicodeMode: WorkspaceUnicodeMode;
}): Uint8Array {
  const pathBytes = Buffer.from(fields.canonicalRoot, "utf8");
  return Buffer.concat([
    Buffer.from(
      `workspace-v1\nplatform=${fields.platform}\npath-bytes=${pathBytes.byteLength}\n`,
      "utf8",
    ),
    pathBytes,
    Buffer.from(
      `\nvolume-id=${fields.rootIdentity.volumeId}\nfile-id=${fields.rootIdentity.fileId}\ncase-mode=${fields.caseMode}\nunicode-mode=${fields.unicodeMode}\n`,
      "utf8",
    ),
  ]);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sha256CanonicalBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function activeIdentityCount(entry: WorkspaceIdentityRegistryEntry): number {
  for (const identityRef of entry.identities) {
    if (identityRef.deref() === undefined) entry.identities.delete(identityRef);
  }
  return entry.identities.size;
}

function requireIdentity(
  adapter: WorkspacePlatformAdapterV1,
  path: string,
): WorkspaceObjectIdentityV1 & { readonly isDirectory: boolean } {
  const identity = adapter.identity(path);
  if (!validUnsignedDecimal(identity.volumeId) || !validUnsignedDecimal(identity.fileId)) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_identity_unavailable",
      "workspace-v1 requires unsigned-decimal stable volume and file identifiers",
    );
  }
  if (
    adapter.platform === "win32" &&
    (BigInt(identity.volumeId) > 0xffff_ffffn ||
      BigInt(identity.fileId) > 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn)
  ) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_identity_unavailable",
      "Windows workspace identity requires a 32-bit volume serial and 128-bit file ID",
    );
  }
  return identity;
}

type CanonicalExisting = {
  readonly canonicalPath: string;
  readonly identity: WorkspaceObjectIdentityV1 & { readonly isDirectory: boolean };
};

function sameObjectIdentity(
  left: WorkspaceObjectIdentityV1,
  right: WorkspaceObjectIdentityV1,
): boolean {
  return left.volumeId === right.volumeId && left.fileId === right.fileId;
}

function canonicalizeExisting(
  adapter: WorkspacePlatformAdapterV1,
  requestedPath: string,
): CanonicalExisting {
  const requestedIdentity = requireIdentity(adapter, requestedPath);
  const returnedPath = exactRoot(adapter.platform, adapter.path, adapter.realpath(requestedPath));
  if (!adapter.path.isAbsolute(returnedPath)) throw new Error("realpath returned a relative path");
  const returnedIdentity = requireIdentity(adapter, returnedPath);
  if (sameObjectIdentity(requestedIdentity, returnedIdentity)) {
    return { canonicalPath: returnedPath, identity: requestedIdentity };
  }

  if (adapter.platform !== "posix") {
    throw new Error("realpath returned a different filesystem object");
  }
  const parent = adapter.path.dirname(requestedPath);
  const basename = adapter.path.basename(requestedPath);
  if (!basename || parent === requestedPath) {
    throw new Error("realpath returned a different filesystem object");
  }
  const canonicalParent = canonicalizeExisting(adapter, parent).canonicalPath;
  const candidate = adapter.path.join(canonicalParent, basename);
  const candidateIdentity = requireIdentity(adapter, candidate);
  if (!sameObjectIdentity(requestedIdentity, candidateIdentity)) {
    throw new Error("realpath returned a different filesystem object");
  }
  return {
    canonicalPath: exactRoot(adapter.platform, adapter.path, candidate),
    identity: requestedIdentity,
  };
}

function provisionWorkspaceIdentity(
  inputRoot: string,
  options: WorkspaceProvisioningOptionsV1,
  digestCanonicalBytes: (bytes: Uint8Array) => string,
): WorkspaceIdentity {
  if (!inputRoot || inputRoot.includes("\0")) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_root_required",
      "workspace root is required and must not contain NUL",
    );
  }

  const adapter = options.adapter ?? defaultAdapter();
  let canonicalRoot: string;
  let captured: WorkspaceObjectIdentityV1 & { readonly isDirectory: boolean };
  let capabilities: ReturnType<WorkspacePlatformAdapterV1["capabilities"]>;
  try {
    const absolute = adapter.path.resolve(adapter.compositionCwd, inputRoot);
    const canonical = canonicalizeExisting(adapter, absolute);
    canonicalRoot = canonical.canonicalPath;
    captured = canonical.identity;
    if (!captured.isDirectory) {
      throw new WorkspaceIdentityDeniedError(
        "workspace_root_required",
        `workspace root must be an existing directory: ${inputRoot}`,
      );
    }
    capabilities = adapter.capabilities(canonicalRoot);
  } catch (error) {
    if (error instanceof WorkspaceIdentityDeniedError) throw error;
    throw new WorkspaceIdentityDeniedError(
      "workspace_identity_unavailable",
      `workspace identity is unavailable for: ${inputRoot}`,
      error,
    );
  }

  const rootIdentity = { volumeId: captured.volumeId, fileId: captured.fileId };
  const bytes = canonicalBytes({
    platform: adapter.platform,
    canonicalRoot,
    rootIdentity,
    caseMode: capabilities.caseMode,
    unicodeMode: capabilities.unicodeMode,
  });
  const digest = digestCanonicalBytes(bytes);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_identity_unavailable",
      "workspace digest must be lowercase SHA-256 hex",
    );
  }
  const workspaceId = `w1:${digest}`;
  let registryEntry = identitiesById.get(workspaceId);
  if (registryEntry && activeIdentityCount(registryEntry) === 0) {
    identitiesById.delete(workspaceId);
    registryEntry = undefined;
  }
  if (registryEntry?.collided) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_identity_collision",
      `workspace ID collision remains active: ${workspaceId}`,
    );
  }
  if (registryEntry && !equalBytes(registryEntry.canonicalBytes, bytes)) {
    registryEntry.collided = true;
    throw new WorkspaceIdentityDeniedError(
      "workspace_identity_collision",
      `workspace ID collision: ${workspaceId}`,
    );
  }
  if (!registryEntry) {
    registryEntry = {
      canonicalBytes: Uint8Array.from(bytes),
      identities: new Set(),
      collided: false,
    };
    identitiesById.set(workspaceId, registryEntry);
  }

  const identity: WorkspaceIdentity = Object.freeze({
    canonicalizerVersion: "workspace-v1",
    workspaceId,
    canonicalBytesDigest: digest,
    canonicalBytes() {
      return Uint8Array.from(bytes);
    },
    platform: adapter.platform,
    pathEncoding: "utf8",
    canonicalRoot,
    rootIdentity: Object.freeze(rootIdentity),
    caseMode: capabilities.caseMode,
    unicodeMode: capabilities.unicodeMode,
  });
  adapters.set(identity, adapter);
  const identityRef = new IdentityWeakRef(identity);
  registryEntry.identities.add(identityRef);
  identityFinalizer.register(identity, { workspaceId, entry: registryEntry, identityRef });
  return identity;
}

export function createWorkspaceIdentity(
  inputRoot: string,
  options: WorkspaceProvisioningOptionsV1 = {},
): WorkspaceIdentity {
  return provisionWorkspaceIdentity(inputRoot, options, sha256CanonicalBytes);
}

/** @internal Test-only deep-import seam; deliberately omitted from the public barrel. */
export function createWorkspaceIdentityForTest(
  inputRoot: string,
  options: WorkspaceProvisioningOptionsV1,
  digestCanonicalBytes: (bytes: Uint8Array) => string,
): WorkspaceIdentity {
  return provisionWorkspaceIdentity(inputRoot, options, digestCanonicalBytes);
}

export function toWorkspaceRef(identity: WorkspaceIdentity): Execution.WorkspaceRefV1 {
  assertWorkspaceIdentity(identity);
  return {
    canonicalizerVersion: "workspace-v1",
    workspaceId: identity.workspaceId,
    canonicalBytesDigest: identity.canonicalBytesDigest,
  };
}

function adapterFor(identity: WorkspaceIdentity): WorkspacePlatformAdapterV1 {
  const adapter = adapters.get(identity);
  if (!adapter) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_identity_unavailable",
      "workspace identity is not a provisioned runtime object",
    );
  }
  return adapter;
}

export function assertWorkspaceIdentity(identity: WorkspaceIdentity): void {
  if (identitiesById.get(identity.workspaceId)?.collided) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_identity_collision",
      `workspace ID collision invalidated identity: ${identity.workspaceId}`,
    );
  }
  const adapter = adapterFor(identity);
  let realpath: string;
  let current: WorkspaceObjectIdentityV1 & { readonly isDirectory: boolean };
  try {
    const canonical = canonicalizeExisting(adapter, identity.canonicalRoot);
    realpath = canonical.canonicalPath;
    current = canonical.identity;
  } catch (error) {
    if (
      error instanceof WorkspaceIdentityDeniedError &&
      error.code === "workspace_identity_unavailable"
    )
      throw error;
    throw new WorkspaceIdentityDeniedError(
      "workspace_root_unavailable",
      `workspace root is unavailable: ${identity.canonicalRoot}`,
      error,
    );
  }
  if (!current.isDirectory) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_root_replaced",
      "workspace root is no longer a directory",
    );
  }
  if (realpath !== identity.canonicalRoot) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_root_moved",
      "workspace root realpath changed",
    );
  }
  if (
    current.volumeId !== identity.rootIdentity.volumeId ||
    current.fileId !== identity.rootIdentity.fileId
  ) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_root_replaced",
      "workspace root object identity changed",
    );
  }
}

function contained(pathApi: PlatformPath, root: string, target: string): boolean {
  const suffix = pathApi.relative(root, target);
  return (
    suffix === "" ||
    (!suffix.startsWith(`..${pathApi.sep}`) && suffix !== ".." && !pathApi.isAbsolute(suffix))
  );
}

function containsInvalidWindowsCodePoint(input: string): boolean {
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 1 && codePoint <= 31) ||
        codePoint === 34 ||
        codePoint === 42 ||
        codePoint === 60 ||
        codePoint === 62 ||
        codePoint === 63 ||
        codePoint === 124)
    ) {
      return true;
    }
  }
  return false;
}

function invalidTargetInput(adapter: WorkspacePlatformAdapterV1, input: string): boolean {
  if (!input || input.includes("\0")) return true;
  if (adapter.platform !== "win32") return false;
  if (input.includes("/") || containsInvalidWindowsCodePoint(input)) return true;

  let pathWithoutDrive = input;
  if (/^[a-zA-Z]:/.test(input)) {
    if (!/^[a-zA-Z]:\\/.test(input)) return true;
    pathWithoutDrive = input.slice(2);
  }
  if (pathWithoutDrive.includes(":")) return true;

  return pathWithoutDrive.split("\\").some((segment) => {
    if (!segment) return false;
    if (/[ .]$/.test(segment)) return true;
    const dot = segment.indexOf(".");
    const basename = dot === -1 ? segment : segment.slice(0, dot);
    return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(basename);
  });
}

export function resolveWorkspaceTarget(
  workspace: WorkspaceIdentity,
  inputPath: string,
  requestedMode?: "existing" | "create",
): CanonicalWorkspaceTarget {
  assertWorkspaceIdentity(workspace);
  const adapter = adapterFor(workspace);
  if (invalidTargetInput(adapter, inputPath)) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_target_invalid",
      "workspace target is empty or platform-invalid",
    );
  }

  const lexicalTarget = adapter.path.resolve(workspace.canonicalRoot, inputPath);
  if (!contained(adapter.path, workspace.canonicalRoot, lexicalTarget)) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_target_escape",
      `workspace target escapes root: ${inputPath}`,
    );
  }

  let existing = lexicalTarget;
  const unresolved: string[] = [];
  while (true) {
    try {
      const canonical = canonicalizeExisting(adapter, existing);
      const canonicalAncestor = canonical.canonicalPath;
      if (!contained(adapter.path, workspace.canonicalRoot, canonicalAncestor)) {
        throw new WorkspaceIdentityDeniedError(
          "workspace_symlink_escape",
          `workspace target escapes through a symlink: ${inputPath}`,
        );
      }
      const ancestorIdentity = canonical.identity;
      const suffix = unresolved.join(adapter.path.sep);
      const targetMode = unresolved.length === 0 ? "existing" : "create";
      if (requestedMode === "existing" && targetMode !== "existing") {
        throw new WorkspaceIdentityDeniedError(
          "workspace_target_invalid",
          "existing workspace target does not exist",
        );
      }
      if (requestedMode === "create" && targetMode !== "create") {
        throw new WorkspaceIdentityDeniedError(
          "workspace_target_invalid",
          "create workspace target already exists",
        );
      }
      assertWorkspaceIdentity(workspace);
      return Object.freeze({
        workspaceId: workspace.workspaceId,
        canonicalTarget: suffix
          ? adapter.path.resolve(canonicalAncestor, ...unresolved)
          : canonicalAncestor,
        existingAncestorIdentity: Object.freeze({
          volumeId: ancestorIdentity.volumeId,
          fileId: ancestorIdentity.fileId,
        }),
        unresolvedSuffix: suffix,
        targetMode,
      });
    } catch (error) {
      if (error instanceof WorkspaceIdentityDeniedError) throw error;
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT" && nodeError.code !== "ENOTDIR") {
        throw new WorkspaceIdentityDeniedError(
          "workspace_target_invalid",
          "workspace target cannot be resolved",
          error,
        );
      }
      if (existing === workspace.canonicalRoot) {
        throw new WorkspaceIdentityDeniedError(
          "workspace_root_unavailable",
          "workspace root disappeared during target resolution",
          error,
        );
      }
      const parent = adapter.path.dirname(existing);
      if (!contained(adapter.path, workspace.canonicalRoot, parent) || parent === existing) {
        throw new WorkspaceIdentityDeniedError(
          "workspace_target_escape",
          "workspace target has no ancestor under root",
          error,
        );
      }
      const component = adapter.path.basename(existing);
      if (
        !component ||
        component === "." ||
        component === ".." ||
        adapter.path.isAbsolute(component)
      ) {
        throw new WorkspaceIdentityDeniedError(
          "workspace_target_escape",
          "workspace target has an unsafe unresolved suffix",
        );
      }
      unresolved.unshift(component);
      existing = parent;
    }
  }
}

export function revalidateWorkspaceTarget(
  workspace: WorkspaceIdentity,
  inputPath: string,
  prior: CanonicalWorkspaceTarget,
  requestedMode?: "existing" | "create",
): CanonicalWorkspaceTarget {
  const current = resolveWorkspaceTarget(workspace, inputPath, requestedMode);
  if (
    current.workspaceId !== prior.workspaceId ||
    current.canonicalTarget !== prior.canonicalTarget ||
    current.unresolvedSuffix !== prior.unresolvedSuffix ||
    current.targetMode !== prior.targetMode ||
    current.existingAncestorIdentity.volumeId !== prior.existingAncestorIdentity.volumeId ||
    current.existingAncestorIdentity.fileId !== prior.existingAncestorIdentity.fileId
  ) {
    throw new WorkspaceIdentityDeniedError(
      "workspace_target_changed",
      `workspace target changed between resolution and act: ${inputPath}`,
    );
  }
  return current;
}
