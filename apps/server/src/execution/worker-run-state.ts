export namespace WorkerRunState {
  interface ActiveRun {
    readonly sessionId: string;
    readonly controller: AbortController;
  }

  export type ActiveRunRegistry = Map<string, ActiveRun>;
  export type ReadableActiveRuns = Pick<ActiveRunRegistry, "get" | "entries" | "size">;
}
