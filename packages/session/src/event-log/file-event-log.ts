import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutionEvent } from "@openomni/protocol";

/** @deprecated Use Storage.Adapter.eventLog instead. Will be removed in a future version. */
export class FileEventLog {
  private readonly eventsDir: string;
  private readonly completeDir: string;

  constructor(private readonly baseDir: string) {
    this.eventsDir = join(baseDir, "events");
    this.completeDir = join(baseDir, "complete");
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    mkdirSync(this.eventsDir, { recursive: true });
    mkdirSync(this.completeDir, { recursive: true });
  }

  private eventFilePath(sessionId: string): string {
    return join(this.eventsDir, `${sessionId}.jsonl`);
  }

  private completeMarkerPath(sessionId: string): string {
    return join(this.completeDir, `${sessionId}.done`);
  }

  private atomicWrite(filePath: string, data: string): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tempPath = `${filePath}.${randomUUID()}.tmp`;

    try {
      writeFileSync(tempPath, data, "utf-8");
      renameSync(tempPath, filePath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {}
      throw error;
    }
  }

  private readFile(filePath: string): string {
    try {
      return readFileSync(filePath, "utf-8");
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  }

  append(sessionId: string, event: ExecutionEvent.T): void {
    const filePath = this.eventFilePath(sessionId);
    const current = this.readFile(filePath);
    const next = `${current}${JSON.stringify(event)}\n`;
    this.atomicWrite(filePath, next);

    const completeMarker = this.completeMarkerPath(sessionId);
    if (existsSync(completeMarker)) {
      unlinkSync(completeMarker);
    }
  }

  *replay(sessionId: string): Generator<ExecutionEvent.T> {
    const filePath = this.eventFilePath(sessionId);
    const raw = this.readFile(filePath);
    if (!raw) {
      return;
    }

    const lines = raw.split("\n");
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsedJSON: unknown;
      try {
        parsedJSON = JSON.parse(trimmed);
      } catch (error) {
        console.warn(
          `FileEventLog: skipping corrupted JSON line ${index + 1} in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const parsedEvent = ExecutionEvent.Schema.safeParse(parsedJSON);
      if (!parsedEvent.success) {
        console.warn(
          `FileEventLog: skipping invalid execution event on line ${index + 1} in ${filePath}`,
        );
        continue;
      }

      yield parsedEvent.data;
    }
  }

  listIncomplete(): string[] {
    this.ensureDirectories();

    const eventFiles = readdirSync(this.eventsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length));

    const completedSessions = new Set(
      readdirSync(this.completeDir)
        .filter((name) => name.endsWith(".done"))
        .map((name) => name.slice(0, -".done".length)),
    );

    return eventFiles.filter((sessionId) => !completedSessions.has(sessionId));
  }

  markComplete(sessionId: string): void {
    const markerPath = this.completeMarkerPath(sessionId);
    this.atomicWrite(
      markerPath,
      JSON.stringify({ sessionId, completedAt: new Date().toISOString() }),
    );
  }

  clear(sessionId: string): void {
    const filePath = this.eventFilePath(sessionId);
    const markerPath = this.completeMarkerPath(sessionId);
    rmSync(filePath, { force: true });
    rmSync(markerPath, { force: true });
  }

  clearAll(): void {
    rmSync(this.baseDir, { recursive: true, force: true });
    this.ensureDirectories();
  }
}
