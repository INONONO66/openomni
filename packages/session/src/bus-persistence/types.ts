import type { Database } from "bun:sqlite";
import type { Bus } from "../bus/index.js";

export interface PersistableAdapter {
  readonly db?: Database;
}

export interface RuntimeState {
  readonly unsubscribe: () => void;
  readonly chains: Map<string, Promise<void>>;
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
