import type { WorkItem } from "../work-item/index.js";

export namespace Storage {
  export interface WorkItemListFilter {
    status?: WorkItem.Status[];
    assigneeId?: string;
    sessionId?: string;
    parentHash?: string;
  }

  export interface WorkItemSubAdapter {
    get(hash: string): WorkItem.Info | undefined;
    set(hash: string, item: WorkItem.Info): void;
    list(filter?: WorkItemListFilter): WorkItem.Info[];
    remove(hash: string): boolean;
  }
}
