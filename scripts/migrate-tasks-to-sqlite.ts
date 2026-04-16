#!/usr/bin/env bun

import { existsSync, readFileSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import type { Task } from "../packages/openomni/src/storage/task-types";

const DEFAULT_TASKS_DIR = join(homedir(), ".openomni", "tasks");

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function migrate(sourceDir: string, dbPath: string) {
  const bakDir = join(sourceDir, ".bak");
  mkdirSync(bakDir, { recursive: true });

  for (const file of [
    "tasks.json",
    "runs.json",
    "taskRuns.json",
    "idempotencyIndex.json",
    "statusIndex.json",
  ]) {
    const src = join(sourceDir, file);
    if (existsSync(src)) {
      cpSync(src, join(bakDir, file));
    }
  }

  const db = new Database(dbPath, { create: true });

  db.exec(`
    PRAGMA journal_mode  = WAL;
    PRAGMA foreign_keys  = ON;
    PRAGMA synchronous   = OFF;
    PRAGMA cache_size    = 10000;

    CREATE TABLE IF NOT EXISTS task (
      id           TEXT PRIMARY KEY,
      owner_type   TEXT,
      owner_id     TEXT,
      status       TEXT NOT NULL,
      data         TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_run (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      status       TEXT NOT NULL,
      trigger      TEXT,
      data         TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_idempotency (
      key          TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL REFERENCES task_run(id) ON DELETE CASCADE,
      time_created INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_status     ON task(status, time_created);
    CREATE INDEX IF NOT EXISTS idx_task_run_task   ON task_run(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_run_status ON task_run(status, time_created);
  `);

  const now = Date.now();
  let taskCount = 0;
  let runCount = 0;
  let idempotencyCount = 0;

  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO task (id, owner_type, owner_id, status, data, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRun = db.prepare(`
    INSERT OR IGNORE INTO task_run (id, task_id, status, trigger, data, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIdempotency = db.prepare(`
    INSERT OR IGNORE INTO task_idempotency (key, run_id, time_created) VALUES (?, ?, ?)
  `);

  const migrate = db.transaction(() => {
    const tasksRaw = readJsonFile<Record<string, Task.Info>>(join(sourceDir, "tasks.json"), {});
    for (const [id, info] of Object.entries(tasksRaw)) {
      insertTask.run(
        id,
        info.owner.type,
        info.owner.id,
        info.status,
        JSON.stringify(info),
        now,
        now,
      );
      taskCount++;
    }

    const runsRaw = readJsonFile<Record<string, Task.Run>>(join(sourceDir, "runs.json"), {});
    const taskExists = db.prepare("SELECT 1 FROM task WHERE id = ?");
    for (const [, run] of Object.entries(runsRaw)) {
      if (!taskExists.get(run.taskId)) continue;
      insertRun.run(
        run.runId,
        run.taskId,
        run.status,
        JSON.stringify(run.trigger),
        JSON.stringify(run),
        now,
        now,
      );
      runCount++;
    }

    const idempotencyRaw = readJsonFile<Record<string, string>>(
      join(sourceDir, "idempotencyIndex.json"),
      {},
    );
    const runExists = db.prepare("SELECT 1 FROM task_run WHERE id = ?");
    for (const [key, runId] of Object.entries(idempotencyRaw)) {
      if (!runExists.get(runId)) continue;
      insertIdempotency.run(key, runId, now);
      idempotencyCount++;
    }
  });

  migrate();
  db.close();

  return { taskCount, runCount, idempotencyCount };
}

const sourceDir = process.argv[2] ?? DEFAULT_TASKS_DIR;
const dbPath = process.argv[3] ?? join(sourceDir, "tasks.db");

console.log(`Migrating ${sourceDir} → ${dbPath}`);
const result = migrate(sourceDir, dbPath);
console.log(
  `Done: ${result.taskCount} tasks, ${result.runCount} runs, ${result.idempotencyCount} idempotency keys`,
);
