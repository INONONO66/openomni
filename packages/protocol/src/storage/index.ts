import type { Actor } from "../actor/index.js";
import type { AppConnector } from "../app-connector/index.js";
import type { Communication } from "../communication/index.js";
import type { CronJob } from "../cron/index.js";
import type { LedgerAppend } from "../ledger-append/index.js";
import type { Wait } from "../wait/index.js";
import type { WorkItem } from "../work-item/index.js";

export namespace Storage {
  export interface WorkItemListFilter {
    status?: WorkItem.Status[];
    assigneeId?: string;
    sessionId?: string;
    parentHash?: string;
  }

  export interface WorkItemSubAdapter {
    create(hash: string, item: WorkItem.Info): boolean;
    get(hash: string): WorkItem.Info | undefined;
    compareAndSet(hash: string, expectedHead: number, item: WorkItem.Info): boolean;
    list(filter?: WorkItemListFilter): WorkItem.Info[];
    remove(hash: string): boolean;
  }

  /**
   * Decision-class ledger append on the storage-owned connection (#510
   * phase B). Exposed as a sub-adapter so a decision-class store can bind
   * `Ledger.append(event, expectedHead)` and its projection write into ONE
   * `Adapter.transaction` fsync unit — no record, no action. `cas_conflict`
   * guarantees nothing was written; retrying from the reported head is the
   * caller's decision.
   */
  export interface LedgerSubAdapter {
    append(
      event: LedgerAppend.Input,
      expectedHead: LedgerAppend.ExpectedHead,
    ): LedgerAppend.Outcome;
    /**
     * Newest recorded fact of one stream (undefined for an empty stream) —
     * the #510 C3 replay read: on a single-fact stream append conflict the
     * caller re-executes from the recorded decision instead of re-deciding.
     */
    headFact(streamId: string): LedgerAppend.RecordedFact | undefined;
    /**
     * Every recorded fact of one type across all streams, ordered by
     * (streamId, seq) — the #510 D3 read-only admin inspection surface
     * (`/admin/ledger/*`). Never a decision input: decision replay reads go
     * through {@link headFact} on the owner stream.
     */
    factsByType(type: string): LedgerAppend.RecordedFact[];
    /**
     * Boot chain tail verification (#510 D1): walks the newest events of
     * every stream and RETURNS chain-break facts — it never throws on a
     * broken chain and never refuses boot. Recording the breaks (Operational
     * event, Governor incident later) is the boot caller's job. Full-chain
     * verification stays the #226 offline restore drill.
     */
    verifyTail(): LedgerAppend.ChainBreak[];
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

  export interface PendingInteractionSubAdapter {
    create(record: Communication.PendingInteraction.Record): void;
    get(id: string): Communication.PendingInteraction.Record | undefined;
    list(
      status?: Communication.PendingInteraction.Status[],
    ): Communication.PendingInteraction.Record[];
    findByCorrelation(
      query: Communication.PendingInteraction.CorrelationQuery,
    ): Communication.PendingInteraction.Record[];
    set(record: Communication.PendingInteraction.Record): void;
    remove(id: string): boolean;
  }

  export interface WorkerGrantSubAdapter {
    create(record: Communication.WorkerGrant.Record): void;
    get(id: string): Communication.WorkerGrant.Record | undefined;
    list(workerRunId?: string): Communication.WorkerGrant.Record[];
    set(record: Communication.WorkerGrant.Record): void;
    remove(id: string): boolean;
  }

  export interface CronJobSubAdapter {
    get(id: string): CronJob.Info | undefined;
    set(job: CronJob.Info): void;
    list(): CronJob.Info[];
    remove(id: string): boolean;
  }

  export interface ActorRegistrySubAdapter {
    getIdentity(id: string): Actor.Identity | undefined;
    setIdentity(identity: Actor.Identity): void;
    listIdentities(): Actor.Identity[];
    removeIdentity(id: string): boolean;
    getEndpoint(id: string): Actor.Endpoint | undefined;
    setEndpoint(endpoint: Actor.Endpoint): void;
    findEndpoint(
      channel: string,
      externalId: string,
      workspace: string | undefined,
    ): Actor.Endpoint | undefined;
    listEndpoints(actorId?: string, workspace?: string): Actor.Endpoint[];
    removeEndpoint(id: string): boolean;
  }

  export interface BlacklistSubAdapter {
    get(id: string): Actor.BlacklistEntry | undefined;
    set(entry: Actor.BlacklistEntry): void;
    list(): Actor.BlacklistEntry[];
    remove(id: string): boolean;
  }

  export interface ChannelGrantSubAdapter {
    get(id: string): Actor.ChannelGrant | undefined;
    set(grant: Actor.ChannelGrant): void;
    list(): Actor.ChannelGrant[];
    remove(id: string): boolean;
  }

  export interface AppConnectorInstallationSubAdapter {
    get(id: string): AppConnector.Installation | undefined;
    set(installation: AppConnector.Installation): void;
    list(): AppConnector.Installation[];
    remove(id: string): boolean;
  }
}
