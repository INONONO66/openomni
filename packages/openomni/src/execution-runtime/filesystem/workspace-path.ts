import {
  createWorkspaceIdentity,
  resolveWorkspaceTarget,
  revalidateWorkspaceTarget,
  type WorkspaceIdentity,
} from "../workspace-identity.js";

function identityOf(workspace: WorkspaceIdentity | string): WorkspaceIdentity {
  return typeof workspace === "string" ? createWorkspaceIdentity(workspace) : workspace;
}
/** Resolve and immediately revalidate a canonical workspace target before native access. */
export function resolveContainedPath(
  workspace: WorkspaceIdentity | string,
  inputPath: string,
): string {
  const identity = identityOf(workspace);
  const target = resolveWorkspaceTarget(identity, inputPath);
  return revalidateWorkspaceTarget(identity, inputPath, target).canonicalTarget;
}

/** Resolve and immediately revalidate a create-or-overwrite target before native access. */
export function resolveContainedPathForCreate(
  workspace: WorkspaceIdentity | string,
  inputPath: string,
): string {
  const identity = identityOf(workspace);
  const target = resolveWorkspaceTarget(identity, inputPath);
  return revalidateWorkspaceTarget(identity, inputPath, target).canonicalTarget;
}

/** Resolve and revalidate an existing directory for process execution. */
export function resolveContainedDirectory(
  workspace: WorkspaceIdentity | string,
  inputPath: string,
): string {
  const identity = identityOf(workspace);
  const target = resolveWorkspaceTarget(identity, inputPath, "existing");
  return revalidateWorkspaceTarget(identity, inputPath, target, "existing").canonicalTarget;
}
