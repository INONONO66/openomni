import type { SessionInfo } from "./info";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../storage/storage";
import { Event } from "./events";

type CreateInput = {
  traceId: string;
  title: string;
  model: { providerID: string; modelID: string };
  ttlMs?: number;
};

type CreateChildInput = {
  traceId: string;
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
  Bus.publish(Event.Created, { traceId: input.traceId, info: session });

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
  Bus.publish(Event.Created, { traceId: input.traceId, info: child });

  return child;
}

/**
 * Lazy materialization for a gateway-minted session id (#707 stage 2): the
 * router mints the sessionId and claims the surface↔session map BEFORE
 * deliver (record-before-act, perimeter domain); the brain materializes the
 * session row on first Deliver. Idempotent create-if-absent — a re-delivery
 * after a crash between claim and deliver converges here.
 */
export function materialize(input: CreateInput & { id: string }): {
  session: SessionInfo;
  created: boolean;
} {
  const existing = get(input.id);
  if (existing !== undefined) return { session: existing, created: false };
  const now = Date.now();
  const session: SessionInfo = {
    id: input.id,
    title: input.title,
    model: input.model,
    time: {
      created: now,
      updated: now,
    },
    spawnDepth: 0,
    ...(input.ttlMs !== undefined && { expiresAt: now + input.ttlMs }),
  };
  Storage.getAdapter().session.set(input.id, session);
  Bus.publish(Event.Created, { traceId: input.traceId, info: session });
  return { session, created: true };
}

function isExpired(session: SessionInfo, now: number): boolean {
  return session.expiresAt !== undefined && now > session.expiresAt;
}

export function get(id: string): SessionInfo | undefined {
  const session = Storage.getAdapter().session.get(id);
  if (!session) return undefined;
  // Reads are pure: an expired session is invisible but NOT deleted here —
  // a get() that writes turns every read into a mutation (delete-during-get
  // races, list() corrupting its own iteration). Physical deletion is
  // sweepExpired()'s job, invoked from a deliberate caller.
  if (isExpired(session, Date.now())) return undefined;
  return session;
}

export function list(): SessionInfo[] {
  const now = Date.now();
  // Pure read: expired sessions are filtered out, never removed mid-filter.
  return Storage.getAdapter()
    .session.list()
    .filter((session) => !isExpired(session, now));
}

/**
 * Explicit expiry sweep: physically removes every expired session (message/
 * part cascade included, via remove()). Reads (get/list) only FILTER expired
 * rows; this is the single place expiry causes a write. Invoked from the boot
 * recovery sweeps (including the OpenOmni app
 * boot in apps/openomni/src/index.ts) alongside WaitService.sweepExpired;
 * there is no periodic scheduler yet, so long-lived processes re-sweep only
 * on restart.
 *
 * Per-session fault isolation (same contract as WaitService.sweepExpired):
 * one corrupt session (e.g. a cascade row that disagrees with its session)
 * records an Operational.Events.Error and the sweep continues — a single bad
 * row must never kill boot recovery. Returns only the sessions actually
 * removed.
 */
export function sweepExpired(traceId: string, now = Date.now()): SessionInfo[] {
  const expired = Storage.getAdapter()
    .session.list()
    .filter((session) => isExpired(session, now));
  const swept: SessionInfo[] = [];
  for (const session of expired) {
    try {
      remove(session.id, traceId);
      swept.push(session);
    } catch (error) {
      Bus.publish(Operational.Events.Error, {
        traceId,
        sessionId: session.id,
        time: Date.now(),
        component: "session",
        msg: `session expiry sweep failed for ${session.id}`,
        context: {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return swept;
}

export function listChildren(parentSessionId: string): SessionInfo[] {
  return list().filter((session) => session.parentSessionId === parentSessionId);
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

export function remove(id: string, traceId: string): boolean {
  const adapter = Storage.getAdapter();
  const exists = adapter.session.get(id) !== undefined;
  if (exists) {
    // One transaction: a crash mid-cascade must not leave a half-deleted
    // session. The manual loop stays — it is the only cascade for adapters
    // without FK enforcement.
    adapter.transaction(() => {
      for (const msg of adapter.message.list(id)) {
        for (const part of adapter.part.list(msg.id)) {
          adapter.part.remove(msg.id, part.id);
        }
        adapter.message.remove(id, msg.id);
      }
      adapter.session.remove(id);
    });
    Bus.publish(Event.Deleted, { traceId, id });
  }
  return exists;
}
