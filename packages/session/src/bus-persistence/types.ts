import type { Database } from "bun:sqlite";
import type { Bus } from "../bus/index.js";

export interface PersistableAdapter {
  readonly db?: Database;
  /**
   * #510 D1 durability split: the NORMAL/group-commit telemetry connection
   * (same file, own connection). Telemetry writes prefer it so they can
   * never join a decision-class transaction on `db`; absent (in-memory
   * degradation or a foreign adapter) they fall back to `db`.
   */
  readonly telemetryDb?: Database;
}

export interface RuntimeState {
  readonly unsubscribe: () => void;
  readonly pending: Set<Promise<void>>;
}

export interface BusPersistenceOptions {
  readonly resolveSessionId?: (
    event: Bus.PublishedDescriptor,
    payload: unknown,
  ) => string | undefined;
  readonly now?: () => Date;
}

export interface PersistInput {
  readonly event: Bus.PublishedDescriptor;
  readonly payload: unknown;
  readonly sessionId?: string;
  readonly now: () => Date;
}
