import { Database } from "bun:sqlite";
import { Storage } from "../../src/storage/storage.js";
import "../../src/storage/initialize.js";

export function resetQueryStorage(): void {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  seedSession("sess-1");
  seedSession("sess-2");
}

export function cleanupQueryStorage(): void {
  Storage.reset();
}

function db(): Database {
  const descriptor = Object.getOwnPropertyDescriptor(Storage.getAdapter(), "db");
  if (descriptor?.value instanceof Database) return descriptor.value;
  throw new Error("Expected SQLite-backed storage adapter");
}

function seedSession(id: string): void {
  const now = Date.now();
  Storage.getAdapter().session.set(id, {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test-model" },
    time: { created: now, updated: now },
    spawnDepth: 0,
  });
}

export function insertEvent(input: {
  readonly sessionId: string;
  readonly runId?: string;
  readonly type: string;
  readonly category: string;
  readonly visibility?: "internal" | "llm_reason" | "user_audit" | "ephemeral";
  readonly data?: Record<string, unknown>;
  readonly traceId: string;
  readonly durationMs?: number;
  readonly timeCreated: number;
}): void {
  db()
    .query(
      `INSERT INTO bus_event
       (session_id, run_id, event_type, category, visibility, data, trace_id, duration_ms, time_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.runId ?? null,
      input.type,
      input.category,
      input.visibility ?? "internal",
      JSON.stringify(input.data ?? {}),
      input.traceId,
      input.durationMs ?? null,
      input.timeCreated,
    );
}

export function insertWorkerRun(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
}): void {
  db()
    .query(
      `INSERT INTO worker_run_state
       (run_id, session_id, parent_session_id, agent_name, status, title, prompt,
        resume_count, assigned_step_id, error, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.sessionId,
      null,
      "worker",
      input.status,
      `Run ${input.runId}`,
      "do the work",
      0,
      null,
      null,
      input.timeCreated,
      input.timeUpdated,
    );
}
