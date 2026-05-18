export namespace WorkerRunState {
  export interface ActiveRun {
    readonly sessionId: string;
    readonly controller: AbortController;
    readonly inbox: string[];
  }

  export type ActiveRunRegistry = Map<string, ActiveRun>;
  export type ReadableActiveRuns = Pick<ActiveRunRegistry, "get" | "entries" | "size">;
  export type InboxReadableActiveRuns = Pick<ActiveRunRegistry, "get">;
}
