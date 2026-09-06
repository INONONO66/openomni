import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readSync, writeSync } from "node:fs";

// Loaded only by an isolated CLI child with --preload. Every decorated method
// still executes the native operation; faults happen at exact durable edges.
const target = "0034_u967_archive_disposition/migration.sql";
const boundary = process.env.U967_BOUNDARY;
const mode = process.env.U967_FAULT_MODE;
let active = false;

function signal(name: string): void {
  writeSync(1, `${JSON.stringify({ boundary: name, transaction: active })}\n`);
  if (name !== boundary) return;
  if (mode === "lock") {
    const gate = Buffer.alloc(1);
    if (readSync(0, gate, 0, 1, null) !== 1) throw new Error("lock gate closed");
    return;
  }
  if (mode === "crash") process.kill(process.pid, "SIGKILL");
  throw new Error(`injected_${name}`);
}

const decorated = new WeakSet<object>();
const nativeQuery = Database.prototype.query;
Object.defineProperty(Database.prototype, "query", {
  configurable: true,
  value(this: Database, sql: string) {
    const statement = nativeQuery.bind(this)<Record<string, SQLQueryBindings>, SQLQueryBindings[]>(sql);
    if (decorated.has(statement)) return statement;
    decorated.add(statement);
    const get = statement.get.bind(statement);
    const run = statement.run.bind(statement);
    Object.defineProperty(statement, "get", { value: (...parameters: SQLQueryBindings[]) => {
      const result = get(...parameters);
      if (sql === "SELECT 1 FROM _migrations WHERE name = ?" && parameters[0] === target && this.inTransaction) {
        active = true;
        signal("locked");
      }
      return result;
    } });
    Object.defineProperty(statement, "run", { value: (...parameters: SQLQueryBindings[]) => {
      const result = run(...parameters);
      if (sql.startsWith("DELETE FROM wait")) signal("after_wait_delete");
      if (sql === "DELETE FROM bus_event") signal("after_bus_delete");
      if (sql.startsWith("INSERT INTO _migrations") && parameters[0] === target) signal("after_marker");
      return result;
    } });
    return statement;
  },
});

const nativeRun = Database.prototype.run;
Object.defineProperty(Database.prototype, "run", {
  configurable: true,
  value(this: Database, ...parameters: Parameters<Database["run"]>) {
    const result = nativeRun.bind(this)(...parameters);
    const sql = parameters[0];
    if (active && sql.startsWith("INSERT INTO _u967_guard")) signal("after_guard");
    if (active && sql === "DROP TABLE bus_event") signal("after_drop");
    return result;
  },
});

const nativeExec = Database.prototype.exec;
Object.defineProperty(Database.prototype, "exec", {
  configurable: true,
  value(this: Database, ...parameters: Parameters<Database["exec"]>) {
    const sql = parameters[0];
    if (active && sql === "ROLLBACK" && mode === "rollback-failure") throw new Error("injected_rollback_failure");
    if (active && sql === "COMMIT") signal("before_commit");
    const result = nativeExec.bind(this)(...parameters);
    if (active && sql === "COMMIT") signal("after_commit");
    return result;
  },
});
