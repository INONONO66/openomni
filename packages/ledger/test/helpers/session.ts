import { SessionHandleStore, type Storage } from "../../src/index";

export function bareStorageAdapter(): Storage.Adapter {
  return { transaction: <T>(operation: () => T): T => operation() };
}

/** A real configured L0 session for store consumers; no legacy JSON writer. */
export function materializeSession(id: string, parentId: string | null = null) {
  return SessionHandleStore.materialize({
    id,
    parentId,
    role: parentId === null ? "resident" : "worker",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
    actionId: `${id}:configure`,
    at: 1,
  }).row;
}
