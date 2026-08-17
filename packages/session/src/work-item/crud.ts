import type { WorkItem } from "@openomni/protocol";
import { Storage } from "../storage/storage.js";
import type { WorkItemListFilter } from "./types.js";

export function getWorkItem(hash: string): WorkItem.Info | undefined {
  return Storage.get().workItem?.get(hash);
}

export function listWorkItems(filter?: WorkItemListFilter): WorkItem.Info[] {
  return Storage.get().workItem?.list(filter) ?? [];
}
