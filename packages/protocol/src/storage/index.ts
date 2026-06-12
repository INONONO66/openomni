import type { Actor } from "../actor/index.js";
import type { Communication } from "../communication/index.js";
import type { CronJob } from "../cron/index.js";
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
}
