import { z } from "zod";
import { Storage } from "./storage";
import { Message } from "./message";
import { BusEvent, Bus } from "./bus";

export interface SnapshotProvider {
  track(sessionID: string): string;
  restore(sessionID: string, snapshotID: string): void;
  diff(sessionID: string, snapshotID: string): SnapshotDiff;
  remove(snapshotID: string): void;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

export class InMemorySnapshotProvider implements SnapshotProvider {
  private snapshots = new Map<
    string,
    { messages: Message.Info[]; parts: Map<string, Message.Part[]> }
  >();

  track(sessionID: string): string {
    const adapter = Storage.getAdapter();
    const snapshotID = `snap-${Math.random().toString(36).substring(2, 11)}`;
    const messages = adapter.message.list(sessionID).map((m) => ({ ...m }));
    const parts = new Map<string, Message.Part[]>();
    for (const msg of messages) {
      const msgParts = adapter.part
        .list(msg.id)
        .map((p) => ({ ...p }) as Message.Part);
      parts.set(msg.id, msgParts);
    }
    this.snapshots.set(snapshotID, { messages, parts });
    return snapshotID;
  }

  restore(sessionID: string, snapshotID: string): void {
    const snapshot = this.snapshots.get(snapshotID);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotID}`);

    const adapter = Storage.getAdapter();

    // Clear current messages and parts
    const currentMsgs = adapter.message.list(sessionID);
    for (const msg of currentMsgs) {
      const currentParts = adapter.part.list(msg.id);
      for (const part of currentParts) {
        adapter.part.remove(msg.id, part.id);
      }
      adapter.message.remove(sessionID, msg.id);
    }

    // Restore from snapshot
    for (const msg of snapshot.messages) {
      adapter.message.set(sessionID, msg);
      const snapshotParts = snapshot.parts.get(msg.id) ?? [];
      for (const part of snapshotParts) {
        adapter.part.set(msg.id, part);
      }
    }
  }

  diff(sessionID: string, snapshotID: string): SnapshotDiff {
    const snapshot = this.snapshots.get(snapshotID);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotID}`);

    const adapter = Storage.getAdapter();
    const currentMsgs = adapter.message.list(sessionID);

    const snapshotIDs = new Set(snapshot.messages.map((m) => m.id));
    const currentIDs = new Set(currentMsgs.map((m) => m.id));

    const added = currentMsgs
      .filter((m) => !snapshotIDs.has(m.id))
      .map((m) => m.id);
    const removed = snapshot.messages
      .filter((m) => !currentIDs.has(m.id))
      .map((m) => m.id);
    const modified: string[] = [];

    for (const msg of currentMsgs) {
      if (snapshotIDs.has(msg.id)) {
        const currentParts = adapter.part.list(msg.id);
        const snapParts = snapshot.parts.get(msg.id) ?? [];
        if (currentParts.length !== snapParts.length) {
          modified.push(msg.id);
        }
      }
    }

    return { added, removed, modified };
  }

  remove(snapshotID: string): void {
    this.snapshots.delete(snapshotID);
  }

  reset(): void {
    this.snapshots.clear();
  }
}

export namespace Snapshot {
  let provider: SnapshotProvider = new InMemorySnapshotProvider();

  export const Event = {
    Tracked: BusEvent.define(
      "snapshot.tracked",
      z.object({ sessionID: z.string(), snapshotID: z.string() }),
    ),
    Restored: BusEvent.define(
      "snapshot.restored",
      z.object({ sessionID: z.string(), snapshotID: z.string() }),
    ),
  };

  export function configure(newProvider: SnapshotProvider): void {
    provider = newProvider;
  }

  export function getProvider(): SnapshotProvider {
    return provider;
  }

  export function track(sessionID: string): string {
    const snapshotID = provider.track(sessionID);
    Bus.publish(Event.Tracked, { sessionID, snapshotID });
    return snapshotID;
  }

  export function restore(sessionID: string, snapshotID: string): void {
    provider.restore(sessionID, snapshotID);
    Bus.publish(Event.Restored, { sessionID, snapshotID });
  }

  export function diff(sessionID: string, snapshotID: string): SnapshotDiff {
    return provider.diff(sessionID, snapshotID);
  }

  export function remove(snapshotID: string): void {
    provider.remove(snapshotID);
  }

  export function reset(): void {
    provider = new InMemorySnapshotProvider();
  }
}
