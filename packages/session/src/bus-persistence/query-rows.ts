export interface BusEventRow {
  readonly id: number;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly event_type: string;
  readonly category: string;
  readonly data: string;
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

export interface AuditChainRow {
  readonly seq: number;
  readonly session_id: string | null;
  readonly event_type: string;
  readonly event_hash: string;
  readonly prev_hash: string;
  readonly time_created: number;
}
