import type { Bus } from "../bus/index.js";

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
