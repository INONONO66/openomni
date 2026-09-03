import { afterEach, beforeEach } from "bun:test";
import { SqliteStorageAdapter, Storage } from "@openomni/ledger";
import type { BusEvent, Delegation, Gateway } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";

export const RESIDENT: Delegation.Origin = {
  role: "resident",
  depth: 0,
  sessionId: "session-origin",
};
export const WORKER: Delegation.Origin = {
  role: "worker",
  depth: 1,
  sessionId: "session-origin",
};

export function useDelegationStore(): void {
  beforeEach(() => {
    Storage.reset();
    Storage.configure(new SqliteStorageAdapter(":memory:", Bus));
  });
  afterEach(() => {
    Storage.reset();
  });
}

export interface EventCollector extends BusEvent.Sink {
  readonly events: Array<{ readonly name: string; readonly data: unknown }>;
  waitFor(name: string, timeoutMs?: number): Promise<unknown>;
}

export function eventCollector(): EventCollector {
  const events: Array<{ readonly name: string; readonly data: unknown }> = [];
  const waiters = new Map<string, Set<(data: unknown) => void>>();
  return {
    events,
    publish(event, data) {
      events.push({ name: event.name, data });
      const pending = waiters.get(event.name);
      if (pending === undefined) return;
      waiters.delete(event.name);
      for (const resolve of pending) resolve(data);
    },
    waitFor(name, timeoutMs = 2_000) {
      const existing = events.find((event) => event.name === name);
      if (existing !== undefined) return Promise.resolve(existing.data);
      return new Promise((resolve, reject) => {
        let pending = waiters.get(name);
        if (pending === undefined) {
          pending = new Set();
          waiters.set(name, pending);
        }
        let timer: ReturnType<typeof setTimeout>;
        const complete = (data: unknown) => {
          clearTimeout(timer);
          pending?.delete(complete);
          if (pending?.size === 0) waiters.delete(name);
          resolve(data);
        };
        pending.add(complete);
        timer = setTimeout(() => {
          pending?.delete(complete);
          if (pending?.size === 0) waiters.delete(name);
          reject(new Error(`timed out waiting for ${name}`));
        }, timeoutMs);
      });
    },
  };
}

export function awaitedReceipt(input: Gateway.SendInput): Gateway.SendReceipt {
  const spec = input.waitSpec;
  if (spec === undefined) throw new Error("expected an awaited send");
  return {
    kind: "sent",
    operation: "awaited",
    messageId: input.messageId,
    senderId: input.senderId,
    grantId: "grant-1",
    target: {
      actorId: input.target.actorId,
      endpointId: "ws:actor",
      channel: "ws",
      externalId: input.target.actorId,
    },
    wait: {
      id: spec.waitId,
      ownerRef: spec.ownerRef,
      originMessageId: input.messageId,
      correlation: { endpointId: "ws:actor", replyToMessageId: input.messageId },
      allowedActions: spec.allowedActions,
      expectedResponders: spec.expectedResponders,
      resolutionPolicy: spec.resolutionPolicy,
      status: "open",
      partial: false,
      replies: [],
      revision: 0,
      expiresAt: spec.expiresAt,
      followUpWindow: spec.followUpWindow,
      createdAt: input.at,
      updatedAt: input.at,
    },
    at: input.at,
  };
}
