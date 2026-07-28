import type { SessionInfo } from "./info";
import { Bus } from "../bus";
import { Storage } from "../storage/storage";
import { Event } from "./events";

type CreateInput = {
  title: string;
  model: { providerID: string; modelID: string };
  ttlMs?: number;
};

type CreateChildInput = {
  parentSessionId: string;
  title: string;
  model: { providerID: string; modelID: string };
  workerMeta?: Record<string, unknown>;
};

type UpdateInput = Partial<Omit<SessionInfo, "id" | "time">> & {
  time?: Partial<SessionInfo["time"]>;
};

export function create(input: CreateInput): SessionInfo {
  const id = crypto.randomUUID();
  const now = Date.now();

  const session: SessionInfo = {
    id,
    title: input.title,
    model: input.model,
    time: {
      created: now,
      updated: now,
    },
    spawnDepth: 0,
    ...(input.ttlMs !== undefined && { expiresAt: now + input.ttlMs }),
  };

  Storage.getAdapter().session.set(id, session);
  Bus.publish(Event.Created, { info: session });

  return session;
}

export function createChild(input: CreateChildInput): SessionInfo {
  const parent = get(input.parentSessionId);
  if (!parent) {
    throw new Error(`Parent session not found: ${input.parentSessionId}`);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const child: SessionInfo = {
    id,
    title: input.title,
    model: input.model,
    parentSessionId: input.parentSessionId,
    spawnDepth: parent.spawnDepth + 1,
    time: {
      created: now,
      updated: now,
    },
    ...(input.workerMeta !== undefined && { workerMeta: input.workerMeta }),
  };

  Storage.getAdapter().session.set(id, child);
  Bus.publish(Event.Created, { info: child });

  return child;
}

export function get(id: string): SessionInfo | undefined {
  const session = Storage.getAdapter().session.get(id);
  if (!session) return undefined;

  if (session.expiresAt !== undefined && Date.now() > session.expiresAt) {
    remove(id);
    return undefined;
  }

  return session;
}

export function list(): SessionInfo[] {
  const sessions = Storage.getAdapter().session.list();
  const now = Date.now();

  return sessions.filter((session) => {
    if (session.expiresAt !== undefined && now > session.expiresAt) {
      remove(session.id);
      return false;
    }
    return true;
  });
}

export function listChildren(parentSessionId: string): SessionInfo[] {
  return list().filter((session) => session.parentSessionId === parentSessionId);
}

export function getWorkerMeta(sessionId: string): Record<string, unknown> | undefined {
  return get(sessionId)?.workerMeta;
}

export function updateWorkerMeta(sessionId: string, meta: Record<string, unknown>): void {
  update(sessionId, { workerMeta: meta });
}

export function update(id: string, input: UpdateInput): SessionInfo | undefined {
  const session = Storage.getAdapter().session.get(id);
  if (!session) return undefined;

  const updated: SessionInfo = {
    ...session,
    ...input,
    time: {
      ...session.time,
      updated: Date.now(),
      ...(input.time || {}),
    },
  };

  Storage.getAdapter().session.set(id, updated);
  Bus.publish(Event.Updated, { info: updated });
  return updated;
}

export function remove(id: string): boolean {
  const adapter = Storage.getAdapter();
  const exists = adapter.session.get(id) !== undefined;
  if (exists) {
    const msgs = adapter.message.list(id);
    for (const msg of msgs) {
      const parts = adapter.part.list(msg.id);
      for (const part of parts) {
        adapter.part.remove(msg.id, part.id);
      }
      adapter.message.remove(id, msg.id);
    }
    adapter.session.remove(id);
    Bus.publish(Event.Deleted, { id });
  }
  return exists;
}

export async function suspend(id: string): Promise<boolean> {
  return get(id) !== undefined;
}

export async function abandon(id: string): Promise<boolean> {
  return remove(id);
}
