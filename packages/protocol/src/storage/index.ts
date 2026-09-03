// Type-only storage contract vocabulary: the sub-adapter surfaces a ledger
// adapter implements, grouped by semantic domain.
import type { Actor } from "../actor/index.js";
import type { AppConnector } from "../app-connector/index.js";
import type { Ledger } from "../ledger/index.js";
import type { Delegation } from "../delegation/index.js";
import type { Approval } from "../approval/index.js";
import type { Wait } from "../wait/index.js";
import type { WorkItem } from "../work-item/index.js";
import type { Gateway } from "../gateway/index.js";
import type { Provisioning } from "../provisioning/index.js";

export namespace Storage {
  export interface ActorRegistrySubAdapter {
    getIdentity(id: string): Actor.Identity | undefined;
    setIdentity(identity: Actor.Identity): void;
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
    /**
     * #P3 mint-volume bound (§8.12): provisional identities whose endpoint
     * sits on this channel(+workspace) minted at or after `since`.
     */
    countProvisionalSince(channel: string, workspace: string | undefined, since: number): number;
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

  /**
   * Provisioning declarations (docs/provisioning-and-providers.md §3):
   * Person manifests, ChannelInstance declarations, and vault Secret rows.
   * Sole-owner and vault laws live in the ledger stores, not here.
   */
  export interface ProvisioningSubAdapter {
    getPerson(id: string): Provisioning.Person | undefined;
    setPerson(person: Provisioning.Person): void;
    listPersons(): Provisioning.Person[];
    removePerson(id: string): boolean;
    getChannelInstance(id: string): Provisioning.ChannelInstance | undefined;
    setChannelInstance(instance: Provisioning.ChannelInstance): void;
    listChannelInstances(): Provisioning.ChannelInstance[];
    removeChannelInstance(id: string): boolean;
    getSecret(id: string): Provisioning.Secret | undefined;
    setSecret(secret: Provisioning.Secret): void;
    listSecrets(): Provisioning.Secret[];
    removeSecret(id: string): boolean;
  }

  export interface AppConnectorInstallationSubAdapter {
    get(id: string): AppConnector.Installation | undefined;
    set(installation: AppConnector.Installation): void;
    list(): AppConnector.Installation[];
    remove(id: string): boolean;
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
    append(event: Ledger.Input, expectedHead: Ledger.ExpectedHead): Ledger.Outcome;
    /**
     * Adopts a PRE-CUTOVER stream (#510 review fix F3): inserts the genesis
     * fact at seq === `headRevision` and sets the stream head to
     * `headRevision`, in one unit, ONLY while the stream is empty — a
     * non-empty stream throws the typed `Ledger.AdoptError`. Used by
     * revision-bound stores whose projection row predates its owner stream
     * (row revision >= 1, empty stream) so the head↔revision equation holds
     * without fabricating per-transition history.
     */
    adoptStream(streamId: string, headRevision: number, genesis: Ledger.AdoptGenesis): void;
    /**
     * Newest recorded fact of one stream (undefined for an empty stream) —
     * the #510 C3 replay read: on a single-fact stream append conflict the
     * caller re-executes from the recorded decision instead of re-deciding.
     */
    headFact(streamId: string): Ledger.RecordedFact | undefined;
    /**
     * Every recorded fact of one type across all streams, ordered by
     * (streamId, seq) — the #510 D3 read-only admin inspection surface
     * (`/admin/ledger/*`). Never a decision input: decision replay reads go
     * through {@link headFact} on the owner stream.
     */
    factsByType(type: string): Ledger.RecordedFact[];
  }

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

  export interface ApprovalSubAdapter {
    /** INSERT receipt: false when the id already exists. */
    create(record: Approval.Record): boolean;
    get(id: string): Approval.Record | undefined;
    list(state?: Approval.State[]): Approval.Record[];
    /** Pending requests created at or after `since` — the §8.13 volume-bound read. */
    countPendingSince(since: number): number;
    /** Revision compare-and-set (UPDATE ... WHERE id AND revision): changes===1 receipt. */
    compareAndSet(id: string, expectedRevision: number, record: Approval.Record): boolean;
  }

  /**
   * Surface-key map rows (perimeter surface, #707): the N:1 surfaceKey →
   * sessionId claim table. `claim` is compare-and-swap shaped — with
   * `expectedSessionId` it replaces only while the current owner still equals
   * it, without it it inserts only when the key is absent — and always returns
   * the sessionId that owns the key after the attempt. The key format codec
   * stays `Channel.SurfaceKey`; this is the row surface only.
   */
  export interface SurfaceKeySubAdapter {
    claim(key: string, sessionId: string, expectedSessionId?: string): string;
    lookup(key: string): string | undefined;
    listBySession(sessionId: string): string[];
  }

  /**
   * Active-egress debit ledger (#219, perimeter domain): a per-(senderId,
   * targetActorId) append-only log of ADMITTED proactive sends. The gateway
   * router is the sole writer (same isolation as the wait store — the brain
   * never reaches it). `claim` atomically folds the projection, asks the
   * perimeter evaluator whether the row fits, and appends only when admitted.
   * Retrying the same row id is idempotently `claimed`.
   */
  export interface EgressBudgetSubAdapter {
    claim(
      row: Gateway.EgressDebitRow,
      windowStartAt: number,
      canClaim: (state: Gateway.EgressDebitState) => boolean,
    ): "claimed" | "refused";
  }

}
