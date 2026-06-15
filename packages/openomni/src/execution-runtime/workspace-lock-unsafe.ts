import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockKey } from "./workspace-lock-files.js";
import { LOCK_ROOT, SETTLED_TOKEN_TTL_MS, type UnsafeWorkspace } from "./workspace-lock-types.js";

const unsafe = new Map<string, UnsafeWorkspace>();
const settledUnsafeTokens = new Map<string, number>();

function unsafeTokenKey(workspace: string, token: string): string {
  return `${lockKey(workspace)}:${token}`;
}

function pruneSettledUnsafeTokens(): void {
  const now = Date.now();
  for (const [key, settledAt] of settledUnsafeTokens) {
    if (now - settledAt >= SETTLED_TOKEN_TTL_MS) settledUnsafeTokens.delete(key);
  }
}

function unsafeFilePath(workspace: string): string {
  return join(LOCK_ROOT, `${lockKey(workspace)}.unsafe.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnsafeWorkspace(value: unknown): value is UnsafeWorkspace {
  return (
    isRecord(value) &&
    typeof value.reason === "string" &&
    typeof value.markedAt === "number" &&
    (value.token === undefined || typeof value.token === "string")
  );
}

export function readUnsafeMeta(workspace: string): UnsafeWorkspace | undefined {
  const local = unsafe.get(workspace);
  if (local) return local;
  try {
    const parsed: unknown = JSON.parse(readFileSync(unsafeFilePath(workspace), "utf-8"));
    const state = isUnsafeWorkspace(parsed)
      ? parsed
      : { reason: "invalid unsafe marker", markedAt: Date.now() };
    unsafe.set(workspace, state);
    return state;
  } catch {
    return undefined;
  }
}

export function unsafeWorkspaceError(workspace: string, state: UnsafeWorkspace): Error {
  return new Error(`workspace marked unsafe for "${workspace}": ${state.reason}`);
}

export function markWorkspaceUnsafe(
  workspace: string,
  reason: string,
  token?: string,
): UnsafeWorkspace | undefined {
  if (token !== undefined) {
    pruneSettledUnsafeTokens();
    if (settledUnsafeTokens.has(unsafeTokenKey(workspace, token))) {
      return undefined;
    }
  }

  const state: UnsafeWorkspace = {
    reason,
    markedAt: Date.now(),
    ...(token !== undefined ? { token } : {}),
  };
  unsafe.set(workspace, state);
  mkdirSync(LOCK_ROOT, { recursive: true });
  writeFileSync(unsafeFilePath(workspace), JSON.stringify(state), "utf-8");
  return state;
}

export function clearWorkspaceUnsafe(workspace: string, token?: string): void {
  const state = readUnsafeMeta(workspace);
  if (token !== undefined) {
    pruneSettledUnsafeTokens();
    settledUnsafeTokens.set(unsafeTokenKey(workspace, token), Date.now());
    if (state?.token !== token) return;
  }

  unsafe.delete(workspace);
  try {
    unlinkSync(unsafeFilePath(workspace));
  } catch {
    return;
  }
}
