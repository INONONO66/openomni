import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Message } from "@openomni/protocol";
import { Session } from "./session";
import type { StorageAdapter } from "./storage";

export class FileStorageAdapter implements StorageAdapter {
  private readonly sessionsDir: string;
  private readonly messagesDir: string;
  private readonly partsDir: string;

  constructor(private readonly baseDir: string) {
    this.sessionsDir = join(baseDir, "sessions");
    this.messagesDir = join(baseDir, "messages");
    this.partsDir = join(baseDir, "parts");

    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.messagesDir, { recursive: true });
    mkdirSync(this.partsDir, { recursive: true });
  }

  private atomicWrite(filePath: string, data: unknown): void {
    const dir = join(filePath, "..");
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* noop */
      }
      throw new Error(
        `FileStorageAdapter: failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private readJSON<T>(filePath: string): T | undefined {
    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      throw new Error(
        `FileStorageAdapter: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private listDir(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw new Error(
        `FileStorageAdapter: failed to list ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  session = {
    get: (id: string): Session.Info | undefined => {
      return this.readJSON<Session.Info>(join(this.sessionsDir, `${id}.json`));
    },

    set: (id: string, info: Session.Info): void => {
      this.atomicWrite(join(this.sessionsDir, `${id}.json`), info);
    },

    list: (): Session.Info[] => {
      const files = this.listDir(this.sessionsDir);
      const results: Session.Info[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const info = this.readJSON<Session.Info>(join(this.sessionsDir, file));
        if (info) results.push(info);
      }
      return results;
    },

    remove: (id: string): boolean => {
      const filePath = join(this.sessionsDir, `${id}.json`);
      try {
        unlinkSync(filePath);
        return true;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return false;
        }
        throw new Error(
          `FileStorageAdapter: failed to remove session ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };

  message = {
    get: (sessionID: string, messageID: string): Message.Info | undefined => {
      return this.readJSON<Message.Info>(
        join(this.messagesDir, sessionID, `${messageID}.json`),
      );
    },

    set: (sessionID: string, message: Message.Info): void => {
      this.atomicWrite(
        join(this.messagesDir, sessionID, `${message.id}.json`),
        message,
      );
    },

    list: (sessionID: string): Message.Info[] => {
      const dir = join(this.messagesDir, sessionID);
      const files = this.listDir(dir);
      const results: Message.Info[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const msg = this.readJSON<Message.Info>(join(dir, file));
        if (msg) results.push(msg);
      }
      return results;
    },

    remove: (sessionID: string, messageID: string): boolean => {
      const filePath = join(this.messagesDir, sessionID, `${messageID}.json`);
      try {
        unlinkSync(filePath);
        return true;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return false;
        }
        throw new Error(
          `FileStorageAdapter: failed to remove message ${messageID}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };

  part = {
    get: (messageID: string, partID: string): Message.Part | undefined => {
      return this.readJSON<Message.Part>(
        join(this.partsDir, messageID, `${partID}.json`),
      );
    },

    set: (messageID: string, part: Message.Part): void => {
      this.atomicWrite(join(this.partsDir, messageID, `${part.id}.json`), part);
    },

    list: (messageID: string): Message.Part[] => {
      const dir = join(this.partsDir, messageID);
      const files = this.listDir(dir);
      const results: Message.Part[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const pt = this.readJSON<Message.Part>(join(dir, file));
        if (pt) results.push(pt);
      }
      return results;
    },

    remove: (messageID: string, partID: string): boolean => {
      const filePath = join(this.partsDir, messageID, `${partID}.json`);
      try {
        unlinkSync(filePath);
        return true;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return false;
        }
        throw new Error(
          `FileStorageAdapter: failed to remove part ${partID}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };

  clear(): void {
    if (existsSync(this.baseDir)) {
      rmSync(this.baseDir, { recursive: true, force: true });
    }
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.messagesDir, { recursive: true });
    mkdirSync(this.partsDir, { recursive: true });
  }
}
