// This file owns durable orchestration state contracts for work, engagement, delegation, and waits.
import type { Delegation } from "../delegation/index.js";
import type { Engagement } from "../engagement/index.js";
import type { Wait } from "../wait/index.js";
import type { WorkItem } from "../work-item/index.js";

export type { Storage } from "./namespace.js";

declare module "./namespace.js" {
  namespace Storage {
    export interface WorkItemListFilter {
      status?: WorkItem.Status[];
      assigneeId?: string;
      sessionId?: string;
      parentId?: string;
    }

    export interface WorkItemSubAdapter {
      create(hash: string, item: WorkItem.Info): boolean;
      get(hash: string): WorkItem.Info | undefined;
      compareAndSet(hash: string, expectedHead: number, item: WorkItem.Info): boolean;
      list(filter?: WorkItemListFilter): WorkItem.Info[];
      remove(hash: string): boolean;
    }

    export interface EngagementListFilter {
      ownerSessionId?: string;
      states?: Engagement.State[];
    }

    /**
     * Engagement rows (brain surface, #709): the brain is their sole writer.
     * Same discipline as Wait: INSERT receipt on create, revision
     * compare-and-set on every transition write.
     */
    export interface EngagementSubAdapter {
      /** INSERT receipt: false when the id already exists. */
      create(record: Engagement.Record): boolean;
      get(id: string): Engagement.Record | undefined;
      list(filter?: EngagementListFilter): Engagement.Record[];
      /** Revision compare-and-set (UPDATE ... WHERE id AND revision): changes===1 receipt. */
      compareAndSet(id: string, expectedRevision: number, record: Engagement.Record): boolean;
    }

    /**
     * Durable delegation rows (record-before-act): the kernel is the sole
     * writer, recording the admission BEFORE the work runs and settling
     * exactly once. Same discipline as Wait: INSERT receipt on create,
     * compare-and-swap on the single terminal transition. `listOpenByRoot`
     * is the fanout-cap count read at admission; `findByWaitId` is the
     * reply-correlation read (`settleFromReply`).
     */
    export interface DelegationSubAdapter {
      /** INSERT receipt: false when the id already exists. */
      create(record: Delegation.Record): boolean;
      get(delegationId: string): Delegation.Record | undefined;
      /**
       * open -> settled compare-and-swap: writes the settlement payload and
       * `settledAt` and flips the status, only while the row is still open.
       * false = already settled (lost race) — the existing settlement stands,
       * which is what makes the settlement wake exactly-once.
       */
      compareAndSwapStatus(
        delegationId: string,
        settled: Delegation.Settled,
        settledAt: number,
      ): boolean;
      /** settled + no wake receipt compare-and-swap: false means already receipted or not settled. */
      compareAndSwapWoken(delegationId: string, wokenAt: number): boolean;
      listOpen(): Delegation.Record[];
      /** Settled rows whose owner-session wake has no successful-delivery receipt. */
      listSettledUnwoken(): Delegation.Record[];
      /** Open rows of one delegation tree — the per-root fanout-cap count. */
      listOpenByRoot(rootDelegationId: string): Delegation.Record[];
      /** The open (or settled) row a correlated channel reply belongs to. */
      findByWaitId(waitId: string): Delegation.Record | undefined;
    }

    export interface WaitSubAdapter {
      /** INSERT receipt: false when id or originMessageId already exists. */
      create(record: Wait.Record): boolean;
      get(id: string): Wait.Record | undefined;
      list(status?: Wait.Status[]): Wait.Record[];
      findByCorrelation(query: Wait.CorrelationQuery): Wait.Record[];
      /** Revision compare-and-set (UPDATE ... WHERE id AND revision): changes===1 receipt. */
      compareAndSet(id: string, expectedRevision: number, record: Wait.Record): boolean;
    }
  }
}
