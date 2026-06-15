import { tmpdir } from "node:os";
import { join } from "node:path";

export type WorkspaceLockWaiter = {
  readonly runId: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

export type LocalWorkspaceLock = {
  readonly runId: string;
  depth: number;
  readonly pending: boolean;
};

export type LockOwnerMeta = {
  readonly runId: string;
  readonly pid: number;
  readonly acquiredAt: number;
};

export type UnsafeWorkspace = {
  readonly reason: string;
  readonly markedAt: number;
  readonly token?: string;
};

export const LOCK_ROOT = join(tmpdir(), "openomni-workspace-locks");
export const OWNER_FILE = "owner.json";
export const STALE_GRACE_MS = 1_000;
export const SETTLED_TOKEN_TTL_MS = 5 * 60_000;
