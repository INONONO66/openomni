export interface BusEventRow {
  readonly id: number;
  /** Nullable: sessionless chain rows (session_id IS NULL) share the table. */
  readonly session_id: string | null;
  readonly run_id: string | null;
  readonly event_type: string;
  readonly category: string;
  readonly visibility: string;
  readonly data: string;
  /** Null only for rows written before payload status markers shipped. */
  readonly payload_status: "valid" | "invalid" | "parse_failed" | null;
  readonly payload_diagnostic: string | null;
  readonly trace_id: string;
  readonly duration_ms: number | null;
  readonly time_created: number;
}

export interface CountRow {
  readonly count: number;
}

export interface CategoryCountRow extends CountRow {
  readonly category: string;
}

export interface TypeCountRow extends CountRow {
  readonly event_type: string;
}

export interface WorkerRunRow {
  readonly run_id: string;
  readonly status: string;
  readonly time_created: number;
  readonly time_updated: number;
  readonly event_count: number;
}

export interface HashChainRow {
  readonly id: number;
  readonly event_type: string;
  readonly data: string;
  readonly trace_id: string;
  readonly time_created: number;
  readonly prev_hash: string | null;
  readonly event_hash: string | null;
}
