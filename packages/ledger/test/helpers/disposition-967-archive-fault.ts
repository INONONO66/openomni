import { Database } from "bun:sqlite";
import fs from "node:fs";
import { mock } from "bun:test";

const boundary = process.env.U967_ARCHIVE_BOUNDARY;
const crash = process.env.U967_FAULT_MODE === "crash";
const files = new Map<number, string>();
const restores = new Set<string>();
let published = "archive";
const write = fs.writeSync;

function signal(at: string): void {
  write(1, `${JSON.stringify({ archiveBoundary: at })}\n`);
  if (at !== boundary) return;
  if (crash) process.kill(process.pid, "SIGKILL");
  throw new Error(`injected_${at}`);
}

const open = fs.openSync;
Object.defineProperty(fs, "openSync", { value: (...args: Parameters<typeof fs.openSync>) => {
  const descriptor = open(...args);
  files.set(descriptor, args[0].toString());
  return descriptor;
} });
const close = fs.closeSync;
Object.defineProperty(fs, "closeSync", { value: (descriptor: number) => {
  close(descriptor);
  files.delete(descriptor);
} });
const writeFile = fs.writeFileSync;
Object.defineProperty(fs, "writeFileSync", { value: (...args: Parameters<typeof fs.writeFileSync>) => {
  writeFile(...args);
  if (typeof args[0] === "number" && files.get(args[0])?.includes("archive.sqlite")) signal("archive_write");
} });
const sync = fs.fsyncSync;
Object.defineProperty(fs, "fsyncSync", { value: (descriptor: number) => {
  sync(descriptor);
  const path = files.get(descriptor);
  if (path?.includes("archive.sqlite")) signal("archive_file_fsync");
  else if (path?.includes("manifest.json")) signal("manifest_file_fsync");
  else signal(`${published}_directory_fsync`);
} });
const link = fs.linkSync;
Object.defineProperty(fs, "linkSync", { value: (...args: Parameters<typeof fs.linkSync>) => {
  link(...args);
  published = args[1].toString().endsWith("manifest.json") ? "manifest" : "archive";
  signal(`${published}_publish`);
} });
const mkdtemp = fs.mkdtempSync;
Object.defineProperty(fs, "mkdtempSync", { value: (...args: Parameters<typeof fs.mkdtempSync>) => {
  const path = mkdtemp(...args);
  restores.add(path.toString());
  write(1, `${JSON.stringify({ ownedRestore: path.toString() })}\n`);
  return path;
} });
const remove = fs.rmSync;
Object.defineProperty(fs, "rmSync", { value: (...args: Parameters<typeof fs.rmSync>) => {
  remove(...args);
  const path = args[0].toString();
  if (restores.delete(path)) write(1, `${JSON.stringify({ cleanedRestore: path, absent: !fs.existsSync(path) })}\n`);
} });
const copy = fs.copyFileSync;
Object.defineProperty(fs, "copyFileSync", { value: (...args: Parameters<typeof fs.copyFileSync>) => {
  copy(...args);
  signal("restore_copy");
} });
// Bun's named builtin exports are not live bindings to the default object.
// Preserve every real operation while explicitly binding the decorated ports.
mock.module("node:fs", () => ({ ...fs }));

const serialize = Database.prototype.serialize;
Object.defineProperty(Database.prototype, "serialize", { value(this: Database, ...args: Parameters<Database["serialize"]>) {
  const bytes = serialize.bind(this)(...args);
  signal("snapshot");
  return bytes;
} });
const query = Database.prototype.query;
Object.defineProperty(Database.prototype, "query", { value(this: Database, sql: string) {
  if (sql === "PRAGMA integrity_check") signal("restore_open");
  return query.bind(this)(sql);
} });
process.on("exit", () => {
  write(1, `${JSON.stringify({ openDescriptors: files.size, ownedRestores: restores.size })}\n`);
  if (files.size !== 0 || restores.size !== 0) process.exitCode = 1;
});
