import type { Communication } from "../communication/index.js";
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

  export interface PendingAskSubAdapter {
    create(record: Communication.PendingAsk.Record): void;
    get(id: string): Communication.PendingAsk.Record | undefined;
    list(status?: Communication.PendingAsk.Status[]): Communication.PendingAsk.Record[];
    findByCorrelation(
      query: Communication.PendingAsk.CorrelationQuery,
    ): Communication.PendingAsk.Record[];
    set(record: Communication.PendingAsk.Record): void;
    remove(id: string): boolean;
  }

  export interface WorkerGrantSubAdapter {
    create(record: Communication.WorkerGrant.Record): void;
    get(id: string): Communication.WorkerGrant.Record | undefined;
    list(workerRunId?: string): Communication.WorkerGrant.Record[];
    set(record: Communication.WorkerGrant.Record): void;
    remove(id: string): boolean;
  }
}
